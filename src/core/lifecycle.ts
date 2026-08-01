// The lifecycle decision engine — a faithful port of the spored monitor loop's
// checkAndAct (~/src/spore-host/spawn/pkg/agent/agent.go:356). Given an
// instance's observed state at time `now`, it decides whether a lifecycle
// action must fire, and emits pre-action warnings.
//
// Priority order is load-bearing and matches the Go original exactly:
//   1. completion signal   (highest)
//   2. TTL                 — ALWAYS terminate; never stop/hibernate (invariant #72)
//   3. cost limit          — terminate
//   4. idle                — stop, or hibernate with --hibernate-on-idle
//
// This module is pure: no clock, no I/O. `now` and observed activity are passed
// in, so the same logic runs identically in the browser, in tests, and against
// substrate's controllable simulated clock.

import type {
  LifecycleWarning,
  ManagedInstance,
  TickResult,
} from "./types.js";
import { tag } from "./tags.js";
import { formatDuration } from "./duration.js";

const FIVE_MIN_MS = 5 * 60_000;

/** The TTL tag pair. Named here because `computeExtension` writes both. */
export const TTL_TAG = tag("ttl");
export const TTL_DEADLINE_TAG = tag("ttl-deadline");

/** Inputs the engine can't derive from tags: live activity signals + clock. */
export interface TickInput {
  nowMs: number;
  /** Whether the completion-signal file is present (completion rule). */
  completionFilePresent: boolean;
  /** Whether the instance currently looks idle (below CPU threshold, no sessions). */
  isIdle: boolean;
}

/**
 * Accumulated compute cost in dollars = computeSeconds/3600 * pricePerHour.
 * Uses total compute across the instance's life (not this boot), so repeated
 * stop/start can't reset the cost clock — mirrors accumulatedComputeCost().
 */
export function accumulatedCost(inst: ManagedInstance): number {
  if (inst.pricePerHour <= 0) return 0;
  return (inst.computeSeconds / 3600) * inst.pricePerHour;
}

/** Effective TTL deadline (ms epoch): prefer the absolute tag; fall back to
 * launch+ttl; 0 = no TTL. Exported so the orphan reaper reuses the same rule. */
export function ttlDeadline(inst: ManagedInstance): number {
  if (inst.ttlDeadlineMs > 0) return inst.ttlDeadlineMs;
  if (inst.ttlMs > 0 && inst.launchTimeMs > 0) return inst.launchTimeMs + inst.ttlMs;
  return 0;
}

/** The tag pair an extend writes, plus the deadline it lands on. */
export interface ExtendResult {
  /** New absolute deadline (ms epoch). */
  deadlineMs: number;
  /** True when the safety floor moved the deadline forward of `old + by`. */
  clamped: boolean;
  /** spawn:ttl / spawn:ttl-deadline, ready for setTags. */
  tags: Record<string, string>;
}

/**
 * Compute the new deadline for `extend`, including the safety floor.
 *
 * Two rules, and they compose — the second is a lower bound on the first, not a
 * replacement for it:
 *
 * 1. **Add to the current deadline, not to now.** Keeps TTL anchored to the
 *    original launch across stop/wake cycles, so stopping and restarting can't
 *    quietly buy extra life.
 * 2. **Never return a deadline earlier than `now + by`.** Ported from Go
 *    (`cmd/extend.go:126`). Without it, extending an already-overdue instance
 *    produces a deadline *still in the past*: an instance 2h overdue (spored
 *    down — the #19 orphan scenario `src/core/orphans.ts` exists for) extended by
 *    1h lands 1h ago. `extend` reports success and the ttl-reaper terminates it
 *    on the next pass, so the user's rescue is silently a no-op. This is most
 *    likely to bite exactly when it matters most: the instance you're trying to
 *    save is by definition one that's overdue.
 *
 * Also writes **both** tags. `spawn:ttl-deadline` is authoritative for both
 * enforcers (reaper `lambda/ttl-reaper/main.go:688`; spored
 * `pkg/provider/ec2.go:478`), so `spawn:ttl` is close to cosmetic — but not
 * entirely: Go's own `extend` reads `instance.TTL` for its no-deadline-tag
 * fallback (`cmd/extend.go:119`), and spored synthesizes a deadline from
 * `anchor + config.TTL` when the deadline tag is zero (`pkg/agent/agent.go:140`).
 * Two tags that disagree are a trap for anything that trusts the wrong one.
 *
 * `ttlMs` is recomputed from the launch anchor rather than incremented, so
 * `spawn:ttl` keeps meaning "duration from launch" — the meaning spored assumes
 * when it synthesizes. When there's no usable anchor the tag is omitted rather
 * than guessed: an absent tag reads as unknown, a wrong one reads as fact.
 */
export function computeExtension(
  inst: ManagedInstance,
  byMs: number,
  nowMs: number,
): ExtendResult {
  const current = ttlDeadline(inst);
  const floor = nowMs + byMs;
  const proposed = current + byMs;
  const deadlineMs = Math.max(proposed, floor);

  const tags: Record<string, string> = {
    [TTL_DEADLINE_TAG]: new Date(deadlineMs).toISOString(),
  };
  const anchor = inst.launchTimeMs;
  if (anchor > 0 && deadlineMs > anchor) {
    tags[TTL_TAG] = formatDuration(deadlineMs - anchor);
  }
  return { deadlineMs, clamped: deadlineMs > proposed, tags };
}

/**
 * Evaluate one lifecycle tick. Returns at most one decision (first rule to fire
 * wins, in priority order) plus any warnings. Callers apply the decision via
 * the provider (terminate/stop/hibernate) and surface warnings to the user.
 */
export function evaluate(inst: ManagedInstance, input: TickInput): TickResult {
  const warnings: LifecycleWarning[] = [];

  // Only running instances are subject to lifecycle actions.
  if (inst.state !== "running") return { warnings };

  // 1. Completion signal (highest priority).
  if (inst.onComplete && input.completionFilePresent) {
    const action = inst.onComplete === "exit" ? "terminate" : inst.onComplete;
    return {
      warnings,
      decision: {
        action,
        rule: "completion",
        reason: `completion signal detected (${inst.completionFile || "signal"})`,
      },
    };
  }

  // 2. TTL — always terminates. This is the unconditional cost backstop.
  const deadline = ttlDeadline(inst);
  if (deadline > 0) {
    const remaining = deadline - input.nowMs;
    if (remaining <= 0) {
      return {
        warnings,
        decision: { action: "terminate", rule: "ttl", reason: "TTL expired" },
      };
    }
    if (remaining <= FIVE_MIN_MS) {
      warnings.push({
        rule: "ttl",
        message: `TTL expires in ~${Math.ceil(remaining / 60_000)}m — instance will terminate`,
      });
    }
  }

  // 3. Cost limit — terminates. Fires alongside TTL; first-to-fire wins.
  if (inst.costLimit > 0 && inst.pricePerHour > 0) {
    const spent = accumulatedCost(inst);
    if (spent >= inst.costLimit) {
      return {
        warnings,
        decision: {
          action: "terminate",
          rule: "cost-limit",
          reason: `cost limit reached ($${inst.costLimit.toFixed(2)})`,
        },
      };
    }
    if (spent / inst.costLimit >= 0.9) {
      warnings.push({
        rule: "cost-limit",
        message: `${Math.round((spent / inst.costLimit) * 100)}% of $${inst.costLimit.toFixed(
          2,
        )} budget consumed`,
      });
    }
  }

  // 4. Idle — stops (or hibernates). Never terminates: idle never destroys data.
  if (inst.idleTimeoutMs > 0) {
    if (input.isIdle) {
      const idleFor = input.nowMs - inst.lastActivityMs;
      if (idleFor >= inst.idleTimeoutMs) {
        return {
          warnings,
          decision: {
            action: inst.hibernateOnIdle ? "hibernate" : "stop",
            rule: "idle",
            reason: `idle timeout reached (${Math.round(idleFor / 60_000)}m)`,
          },
        };
      }
      const remaining = inst.idleTimeoutMs - idleFor;
      if (remaining > 0 && remaining <= FIVE_MIN_MS) {
        warnings.push({
          rule: "idle",
          message: `idle ~${Math.round(idleFor / 60_000)}m — will ${
            inst.hibernateOnIdle ? "hibernate" : "stop"
          } in ~${Math.ceil(remaining / 60_000)}m`,
        });
      }
    }
    // Note: when NOT idle, the caller resets lastActivityMs (activity observed).
    // The engine stays pure and does not mutate the instance.
  }

  return { warnings };
}
