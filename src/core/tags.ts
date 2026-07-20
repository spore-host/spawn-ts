// The spawn:* tag contract. These are the tags the real Go spawn writes at
// launch (see pkg/provider/ec2.go) and that spored reads to enforce lifecycle.
// spawn-ts writes the identical set so an instance it launches is managed
// correctly by a real spored, and shows up in `spawn list` from the Go CLI.

import type { LaunchSpec, ManagedInstance } from "./types.js";
import { formatDuration, parseDuration } from "./duration.js";

/** Tag prefix. The real tool makes this configurable via SPORED_TAG_PREFIX. */
export const TAG_PREFIX = "spawn";

export function tag(key: string): string {
  return `${TAG_PREFIX}:${key}`;
}

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
