// Orphan / zombie detection — the lifecycle safety-net. An orphan is a spawn-
// managed instance that is still live (running/pending) well past the deadline
// at which spored should have wound it down. That's exactly the #19 failure
// mode: spored crash-looped (or never installed), so the instance never self-
// terminated and bills indefinitely.
//
// Pure and provider-agnostic: given a list of instances + `now`, it decides
// which are orphaned. The client/CLI/dashboard consume it; reaping (terminate)
// is a separate, confirmed action. Mirrors the intent of the Go tool's
// `spawn orphans` / `cleanup` / zombie_guard.

import type { ManagedInstance } from "./types.js";
import { ttlDeadline } from "./lifecycle.js";

/**
 * Grace period past the TTL deadline before an instance is considered orphaned.
 * spored polls on an interval and termination has lag, so a live instance a
 * little past its deadline is normal, not orphaned. 10 min is comfortably longer
 * than spored's poll + EC2 shutdown, while still catching a truly stuck box fast.
 */
export const ORPHAN_GRACE_MS = 10 * 60_000;

/** Why an instance is flagged — currently always a blown TTL. */
export interface Orphan {
  instance: ManagedInstance;
  /** How long (ms) past its effective TTL deadline it has been live. */
  overdueByMs: number;
}

/**
 * Find managed instances that should be dead but aren't: state running/pending,
 * a real TTL deadline, and now beyond that deadline + grace. Instances with no
 * TTL are never orphans (nothing promised they'd self-terminate). `graceMs`
 * overrides the default for testing/tuning.
 */
export function findOrphans(
  instances: ManagedInstance[],
  nowMs: number,
  graceMs: number = ORPHAN_GRACE_MS,
): Orphan[] {
  const orphans: Orphan[] = [];
  for (const inst of instances) {
    if (inst.state !== "running" && inst.state !== "pending") continue;
    const deadline = ttlDeadline(inst);
    if (deadline <= 0) continue; // no TTL → not an orphan
    const overdueByMs = nowMs - (deadline + graceMs);
    if (overdueByMs > 0) orphans.push({ instance: inst, overdueByMs });
  }
  // Most overdue first — the worst offenders lead.
  orphans.sort((a, b) => b.overdueByMs - a.overdueByMs);
  return orphans;
}
