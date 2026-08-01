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
  /**
   * Minimum members that must come up for the fan-out to be worth running at all
   * (#52) — the port of Go's `--min-viable` (`cmd/launch_jobarray.go:572` →
   * `cohort.NewPartialCohort`). Clamped to `[1, members.length]` exactly as Go
   * clamps it, so an out-of-range value is corrected rather than rejected.
   *
   * This is a threshold on the **whole set**, which is what makes it different
   * from `onFailure` in the way that matters. `onFailure` is a *per-member*
   * policy: it decides whether to keep launching, and "stop" leaves already-
   * launched members running. So an array that comes up 2-of-100 is, under
   * `onFailure` alone, a mostly-failed array with two billable instances alive.
   * `minViable` asks the different question — "is this set still worth having?"
   * — and when the answer is no, `nonViable` goes true and the survivors are
   * identified for wind-down (`survivorIds`). Cost-safety, not a nicety.
   *
   * Undefined (default) = 1, i.e. any single member makes the set viable, which
   * is Go's `NewIndependentCohort` behaviour and the pre-#52 status quo.
   *
   * The engine reports non-viability; it does NOT terminate anything itself.
   * FanOut owns no lifecycle authority — every other state change here is a
   * launch, and a fan-out that silently terminated instances would be a surprise
   * to the sweep and queue callers that share it. `JobArray.enforceViability()`
   * is where the wind-down is performed.
   */
  minViable?: number;
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
  /** The effective `--min-viable` threshold, clamped to [1, total] (#52). */
  minViable: number;
  /**
   * Members that could still contribute to viability: running, plus everything
   * not yet terminally failed/skipped. Compared against `minViable` to decide
   * `nonViable` — see the comment on `nonViable` for why it counts hopefuls
   * rather than only what is up right now.
   */
  viableCandidates: number;
  /**
   * True when the set can no longer reach `minViable` — too many members have
   * terminally failed or been skipped for the threshold to be met even if every
   * remaining one succeeds (#52).
   *
   * This is deliberately a statement about the *unreachable*, not about the
   * *not-yet-reached*. Counting only currently-running members would report a
   * healthy 100-member array as non-viable during its first pump, when 0 are up
   * and 100 are still pending — and the caller's response to non-viability is to
   * terminate, so a premature true is not a cosmetic error. `false` here means
   * "not yet ruled out", never "confirmed viable".
   */
  nonViable: boolean;
  /**
   * Indexes in `[0, total)` with no live member — the sparse-index gap a
   * `--min-viable` partial launch leaves behind (Go: `missingIndexes`,
   * `cmd/arraygroup.go:99`). Ports Go's rule that a *terminated* member's index
   * counts as missing too, not just one that never launched
   * (`retryIndexes`, `:224`): both are indexes with no live worker, and a
   * consumer relaunching or collecting results has to treat them alike.
   *
   * Reporting the threshold without this would trade one wrong answer for
   * another — "97 of 100 running" hides *which* three slices of the workload
   * have no worker, and for indexed work that's the only part that matters.
   */
  missingIndexes: number[];
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
  /** Effective --min-viable, clamped to [1, members.length] as Go clamps it. */
  readonly minViable: number;
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
    // Clamp exactly as Go does (cmd/launch_jobarray.go:576-582): below 1 → 1,
    // above the member count → the member count. Go clamps rather than erroring
    // because `--min-viable 200` on a 100-member array is an obvious "all of
    // them", and cohort.NewPartialCohort would otherwise reject the whole launch
    // over an off-by-one. A non-finite/NaN value (`Number("x")`) also lands on 1,
    // which is the no-op default rather than a silently disabled threshold.
    const mv = Math.floor(opts.minViable ?? 1);
    this.minViable = Number.isFinite(mv) ? Math.min(Math.max(mv, 1), members.length || 1) : 1;
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
    // A member still counts toward viability unless it has terminally failed or
    // been skipped. "completed" counts: it came up and did its work, so it
    // contributed — treating a finished member as a lost one would make a
    // successful array turn non-viable as it drains, and the caller's response to
    // non-viability is to terminate the survivors.
    const viableCandidates = this.viableCandidates;
    return {
      total: s.length,
      pending: count("pending") + count("blocked") + count("launching"),
      blocked: count("blocked"),
      running: count("running"),
      completed: count("completed"),
      failed: count("failed"),
      skipped: count("skipped"),
      minViable: this.minViable,
      viableCandidates,
      nonViable: viableCandidates < this.minViable,
      missingIndexes: this.missingIndexes,
      members: this.status,
    };
  }

  /**
   * Members that can still contribute to viability: everything not terminally
   * failed or skipped.
   *
   * "completed" counts. It came up and did its work, so it contributed —
   * treating a finished member as a lost one would make a *successful* array
   * turn non-viable as it drains, and the caller's response to non-viability is
   * to terminate the survivors. A draining array must not read as a failing one.
   */
  private get viableCandidates(): number {
    let lost = 0;
    for (const s of this.statuses) {
      if (s.state === "failed" || s.state === "skipped") lost++;
    }
    return this.statuses.length - lost;
  }

  /**
   * The `nonViable` predicate, shared by `summary` and `applyGating` so the
   * gate and the report can never disagree about whether the set is doomed.
   *
   * Note the deliberate feedback loop with gating: once this goes true, gating
   * skips the unstarted members, which raises the lost count, which keeps it
   * true. That is monotone — a set cannot become viable again once ruled out —
   * so `applyGating`'s fixpoint loop still terminates, and "doomed" is
   * correctly a latch rather than something that can flicker back off.
   */
  private isNonViable(): boolean {
    return this.viableCandidates < this.minViable;
  }

  /**
   * Instance ids still running, for a caller winding down a non-viable set
   * (`JobArray.enforceViability()`). Kept here because FanOut owns the member
   * records, but deliberately NOT acted on here: FanOut owns no lifecycle
   * authority — every other state change it makes is a launch, and a shared
   * engine that silently terminated instances would surprise the sweep and
   * queue callers.
   */
  get survivorIds(): string[] {
    return this.statuses
      .filter((s) => s.state === "running" && s.instanceId)
      .map((s) => s.instanceId as string);
  }

  /**
   * Indexes with no live member. Ports Go's `missingIndexes` + `retryIndexes`
   * (`cmd/arraygroup.go:99`, `:224`), whose shared rule is that an index is
   * missing when it has no member in an *active* state — Go's `active` map is
   * built from exactly `"running"` and `"pending"` EC2 states.
   *
   * So: `running`/`launching` are present; failed, skipped, completed and
   * not-yet-launched are all missing. Two of those need a decision rather than a
   * straight port, because Go reads live AWS state while FanOut keeps a record:
   *
   * - **completed** is missing. `retryIndexes` relaunches an index whose members
   *   are "all in a non-active terminal state (terminated/stopped)", which is
   *   what completed means here.
   * - **pending** is missing, because the question this answers is "which slices
   *   of the workload have no worker", and a pending slice has none *yet*. That
   *   makes every index missing on the first pump, which is truthful rather than
   *   alarming — read it next to `pending`/`running`, not alone. The alternative
   *   (calling a pending index present) would report full coverage for an array
   *   that hasn't launched anything, and this field exists to stop exactly that
   *   kind of optimistic reading.
   */
  private get missingIndexes(): number[] {
    const active = new Set<number>();
    for (const s of this.statuses) {
      if (s.state === "running" || s.state === "launching") active.add(s.index);
    }
    const out: number[] = [];
    for (let i = 0; i < this.statuses.length; i++) if (!active.has(i)) out.push(i);
    return out;
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
      // Two independent reasons to skip everything not yet started:
      //
      //   onFailure: "stop" — the caller's per-member policy.
      //   nonViable        — the set can no longer reach minViable (#52).
      //
      // The second ports cohort's fastFailCancel (cohort/reconcile.go:243),
      // which cancels the remaining entities the instant the gate becomes
      // unsatisfiable rather than letting them run to completion. Without it, a
      // 100-member array with --min-viable 50 that loses 51 members would go on
      // launching the other 49 — billing for instances the caller is about to
      // terminate, in a set already known to be unusable.
      const stopAll =
        (this.onFailure === "stop" && this.statuses.some((s) => s.state === "failed")) ||
        this.isNonViable();
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
