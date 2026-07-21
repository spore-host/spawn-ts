// SpawnClient — the public API of spawn-ts. This is the primary deliverable:
// a clean, framework-free façade over a Provider and the lifecycle engine that
// any consumer (the GUI, the terminal, tests, another app) drives the same way.
//
// It owns three things the raw Provider does not:
//   1. lifecycle enforcement — a monitor loop mirroring spored's checkAndAct,
//      so instances self-terminate on TTL/cost/idle/completion in-app too;
//   2. a clock — real wall-time, or an accelerated/steppable sim clock so a 4h
//      TTL can play out in seconds (and to line up with substrate's controllable
//      clock later);
//   3. events — a typed subscription stream (state changes, warnings, actions)
//      so a GUI can render live without polling internals.
//
// Everything is provider-agnostic: swap MockProvider ↔ EC2Provider without
// touching this file or its consumers.

import type { Provider } from "./provider.js";
import type {
  LaunchSpec,
  LifecycleAction,
  ManagedInstance,
  SweepMembership,
} from "./types.js";
import { evaluate } from "./lifecycle.js";
import { parseDuration, formatDuration } from "./duration.js";
import { tag } from "./tags.js";
import { MockProvider } from "./mock.js";
import { FanOut, type FanOutMemberStatus, type FanOutSummary } from "./fanout.js";
import { buildSweep, Sweep, type SweepOptions } from "./sweep.js";
import { buildQueue, Queue, type QueueConfig, type QueueOptions } from "./queue.js";
import type { ParamSpec } from "./params.js";

export type SpawnEvent =
  | { type: "instances"; instances: ManagedInstance[] }
  | { type: "launched"; instance: ManagedInstance }
  | { type: "action"; instance: string; action: LifecycleAction; rule: string; reason: string }
  | { type: "warning"; instance: string; rule: string; message: string }
  | { type: "info"; instance: string; message: string }
  | { type: "provider"; label: string; isReal: boolean }
  | { type: "sweep"; id: string; name: string; summary: FanOutSummary; done: boolean }
  | { type: "queue"; id: string; name: string; summary: FanOutSummary; done: boolean };

export type EventHandler = (e: SpawnEvent) => void;

export interface ClientOptions {
  /** Provider backend. Defaults to a non-billable in-memory MockProvider. */
  provider?: Provider;
  /**
   * Clock. "real" tracks wall time; a number is a sim-speed multiplier
   * (e.g. 60 = one simulated minute per real second). Sim mode only applies to
   * MockProvider; real providers are pinned to realtime.
   */
  clock?: "real" | number;
  /** Sim start epoch (ms). Fixed default keeps demo cost/TTL math reproducible. */
  startMs?: number;
}

export interface LaunchInput {
  name: string;
  instanceType?: string;
  region?: string;
  ami?: string;
  keyPair?: string;
  spot?: boolean;
  /** Any Go-form duration string ("4h") or ms number. 0/absent = none. */
  ttl?: string | number;
  idleTimeout?: string | number;
  hibernateOnIdle?: boolean;
  idleCpuPercent?: number;
  costLimit?: number;
  pricePerHour?: number;
  onComplete?: LifecycleAction | "";
  completionFile?: string;
  completionDelay?: string | number;
  /** Idle-SSH-shell auto-logout (Go-form duration or ms). 0/absent = disabled. */
  sessionTimeout?: string | number;
  /** Bypass the "real launch needs a bound" safety check. */
  allowUnbounded?: boolean;
  /** Parameter-sweep membership; stamps spawn:sweep-* / spawn:param:* tags. */
  sweep?: SweepMembership;
}

export class SpawnClient {
  private provider: Provider;
  private handlers = new Set<EventHandler>();
  private speed: number; // 1 = realtime
  private clockMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = new Set<string>();
  private lastInstances: ManagedInstance[] = [];
  /** Active fan-outs (sweeps/queues) pumped on each monitor tick. */
  private fanOuts = new Map<
    string,
    { kind: "sweep" | "queue"; name: string; fanOut: FanOut }
  >();

  constructor(opts: ClientOptions = {}) {
    this.provider = opts.provider ?? new MockProvider();
    this.speed = opts.clock === "real" || opts.clock === undefined ? 1 : opts.clock;
    if (this.provider.isReal) this.speed = 1;
    this.clockMs = opts.startMs ?? Date.UTC(2026, 6, 20, 12, 0, 0);
  }

  // ---- provider + clock ----

  get backend(): { label: string; isReal: boolean } {
    return { label: this.provider.label, isReal: this.provider.isReal };
  }

  /** The active provider — exposed so the CLI/terminal can build a ShellCtx. */
  get activeProvider(): Provider {
    return this.provider;
  }

  now(): number {
    return this.provider.isReal ? Date.now() : this.clockMs;
  }

  /** Swap the compute backend at runtime (e.g. mock → real AWS from a creds form). */
  setProvider(p: Provider): void {
    this.provider = p;
    this.warned.clear();
    if (p.isReal) this.speed = 1;
    this.emit({ type: "provider", label: p.label, isReal: p.isReal });
    void this.refresh();
  }

  /** Set sim speed (mock only). 1 = realtime, 60 = 1 min/sec. */
  setSpeed(multiplier: number): void {
    if (!this.provider.isReal) this.speed = Math.max(0, multiplier);
  }

  // ---- events ----

  on(fn: EventHandler): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
  private emit(e: SpawnEvent): void {
    for (const fn of this.handlers) fn(e);
  }

  // ---- lifecycle loop ----

  /** Begin the monitor loop (ticks every `intervalMs` of wall time). */
  startMonitor(intervalMs = 250): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(intervalMs), intervalMs);
  }
  stopMonitor(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Advance the sim clock by a duration and run one tick (mock only, for tests/step). */
  async step(by: string | number): Promise<void> {
    const ms = typeof by === "number" ? by : parseDuration(by) ?? 0;
    await this.tick(ms, /*advanceByArg*/ true);
  }

  private async tick(deltaWallMs: number, explicit = false): Promise<void> {
    const prev = this.clockMs;
    if (this.provider.isReal) {
      this.clockMs = Date.now();
    } else {
      this.clockMs += explicit ? deltaWallMs : this.speed * deltaWallMs;
      const mock = this.provider as MockProvider;
      mock.simTick?.(this.clockMs, prev, { busy: () => false });
    }

    await this.refresh();
    for (const inst of this.lastInstances) {
      if (inst.state !== "running") continue;
      const res = evaluate(inst, {
        nowMs: this.now(),
        completionFilePresent: false,
        isIdle: true,
      });
      for (const w of res.warnings) {
        const key = `${inst.instanceId}:${w.rule}`;
        if (this.warned.has(key)) continue;
        this.warned.add(key);
        this.emit({ type: "warning", instance: inst.name, rule: w.rule, message: w.message });
      }
      if (res.decision) {
        this.emit({
          type: "action",
          instance: inst.name,
          action: res.decision.action,
          rule: res.decision.rule,
          reason: res.decision.reason,
        });
        await this.applyAction(inst, res.decision.action);
      }
    }
    await this.refresh();
    await this.pumpFanOuts();
  }

  /**
   * Advance every registered fan-out (sweep/queue) one step, emit its progress,
   * and drop it once complete. Called after each monitor tick so members launch
   * as slots free and statuses reconcile against the freshly-refreshed list.
   */
  private async pumpFanOuts(): Promise<void> {
    if (this.fanOuts.size === 0) return;
    for (const [id, { kind, name, fanOut }] of [...this.fanOuts]) {
      await fanOut.pump(this.now());
      const done = fanOut.isComplete;
      this.emit({ type: kind, id, name, summary: fanOut.summary, done });
      if (done) this.fanOuts.delete(id);
    }
    // Launches during the pump changed the world; reflect it.
    await this.refresh();
  }

  // ---- sweeps / fan-out ----

  /**
   * Start a parameter sweep: expand the spec into members and register a fan-out
   * that the monitor loop pumps each tick (launching members as the concurrency
   * cap allows). Returns the built Sweep for identity/inspection. Progress is
   * delivered via "sweep" events; call startMonitor() (or step() in tests) to
   * drive it. A real launch inherits the same cost-safety guard as launch().
   */
  startSweep(spec: ParamSpec | string, opts: SweepOptions = {}): Sweep {
    const built = buildSweep(spec, { nowMs: this.now(), ...opts });
    const fanOut = new FanOut(this, built.members, {
      maxConcurrent: opts.maxConcurrent,
      launchDelayMs: opts.launchDelayMs,
    });
    this.fanOuts.set(built.id, { kind: "sweep", name: built.name, fanOut });
    // Kick the first batch immediately so callers see progress without waiting
    // a full tick; the monitor loop takes over from here.
    void this.pumpFanOuts();
    return new Sweep(built, fanOut);
  }

  /**
   * Start a batch job queue: validate + order the config into a DAG of members
   * and register a fan-out that the monitor loop pumps each tick, launching each
   * job's instance as its dependencies complete and capacity allows. Returns the
   * built Queue; progress arrives via "queue" events. Same cost-safety guard as
   * launch() applies to a real backend.
   */
  startQueue(cfg: QueueConfig, opts: QueueOptions = {}): Queue {
    const built = buildQueue(cfg, { nowMs: this.now(), ...opts });
    const fanOut = new FanOut(this, built.members, {
      maxConcurrent: opts.maxConcurrent,
      launchDelayMs: opts.launchDelayMs,
      onFailure: cfg.onFailure ?? "continue",
    });
    this.fanOuts.set(built.id, { kind: "queue", name: built.name, fanOut });
    void this.pumpFanOuts();
    return new Queue(built, fanOut);
  }

  /** Snapshot of a registered fan-out's per-member status, or null if unknown. */
  sweepStatus(id: string): FanOutMemberStatus[] | null {
    return this.fanOuts.get(id)?.fanOut.status ?? null;
  }

  /** Ids of fan-outs (sweeps + queues) still running. */
  activeSweeps(): string[] {
    return [...this.fanOuts.keys()];
  }

  // ---- operations ----

  async refresh(): Promise<ManagedInstance[]> {
    this.lastInstances = await this.provider.list(true);
    this.emit({ type: "instances", instances: this.lastInstances });
    return this.lastInstances;
  }

  list(): ManagedInstance[] {
    return this.lastInstances;
  }

  async get(nameOrId: string): Promise<ManagedInstance | null> {
    return this.provider.get(nameOrId);
  }

  async launch(input: LaunchInput): Promise<ManagedInstance> {
    const spec = this.toSpec(input);
    if (this.provider.isReal && spec.ttlMs === 0 && spec.costLimit === 0 && !input.allowUnbounded) {
      throw new Error(
        "refusing to launch a REAL instance with no ttl and no costLimit (would bill indefinitely); set ttl or pass allowUnbounded",
      );
    }
    const inst = await this.provider.launch(spec, this.now());
    this.emit({ type: "launched", instance: inst });
    await this.refresh();
    return inst;
  }

  async terminate(nameOrId: string, reason = "user request"): Promise<void> {
    const i = await this.resolve(nameOrId);
    await this.provider.terminate(i.instanceId, reason);
    await this.refresh();
  }
  async stop(nameOrId: string, reason = "user request"): Promise<void> {
    const i = await this.resolve(nameOrId);
    await this.provider.stop(i.instanceId, reason);
    await this.refresh();
  }
  async start(nameOrId: string): Promise<void> {
    const i = await this.resolve(nameOrId);
    await this.provider.start(i.instanceId);
    await this.refresh();
  }
  async hibernate(nameOrId: string): Promise<void> {
    const i = await this.resolve(nameOrId);
    await this.provider.hibernate(i.instanceId);
    await this.refresh();
  }

  /** Extend an instance's TTL deadline by a duration. Returns the new deadline (ms). */
  async extend(nameOrId: string, by: string | number): Promise<number> {
    const i = await this.resolve(nameOrId);
    if (!i.ttlDeadlineMs) throw new Error(`${i.name} has no TTL to extend`);
    const ms = typeof by === "number" ? by : parseDuration(by);
    if (ms === null || ms <= 0) throw new Error(`invalid duration: ${by}`);
    const deadline = i.ttlDeadlineMs + ms;
    await this.provider.setTags(i.instanceId, {
      [tag("ttl-deadline")]: new Date(deadline).toISOString(),
    });
    await this.refresh();
    return deadline;
  }

  /** Fire a completion signal (drops the watched file) to demo on-complete. */
  async signalComplete(nameOrId: string): Promise<void> {
    const i = await this.resolve(nameOrId);
    if (!i.onComplete) throw new Error(`${i.name} has no on-complete action`);
    this.emit({
      type: "action",
      instance: i.name,
      action: i.onComplete === "exit" ? "terminate" : i.onComplete,
      rule: "completion",
      reason: "completion signal",
    });
    await this.applyAction(i, i.onComplete);
    await this.refresh();
  }

  // ---- internals ----

  private async applyAction(inst: ManagedInstance, action: LifecycleAction): Promise<void> {
    switch (action) {
      case "terminate":
      case "exit":
        await this.provider.terminate(inst.instanceId, "lifecycle");
        break;
      case "stop":
        await this.provider.stop(inst.instanceId, "lifecycle");
        break;
      case "hibernate":
        await this.provider.hibernate(inst.instanceId);
        break;
    }
  }

  private async resolve(nameOrId: string): Promise<ManagedInstance> {
    const i = await this.provider.get(nameOrId);
    if (!i) throw new Error(`no instance named "${nameOrId}"`);
    return i;
  }

  private toSpec(input: LaunchInput): LaunchSpec {
    const dur = (v: string | number | undefined): number =>
      v === undefined ? 0 : typeof v === "number" ? v : parseDuration(v) ?? 0;
    return {
      name: input.name,
      instanceType: input.instanceType ?? "c6a.xlarge",
      region: input.region ?? this.provider.label.split(":")[1] ?? "us-east-1",
      ami: input.ami,
      keyPair: input.keyPair,
      spot: input.spot ?? false,
      ttlMs: dur(input.ttl),
      idleTimeoutMs: dur(input.idleTimeout),
      hibernateOnIdle: input.hibernateOnIdle ?? false,
      idleCpuPercent: input.idleCpuPercent ?? 0,
      costLimit: input.costLimit ?? 0,
      onComplete: input.onComplete ?? "",
      completionFile: input.completionFile ?? "",
      completionDelayMs: dur(input.completionDelay),
      pricePerHour: input.pricePerHour ?? 0,
      sessionTimeoutMs: dur(input.sessionTimeout),
      sweep: input.sweep,
    };
  }
}

/** Convenience re-export so consumers get the whole API from one import. */
export { formatDuration };
