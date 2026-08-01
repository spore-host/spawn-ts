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
import { encodeAccountId } from "../dns/dns-name.js";

/**
 * Value written to spawn:version. Read by Go's pkg/aws/ami_mgmt.go:170.
 *
 * Hand-maintained: a browser library can't read package.json at runtime, and
 * importing src/index.ts here would be circular (index re-exports this module).
 * tags.test.ts asserts it matches package.json so a release can't leave it stale
 * — the same guard the three sibling -ts repos carry on their VERSION constants,
 * two of which caught a real miss.
 */
export const LIB_VERSION = "0.6.1";

/** Tag prefix. The real tool makes this configurable via SPORED_TAG_PREFIX. */
export const TAG_PREFIX = "spawn";

export function tag(key: string): string {
  return `${TAG_PREFIX}:${key}`;
}

/**
 * Convert a name into a single RFC-1035 DNS label safe for the FQDN segment
 * {label}.{base36(account)}.spore.host, or "" if it can't. Port of the Go tool's
 * slugifyDNSLabel (pkg/aws/tags.go): lowercase; keep [a-z0-9]; collapse any run
 * of other chars to a single hyphen; no leading/trailing hyphen; ≤63 chars.
 */
export function slugifyDnsLabel(name: string): string {
  let out = "";
  let lastHyphen = false;
  for (const ch of name.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      lastHyphen = false;
    } else if (!lastHyphen && out.length > 0) {
      out += "-";
      lastHyphen = true;
    }
  }
  out = out.replace(/^-+|-+$/g, "");
  if (out.length > 63) out = out.slice(0, 63).replace(/-+$/g, "");
  return out;
}

/**
 * Prefix for per-member parameter tags: spawn:param:<key>=<value>.
 */
export const PARAM_TAG_PREFIX = tag("param:");

/** AWS's hard per-resource tag limit. Exceeding it fails RunInstances outright. */
export const AWS_TAG_LIMIT = 50;

/**
 * Max spawn:param:* tags on a sweep member, as a *budget* rather than a constant.
 *
 * Go uses a fixed 35 "to stay under AWS 50-tag limit" (pkg/aws/tags.go:247), and
 * that arithmetic doesn't hold: the sweep block itself is 4 tags and a fully
 * configured launch carries ~30 more, so 35 params puts a maximal sweep member at
 * ~73 tags and RunInstances rejects the launch. spawn-ts inherited the same
 * comment and the same bug. Rather than swap in a smaller guessed number, cap
 * against what's actually left, so the budget stays correct as tags are added.
 *
 * Dropping parameters is itself lossy — spawn:param:* tags are how a sweep member
 * records which point in the parameter space it *is* — but a truncated tag set
 * beats a launch that fails outright, and the keys are emitted in sorted order so
 * the surviving subset is at least deterministic.
 */
function paramTagBudget(alreadyUsed: number): number {
  return Math.max(0, AWS_TAG_LIMIT - alreadyUsed);
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
 * Who launched an instance, and into which account — Go's "base identity"
 * (pkg/aws/tags.go:32, "Section 1: base identity (always present)").
 *
 * Passed in as data rather than resolved here so buildLaunchTags stays pure. The
 * caller (EC2Provider) resolves it once per provider via GetCallerIdentity.
 */
export interface LaunchIdentity {
  /** AWS account id, 12 decimal digits → spawn:account-id + base36 subdomain. */
  accountId: string;
  /** Caller's IAM/role ARN → spawn:iam-user. Load-bearing: see buildIdentityTags. */
  userArn: string;
  /** Optional account alias; slugified into spawn:account-name (#121). */
  accountName?: string;
}

/**
 * The always-present base-identity tags. Split out from buildLaunchTags so the
 * launch, sweep and job-array paths can share one definition.
 *
 * **spawn:iam-user is the load-bearing one.** Three portal paths filter on it:
 * the instance list (lambda/dashboard-api/instances.go:60), single-instance
 * lookup (:168), and terminate (:285, which 403s on a mismatch). `spawn list`
 * filters on spawn:managed alone, so an instance missing this tag appears in the
 * CLI yet is invisible *and unterminatable* through the portal — the divergence
 * only surfaces when someone tries to clean up. `spawn cleanup --only-mine`
 * skips it too (pkg/aws/cleanup.go:93).
 *
 * created-by is deliberately "spawn-ts", not Go's "spawn": no reader compares the
 * value for equality, and an operator benefits from knowing which launcher
 * produced an instance.
 */
export function buildIdentityTags(id: LaunchIdentity): Record<string, string> {
  const tags: Record<string, string> = {
    [tag("managed")]: "true",
    [tag("root")]: "true",
    [tag("created-by")]: "spawn-ts",
    [tag("version")]: LIB_VERSION,
    [tag("account-id")]: id.accountId,
    [tag("account-base36")]: encodeAccountId(id.accountId),
    [tag("iam-user")]: id.userArn,
  };
  // Only when it slugifies to a usable DNS label — an alias like "!!!" yields ""
  // and an empty tag value is worse than an absent one.
  if (id.accountName) {
    const slug = slugifyDnsLabel(id.accountName);
    if (slug) tags[tag("account-name")] = slug;
  }
  return tags;
}

/**
 * Build the full spawn:* tag map for a launch. launchTimeMs is passed in (not
 * read from a clock) so callers control it and results stay testable.
 *
 * `identity` is optional only so the MockProvider and existing tests can launch
 * without an AWS call. On the real path EC2Provider always supplies it, and
 * refuses to launch if it can't — omitting spawn:iam-user silently produces an
 * instance the portal can neither see nor terminate.
 */
export function buildLaunchTags(
  spec: LaunchSpec,
  launchTimeMs: number,
  identity?: LaunchIdentity,
): Record<string, string> {
  const tags: Record<string, string> = {
    Name: spec.name,
    [tag("managed")]: "true",
    ...(identity ? buildIdentityTags(identity) : {}),
    [tag("launch-time")]: rfc3339(launchTimeMs),
    [tag("compute-seconds")]: "0",
    // Explicit rather than absent: Go's `connect` branches on
    // `tags["spawn:os"] == "windows"` (cmd/connect.go:120) and treats absent and
    // "linux" alike today, but wire-compatibility means stating it — and spawn-ts
    // launches Linux only (no Windows support anywhere in src/).
    [tag("os")]: "linux",
  };
  // Go's `connect` prefers spawn:local-username, falling back to ec2-user "for
  // instances launched before that tag existed" (cmd/connect.go:135). userdata
  // already creates this user, so the value was known and simply unrecorded —
  // meaning a non-default username sent `spawn connect` to the wrong account.
  if (spec.localUsername) tags[tag("local-username")] = spec.localUsername;

  // DNS name: spored registers {dns-name}.{base36(account)}.spore.host only when
  // spawn:dns-name is present (agent.go gates on a non-empty config.DNSName). The
  // Go launcher defaults --dns to the required --name, so it always sets this; we
  // mirror that — default to the (slugified) launch name unless overridden. An
  // empty slug (e.g. a name with no DNS-safe chars) omits the tag, disabling DNS.
  const dnsLabel = slugifyDnsLabel(spec.dnsName ?? spec.name);
  if (dnsLabel) tags[tag("dns-name")] = dnsLabel;

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
  if (spec.jobArray) Object.assign(tags, buildJobArrayTags(spec.jobArray));
  // Sweep last, so its parameter tags can be capped against what the rest of the
  // launch actually consumed. The caller adds spawn:local-username too, so leave
  // one slot for it.
  if (spec.sweep) {
    Object.assign(tags, buildSweepTags(spec.sweep, Object.keys(tags).length + 1));
  }
  return tags;
}

/**
 * Build the spawn:sweep-* + spawn:param:* tags for one sweep member. Emitted only
 * for sweep launches. Parameter keys are emitted in sorted order so the (capped)
 * subset is deterministic rather than dependent on object insertion order.
 *
 * `tagsAlreadyUsed` is how many tags the rest of the launch has consumed, so the
 * parameter cap can be a real budget against AWS_TAG_LIMIT. Called directly (not
 * via buildLaunchTags) it defaults to just this block, which is the standalone
 * behaviour tests expect.
 */
export function buildSweepTags(
  m: SweepMembership,
  tagsAlreadyUsed = 0,
): Record<string, string> {
  const tags: Record<string, string> = {
    [tag("sweep-id")]: m.id,
    [tag("sweep-name")]: m.name,
    [tag("sweep-size")]: String(m.size),
    [tag("sweep-index")]: String(m.index),
  };
  const budget = paramTagBudget(tagsAlreadyUsed + Object.keys(tags).length);
  let count = 0;
  for (const key of Object.keys(m.parameters).sort()) {
    if (count >= budget) break;
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
  if (h.activePorts) tags[tag("active-ports")] = h.activePorts;
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
  if (tags[tag("active-ports")]) h.activePorts = tags[tag("active-ports")];
  return Object.keys(h).length > 0 ? h : undefined;
}
