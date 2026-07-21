// MockProvider — an in-memory, no-network compute backend. This is the default,
// so spawn-ts is fully usable (and safely demoable) with zero AWS credentials
// and zero billing risk. It also models compute-second accrual and state
// transitions, so the lifecycle engine can be exercised end-to-end.
//
// It is NOT a re-implementation of substrate; it's a tiny local stand-in. When
// substrate#346 (CORS) lands, EC2Provider pointed at localhost:4566 gives a
// higher-fidelity backend over the wire.

import type { Provider } from "./provider.js";
import type { LaunchSpec, LifecycleAction, ManagedInstance } from "./types.js";
import { buildLaunchTags, decodeConfigTags, decodeSweepTags, decodeJobArrayTags, isManaged, tag } from "./tags.js";

let idCounter = 0;
function newInstanceId(): string {
  idCounter += 1;
  // EC2-style id; deterministic-ish sequence keeps tests readable.
  return "i-" + (0x1000_0000 + idCounter).toString(16).padStart(17, "0");
}

function ip(): string {
  // Stable pseudo-IPs derived from the counter; avoids Math.random for determinism.
  const a = 10;
  const b = (idCounter >> 8) & 0xff;
  const c = idCounter & 0xff;
  return `${a}.0.${b}.${c}`;
}

export class MockProvider implements Provider {
  readonly label = "mock";
  readonly isReal = false;

  private instances = new Map<string, ManagedInstance>();

  private buildFromTags(
    instanceId: string,
    tags: Record<string, string>,
    spec: Pick<LaunchSpec, "instanceType" | "region" | "spot" | "name">,
    launchTimeMs: number,
  ): ManagedInstance {
    const cfg = decodeConfigTags(tags);
    return {
      instanceId,
      name: tags.Name ?? spec.name,
      region: spec.region,
      instanceType: spec.instanceType,
      state: "running",
      publicIp: ip(),
      privateIp: ip(),
      spot: spec.spot,
      tags,
      lastActivityMs: launchTimeMs,
      cpuPercent: 0,
      sweep: decodeSweepTags(tags),
      jobArray: decodeJobArrayTags(tags),
      ...cfg,
    };
  }

  async launch(spec: LaunchSpec, launchTimeMs: number): Promise<ManagedInstance> {
    const instanceId = newInstanceId();
    const tags = buildLaunchTags(spec, launchTimeMs);
    const inst = this.buildFromTags(instanceId, tags, spec, launchTimeMs);
    // Mock boots instantly to running.
    this.instances.set(instanceId, inst);
    return structuredClone(inst);
  }

  async list(includeTerminated = false): Promise<ManagedInstance[]> {
    return [...this.instances.values()]
      .filter((i) => isManaged(i.tags))
      .filter((i) => includeTerminated || i.state !== "terminated")
      .map((i) => structuredClone(i));
  }

  async get(nameOrId: string): Promise<ManagedInstance | null> {
    const found =
      this.instances.get(nameOrId) ??
      [...this.instances.values()].find((i) => i.name === nameOrId);
    return found ? structuredClone(found) : null;
  }

  private mutate(instanceId: string, fn: (i: ManagedInstance) => void): void {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`no such instance: ${instanceId}`);
    fn(inst);
  }

  async terminate(instanceId: string): Promise<void> {
    this.mutate(instanceId, (i) => (i.state = "terminated"));
  }
  async stop(instanceId: string): Promise<void> {
    this.mutate(instanceId, (i) => (i.state = "stopped"));
  }
  async start(instanceId: string): Promise<void> {
    this.mutate(instanceId, (i) => {
      i.state = "running";
      // Restarting counts as activity; idle clock re-arms from the resume.
      i.lastActivityMs = Math.max(i.lastActivityMs, i.launchTimeMs);
    });
  }
  async hibernate(instanceId: string): Promise<void> {
    this.mutate(instanceId, (i) => (i.state = "hibernated"));
  }

  async setTags(instanceId: string, tags: Record<string, string>): Promise<void> {
    this.mutate(instanceId, (i) => {
      i.tags = { ...i.tags, ...tags };
      Object.assign(i, decodeConfigTags(i.tags));
    });
  }

  // ---- Simulation helpers (mock-only; not part of the Provider interface) ----

  /**
   * Advance the simulated world to `nowMs`: accrue compute-seconds for running
   * instances since their last-known point, and optionally mark them busy/idle.
   * The UI's sim loop calls this, then runs the lifecycle engine over the result.
   */
  simTick(nowMs: number, prevMs: number, opts: { busy?: (i: ManagedInstance) => boolean } = {}): void {
    const dtSec = Math.max(0, (nowMs - prevMs) / 1000);
    for (const inst of this.instances.values()) {
      if (inst.state !== "running") continue;
      inst.computeSeconds += dtSec;
      inst.tags[tag("compute-seconds")] = String(Math.round(inst.computeSeconds));
      const busy = opts.busy ? opts.busy(inst) : false;
      inst.cpuPercent = busy ? 85 : 2;
      if (busy) inst.lastActivityMs = nowMs;
    }
  }

  /** Apply a lifecycle action decided by the engine, transitioning state. */
  applyAction(instanceId: string, action: LifecycleAction): void {
    this.mutate(instanceId, (i) => {
      switch (action) {
        case "terminate":
        case "exit":
          i.state = "terminated";
          break;
        case "stop":
          i.state = "stopped";
          break;
        case "hibernate":
          i.state = "hibernated";
          break;
      }
    });
  }
}
