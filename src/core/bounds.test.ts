import { describe, it, expect } from "vitest";
import { evaluateBounds, ENFORCEMENT } from "./bounds.js";

/** Only the three fields the guard reads. */
const spec = (o: Partial<{ ttlMs: number; idleTimeoutMs: number; costLimit: number }> = {}) => ({
  ttlMs: 0,
  idleTimeoutMs: 0,
  costLimit: 0,
  ...o,
});

describe("evaluateBounds — which bounds count (#55)", () => {
  it("accepts idleTimeout as a bound", () => {
    // The inversion this issue is about: an idle timeout was REFUSED, although
    // it's the bound Go itself auto-applies as its 1h default
    // (cmd/zombie_guard.go:20, whose trigger is `TTL == "" && IdleTimeout == ""`).
    const v = evaluateBounds(spec({ idleTimeoutMs: 3600_000 }), true);
    expect(v.refuse).toBeUndefined();
    expect(v.bounds).toEqual(["idle-timeout"]);
  });

  it("accepts a ttl, and reports it as the one externally-enforced bound", () => {
    const v = evaluateBounds(spec({ ttlMs: 4 * 3600_000 }), true);
    expect(v.refuse).toBeUndefined();
    expect(v.warn).toBeUndefined(); // nothing to caveat: the reaper enforces this
    expect(v.hasExternalBound).toBe(true);
  });

  it("permits a costLimit-only launch but WARNS that nothing external enforces it", () => {
    // The other half of the inversion. The old guard treated a cost limit as
    // fully sufficient and said nothing — the weakest of the three bounds
    // reported as complete safety.
    const v = evaluateBounds(spec({ costLimit: 10 }), true);
    expect(v.refuse).toBeUndefined();
    expect(v.hasExternalBound).toBe(false);
    expect(v.warn).toMatch(/spored/);
    expect(v.warn).toMatch(/invisible/); // names the orphan-detection blind spot
  });

  it("warns for idleTimeout + costLimit together — two soft bounds are still soft", () => {
    // Stacking on-instance limits doesn't produce an external one. Both die with
    // the same spored.
    const v = evaluateBounds(spec({ idleTimeoutMs: 600_000, costLimit: 5 }), true);
    expect(v.hasExternalBound).toBe(false);
    expect(v.warn).toMatch(/are enforced by spored/); // plural, reads correctly
    expect(v.bounds).toEqual(["idle-timeout", "cost-limit"]);
  });

  it("does not warn when a ttl accompanies the soft bounds", () => {
    const v = evaluateBounds(spec({ ttlMs: 3600_000, idleTimeoutMs: 600_000, costLimit: 5 }), true);
    expect(v.warn).toBeUndefined();
    expect(v.bounds).toEqual(["ttl", "idle-timeout", "cost-limit"]);
  });

  it("refuses a real launch with no bound at all, naming the consequence", () => {
    const v = evaluateBounds(spec(), true);
    expect(v.refuse).toMatch(/bill indefinitely/);
    // The message must point at the fix, and say WHICH bound is the strong one —
    // otherwise a user satisfies the guard with the weakest option available.
    expect(v.refuse).toMatch(/outside the instance/);
    expect(v.warn).toBeUndefined(); // a refusal is not also a warning
  });

  it("does not refuse an unbounded MOCK launch — it bills nothing", () => {
    const v = evaluateBounds(spec(), false);
    expect(v.refuse).toBeUndefined();
    expect(v.bounds).toEqual([]);
  });

  it("classifies bounds identically regardless of provider, so UI can show it", () => {
    const real = evaluateBounds(spec({ costLimit: 1 }), true);
    const mock = evaluateBounds(spec({ costLimit: 1 }), false);
    expect(mock.bounds).toEqual(real.bounds);
    expect(mock.hasExternalBound).toBe(real.hasExternalBound);
  });

  it("treats zero and negative values as absent, not as bounds", () => {
    // A 0 that reads as "configured" is the failure this codebase keeps hitting:
    // a limit of 0 must never satisfy a limit check.
    expect(evaluateBounds(spec({ ttlMs: 0, costLimit: 0 }), true).refuse).toBeTruthy();
    expect(evaluateBounds(spec({ ttlMs: -1 }), true).refuse).toBeTruthy();
  });

  it("records TTL as the only externally-enforced bound", () => {
    // If this table ever changes, the warning text above is wrong. Pin it.
    expect(ENFORCEMENT).toEqual({
      ttl: "external",
      "idle-timeout": "on-instance",
      "cost-limit": "on-instance",
    });
  });
});
