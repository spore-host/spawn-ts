// Tag-derived status notices — a port of the four blocks Go's `spawn status`
// appends after its remote `spored status` output (cmd/status.go:130-134).
//
// The remote half isn't portable (see docs/integration.md), but these are: every
// input is a tag `DescribeInstances` already returned, so they work in a browser
// with no transport at all. Three of the four are pure and live here; the Elastic
// IP notice needs `DescribeAddresses` and lives in src/aws/eip.ts.
//
// Why they matter more than their size suggests: each one surfaces a condition the
// user cannot otherwise see. spored writes a record when DNS registration fails
// precisely so the failure isn't buried in the instance's journal — and dropping
// the reader makes a failure indistinguishable from success, which is the #63
// invariant these notices exist to uphold.
//
// Returns structured notices rather than pre-formatted strings, so the CLI, the
// dashboard and the portal render one source three ways.

import type { ManagedInstance } from "./types.js";
import { ttlDeadline } from "./lifecycle.js";
import { tag } from "./tags.js";
import { formatDuration, humanRemaining } from "./duration.js";

export type NoticeLevel = "info" | "warn";

export interface Notice {
  /** Stable identifier, so a UI can style/suppress a specific notice. */
  kind: "dns" | "lifecycle-protection" | "spored-upgrade" | "elastic-ip";
  level: NoticeLevel;
  /** One-line summary. */
  text: string;
  /**
   * Extra lines: the protection block's body, or the exact command a user should
   * run. Kept separate from `text` so a compact UI can show the summary alone.
   */
  detail?: string[];
}

/**
 * DNS registration outcome (Go `dnsStatusNotice`, status.go:241).
 *
 * spored writes `spawn:dns-status` = "registered" | "failed", plus
 * `spawn:dns-error` on failure (agent.go:921), for one stated reason: a
 * Function-URL auth rejection or any other failure would otherwise leave the FQDN
 * silently unresolvable with no user-facing signal (#435).
 *
 * spawn-ts already tells a user what FQDN *will* exist (src/dns/dns-name.ts). It
 * had no way to say registration **failed**, so a portal user got a hostname that
 * never resolves and no explanation — while the diagnostic sat in a tag the
 * browser had already fetched.
 *
 * Absent tag returns null (older spored, or DNS not configured) — deliberately
 * distinct from "failed". An unset tag means we don't know, and claiming failure
 * would be as wrong as claiming success.
 */
export function dnsNotice(inst: ManagedInstance): Notice | null {
  const status = inst.tags[tag("dns-status")];
  if (!status) return null;
  if (status === "registered") return null;
  // A recorded failure with no detail is still a failure worth reporting; say
  // that the detail is missing rather than omitting the notice.
  const detail = inst.tags[tag("dns-error")] || "no detail reported";
  return {
    kind: "dns",
    level: "warn",
    text: `DNS registration failed — the instance name may not resolve: ${detail}`,
  };
}

/**
 * Safety posture, hard deadline, and worst-case compute cost (Go
 * `lifecycleProtectionBlock`, status.go:149).
 *
 * spawn-ts's `status` already prints cost **so far**; this prints the maximum the
 * instance can cost before its deadline. Those answer different questions, and
 * the ceiling is the one that tells a user whether to worry.
 *
 * Two honesty constraints carried over verbatim from the Go original:
 *
 *  - The out-of-band reaper runs in the infra account and is **not**
 *    authoritatively visible from the launch account, so it's described as a
 *    backstop "if deployed" rather than asserting an enforcement we can't confirm
 *    from here.
 *  - The cost figure keeps its "compute only" label: it excludes EBS and network,
 *    so presenting it as a total would understate the bill.
 */
export function lifecycleProtection(inst: ManagedInstance, nowMs: number): Notice | null {
  // Only meaningful for a managed instance that is actually running.
  if (inst.tags[tag("managed")] !== "true") return null;
  if (inst.state !== "running" && inst.state !== "pending") return null;

  const detail = [
    "in-instance (spored):  enforces TTL + idle rules on the instance itself",
    "out-of-band reaper:    backstop in the spore.host-infra account, if deployed for your account",
  ];

  const deadline = ttlDeadline(inst);
  if (deadline > 0) {
    const remaining = deadline - nowMs;
    detail.push(
      remaining > 0
        ? `termination deadline:  ${new Date(deadline).toISOString()} (in ${humanRemaining(remaining)})`
        : // Past due reads as a state, not as a negative duration (#54's overdue
          // case has to be legible).
          `termination deadline:  ${new Date(deadline).toISOString()} (past due — terminates on next check)`,
    );
    // Worst-case = rate × launch→deadline. Best-effort: skipped when we can't
    // price the instance, rather than shown as $0.00 — a confident zero would be
    // worse than no line at all.
    if (inst.pricePerHour > 0 && inst.launchTimeMs > 0) {
      const maxHours = (deadline - inst.launchTimeMs) / 3600_000;
      if (maxHours > 0) {
        detail.push(
          `max compute cost:      ~$${(inst.pricePerHour * maxHours).toFixed(2)} by deadline ` +
            `(on-demand rate, compute only; idle-stop usually ends it sooner)`,
        );
      }
    }
  } else if (inst.ttlMs > 0) {
    detail.push(`ttl:                   ${formatDuration(inst.ttlMs)} (hard lifetime)`);
  }

  if (inst.idleTimeoutMs > 0) {
    detail.push(
      `idle timeout:          ${formatDuration(inst.idleTimeoutMs)} ` +
        `(${inst.hibernateOnIdle ? "hibernates" : "stops"} the instance when idle; never terminates)`,
    );
  }

  return { kind: "lifecycle-protection", level: "info", text: "lifecycle protection:", detail };
}

/**
 * Compare two semver strings. Returns >0 when `a` is newer than `b`.
 *
 * A direct port of libs/update `compareSemver` + `parseSemver`: three numeric
 * components, missing components are 0, a `-suffix` pre-release marker on any
 * component is stripped before parsing. Kept identical so spawn-ts and the Go
 * tool never disagree about whether an upgrade is available.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): [number, number, number] => {
    const parts = v.replace(/^v/, "").split(".", 3);
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < parts.length && i < 3; i++) {
      // "1-rc1" → 1, matching Go's SplitN(parts[i], "-", 2)[0].
      const n = parseInt(parts[i].split("-", 1)[0], 10);
      out[i] = Number.isNaN(n) ? 0 : n;
    }
    return out;
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

/**
 * spored upgrade available (Go `sporedUpgradeNotice`, status.go:305).
 *
 * Only the tag half is ported. Go falls back to parsing the version out of live
 * `spored status` output when the tag is absent; without that transport there is
 * no fallback, so an absent `spawn:spored-version` returns null.
 *
 * `latestVersion` is passed in rather than fetched. Go hits the GitHub releases
 * API (libs/update `fetchLatestRelease`); this stays pure so it's testable with no
 * network, and the caller decides whether a release lookup is worth a request.
 * Comparison uses the same `compareSemver` as the Go side.
 */
export function sporedUpgrade(inst: ManagedInstance, latestVersion: string): Notice | null {
  const running = inst.tags[tag("spored-version")];
  if (!running || !latestVersion) return null;
  if (compareSemver(latestVersion, running) <= 0) return null;
  return {
    kind: "spored-upgrade",
    level: "info",
    text: `spored upgrade available: v${running} → v${latestVersion}`,
    // spawn-ts can't perform the upgrade (it needs a shell on the box), so it
    // names the Go command instead of implying a capability it lacks.
    detail: [`run from a terminal:  spawn upgrade-spored ${inst.instanceId}`],
  };
}

/** An Elastic IP association, as `DescribeAddresses` reports it. */
export interface AttachedEip {
  publicIp: string;
  allocationId: string;
}

/**
 * Outcome of an Elastic IP lookup. Three states, not two — `eip: null` with no
 * `error` means "checked, none attached", while `error` means "could not check".
 *
 * This is a deliberate divergence from Go's `GetInstanceElasticIP`
 * (pkg/aws/cleanup.go:219), which returns `nil, nil` on any API error and so
 * makes a missing `ec2:DescribeAddresses` permission look exactly like a clean
 * bill of health. The whole point of this notice is to stop an EIP billing
 * unnoticed; silently swallowing the one call that detects it defeats it.
 */
export interface ElasticIpLookup {
  eip: AttachedEip | null;
  /** Set when the lookup itself failed. Distinct from "no EIP attached". */
  error?: string;
}

/**
 * Elastic IP billing notice (Go `elasticIPNotice`, status.go:222).
 *
 * The case that matters is a **stopped** instance: stopping it pauses compute
 * billing, so a user reasonably believes the instance now costs nothing — but an
 * associated EIP with no running instance is charged (~$3.60/mo) precisely
 * *because* nothing is using it. spawn never releases EIPs (they may be pinned in
 * DNS or an allowlist), so the notice names the release command instead.
 *
 * Pure: takes the lookup result rather than performing it, so it's testable with
 * no credentials. The lookup lives in src/aws/eip.ts.
 */
export function elasticIpNotice(
  inst: ManagedInstance,
  lookup: ElasticIpLookup,
): Notice | null {
  if (lookup.error) {
    // A failed check is reported, not dropped — see ElasticIpLookup.
    return {
      kind: "elastic-ip",
      level: "warn",
      text: `could not check for an attached Elastic IP (${lookup.error}) — if one is attached it may still be billing`,
      detail: ["check manually:  aws ec2 describe-addresses --filters Name=instance-id,Values=" + inst.instanceId],
    };
  }
  const eip = lookup.eip;
  if (!eip) return null;
  if (inst.state === "running" || inst.state === "pending") {
    return {
      kind: "elastic-ip",
      level: "info",
      text: `Elastic IP ${eip.publicIp} (${eip.allocationId}) is attached — free while the instance runs`,
    };
  }
  return {
    kind: "elastic-ip",
    level: "warn",
    text:
      `Elastic IP ${eip.publicIp} (${eip.allocationId}) is attached to this ${inst.state} ` +
      `instance and keeps billing (~$3.60/mo)`,
    detail: [
      "spawn never releases EIPs — release it yourself if unneeded:",
      `  aws ec2 release-address --allocation-id ${eip.allocationId}`,
    ],
  };
}

/**
 * All the pure, tag-derived notices for an instance, in Go's print order
 * (protection → dns → elastic ip → spored upgrade).
 *
 * Both extras are optional and behave the same way when omitted: the notice is
 * skipped rather than guessed at. `eip` needs a `DescribeAddresses` call the
 * caller may not want to make; `latestSporedVersion` needs a release lookup.
 */
export function statusNotices(
  inst: ManagedInstance,
  nowMs: number,
  opts: { eip?: ElasticIpLookup; latestSporedVersion?: string } = {},
): Notice[] {
  return [
    lifecycleProtection(inst, nowMs),
    dnsNotice(inst),
    opts.eip ? elasticIpNotice(inst, opts.eip) : null,
    opts.latestSporedVersion ? sporedUpgrade(inst, opts.latestSporedVersion) : null,
  ].filter((n): n is Notice => n !== null);
}
