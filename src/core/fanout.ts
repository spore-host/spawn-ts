// FanOut — the reusable engine that launches many instances over a SpawnClient
// while respecting a concurrency cap, an inter-launch delay, inter-member
// dependencies, and per-member launch retries. It is the shared substrate for
// two features:
//
//   - parameter sweeps  (core/sweep.ts, issue #4) — a flat grid of members
//   - batch job queues   (core/queue.ts, issue #5) — a DAG of members that
//     launch as their dependencies complete and capacity/turn allows
//
// The rolling-queue behaviour is a faithful port of launchWithRollingQueue in
// the Go tool (cmd/launch_sweep.go): launch an initial batch up to the cap, then
// launch the next eligible member each time a slot frees (a running instance
// self-terminates via the lifecycle monitor). Dependency gating + retry mirror
// pkg/queue (dependency.go / retry.go). Members are independent unless linked by
// a dependency — one member's failure never crashes the engine; the on-failure
// policy decides whether it stops launching the rest.
//
// The engine is pure orchestration: it owns no timers and no clock. `pump(now)`
// advances it one step given the current time; something external drives it —
// in the GUI, the SpawnClient monitor's refresh; in tests, a manual loop
// interleaved with client.step(). This keeps it deterministic and testable.

import type { SpawnClient, LaunchInput } from "./client.js";

/** One unit of work in a fan-out: a stable key plus the launch to perform. */
export interface FanOutMember {
  /** Stable identifier for tracking/display + dependency references. */
  key: string;
  input: LaunchInput;
  /**
   * Keys of members that must reach "completed" before this one is eligible to
   * launch. A dependency that fails (or is skipped) skips this member too — the
   * cascade a batch queue needs. Undefined/empty = launch as soon as capacity
   * allows. (Sweeps never set this.)
   */
  dependsOn?: string[];
  /** Max launch attempts (>= 1). Default 1 (no retry). */
  maxAttempts?: number;
}

/**
 * A member's lifecycle within the fan-out (distinct from the EC2 instance
 * state):
 *   pending   — eligible now (deps satisfied), awaiting a free slot
 *   blocked   — waiting on an unfinished dependency
 *   launching — launch in flight
 *   running   — instance is live
 *   completed — instance is no longer live (terminated/stopped/hibernated)
 *   failed    — launch threw and retries are exhausted
 *   skipped   — never launched (a dependency failed, or the on-failure policy
 *               stopped the queue after an earlier failure)
 */
export type FanOutMemberState =
  | "pending"
  | "blocked"
  | "launching"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface FanOutMemberStatus {
  key: string;
  index: number;
  state: FanOutMemberState;
  /** The instance id once launched (absent while pending/blocked/failed/skipped). */
  instanceId?: string;
  /** Launch attempts made so far. */
  attempts: number;
  /** Failure message when state === "failed". */
  error?: string;
}

/** What to do after a member's terminal failure. */
export type OnFailure = "continue" | "stop";

export interface FanOutOptions {
  /** Max instances running at once. 0 (default) launches everything at once. */
  maxConcurrent?: number;
  /**
   * Minimum wall/sim time between launches (ms). Enforced across pump() calls:
   * at most one member launches per pump while the delay has not elapsed, so
   * launches spread over successive monitor ticks. 0 (default) = no throttle.
   */
  launchDelayMs?: number;
  /**
   * Minimum time (ms) before a failed member is re-launched. 0 (default) retries
   * on the next pump. Coarsely models pkg/queue's retry backoff.
   */
  retryDelayMs?: number;
  /**
   * On a member's terminal failure: keep launching independent members
   * ("continue", default) or stop launching any not-yet-started member ("stop").
   * Dependents of a failed member are always skipped regardless.
   */
  onFailure?: OnFailure;
  /** Called after every pump that changes state, with a fresh status snapshot. */
  onProgress?: (statuses: FanOutMemberStatus[]) => void;
}

/** Aggregate counts across a fan-out, for dashboards and status commands. */
export interface FanOutSummary {
  total: number;
  /** Not yet started but still could run (pending + blocked + launching). */
  pending: number;
  /** Waiting on an unfinished dependency. */
  blocked: number;
  running: number;
  completed: number;
  failed: number;
  /** Never launched (a dependency failed, or the queue was stopped). */
  skipped: number;
  members: FanOutMemberStatus[];
}

const NOT_STARTED: ReadonlySet<FanOutMemberState> = new Set(["pending", "blocked"]);
const TERMINAL: ReadonlySet<FanOutMemberState> = new Set(["completed", "failed", "skipped"]);

export class FanOut {
  private statuses: FanOutMemberStatus[];
  private byKey: Map<string, FanOutMemberStatus>;
  private lastAttemptMs = new Map<string, number>();
  private lastLaunchMs = -Infinity;
  private pumping = false;
  private readonly maxConcurrent: number;
  private readonly launchDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly onFailure: OnFailure;
  private readonly onProgress?: (statuses: FanOutMemberStatus[]) => void;

  constructor(
    private client: SpawnClient,
    private members: FanOutMember[],
    opts: FanOutOptions = {},
  ) {
    this.maxConcurrent = Math.max(0, opts.maxConcurrent ?? 0);
    this.launchDelayMs = Math.max(0, opts.launchDelayMs ?? 0);
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? 0);
    this.onFailure = opts.onFailure ?? "continue";
    this.onProgress = opts.onProgress;
    this.statuses = members.map((m, index) => ({
      key: m.key,
      index,
      state: "pending" as FanOutMemberState,
      attempts: 0,
    }));
    this.byKey = new Map(this.statuses.map((s) => [s.key, s]));
  }

  /** Current per-member status (a copy — safe for the caller to keep/render). */
  get status(): FanOutMemberStatus[] {
    return this.statuses.map((s) => ({ ...s }));
  }

  /** Aggregate counts + members, for dashboards and `queue`/`sweep status`. */
  get summary(): FanOutSummary {
    const s = this.statuses;
    const count = (st: FanOutMemberState) => s.filter((m) => m.state === st).length;
    return {
      total: s.length,
      pending: count("pending") + count("blocked") + count("launching"),
      blocked: count("blocked"),
      running: count("running"),
      completed: count("completed"),
      failed: count("failed"),
      skipped: count("skipped"),
      members: this.status,
    };
  }

  /** True once every member has reached a terminal state (completed/failed/skipped). */
  get isComplete(): boolean {
    return this.statuses.every((s) => TERMINAL.has(s.state));
  }

  /** True while some member has yet to start (pending or blocked). */
  get hasPending(): boolean {
    return this.statuses.some((s) => NOT_STARTED.has(s.state));
  }

  /**
   * Advance the fan-out one step at time `nowMs`: reconcile launched members
   * against the client's current instance list, recompute dependency gating,
   * then launch as many eligible members as the concurrency cap and the launch/
   * retry delays permit. Reentrancy-guarded (launching refreshes the client,
   * which re-fires the event that drives this). Returns true when nothing is
   * left to start.
   */
  async pump(nowMs: number): Promise<boolean> {
    if (this.pumping) return !this.hasPending;
    this.pumping = true;
    let changed = false;
    try {
      const live = new Map(this.client.list().map((i) => [i.instanceId, i]));

      // 1. Reconcile launched members: running → completed when no longer live.
      let active = 0;
      for (const s of this.statuses) {
        if (s.state !== "running") continue;
        const inst = s.instanceId ? live.get(s.instanceId) : undefined;
        if (inst && (inst.state === "running" || inst.state === "pending")) {
          active++;
        } else {
          s.state = "completed";
          changed = true;
        }
      }

      // 2. Recompute gating for not-yet-started members (skip cascades + the
      //    stop policy propagate to a fixpoint — they don't consume capacity).
      changed = this.applyGating() || changed;

      // 3. Launch eligible (pending) members up to the concurrency cap.
      const cap = this.maxConcurrent > 0 ? this.maxConcurrent : this.members.length;
      for (let i = 0; i < this.statuses.length && active < cap; i++) {
        const s = this.statuses[i];
        if (s.state !== "pending") continue;
        // Global launch-delay throttle: one launch per pump until it elapses.
        if (this.launchDelayMs > 0 && nowMs - this.lastLaunchMs < this.launchDelayMs) break;
        // Per-member retry backoff after a failed attempt.
        const last = this.lastAttemptMs.get(s.key);
        if (last !== undefined && this.retryDelayMs > 0 && nowMs - last < this.retryDelayMs) {
          continue;
        }

        s.state = "launching";
        s.attempts++;
        changed = true;
        try {
          const inst = await this.client.launch(this.members[i].input);
          s.state = "running";
          s.instanceId = inst.instanceId;
          active++;
        } catch (e) {
          const max = Math.max(1, this.members[i].maxAttempts ?? 1);
          if (s.attempts < max) {
            s.state = "pending"; // eligible again after retryDelayMs
          } else {
            s.state = "failed";
            s.error = (e as Error).message;
            // A terminal failure can skip dependents (and, under "stop",
            // everything not yet started) — re-gate before launching further so
            // the effect lands in this same pump.
            this.applyGating();
          }
        }
        this.lastAttemptMs.set(s.key, nowMs);
        this.lastLaunchMs = nowMs;
      }
    } finally {
      this.pumping = false;
    }
    if (changed) this.onProgress?.(this.status);
    return !this.hasPending;
  }

  /**
   * Recompute the state of every not-yet-started member from its dependencies
   * and the on-failure policy, iterating to a fixpoint so a skip cascades all
   * the way down a chain within a single pump. Returns whether anything changed.
   */
  private applyGating(): boolean {
    let changed = false;
    for (;;) {
      const stopAll = this.onFailure === "stop" && this.statuses.some((s) => s.state === "failed");
      let dirty = false;
      for (let i = 0; i < this.statuses.length; i++) {
        const s = this.statuses[i];
        if (!NOT_STARTED.has(s.state)) continue;
        const next = this.gate(this.members[i].dependsOn ?? [], stopAll);
        if (s.state !== next) {
          s.state = next;
          dirty = true;
          changed = true;
        }
      }
      if (!dirty) break;
    }
    return changed;
  }

  /** Decide a not-yet-started member's state from its dependencies + stop flag. */
  private gate(deps: string[], stopAll: boolean): FanOutMemberState {
    for (const dep of deps) {
      const d = this.byKey.get(dep);
      if (d && (d.state === "failed" || d.state === "skipped")) return "skipped";
    }
    if (stopAll) return "skipped";
    for (const dep of deps) {
      const d = this.byKey.get(dep);
      if (!d || d.state !== "completed") return "blocked";
    }
    return "pending";
  }
}
