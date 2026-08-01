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
  JobArrayMembership,
  MpiMembership,
  LifecycleHooks,
} from "./types.js";
import { evaluate, computeExtension, ttlDeadline } from "./lifecycle.js";
import { findOrphans, type Orphan } from "./orphans.js";
import { evaluateBounds } from "./bounds.js";
import { parseDuration, formatDuration } from "./duration.js";
import { tag } from "./tags.js";
import { MockProvider } from "./mock.js";
import { FanOut, type FanOutMemberStatus, type FanOutSummary } from "./fanout.js";
import { buildSweep, Sweep, type SweepOptions } from "./sweep.js";
import { buildQueue, Queue, type QueueConfig, type QueueOptions } from "./queue.js";
import { buildJobArray, JobArray, type JobArrayOptions } from "./jobarray.js";
import type { ParamSpec } from "./params.js";
import { validateDeclarations, type PluginDeclaration } from "./plugins.js";

export type SpawnEvent =
  | { type: "instances"; instances: ManagedInstance[] }
  | { type: "launched"; instance: ManagedInstance }
  | { type: "action"; instance: string; action: LifecycleAction; rule: string; reason: string }
  | { type: "warning"; instance: string; rule: string; message: string }
  | { type: "info"; instance: string; message: string }
  | { type: "provider"; label: string; isReal: boolean }
  | { type: "sweep"; id: string; name: string; summary: FanOutSummary; done: boolean }
  | { type: "queue"; id: string; name: string; summary: FanOutSummary; done: boolean }
  | { type: "jobarray"; id: string; name: string; summary: FanOutSummary; done: boolean };

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
  /** DNS label override; defaults to a slugified `name` (see LaunchSpec.dnsName). */
  dnsName?: string;
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
  /**
   * Bypass the "real launch needs a bound" refusal (see `evaluateBounds`). Only
   * clears the refusal — a launch whose only bounds are spored-dependent still
   * emits its warning, because that one isn't the caller opting into a known
   * risk, it's a limit that may quietly not be enforced at all.
   */
  allowUnbounded?: boolean;
  /** Parameter-sweep membership; stamps spawn:sweep-* / spawn:param:* tags. */
  sweep?: SweepMembership;
  /** Job-array membership; stamps spawn:job-array-* tags. */
  jobArray?: JobArrayMembership;
  /**
   * MPI declaration; stamps spawn:mpi-enabled + spawn:mpi-processes-per-node
   * (#52). Tag-emit only: it makes the launch *recognisable* as MPI to the Go CLI
   * and the portal, and does not orchestrate a collective launch — EFA validation
   * and placement groups are out of a browser's reach. See
   * docs/execution-shapes.md.
   */
  mpi?: MpiMembership;
  /** Daemon-enforced lifecycle hooks; stamps the pre-stop/webhook/notify tags. */
  hooks?: LifecycleHooks;
  /**
   * Plugins to install at launch, carried in user-data as /etc/spawn/plugins.json
   * (#53). Only the seven remote-only plugins work this way — see
   * `LAUNCH_DECLARABLE_PLUGINS`. Anything else makes `launch()` throw with the
   * reason, before any instance exists: the alternative is a running instance
   * missing a plugin the caller asked for and nothing to explain it.
   */
  plugins?: PluginDeclaration[];
}

export class SpawnClient {
  private provider: Provider;
  private handlers = new Set<EventHandler>();
  private speed: number; // 1 = realtime
  private clockMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = new Set<string>();
  private lastInstances: ManagedInstance[] = [];
  /** Active fan-outs (sweeps/queues/job arrays) pumped on each monitor tick. */
  private fanOuts = new Map<
    string,
    {
      kind: "sweep" | "queue" | "jobarray";
      name: string;
      fanOut: FanOut;
      /**
       * Set for job arrays only, so `pumpFanOuts` can wind down a non-viable
       * one (#52). The FanOut alone isn't enough: it reports non-viability but
       * deliberately holds no lifecycle authority, and `--min-viable` is a
       * job-array concept — a sweep or queue has no viability threshold.
       */
      array?: JobArray;
    }
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
   * Advance every registered fan-out (sweep/queue/job array) one step, wind down
   * any array that can no longer meet `--min-viable`, emit its progress, and drop
   * it once complete. Called after each monitor tick so members launch as slots
   * free and statuses reconcile against the freshly-refreshed list.
   */
  private async pumpFanOuts(): Promise<void> {
    if (this.fanOuts.size === 0) return;
    for (const [id, { kind, name, fanOut, array }] of [...this.fanOuts]) {
      await fanOut.pump(this.now());
      // A non-viable array is drained here rather than left for the caller to
      // notice, because the cost of forgetting is instances that bill for a job
      // that cannot be done — Go drains for that stated reason ("Drain surviving
      // instances so nothing idles and bills", cohort/reconcile.go:298). Runs
      // before the event so the summary a consumer receives already reflects the
      // wind-down having been attempted. Each survivor is reported once even
      // across overlapping pumps, so one instance yields one terminate event.
      if (array) await this.enforceArrayViability(array);
      const done = fanOut.isComplete;
      this.emit({ type: kind, id, name, summary: fanOut.summary, done });
      if (done) this.fanOuts.delete(id);
    }
    // Launches during the pump changed the world; reflect it.
    await this.refresh();
  }

  /**
   * Drain a non-viable job array and report what happened, as events rather than
   * silently (#52).
   *
   * Terminations are emitted as `action` events with rule `min-viable` — the same
   * event shape a TTL or cost-limit terminate uses, because this is the same kind
   * of thing: an automatic, cost-driven termination the user did not ask for and
   * must be told about. An instance that could NOT be terminated emits a warning:
   * a failed drain is the case where money keeps being spent, so it is the last
   * thing that should be quiet.
   */
  private async enforceArrayViability(array: JobArray): Promise<void> {
    const { terminated, failed } = await array.enforceViability();
    const shortfall = `only ${array.summary.viableCandidates} of ${array.size} members can come up, below --min-viable ${array.summary.minViable}`;
    for (const instanceId of terminated) {
      this.emit({
        type: "action",
        instance: instanceId,
        action: "terminate",
        rule: "min-viable",
        reason: `job array ${array.id} is non-viable: ${shortfall}`,
      });
    }
    for (const instanceId of failed) {
      this.emit({
        type: "warning",
        instance: instanceId,
        rule: "min-viable",
        message: `could not terminate this member of non-viable job array ${array.id} — it may still be billing`,
      });
    }
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

  /**
   * Start a job array: N identical launches from one base input, each stamped
   * with its index via the spawn:job-array-* tags, fanned out under the monitor
   * loop (concurrency cap / launch delay). Returns the built JobArray; progress
   * arrives via "jobarray" events. Same cost-safety guard as launch().
   */
  startJobArray(base: LaunchInput, size: number, opts: JobArrayOptions = {}): JobArray {
    const built = buildJobArray(base, size, { nowMs: this.now(), ...opts });
    const fanOut = new FanOut(this, built.members, {
      maxConcurrent: opts.maxConcurrent,
      launchDelayMs: opts.launchDelayMs,
      minViable: opts.minViable,
    });
    // `this` is passed so the array can enforceViability(): a --min-viable array
    // that can't reach its threshold winds itself down. The array is registered
    // alongside its fan-out so pumpFanOuts() performs that automatically each
    // tick, rather than leaving it to a caller who has to remember.
    const array = new JobArray(built, fanOut, this);
    this.fanOuts.set(built.id, { kind: "jobarray", name: built.name, fanOut, array });
    void this.pumpFanOuts();
    return array;
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

  /**
   * Orphans among the currently-known instances: managed + live + past their
   * TTL deadline by the grace window (spored should have reaped them but didn't
   * — the #19 failure mode). Call refresh() first for fresh data. Pure detection;
   * reaping is a separate, confirmed action (reapOrphans).
   */
  findOrphans(graceMs?: number): Orphan[] {
    return findOrphans(this.lastInstances, this.now(), graceMs);
  }

  /**
   * Terminate the given orphans (or all currently-detected ones). Returns the
   * instance ids terminated. The caller is responsible for confirming first —
   * this always terminates. Emits an "info" event per reap and refreshes.
   */
  async reapOrphans(orphans: Orphan[] = this.findOrphans()): Promise<string[]> {
    const reaped: string[] = [];
    for (const o of orphans) {
      await this.provider.terminate(o.instance.instanceId, "orphan reaper (TTL exceeded)");
      this.emit({
        type: "info",
        instance: o.instance.name,
        message: `reaped orphan ${o.instance.instanceId} (${Math.round(o.overdueByMs / 60_000)}m past TTL)`,
      });
      reaped.push(o.instance.instanceId);
    }
    if (reaped.length) await this.refresh();
    return reaped;
  }

  async get(nameOrId: string): Promise<ManagedInstance | null> {
    return this.provider.get(nameOrId);
  }

  async launch(input: LaunchInput): Promise<ManagedInstance> {
    const spec = this.toSpec(input);
    // Shared with the CLI's `launch` (src/cli/commands.ts), which reaches the
    // provider directly — one definition so the two can't drift apart.
    const verdict = evaluateBounds(spec, this.provider.isReal);
    if (verdict.refuse && !input.allowUnbounded) throw new Error(verdict.refuse);

    // A plugin the launch-time path can't honour is refused BEFORE the launch,
    // not dropped from it. `validateDeclarations` returns rejections so a caller
    // *can* proceed with the accepted subset, and the provider filters to that
    // subset defensively (ec2.ts:162) — but proceeding is the wrong call here:
    // nothing has been billed yet, the fix is a one-word edit, and the
    // alternative is a running instance missing a plugin the caller asked for
    // with only a log line to explain it. Refusing costs a retry; launching
    // costs an instance that can't do the job it was launched for.
    //
    // This diverges from Go, which writes any ref straight into
    // /etc/spawn/plugins.json and lets a push-dependent plugin park at
    // StatusWaitingForPush on the box (pkg/pluginruntime/runtime.go:62). That
    // failure is invisible from the launch side, which is exactly why it's
    // caught here instead.
    if (spec.plugins?.length) {
      const { rejected } = validateDeclarations(spec.plugins);
      if (rejected.length) {
        throw new Error(rejected.map((r) => `plugin "${r.ref}": ${r.reason}`).join("\n"));
      }
    }

    const inst = await this.provider.launch(spec, this.now());
    // Emitted AFTER the launch so it names a real instance, and only for a real
    // provider — a mock launch bills nothing, so the caveat would be noise. A
    // spored-dependent bound is not the same promise as a TTL, and a caller who
    // isn't told assumes it is.
    if (verdict.warn && this.provider.isReal) {
      this.emit({ type: "warning", instance: inst.name, rule: "unbounded", message: verdict.warn });
    }
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

  /**
   * Extend an instance's TTL deadline by a duration. Returns the new deadline (ms).
   *
   * The arithmetic and the safety floor live in `computeExtension` (core/lifecycle.ts),
   * shared with the CLI's `extend` — same reason as the launch guard: two copies of
   * a cost-safety rule drift, and the lenient copy is the one nobody notices.
   *
   * Emits an "info" event when the floor engaged, because the deadline the caller
   * asked for is not the one they got, and an extend that reports plain success
   * after silently clamping is the same class of lie as the unclamped bug.
   */
  async extend(nameOrId: string, by: string | number): Promise<number> {
    const i = await this.resolve(nameOrId);
    // Accept either TTL form: an instance tagged only spawn:ttl (no absolute
    // deadline) still has a deadline under ttlDeadline()'s launch+ttl fallback,
    // and refusing it here would have made `extend` unusable on exactly those.
    if (!ttlDeadline(i)) throw new Error(`${i.name} has no TTL to extend`);
    const ms = typeof by === "number" ? by : parseDuration(by);
    if (ms === null || ms <= 0) throw new Error(`invalid duration: ${by}`);
    const ext = computeExtension(i, ms, this.now());
    await this.provider.setTags(i.instanceId, ext.tags);
    if (ext.clamped) {
      this.emit({
        type: "info",
        instance: i.name,
        message:
          `TTL had already expired, so the extension was applied from now rather than ` +
          `from the old deadline — new deadline ${new Date(ext.deadlineMs).toISOString()}.`,
      });
    }
    // Ask spored to pick the new deadline up now. Only on a real provider (a mock
    // has no box), and only reported — never awaited for success, never fatal.
    if (this.provider.isReal && this.provider.reloadAgent) {
      const r = await this.provider.reloadAgent(i.instanceId);
      this.emit({
        type: "info",
        instance: i.name,
        message: r.ok
          ? `${r.detail} — spored will apply the new deadline shortly.`
          : `could not reload spored (${r.detail}). The new deadline IS saved to the ` +
            `spawn:ttl-deadline tag, but spored re-reads tags only every ~5 minutes, so ` +
            `it may still act on the old one until then. To apply it now: ` +
            `ssh ${i.tags[tag("local-username")] || "ec2-user"}@${
              i.publicIp || "<instance>"
            } 'sudo spored reload'`,
      });
    }
    await this.refresh();
    return ext.deadlineMs;
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
      dnsName: input.dnsName,
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
      jobArray: input.jobArray,
      mpi: input.mpi,
      hooks: input.hooks,
      plugins: input.plugins,
    };
  }
}

/** Convenience re-export so consumers get the whole API from one import. */
export { formatDuration };
