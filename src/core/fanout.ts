// FanOut — the reusable engine that launches many instances over a SpawnClient
// while respecting a concurrency cap and an inter-launch delay, tracking each
// member's status. It is the shared substrate for two features:
//
//   - parameter sweeps  (core/sweep.ts, issue #4) — a static grid of members
//   - batch job queues   (issue #5) — members launched as capacity/turn allows
//
// The rolling-queue behaviour is a faithful port of launchWithRollingQueue in
// the Go tool (cmd/launch_sweep.go): launch an initial batch up to the cap, then
// launch the next pending member each time a slot frees (a running instance
// self-terminates via the lifecycle monitor). Members are independent — one
// member's launch failure is recorded but never aborts the others.
//
// The engine is pure orchestration: it owns no timers and no clock. `pump(now)`
// advances it one step given the current time; something external drives it —
// in the GUI, the SpawnClient monitor's refresh event; in tests, a manual loop
// interleaved with client.step(). This keeps it deterministic and testable.

import type { SpawnClient, LaunchInput } from "./client.js";

/** One unit of work in a fan-out: a stable key plus the launch to perform. */
export interface FanOutMember {
  /** Stable identifier for tracking/display (e.g. a sweep index or job id). */
  key: string;
  input: LaunchInput;
}

/**
 * A member's lifecycle within the fan-out (distinct from the EC2 instance
 * state): pending → launching → running → completed, or failed if the launch
 * threw. "completed" means the member's instance is no longer live (terminated
 * by TTL/completion, or stopped/hibernated).
 */
export type FanOutMemberState =
  | "pending"
  | "launching"
  | "running"
  | "completed"
  | "failed";

export interface FanOutMemberStatus {
  key: string;
  index: number;
  state: FanOutMemberState;
  /** The instance id once launched (absent while pending/launching/failed). */
  instanceId?: string;
  /** Failure message when state === "failed". */
  error?: string;
}

export interface FanOutOptions {
  /** Max instances running at once. 0 (default) launches everything at once. */
  maxConcurrent?: number;
  /**
   * Minimum wall/sim time between launches (ms). Enforced across pump() calls:
   * at most one member launches per pump while the delay has not elapsed, so
   * launches spread over successive monitor ticks. 0 (default) = no throttle.
   */
  launchDelayMs?: number;
  /** Called after every pump that changes state, with a fresh status snapshot. */
  onProgress?: (statuses: FanOutMemberStatus[]) => void;
}

/** Aggregate counts across a fan-out, for dashboards and status commands. */
export interface FanOutSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  members: FanOutMemberStatus[];
}

export class FanOut {
  private statuses: FanOutMemberStatus[];
  private nextIndex = 0;
  private lastLaunchMs = -Infinity;
  private pumping = false;
  private readonly maxConcurrent: number;
  private readonly launchDelayMs: number;
  private readonly onProgress?: (statuses: FanOutMemberStatus[]) => void;

  constructor(
    private client: SpawnClient,
    private members: FanOutMember[],
    opts: FanOutOptions = {},
  ) {
    this.maxConcurrent = Math.max(0, opts.maxConcurrent ?? 0);
    this.launchDelayMs = Math.max(0, opts.launchDelayMs ?? 0);
    this.onProgress = opts.onProgress;
    this.statuses = members.map((m, index) => ({
      key: m.key,
      index,
      state: "pending" as FanOutMemberState,
    }));
  }

  /** Current per-member status (a copy — safe for the caller to keep/render). */
  get status(): FanOutMemberStatus[] {
    return this.statuses.map((s) => ({ ...s }));
  }

  /** Aggregate counts + members, for dashboards and `sweep status`. */
  get summary(): FanOutSummary {
    const s = this.statuses;
    return {
      total: s.length,
      pending: s.filter((m) => m.state === "pending" || m.state === "launching").length,
      running: s.filter((m) => m.state === "running").length,
      completed: s.filter((m) => m.state === "completed").length,
      failed: s.filter((m) => m.state === "failed").length,
      members: this.status,
    };
  }

  /** True once every member has reached a terminal state (completed/failed). */
  get isComplete(): boolean {
    return this.statuses.every((s) => s.state === "completed" || s.state === "failed");
  }

  /** True while there are members not yet launched. */
  get hasPending(): boolean {
    return this.nextIndex < this.members.length;
  }

  /**
   * Advance the fan-out one step at time `nowMs`: reconcile the states of
   * already-launched members against the client's current instance list, then
   * launch as many pending members as the concurrency cap and launch-delay gate
   * permit. Reentrancy-guarded (launching refreshes the client, which re-fires
   * the event that drives this). Returns true when nothing is left pending.
   */
  async pump(nowMs: number): Promise<boolean> {
    if (this.pumping) return !this.hasPending;
    this.pumping = true;
    let changed = false;
    try {
      const live = new Map(this.client.list().map((i) => [i.instanceId, i]));
      let active = 0;
      for (const s of this.statuses) {
        if (s.instanceId === undefined) continue;
        const inst = live.get(s.instanceId);
        const nextState: FanOutMemberState =
          inst && (inst.state === "running" || inst.state === "pending")
            ? "running"
            : "completed";
        if (s.state !== nextState) {
          s.state = nextState;
          changed = true;
        }
        if (nextState === "running") active++;
      }

      const cap = this.maxConcurrent > 0 ? this.maxConcurrent : this.members.length;
      while (this.nextIndex < this.members.length && active < cap) {
        // Throttle: at most one launch until the delay has elapsed. `nowMs` is
        // fixed for this pump, so a non-zero delay yields one launch per pump.
        if (this.launchDelayMs > 0 && nowMs - this.lastLaunchMs < this.launchDelayMs) break;

        const idx = this.nextIndex++;
        const member = this.members[idx];
        this.statuses[idx].state = "launching";
        changed = true;
        try {
          const inst = await this.client.launch(member.input);
          this.statuses[idx].state = "running";
          this.statuses[idx].instanceId = inst.instanceId;
          active++;
        } catch (e) {
          this.statuses[idx].state = "failed";
          this.statuses[idx].error = (e as Error).message;
        }
        this.lastLaunchMs = nowMs;
      }
    } finally {
      this.pumping = false;
    }
    if (changed) this.onProgress?.(this.status);
    return !this.hasPending;
  }
}
