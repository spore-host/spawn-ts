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

  const members: FanOutMember[] = Array.from({ length: size }, (_, index) => {
    // Clone the base per member so per-index mutations don't alias, and drop any
    // sweep membership the base might carry (a launch is one or the other).
    const input: LaunchInput = {
      ...base,
      name: `${name}-${index}`,
      sweep: undefined,
      jobArray: { id, name, index, size },
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

  constructor(
    built: Pick<BuiltJobArray, "id" | "name" | "size">,
    readonly fanOut: FanOut,
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
    });
    return new JobArray(built, fanOut);
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
