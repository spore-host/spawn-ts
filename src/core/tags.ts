// The spawn:* tag contract. These are the tags the real Go spawn writes at
// launch (see pkg/provider/ec2.go) and that spored reads to enforce lifecycle.
// spawn-ts writes the identical set so an instance it launches is managed
// correctly by a real spored, and shows up in `spawn list` from the Go CLI.

import type { LaunchSpec, ManagedInstance, SweepMembership } from "./types.js";
import { formatDuration, parseDuration } from "./duration.js";

/** Tag prefix. The real tool makes this configurable via SPORED_TAG_PREFIX. */
export const TAG_PREFIX = "spawn";

export function tag(key: string): string {
  return `${TAG_PREFIX}:${key}`;
}

/**
 * Prefix for per-member parameter tags: spawn:param:<key>=<value>. Mirrors the
 * Go tool (pkg/aws/tags.go), which caps parameter tags to stay under the AWS
 * 50-tag limit; buildSweepTags applies the same cap.
 */
export const PARAM_TAG_PREFIX = tag("param:");

/** Max spawn:param:* tags written per instance — matches the Go tool's guard. */
const MAX_PARAM_TAGS = 35;

/** RFC3339 (what Go's time.Format(time.RFC3339) produces; JS toISOString is compatible). */
function rfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

function parseRfc3339(v: string): number {
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Build the full spawn:* tag map for a launch. launchTimeMs is passed in (not
 * read from a clock) so callers control it and results stay testable.
 */
export function buildLaunchTags(spec: LaunchSpec, launchTimeMs: number): Record<string, string> {
  const tags: Record<string, string> = {
    Name: spec.name,
    [tag("managed")]: "true",
    [tag("launch-time")]: rfc3339(launchTimeMs),
    [tag("compute-seconds")]: "0",
  };

  if (spec.ttlMs > 0) {
    tags[tag("ttl")] = formatDuration(spec.ttlMs);
    // Absolute deadline anchored to launch — never recomputed on stop/wake.
    tags[tag("ttl-deadline")] = rfc3339(launchTimeMs + spec.ttlMs);
  }
  if (spec.idleTimeoutMs > 0) {
    tags[tag("idle-timeout")] = formatDuration(spec.idleTimeoutMs);
    tags[tag("hibernate-on-idle")] = spec.hibernateOnIdle ? "true" : "false";
    if (spec.idleCpuPercent > 0) tags[tag("idle-cpu")] = String(spec.idleCpuPercent);
  }
  if (spec.costLimit > 0) tags[tag("cost-limit")] = String(spec.costLimit);
  if (spec.pricePerHour > 0) tags[tag("price-per-hour")] = String(spec.pricePerHour);
  if (spec.onComplete) {
    tags[tag("on-complete")] = spec.onComplete;
    if (spec.completionFile) tags[tag("completion-file")] = spec.completionFile;
    if (spec.completionDelayMs > 0)
      tags[tag("completion-delay")] = formatDuration(spec.completionDelayMs);
  }
  if (spec.sessionTimeoutMs > 0) {
    tags[tag("session-timeout")] = formatDuration(spec.sessionTimeoutMs);
  }
  if (spec.sweep) Object.assign(tags, buildSweepTags(spec.sweep));
  return tags;
}

/**
 * Build the spawn:sweep-* + spawn:param:* tags for one sweep member. Emitted
 * only for sweep launches; wire-identical to the Go tool (pkg/aws/tags.go),
 * including the 35-parameter cap that keeps a member under AWS's 50-tag limit.
 * Parameter keys are emitted in sorted order so the (capped) subset is stable.
 */
export function buildSweepTags(m: SweepMembership): Record<string, string> {
  const tags: Record<string, string> = {
    [tag("sweep-id")]: m.id,
    [tag("sweep-name")]: m.name,
    [tag("sweep-size")]: String(m.size),
    [tag("sweep-index")]: String(m.index),
  };
  let count = 0;
  for (const key of Object.keys(m.parameters).sort()) {
    if (count >= MAX_PARAM_TAGS) break;
    tags[PARAM_TAG_PREFIX + key] = m.parameters[key];
    count++;
  }
  return tags;
}

/** Is this a spawn-managed instance? (spawn:managed=true) */
export function isManaged(tags: Record<string, string>): boolean {
  return tags[tag("managed")] === "true";
}

/**
 * Decode the lifecycle-relevant config from an instance's tag map into the
 * fields of ManagedInstance. Mirrors the switch in pkg/provider/ec2.go —
 * malformed values are ignored (left at their defaults), never fatal.
 */
export function decodeConfigTags(
  tags: Record<string, string>,
): Pick<
  ManagedInstance,
  | "launchTimeMs"
  | "ttlDeadlineMs"
  | "ttlMs"
  | "idleTimeoutMs"
  | "hibernateOnIdle"
  | "idleCpuPercent"
  | "costLimit"
  | "pricePerHour"
  | "onComplete"
  | "completionFile"
  | "completionDelayMs"
  | "computeSeconds"
> {
  const num = (v: string | undefined, dflt: number): number => {
    if (v === undefined) return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const dur = (v: string | undefined, dflt: number): number => {
    if (v === undefined) return dflt;
    const d = parseDuration(v);
    return d === null ? dflt : d;
  };

  return {
    launchTimeMs: tags[tag("launch-time")] ? parseRfc3339(tags[tag("launch-time")]) : 0,
    ttlDeadlineMs: tags[tag("ttl-deadline")] ? parseRfc3339(tags[tag("ttl-deadline")]) : 0,
    ttlMs: dur(tags[tag("ttl")], 0),
    idleTimeoutMs: dur(tags[tag("idle-timeout")], 0),
    hibernateOnIdle: tags[tag("hibernate-on-idle")] === "true",
    idleCpuPercent: num(tags[tag("idle-cpu")], 0),
    costLimit: num(tags[tag("cost-limit")], 0),
    pricePerHour: num(tags[tag("price-per-hour")], 0),
    onComplete: (tags[tag("on-complete")] as ManagedInstance["onComplete"]) ?? "",
    completionFile: tags[tag("completion-file")] ?? "",
    completionDelayMs: dur(tags[tag("completion-delay")], 0),
    computeSeconds: num(tags[tag("compute-seconds")], 0),
  };
}

/**
 * Decode a sweep membership from an instance's tags, or undefined if the
 * instance carries no spawn:sweep-id (i.e. it's not part of a sweep). Mirrors
 * the sweep/param branch of the Go describe path (pkg/aws/client.go). Malformed
 * numeric tags fall back to 0 rather than being fatal.
 */
export function decodeSweepTags(tags: Record<string, string>): SweepMembership | undefined {
  const id = tags[tag("sweep-id")];
  if (!id) return undefined;

  const int = (v: string | undefined): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const parameters: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (k.startsWith(PARAM_TAG_PREFIX)) parameters[k.slice(PARAM_TAG_PREFIX.length)] = v;
  }

  return {
    id,
    name: tags[tag("sweep-name")] ?? "",
    index: int(tags[tag("sweep-index")]),
    size: int(tags[tag("sweep-size")]),
    parameters,
  };
}
