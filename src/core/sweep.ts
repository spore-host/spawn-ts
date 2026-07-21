// Parameter sweeps — `spawn sweep` for the browser. Expands a parameter spec
// into N members and fans them out over a SpawnClient via the shared FanOut
// engine, tagging each instance with the spawn:sweep-* / spawn:param:* contract
// so the whole sweep is discoverable and wire-compatible with the Go tool.
//
// This is the port of pkg/sweep + cmd/sweep.go's local (non-Lambda) path. The
// browser has no filesystem, DynamoDB, or Lambda, so the detached/orchestrated
// path is out of scope — the fan-out runs in-page over the same client the GUI
// and terminal already drive. Building members (spec → launches) is pure and
// testable; running them is delegated to FanOut.

import type { SpawnClient, LaunchInput } from "./client.js";
import { FanOut, type FanOutMember } from "./fanout.js";
import { resolveMembers, type ParamSpec, type ParamSet, type ParamValue } from "./params.js";

/** Options for building/launching a sweep. */
export interface SweepOptions {
  /** Sweep name; also the launched instances' name prefix. Default "sweep". */
  name?: string;
  /**
   * Explicit sweep id. Normally generated from `nowMs`; pass this to make a
   * sweep's ids fully deterministic (tests) or to resume a known id.
   */
  id?: string;
  /** Time (ms epoch) used to stamp a generated sweep id. Required if `id` unset. */
  nowMs?: number;
  /** Max instances running at once (0 = all at once). Passed to FanOut. */
  maxConcurrent?: number;
  /** Min ms between launches. Passed to FanOut. */
  launchDelayMs?: number;
}

/** A built sweep: its identity, the resolved members, and their launch inputs. */
export interface BuiltSweep {
  id: string;
  name: string;
  size: number;
  members: FanOutMember[];
}

// Keys that map onto a LaunchInput field rather than becoming an opaque sweep
// parameter. Mirrors the switch in cmd/sweep.go's buildLaunchConfigFromParams;
// only the fields spawn-ts's LaunchInput models are consumed here. Everything
// else (the sweep's actual variables — alpha, beta, learning_rate, …) falls
// through to `parameters` and rides along as spawn:param:* tags.
const KNOWN_KEYS = new Set([
  "name",
  "instance_type",
  "region",
  "ami",
  "key_pair",
  "key_name",
  "spot",
  "ttl",
  "idle_timeout",
  "hibernate_on_idle",
  "idle_cpu",
  "cost_limit",
  "price_per_hour",
  "on_complete",
  "completion_file",
  "completion_delay",
]);

const str = (v: ParamValue): string => (typeof v === "string" ? v : String(v));
const bool = (v: ParamValue): boolean => v === true || v === "true";
const num = (v: ParamValue): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Turn one resolved parameter map into a LaunchInput plus the opaque parameter
 * subset (unknown keys). Known keys map onto LaunchInput fields; unknown keys
 * become spawn:param:* values. Matches the Go field mapping so a spec written
 * for `spawn sweep` behaves the same here.
 */
function mapMember(
  values: ParamSet,
  fallbackName: string,
): { input: LaunchInput; parameters: Record<string, string> } {
  const input: LaunchInput = { name: fallbackName };
  const parameters: Record<string, string> = {};

  for (const [key, val] of Object.entries(values)) {
    if (!KNOWN_KEYS.has(key)) {
      parameters[key] = str(val);
      continue;
    }
    switch (key) {
      case "name": input.name = str(val); break;
      case "instance_type": input.instanceType = str(val); break;
      case "region": input.region = str(val); break;
      case "ami": input.ami = str(val); break;
      case "key_pair":
      case "key_name": input.keyPair = str(val); break;
      case "spot": input.spot = bool(val); break;
      case "ttl": input.ttl = str(val); break;
      case "idle_timeout": input.idleTimeout = str(val); break;
      case "hibernate_on_idle": input.hibernateOnIdle = bool(val); break;
      case "idle_cpu": input.idleCpuPercent = num(val); break;
      case "cost_limit": input.costLimit = num(val); break;
      case "price_per_hour": input.pricePerHour = num(val); break;
      case "on_complete": input.onComplete = str(val) as LaunchInput["onComplete"]; break;
      case "completion_file": input.completionFile = str(val); break;
      case "completion_delay": input.completionDelay = str(val); break;
    }
  }
  return { input, parameters };
}

/**
 * Generate a sweep id in the Go tool's shape: <name>-<YYYYMMDD>-<6 digits>.
 * The digits derive from `nowMs` (not a RNG) so a given (name, time) is
 * reproducible — matching this project's determinism convention.
 */
export function generateSweepId(name: string, nowMs: number): string {
  const d = new Date(nowMs);
  const date =
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}` +
    `${String(d.getUTCDate()).padStart(2, "0")}`;
  const suffix = String(Math.abs(nowMs) % 1_000_000).padStart(6, "0");
  return `${name}-${date}-${suffix}`;
}

/**
 * Build (but do not launch) a sweep from a parameter spec: resolve members,
 * assign sweep ids/indexes, and attach the sweep membership to each LaunchInput
 * so launching stamps the spawn:sweep-* / spawn:param:* tags. Pure and testable.
 */
export function buildSweep(spec: ParamSpec | string, opts: SweepOptions = {}): BuiltSweep {
  const name = opts.name?.trim() || "sweep";
  const id = opts.id ?? generateSweepId(name, opts.nowMs ?? 0);
  const resolved = resolveMembers(spec);
  const size = resolved.length;

  const members: FanOutMember[] = resolved.map(({ index, values }) => {
    const { input, parameters } = mapMember(values, `${name}-${index}`);
    input.sweep = { id, name, index, size, parameters };
    return { key: `${id}#${index}`, input };
  });

  return { id, name, size, members };
}

/**
 * A running parameter sweep: a thin wrapper binding sweep identity to a FanOut
 * so consumers get id/name/size alongside live fan-out progress. It holds the
 * *same* FanOut instance being driven (never a copy), so `summary` always
 * reflects current state. Driving it (pump on each tick) is the consumer's job
 * unless it was started via SpawnClient.startSweep, which pumps it for you.
 */
export class Sweep {
  readonly id: string;
  readonly name: string;
  readonly size: number;

  constructor(
    built: Pick<BuiltSweep, "id" | "name" | "size">,
    readonly fanOut: FanOut,
  ) {
    this.id = built.id;
    this.name = built.name;
    this.size = built.size;
  }

  /** Build from a spec and wire up a fresh FanOut over the given client. */
  static create(client: SpawnClient, spec: ParamSpec | string, opts: SweepOptions = {}): Sweep {
    const built = buildSweep(spec, opts);
    const fanOut = new FanOut(client, built.members, {
      maxConcurrent: opts.maxConcurrent,
      launchDelayMs: opts.launchDelayMs,
    });
    return new Sweep(built, fanOut);
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
