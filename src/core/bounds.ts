// The unbounded-launch guard: does this launch have anything that will wind the
// instance down, and is that thing trustworthy?
//
// Pure and provider-agnostic so the two launch paths share ONE definition.
// They previously each carried their own copy of the condition — the CLI's
// `launch` calls `provider.launch` directly rather than going through
// SpawnClient, so its check was not a friendlier restatement of the client's,
// it was an independent second implementation. Two copies of a cost-safety
// predicate drift, and the drift is silent because the lenient copy is the one
// that lets a launch through.
//
// Mirrors the intent of Go's `applyIdleTimeoutDefault` (cmd/zombie_guard.go:20),
// with one deliberate divergence recorded in `evaluateBounds` below.

import type { LaunchSpec } from "./types.js";

/** A configured limit that could end an instance's life. */
export type Bound = "ttl" | "idle-timeout" | "cost-limit";

/**
 * How a bound is enforced — the distinction the old guard was missing.
 *
 * - `external`: enforced from OUTSIDE the instance, so it survives the instance
 *   misbehaving. Only the TTL qualifies: the ttl-reaper Lambda reads
 *   `spawn:ttl-deadline` without the box's cooperation
 *   (`lambda/ttl-reaper/main.go:688` — "the authoritative, launch-anchored
 *   deadline"), and `src/core/types.ts` calls TTL "the hard cost backstop".
 * - `on-instance`: enforced by `spored` polling on the box. Real, but it assumes
 *   spored started and stayed up. If the bootstrap failed, the instance profile
 *   is wrong, or spored crash-loops, nothing enforces it — which is precisely
 *   the #19 orphan failure mode `src/core/orphans.ts` exists to detect.
 */
export type Enforcement = "external" | "on-instance";

export const ENFORCEMENT: Record<Bound, Enforcement> = {
  ttl: "external",
  "idle-timeout": "on-instance",
  "cost-limit": "on-instance",
};

export interface BoundsVerdict {
  /** Every bound configured on the spec. */
  bounds: Bound[];
  /** True when at least one bound is enforced independently of the instance. */
  hasExternalBound: boolean;
  /**
   * Set when the launch must not proceed (no bound at all, on a real provider)
   * unless the caller explicitly opts out. Names the consequence, not just the
   * rule.
   */
  refuse?: string;
  /**
   * Set when the launch may proceed but its only bounds are spored-dependent.
   * A guard that passes must not imply a guarantee it isn't making, so this is
   * surfaced rather than swallowed — the #63 invariant applied to a safety
   * check: silence would read as "bounded", which is the wrong answer.
   */
  warn?: string;
}

/**
 * Classify a launch's cost bounds.
 *
 * `isReal` gates only the refusal: a MockProvider launch bills nothing, so an
 * unbounded one is legitimate (and the demo relies on it). The classification
 * itself is computed either way so tests and UI can show it without a provider.
 *
 * Two fixes to what this used to do (#55):
 *
 * 1. **`idleTimeout` now counts.** It was refused despite being a real bound,
 *    and despite being the one Go itself auto-applies as its default. Go's
 *    trigger is `TTL == "" && IdleTimeout == ""` and doesn't consult the cost
 *    limit at all.
 * 2. **`costLimit` alone no longer passes silently.** It's the *weakest* of the
 *    three and the old guard treated it as fully sufficient. Worse, an instance
 *    with a cost limit and no TTL is invisible to `findOrphans`, which skips
 *    anything whose deadline is 0 (`src/core/orphans.ts:46`) — so the guard was
 *    waving through exactly the launches the orphan detector cannot catch. It
 *    still permits the launch (refusing it would be a new, harsher divergence
 *    from Go) but says what the caller is actually getting.
 *
 * The deliberate divergence from Go, which stays: Go **applies a 1h idle default**
 * and proceeds; spawn-ts **refuses**. Refusing is the better choice in a browser —
 * nothing launches, so nothing bills, and there's no daemon here to fall back on.
 * It should just not be mistaken for the same guard.
 */
export function evaluateBounds(
  spec: Pick<LaunchSpec, "ttlMs" | "idleTimeoutMs" | "costLimit">,
  isReal: boolean,
): BoundsVerdict {
  const bounds: Bound[] = [];
  if (spec.ttlMs > 0) bounds.push("ttl");
  if (spec.idleTimeoutMs > 0) bounds.push("idle-timeout");
  if (spec.costLimit > 0) bounds.push("cost-limit");

  const hasExternalBound = bounds.some((b) => ENFORCEMENT[b] === "external");
  const verdict: BoundsVerdict = { bounds, hasExternalBound };

  if (bounds.length === 0) {
    if (isReal) {
      verdict.refuse =
        "refusing to launch a REAL instance with no ttl, no idleTimeout and no costLimit: " +
        "nothing would ever wind it down and it would bill indefinitely. " +
        "Set ttl (recommended — it is the only bound enforced from outside the instance) " +
        "or idleTimeout, or pass allowUnbounded to accept the cost.";
    }
    return verdict;
  }

  if (!hasExternalBound) {
    const which = bounds.join(" + ");
    verdict.warn =
      `no ttl: ${which} ${bounds.length > 1 ? "are" : "is"} enforced by spored ON the instance, ` +
      "so if spored never starts (failed bootstrap, wrong instance profile, crash-loop) " +
      "nothing stops this instance and it bills until someone notices. It is also invisible " +
      "to orphan detection, which only tracks instances with a TTL deadline. " +
      "Add ttl for a backstop enforced independently of the box.";
  }
  return verdict;
}

/** Go's NestedSpawnRolePrefix (pkg/aws/nested_spawn.go). */
export const NESTED_SPAWN_ROLE_PREFIX = "spawn-instance-nested-";

/** Every nested-spawn refusal's reason (Go ErrNestedSpawnNeedsTTL). */
export const NESTED_SPAWN_NEEDS_TTL = "an instance that can launch other instances must have a hard lifetime";

/**
 * Is `profile` one of the `spawn-instance-nested-*` profiles `spawn launch
 * --nested-spawn` creates? Those roles may call RunInstances and pass roles, so
 * an instance carrying one can start more instances.
 *
 * Accepts a profile name or ARN: spawn-ts takes either (EC2ProviderOptions.
 * iamInstanceProfile), so the ARN's last path segment is checked too. Go's
 * IsNestedSpawnRole checks the string's prefix only, because Go is only ever
 * handed a name; checking the ARN form is the same rule, not a wider one.
 */
export function isNestedSpawnProfile(profile: string | undefined): boolean {
  if (!profile) return false;
  const name = profile.startsWith("arn:") ? profile.slice(profile.lastIndexOf("/") + 1) : profile;
  return name.startsWith(NESTED_SPAWN_ROLE_PREFIX);
}

/**
 * Go's CheckNestedSpawnTTL (#1375): refuse a nested-spawn profile with no TTL,
 * before any AWS call. A TTL specifically, not just any bound: an idle timeout
 * stops rather than terminates by default, and a head node busy dispatching may
 * never be idle. Returns the refusal, or undefined.
 */
export function checkNestedSpawnTtl(source: string, profile: string | undefined, ttlMs: number): string | undefined {
  if (!isNestedSpawnProfile(profile) || ttlMs > 0) return undefined;
  return (
    `${source} "${profile}" is a nested-spawn role (${NESTED_SPAWN_ROLE_PREFIX}*), which, ` +
    `like --nested-spawn, requires --ttl: ${NESTED_SPAWN_NEEDS_TTL}`
  );
}

/**
 * Go's spotrequest.NeedsStoppable: does this lifecycle ask EC2 to stop or
 * hibernate the instance? An idle timeout does (its action is stop, or
 * hibernate; never terminate in spawn-ts), and so does on-complete stop or
 * hibernate.
 */
export function needsStoppable(
  spec: Pick<LaunchSpec, "idleTimeoutMs" | "onComplete">,
): boolean {
  return spec.idleTimeoutMs > 0 || spec.onComplete === "stop" || spec.onComplete === "hibernate";
}

/**
 * Refuse a Spot launch whose lifecycle stops the instance (Go #922/#1330).
 *
 * EC2 cannot stop an instance from a one-time Spot request, and one-time is the
 * only kind spawn-ts makes. spored's stop then fails and is retried with backoff
 * (pkg/agent stopWithBackoff: "a one-time Spot instance cannot be stopped"), so
 * the instance keeps running until its TTL, and with only an idle timeout as its
 * bound, indefinitely. Go's foreground launch makes such a request persistent
 * instead; that needs the request cancelled whenever the instance is terminated,
 * or EC2 launches a replacement, which is why Go's detached sweep refuses these
 * members rather than doing so, and why spawn-ts does the same.
 */
export function checkSpotStoppable(
  spec: Pick<LaunchSpec, "spot" | "idleTimeoutMs" | "onComplete">,
): string | undefined {
  if (!spec.spot || !needsStoppable(spec)) return undefined;
  return (
    "refusing a Spot launch whose lifecycle stops the instance (an idle timeout, or on-complete " +
    "stop/hibernate): spawn-ts makes one-time Spot requests, which EC2 cannot stop, so the stop would " +
    "fail and the instance would keep billing. Give it a ttl and no idle timeout, and on-complete " +
    "terminate if it has one, or launch on-demand"
  );
}
