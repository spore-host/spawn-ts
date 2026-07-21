// The spawn:* tag contract. These are the tags the real Go spawn writes at
// launch (see pkg/provider/ec2.go) and that spored reads to enforce lifecycle.
// spawn-ts writes the identical set so an instance it launches is managed
// correctly by a real spored, and shows up in `spawn list` from the Go CLI.

import type {
  LaunchSpec,
  ManagedInstance,
  SweepMembership,
  JobArrayMembership,
  LifecycleHooks,
} from "./types.js";
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
    // Only emit hibernate-on-idle when true (matches the Go tool; the default
    // idle action is stop, so an absent tag = stop). decodeConfigTags reads
    // `=== "true"`, so omitting it is equivalent to the old "false".
    if (spec.hibernateOnIdle) tags[tag("hibernate-on-idle")] = "true";
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
  if (spec.hooks) Object.assign(tags, buildHookTags(spec.hooks));
  if (spec.sweep) Object.assign(tags, buildSweepTags(spec.sweep));
  if (spec.jobArray) Object.assign(tags, buildJobArrayTags(spec.jobArray));
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

/**
 * Build the spawn:job-array-* tags for one array member. Wire-identical to the
 * Go tool (pkg/aws/tags.go): id/name/size/index. (Go also stamps a
 * spawn:job-array-created timestamp; omitted here so tags stay deterministic —
 * launch-time is already recorded in spawn:launch-time.)
 */
export function buildJobArrayTags(m: JobArrayMembership): Record<string, string> {
  return {
    [tag("job-array-id")]: m.id,
    [tag("job-array-name")]: m.name,
    [tag("job-array-size")]: String(m.size),
    [tag("job-array-index")]: String(m.index),
  };
}

/**
 * Decode a job-array membership from an instance's tags, or undefined if the
 * instance carries no spawn:job-array-id. Mirrors the job-array branch of the Go
 * describe path (pkg/aws/client.go). Malformed numeric tags fall back to 0.
 */
export function decodeJobArrayTags(tags: Record<string, string>): JobArrayMembership | undefined {
  const id = tags[tag("job-array-id")];
  if (!id) return undefined;
  const int = (v: string | undefined): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    id,
    name: tags[tag("job-array-name")] ?? "",
    index: int(tags[tag("job-array-index")]),
    size: int(tags[tag("job-array-size")]),
  };
}

/**
 * Build the spawn:* tags for daemon-enforced lifecycle hooks. Each field emits
 * its tag only when set; durations serialize to Go duration strings. These are
 * written verbatim to the shape the Go tool uses (pkg/aws/tags.go) so a real
 * spored on the instance runs them — spawn-ts never executes them itself.
 */
export function buildHookTags(h: LifecycleHooks): Record<string, string> {
  const tags: Record<string, string> = {};
  if (h.preStop) {
    tags[tag("pre-stop")] = h.preStop;
    if (h.preStopTimeoutMs && h.preStopTimeoutMs > 0)
      tags[tag("pre-stop-timeout")] = formatDuration(h.preStopTimeoutMs);
  }
  if (h.spotWebhookUrl) {
    tags[tag("spot-webhook-url")] = h.spotWebhookUrl;
    // Correlation + timeout are companions, meaningful only with a URL.
    if (h.webhookCorrelation) tags[tag("webhook-correlation")] = h.webhookCorrelation;
    if (h.webhookTimeoutMs && h.webhookTimeoutMs > 0)
      tags[tag("webhook-timeout")] = formatDuration(h.webhookTimeoutMs);
  }
  if (h.notifyUrl) tags[tag("notify-url")] = h.notifyUrl;
  if (h.notifyPlatform) tags[tag("notify-platform")] = h.notifyPlatform;
  if (h.notifyCommand) tags[tag("notify-command")] = h.notifyCommand;
  if (h.activeProcesses) tags[tag("active-processes")] = h.activeProcesses;
  return tags;
}

/**
 * Decode lifecycle-hook tags back into a LifecycleHooks, or undefined if none
 * are present. Inverse of buildHookTags; used by `status` and round-trip tests.
 */
export function decodeHookTags(tags: Record<string, string>): LifecycleHooks | undefined {
  const h: LifecycleHooks = {};
  const dur = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const d = parseDuration(v);
    return d === null ? undefined : d;
  };
  if (tags[tag("pre-stop")]) h.preStop = tags[tag("pre-stop")];
  const pst = dur(tags[tag("pre-stop-timeout")]);
  if (pst !== undefined) h.preStopTimeoutMs = pst;
  if (tags[tag("spot-webhook-url")]) h.spotWebhookUrl = tags[tag("spot-webhook-url")];
  if (tags[tag("webhook-correlation")]) h.webhookCorrelation = tags[tag("webhook-correlation")];
  const wt = dur(tags[tag("webhook-timeout")]);
  if (wt !== undefined) h.webhookTimeoutMs = wt;
  if (tags[tag("notify-url")]) h.notifyUrl = tags[tag("notify-url")];
  if (tags[tag("notify-platform")]) h.notifyPlatform = tags[tag("notify-platform")];
  if (tags[tag("notify-command")]) h.notifyCommand = tags[tag("notify-command")];
  if (tags[tag("active-processes")]) h.activeProcesses = tags[tag("active-processes")];
  return Object.keys(h).length > 0 ? h : undefined;
}
