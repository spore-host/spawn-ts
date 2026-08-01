// Job arrays — `spawn`'s indexed fan-out for the browser. N identical launches
// from one base config, differing only by index, tagged with the spawn:job-
// array-* contract so the array is discoverable and wire-compatible with the Go
// tool. A peer of parameter sweeps (core/sweep.ts) and the batch queue
// (core/queue.ts), built on the same shared FanOut engine.
//
// Unlike a sweep (which varies parameters per member), a job-array member is
// identical to its siblings except for its index — the instance's spored
// surfaces it as JOB_ARRAY_INDEX so the workload knows which slice it is.
//
// This is the port of cmd/launch_jobarray.go's launch path. Out of scope
// (needs node/SSH or a persisted record, not browser-feasible): `logs`,
// `collect`, and `retry --failed` — noted as follow-ups.

import type { SpawnClient, LaunchInput } from "./client.js";
import { FanOut, type FanOutMember } from "./fanout.js";

/** Options for building/launching a job array. */
export interface JobArrayOptions {
  /** Array name; also the launched instances' name prefix. Default "array". */
  name?: string;
  /** Explicit array id; normally generated from `nowMs`. */
  id?: string;
  /** Time (ms epoch) used to stamp a generated id. */
  nowMs?: number;
  /** Max instances running at once (0 = all at once). Passed to FanOut. */
  maxConcurrent?: number;
  /** Min ms between launches. Passed to FanOut. */
  launchDelayMs?: number;
  /**
   * Minimum members that must come up for the array to be worth running (#52) —
   * Go's `--min-viable`. Clamped to `[1, size]`. Default 1 (any member makes the
   * array viable), matching Go's plain-array default.
   *
   * When the array can no longer reach this threshold, `enforceViability()`
   * terminates the survivors: a 100-member array that came up 2-of-100 is not a
   * 2% success, it's two instances billing for a job that cannot be done.
   */
  minViable?: number;
  /**
   * Emitted when MPI mode is on: writes `spawn:mpi-enabled` (and
   * `spawn:mpi-processes-per-node` when > 0) so a spawn-ts-launched array is
   * *recognisable* as MPI by the Go CLI and the portal (#52, tier C).
   *
   * This is the tag half only, and that boundary is deliberate. spawn-ts does not
   * orchestrate the collective launch: Go's own `pkg/mpicohort` is a self-declared
   * spike whose unresolved problem is that cohort's `Placement` is per-entity
   * while a placement group and EFA fabric are collective constraints. Porting a
   * spike would commit spawn-ts to a shape Go is still deciding. See
   * docs/execution-shapes.md.
   */
  mpi?: MpiOptions;
}

/**
 * MPI declaration for an array. Carries only what maps to a tag — the collective
 * knobs Go validates alongside these (EFA validation, placement groups) are out
 * of reach from a browser and documented as such rather than half-ported.
 */
export interface MpiOptions {
  /** Stamp `spawn:mpi-enabled=true` on every member. */
  enabled: boolean;
  /**
   * Ranks per node → `spawn:mpi-processes-per-node`. Omitted from the tags when
   * absent or <= 0, exactly as Go omits it (`cmd/launch_single.go:706`).
   */
  processesPerNode?: number;
}

/** A built job array: identity, size, and the per-index launch inputs. */
export interface BuiltJobArray {
  id: string;
  name: string;
  size: number;
  members: FanOutMember[];
}

/** Generate a job-array id in the Go shape: <name>-<YYYYMMDD>-<6 hex>. Derived
 * from `nowMs` (not a RNG) so a given (name, time) is reproducible. */
export function generateJobArrayId(name: string, nowMs: number): string {
  const d = new Date(nowMs);
  const date =
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(d.getUTCDate()).padStart(2, "0")}`;
  const suffix = (Math.abs(nowMs) % 0xffffff).toString(16).padStart(6, "0");
  return `${name}-${date}-${suffix}`;
}

/**
 * Build (but do not launch) a job array of `size` members from one base
 * LaunchInput. Each member gets a per-index name and the job-array membership so
 * launching stamps the spawn:job-array-* tags. `size` must be >= 1. Pure/testable.
 */
export function buildJobArray(
  base: LaunchInput,
  size: number,
  opts: JobArrayOptions = {},
): BuiltJobArray {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`job array size must be a positive integer, got ${size}`);
  }
  const name = opts.name?.trim() || base.name?.trim() || "array";
  const id = opts.id ?? generateJobArrayId(name, opts.nowMs ?? 0);

  // MPI is stamped on every member (Go sets it on the shared baseConfig before
  // the array fans out, cmd/launch_single.go:704), so a reader can identify any
  // single instance as part of an MPI job without first resolving its array.
  const mpi = opts.mpi?.enabled
    ? {
        enabled: true,
        ...(opts.mpi.processesPerNode !== undefined
          ? { processesPerNode: opts.mpi.processesPerNode }
          : {}),
      }
    : undefined;

  const members: FanOutMember[] = Array.from({ length: size }, (_, index) => {
    // Clone the base per member so per-index mutations don't alias, and drop any
    // sweep membership the base might carry (a launch is one or the other).
    const input: LaunchInput = {
      ...base,
      name: `${name}-${index}`,
      sweep: undefined,
      jobArray: { id, name, index, size },
      // An explicit --mpi wins over whatever the base carried; otherwise the
      // base's own declaration is preserved.
      mpi: mpi ?? base.mpi,
    };
    return { key: `${id}#${index}`, input };
  });

  return { id, name, size, members };
}

/**
 * A running job array: binds array identity to a FanOut so consumers get
 * id/name/size alongside live fan-out progress. Driving it (pump each tick) is
 * the consumer's job unless it was started via SpawnClient.startJobArray.
 */
export class JobArray {
  readonly id: string;
  readonly name: string;
  readonly size: number;

  /** Instance ids `enforceViability()` has already terminated (see its doc). */
  private readonly drained = new Set<string>();

  constructor(
    built: Pick<BuiltJobArray, "id" | "name" | "size">,
    readonly fanOut: FanOut,
    /** Needed only by enforceViability(); optional so existing callers still work. */
    private readonly client?: SpawnClient,
  ) {
    this.id = built.id;
    this.name = built.name;
    this.size = built.size;
  }

  /** Build from a base input + size and wire up a fresh FanOut over the client. */
  static create(
    client: SpawnClient,
    base: LaunchInput,
    size: number,
    opts: JobArrayOptions = {},
  ): JobArray {
    const built = buildJobArray(base, size, opts);
    const fanOut = new FanOut(client, built.members, {
      maxConcurrent: opts.maxConcurrent,
      launchDelayMs: opts.launchDelayMs,
      minViable: opts.minViable,
    });
    return new JobArray(built, fanOut, client);
  }

  /**
   * Wind down a non-viable array: when fewer members can come up than
   * `--min-viable` requires, terminate the survivors and return their instance
   * ids (empty when the array is still viable, or when nothing is left running).
   *
   * This is the half of Go's partial-cohort contract that costs money if it's
   * missing. `cohort.Reconciler` drains on a failed viability gate for a stated
   * reason — "Drain surviving instances so nothing idles and bills"
   * (`cohort/reconcile.go:298`) — and without it a 100-member array that came up
   * 2-of-100 leaves two instances running a job that cannot be done.
   *
   * Safe to call on every pump, which is what the monitor loop does. A member
   * stays `running` in the fan-out's record until the next `pump()` reconciles it
   * against the instance list, so within a single tick this can be reached twice
   * for the same instance — and two pumps can also be *in flight at once*, since
   * `startJobArray` kicks one without awaiting it. `drained` claims each id before
   * the terminate call so neither case reports it twice. That matters not because
   * re-terminating would break anything (it's a no-op on both providers) but
   * because the *caller* acts on the return value: a duplicated id reads as two
   * instances wound down, and the monitor loop turns each one into a user-visible
   * `terminate` event. Mutating the member's state from here would fix it too, but
   * would make this method a second writer of the fan-out's records.
   *
   * A failed terminate releases the claim. An instance that is still billing has
   * to stay retryable, or a transient throttle would strand it.
   *
   * It lives here rather than in `FanOut`
   * because FanOut owns no lifecycle authority — every other state change it
   * makes is a launch, and a shared engine that silently terminated instances
   * would surprise the sweep and queue callers.
   *
   * A termination that throws does not stop the rest: the goal is to stop the
   * billing, so one unreachable instance must not leave the others running. The
   * ids of instances that could not be terminated are reported in `failed` rather
   * than swallowed — a caller that believes the array was wound down when it
   * wasn't is exactly the wrong outcome to hide.
   */
  async enforceViability(): Promise<{ terminated: string[]; failed: string[] }> {
    const terminated: string[] = [];
    const failed: string[] = [];
    if (!this.client || !this.fanOut.summary.nonViable) return { terminated, failed };
    const reason = `job array ${this.id} is non-viable (needs ${this.fanOut.minViable} of ${this.size})`;
    for (const instanceId of this.fanOut.survivorIds) {
      if (this.drained.has(instanceId)) continue;
      // Claimed *before* the await, not after. Two pumps can overlap (startJobArray
      // kicks one without awaiting it, and the first monitor tick starts another),
      // and a mark-on-success would let both pass this check while the first
      // terminate is still in flight — which is exactly the duplicate this set is
      // here to prevent. Released again on failure, so a throttled instance stays
      // retryable.
      this.drained.add(instanceId);
      try {
        await this.client.terminate(instanceId, reason);
        terminated.push(instanceId);
      } catch {
        this.drained.delete(instanceId);
        failed.push(instanceId);
      }
    }
    return { terminated, failed };
  }

  pump(nowMs: number): Promise<boolean> {
    return this.fanOut.pump(nowMs);
  }

  get summary() {
    return this.fanOut.summary;
  }
  get isComplete(): boolean {
    return this.fanOut.isComplete;
  }
}
