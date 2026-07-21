import { describe, it, expect } from "vitest";
import { findOrphans, ORPHAN_GRACE_MS } from "./orphans.js";
import type { ManagedInstance } from "./types.js";

const T0 = Date.UTC(2026, 6, 21, 12, 0, 0);

// Minimal ManagedInstance factory — only the fields findOrphans reads matter.
function inst(over: Partial<ManagedInstance>): ManagedInstance {
  return {
    instanceId: "i-1", name: "job", region: "us-east-1", instanceType: "t3.micro",
    state: "running", spot: false, tags: {},
    launchTimeMs: T0, ttlDeadlineMs: 0, ttlMs: 0, idleTimeoutMs: 0,
    hibernateOnIdle: false, idleCpuPercent: 0, costLimit: 0, pricePerHour: 0,
    onComplete: "", completionFile: "", completionDelayMs: 0,
    computeSeconds: 0, lastActivityMs: T0, cpuPercent: 0,
    ...over,
  };
}

describe("findOrphans", () => {
  it("flags a live instance past its TTL deadline + grace", () => {
    const deadline = T0 - ORPHAN_GRACE_MS - 60_000; // 1m past deadline+grace
    const o = findOrphans([inst({ ttlDeadlineMs: deadline })], T0);
    expect(o).toHaveLength(1);
    expect(o[0].overdueByMs).toBe(60_000);
  });

  it("does NOT flag within the grace window", () => {
    const deadline = T0 - 60_000; // 1m past deadline, but well inside grace
    expect(findOrphans([inst({ ttlDeadlineMs: deadline })], T0)).toEqual([]);
  });

  it("ignores instances with no TTL (nothing promised self-termination)", () => {
    expect(findOrphans([inst({ ttlDeadlineMs: 0, ttlMs: 0 })], T0 + 1e12)).toEqual([]);
  });

  it("ignores non-live states (stopped / terminated)", () => {
    const deadline = T0 - ORPHAN_GRACE_MS - 60_000;
    expect(findOrphans([inst({ state: "stopped", ttlDeadlineMs: deadline })], T0)).toEqual([]);
    expect(findOrphans([inst({ state: "terminated", ttlDeadlineMs: deadline })], T0)).toEqual([]);
  });

  it("falls back to launchTime+ttlMs when the absolute deadline tag is absent", () => {
    // launch at T0, ttl 1h → deadline T0+1h; now = T0 + 1h + grace + 5m → orphan
    const now = T0 + 3600_000 + ORPHAN_GRACE_MS + 5 * 60_000;
    const o = findOrphans([inst({ ttlMs: 3600_000, launchTimeMs: T0 })], now);
    expect(o).toHaveLength(1);
  });

  it("sorts most-overdue first", () => {
    const a = inst({ instanceId: "i-a", ttlDeadlineMs: T0 - ORPHAN_GRACE_MS - 60_000 });
    const b = inst({ instanceId: "i-b", ttlDeadlineMs: T0 - ORPHAN_GRACE_MS - 600_000 });
    const o = findOrphans([a, b], T0);
    expect(o.map((x) => x.instance.instanceId)).toEqual(["i-b", "i-a"]);
  });

  it("honors a custom grace override", () => {
    const deadline = T0 - 60_000; // 1m past deadline
    expect(findOrphans([inst({ ttlDeadlineMs: deadline })], T0, 0)).toHaveLength(1);
  });
});
