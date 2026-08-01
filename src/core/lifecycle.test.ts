import { describe, it, expect } from "vitest";
import {
  evaluate,
  accumulatedCost,
  computeExtension,
  TTL_TAG,
  TTL_DEADLINE_TAG,
} from "./lifecycle.js";
import { buildLaunchTags, decodeConfigTags } from "./tags.js";
import type { LaunchSpec, ManagedInstance } from "./types.js";
import { parseDuration, formatDuration } from "./duration.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function inst(overrides: Partial<ManagedInstance> = {}): ManagedInstance {
  const base: ManagedInstance = {
    instanceId: "i-test",
    name: "job",
    region: "us-east-1",
    instanceType: "c6a.xlarge",
    state: "running",
    spot: false,
    tags: {},
    launchTimeMs: T0,
    ttlDeadlineMs: 0,
    ttlMs: 0,
    idleTimeoutMs: 0,
    hibernateOnIdle: false,
    idleCpuPercent: 0,
    costLimit: 0,
    pricePerHour: 0,
    onComplete: "",
    completionFile: "",
    completionDelayMs: 0,
    computeSeconds: 0,
    lastActivityMs: T0,
    cpuPercent: 0,
  };
  return { ...base, ...overrides };
}

describe("duration parsing", () => {
  it("parses Go duration strings", () => {
    expect(parseDuration("4h")).toBe(4 * 3600_000);
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("1h30m")).toBe(90 * 60_000);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration("garbage")).toBeNull();
    expect(parseDuration("4h!")).toBeNull();
  });
  it("round-trips through format", () => {
    expect(formatDuration(4 * 3600_000)).toBe("4h");
    expect(formatDuration(90 * 60_000)).toBe("1h30m");
    expect(formatDuration(45_000)).toBe("45s");
  });
});

describe("TTL rule", () => {
  it("always terminates on expiry (never stops)", () => {
    const i = inst({ ttlMs: 3600_000, ttlDeadlineMs: T0 + 3600_000, hibernateOnIdle: true });
    const r = evaluate(i, { nowMs: T0 + 3600_001, completionFilePresent: false, isIdle: true });
    expect(r.decision?.action).toBe("terminate");
    expect(r.decision?.rule).toBe("ttl");
  });
  it("warns within 5 minutes but does not act", () => {
    const i = inst({ ttlMs: 3600_000, ttlDeadlineMs: T0 + 3600_000 });
    const r = evaluate(i, { nowMs: T0 + 3600_000 - 4 * 60_000, completionFilePresent: false, isIdle: false });
    expect(r.decision).toBeUndefined();
    expect(r.warnings.some((w) => w.rule === "ttl")).toBe(true);
  });
  it("uses absolute deadline, immune to stop/start clock resets", () => {
    // launchTime long ago, deadline passed — even if 'now' is only slightly past launch.
    const i = inst({ ttlMs: 3600_000, ttlDeadlineMs: T0 - 1 });
    const r = evaluate(i, { nowMs: T0, completionFilePresent: false, isIdle: false });
    expect(r.decision?.rule).toBe("ttl");
  });
});

describe("priority order", () => {
  it("completion beats TTL", () => {
    const i = inst({
      ttlMs: 3600_000,
      ttlDeadlineMs: T0 - 1, // TTL also expired
      onComplete: "stop",
      completionFile: "/tmp/done",
    });
    const r = evaluate(i, { nowMs: T0, completionFilePresent: true, isIdle: false });
    expect(r.decision?.rule).toBe("completion");
    expect(r.decision?.action).toBe("stop");
  });
  it("TTL beats cost limit", () => {
    const i = inst({
      ttlDeadlineMs: T0 - 1,
      costLimit: 1,
      pricePerHour: 100,
      computeSeconds: 3600, // $100 spent, over limit
    });
    const r = evaluate(i, { nowMs: T0, completionFilePresent: false, isIdle: false });
    expect(r.decision?.rule).toBe("ttl");
  });
});

describe("cost rule", () => {
  it("terminates when accumulated cost reaches the limit", () => {
    const i = inst({ costLimit: 0.5, pricePerHour: 1, computeSeconds: 1800 }); // $0.50
    const r = evaluate(i, { nowMs: T0 + 1, completionFilePresent: false, isIdle: false });
    expect(r.decision?.rule).toBe("cost-limit");
    expect(r.decision?.action).toBe("terminate");
  });
  it("warns at 90% budget", () => {
    const i = inst({ costLimit: 1, pricePerHour: 1, computeSeconds: 3300 }); // $0.9166
    const r = evaluate(i, { nowMs: T0, completionFilePresent: false, isIdle: false });
    expect(r.decision).toBeUndefined();
    expect(r.warnings.some((w) => w.rule === "cost-limit")).toBe(true);
  });
  it("accumulatedCost math", () => {
    expect(accumulatedCost(inst({ pricePerHour: 3.6, computeSeconds: 3600 }))).toBeCloseTo(3.6);
  });
});

describe("idle rule", () => {
  it("stops by default after idle timeout", () => {
    const i = inst({ idleTimeoutMs: 30 * 60_000, lastActivityMs: T0 });
    const r = evaluate(i, { nowMs: T0 + 31 * 60_000, completionFilePresent: false, isIdle: true });
    expect(r.decision?.rule).toBe("idle");
    expect(r.decision?.action).toBe("stop");
  });
  it("hibernates when hibernateOnIdle set", () => {
    const i = inst({ idleTimeoutMs: 30 * 60_000, lastActivityMs: T0, hibernateOnIdle: true });
    const r = evaluate(i, { nowMs: T0 + 31 * 60_000, completionFilePresent: false, isIdle: true });
    expect(r.decision?.action).toBe("hibernate");
  });
  it("does not act when not idle", () => {
    const i = inst({ idleTimeoutMs: 30 * 60_000, lastActivityMs: T0 });
    const r = evaluate(i, { nowMs: T0 + 31 * 60_000, completionFilePresent: false, isIdle: false });
    expect(r.decision).toBeUndefined();
  });
});

describe("non-running instances are inert", () => {
  it("no decision for stopped instance even past TTL", () => {
    const i = inst({ state: "stopped", ttlDeadlineMs: T0 - 1 });
    const r = evaluate(i, { nowMs: T0, completionFilePresent: false, isIdle: true });
    expect(r.decision).toBeUndefined();
  });
});

describe("computeExtension — the extend safety floor (#54)", () => {
  const H = 3600_000;

  it("adds to the current deadline, not to now, while the TTL is still live", () => {
    // The anchoring rule: extending at T0+30m an instance due at T0+1h gives
    // T0+3h, not T0+2h30m. Stop/start cycles can't buy extra life.
    const i = inst({ ttlDeadlineMs: T0 + H });
    const ext = computeExtension(i, 2 * H, T0 + 30 * 60_000);
    expect(ext.deadlineMs).toBe(T0 + 3 * H);
    expect(ext.clamped).toBe(false);
  });

  it("clamps an OVERDUE instance to now + by, instead of a deadline in the past", () => {
    // The whole point of the issue. Deadline was T0+1h; it is now T0+3h (2h
    // overdue, spored down). Extending by 1h must land at T0+4h — an hour from
    // now — NOT at T0+2h, an hour ago.
    const i = inst({ ttlDeadlineMs: T0 + H });
    const now = T0 + 3 * H;
    const ext = computeExtension(i, H, now);
    expect(ext.deadlineMs).toBe(now + H);
    expect(ext.deadlineMs).toBeGreaterThan(now); // the invariant, stated directly
    expect(ext.clamped).toBe(true);
  });

  it("reports clamped=false when the floor made no difference", () => {
    const i = inst({ ttlDeadlineMs: T0 + 10 * H });
    expect(computeExtension(i, H, T0).clamped).toBe(false);
  });

  it("clamps at the exact boundary too — a deadline landing on now is not a rescue", () => {
    // old + by === now exactly. Without >= in the floor comparison the result is
    // a deadline equal to now, which the reaper treats as expired (remaining <= 0).
    const i = inst({ ttlDeadlineMs: T0 });
    const now = T0 + H;
    const ext = computeExtension(i, H, now);
    expect(ext.deadlineMs).toBe(now + H);
  });

  it("writes BOTH spawn:ttl and spawn:ttl-deadline", () => {
    // Two enforcers read the deadline tag, but Go's own extend and spored's
    // synthesis path read spawn:ttl. Leaving it stale means they disagree.
    const i = inst({ launchTimeMs: T0, ttlDeadlineMs: T0 + H, ttlMs: H });
    const ext = computeExtension(i, H, T0 + 30 * 60_000);
    expect(ext.tags[TTL_DEADLINE_TAG]).toBe(new Date(T0 + 2 * H).toISOString());
    // Recomputed from the launch anchor: T0 → T0+2h is 2h, not "1h + 1h" applied
    // to some other origin.
    expect(ext.tags[TTL_TAG]).toBe("2h");
  });

  it("keeps spawn:ttl Go-parseable, and consistent with the deadline it ships with", () => {
    const i = inst({ launchTimeMs: T0, ttlDeadlineMs: T0 + H });
    const ext = computeExtension(i, 90 * 60_000, T0);
    const ttl = parseDuration(ext.tags[TTL_TAG]);
    expect(ttl).not.toBeNull();
    expect(i.launchTimeMs + ttl!).toBe(ext.deadlineMs);
  });

  it("omits spawn:ttl rather than guessing when there is no launch anchor", () => {
    // An absent tag reads as unknown; a wrong one reads as fact. decodeConfigTags
    // would turn a bogus duration into a confident ttlMs.
    const i = inst({ launchTimeMs: 0, ttlDeadlineMs: T0 + H });
    const ext = computeExtension(i, H, T0);
    expect(ext.tags[TTL_DEADLINE_TAG]).toBeTruthy();
    expect(ext.tags).not.toHaveProperty(TTL_TAG);
  });

  it("extends an instance tagged only spawn:ttl, via the launch+ttl fallback", () => {
    // No absolute deadline tag — the deadline is launchTime+ttl. Both call sites
    // gate on ttlDeadline() for this reason.
    const i = inst({ launchTimeMs: T0, ttlDeadlineMs: 0, ttlMs: H });
    const ext = computeExtension(i, H, T0);
    expect(ext.deadlineMs).toBe(T0 + 2 * H);
    expect(ext.tags[TTL_TAG]).toBe("2h");
  });

  it("agrees with the TTL rule: an extended instance is no longer terminated", () => {
    // End to end against the enforcer this is meant to outrun. Feed the extension
    // back through decode+evaluate and assert the reaper's rule now spares it.
    const overdue = inst({ ttlDeadlineMs: T0 + H });
    const now = T0 + 3 * H;
    expect(evaluate(overdue, { nowMs: now, completionFilePresent: false, isIdle: false }).decision)
      .toMatchObject({ action: "terminate", rule: "ttl" });

    const ext = computeExtension(overdue, H, now);
    const extended = inst({ ...overdue, ttlDeadlineMs: ext.deadlineMs });
    const res = evaluate(extended, { nowMs: now, completionFilePresent: false, isIdle: false });
    expect(res.decision).toBeUndefined();
  });
});

describe("tag round-trip", () => {
  it("launch tags decode back to the same config", () => {
    const spec: LaunchSpec = {
      name: "job",
      instanceType: "c6a.xlarge",
      region: "us-east-1",
      spot: false,
      ttlMs: 4 * 3600_000,
      idleTimeoutMs: 30 * 60_000,
      hibernateOnIdle: true,
      idleCpuPercent: 5,
      costLimit: 2.5,
      onComplete: "terminate",
      completionFile: "/tmp/done",
      completionDelayMs: 0,
      pricePerHour: 0.153,
      sessionTimeoutMs: 0,
    };
    const tags = buildLaunchTags(spec, T0);
    expect(tags["spawn:managed"]).toBe("true");
    expect(tags["spawn:ttl"]).toBe("4h");
    const cfg = decodeConfigTags(tags);
    expect(cfg.ttlMs).toBe(spec.ttlMs);
    expect(cfg.idleTimeoutMs).toBe(spec.idleTimeoutMs);
    expect(cfg.hibernateOnIdle).toBe(true);
    expect(cfg.costLimit).toBe(2.5);
    expect(cfg.onComplete).toBe("terminate");
    expect(cfg.ttlDeadlineMs).toBe(T0 + spec.ttlMs);
  });
});
