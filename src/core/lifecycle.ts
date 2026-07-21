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

const FIVE_MIN_MS = 5 * 60_000;

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
