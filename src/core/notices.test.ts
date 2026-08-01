import { describe, it, expect } from "vitest";
import {
  dnsNotice,
  lifecycleProtection,
  sporedUpgrade,
  elasticIpNotice,
  statusNotices,
  compareSemver,
} from "./notices.js";
import type { ManagedInstance } from "./types.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function inst(overrides: Partial<ManagedInstance> = {}): ManagedInstance {
  const base: ManagedInstance = {
    instanceId: "i-test",
    name: "job",
    region: "us-east-1",
    instanceType: "c6a.xlarge",
    state: "running",
    spot: false,
    tags: { "spawn:managed": "true" },
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
  return { ...base, ...overrides, tags: { ...base.tags, ...(overrides.tags || {}) } };
}

describe("dnsNotice — a failed registration must be visible (#56)", () => {
  it("reports a failure with spored's own diagnostic", () => {
    const n = dnsNotice(
      inst({
        tags: {
          "spawn:dns-status": "failed",
          "spawn:dns-error": "403 from function URL: auth required",
        },
      }),
    );
    expect(n).toBeTruthy();
    expect(n!.level).toBe("warn");
    // The detail is the whole value of the notice — spored recorded WHY, and a
    // notice that dropped it would leave the user no better off than silence.
    expect(n!.text).toContain("403 from function URL: auth required");
  });

  it("still reports a failure that carries no detail", () => {
    const n = dnsNotice(inst({ tags: { "spawn:dns-status": "failed" } }));
    expect(n).toBeTruthy();
    expect(n!.text).toContain("no detail reported");
  });

  it("says nothing when registration succeeded", () => {
    expect(dnsNotice(inst({ tags: { "spawn:dns-status": "registered" } }))).toBeNull();
  });

  it("says nothing when the tag is absent — unknown is not failure", () => {
    // An older spored, or DNS never configured. Claiming failure here would be as
    // wrong as claiming success.
    expect(dnsNotice(inst())).toBeNull();
  });
});

describe("lifecycleProtection — the cost ceiling and the deadline (#56)", () => {
  const priced = () =>
    inst({ launchTimeMs: T0, ttlDeadlineMs: T0 + 4 * 3600_000, ttlMs: 4 * 3600_000, pricePerHour: 2 });

  it("states the worst-case compute cost to the deadline", () => {
    const n = lifecycleProtection(priced(), T0 + 3600_000)!;
    // 4h × $2/hr = $8.00, measured launch→deadline (NOT now→deadline): the bill
    // already incurred is part of the ceiling.
    const line = n.detail!.find((d) => d.includes("max compute cost"))!;
    expect(line).toContain("$8.00");
    // "compute only" must survive the port — it excludes EBS and network, so
    // presenting it as a total would understate the bill.
    expect(line).toContain("compute only");
  });

  it("marks a past-due deadline as past due rather than a negative duration", () => {
    const n = lifecycleProtection(priced(), T0 + 9 * 3600_000)!;
    const line = n.detail!.find((d) => d.includes("termination deadline"))!;
    expect(line).toContain("past due — terminates on next check");
    // Not "in -5h left" — the ISO date legitimately contains hyphens, so pin the
    // parenthetical instead of the whole line.
    expect(line).not.toMatch(/\(in /);
  });

  it("shows time remaining while the instance is live", () => {
    const n = lifecycleProtection(priced(), T0 + 3600_000)!;
    const line = n.detail!.find((d) => d.includes("termination deadline"))!;
    expect(line).toMatch(/in 3h/);
    expect(line).not.toContain("past due");
  });

  it("describes the out-of-band reaper as a backstop, not a certainty", () => {
    // The reaper runs in the infra account and is not visible from the launch
    // account, so the notice must not assert an enforcement it can't confirm.
    const n = lifecycleProtection(priced(), T0)!;
    expect(n.detail!.join("\n")).toMatch(/if deployed/);
  });

  it("omits the cost line rather than printing a confident $0.00", () => {
    const n = lifecycleProtection(
      inst({ ttlDeadlineMs: T0 + 3600_000, pricePerHour: 0 }),
      T0,
    )!;
    expect(n.detail!.some((d) => d.includes("max compute cost"))).toBe(false);
  });

  it("falls back to the TTL when there is no absolute deadline", () => {
    const n = lifecycleProtection(inst({ ttlMs: 2 * 3600_000, launchTimeMs: 0 }), T0)!;
    expect(n.detail!.some((d) => d.includes("2h"))).toBe(true);
  });

  it("uses the launch+ttl deadline when only spawn:ttl is set", () => {
    // Same rule as ttlDeadline() / Go's lifecycleDeadline (status.go:204): an
    // instance with no deadline tag still has a deadline.
    const n = lifecycleProtection(
      inst({ ttlMs: 4 * 3600_000, ttlDeadlineMs: 0, pricePerHour: 1 }),
      T0,
    )!;
    expect(n.detail!.find((d) => d.includes("max compute cost"))).toContain("$4.00");
  });

  it("says idle stops but never terminates", () => {
    const n = lifecycleProtection(inst({ idleTimeoutMs: 30 * 60_000, ttlMs: 3600_000 }), T0)!;
    const line = n.detail!.find((d) => d.includes("idle timeout"))!;
    expect(line).toContain("stops");
    expect(line).toContain("never terminates");
  });

  it("says hibernates when that is what is configured", () => {
    const n = lifecycleProtection(
      inst({ idleTimeoutMs: 30 * 60_000, hibernateOnIdle: true, ttlMs: 3600_000 }),
      T0,
    )!;
    expect(n.detail!.find((d) => d.includes("idle timeout"))).toContain("hibernates");
  });

  it("says nothing for a stopped or terminated instance", () => {
    // Nothing is being enforced against a box that isn't running.
    expect(lifecycleProtection(inst({ state: "stopped", ttlMs: 3600_000 }), T0)).toBeNull();
    expect(lifecycleProtection(inst({ state: "terminated", ttlMs: 3600_000 }), T0)).toBeNull();
  });

  it("says nothing for an unmanaged instance", () => {
    expect(lifecycleProtection(inst({ tags: { "spawn:managed": "" }, ttlMs: 3600_000 }), T0)).toBeNull();
  });
});

describe("compareSemver — parity with libs/update (#56)", () => {
  it("orders by major, minor, then patch", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareSemver("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
  });

  it("tolerates a v prefix on either side", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("v1.3.0", "v1.2.0")).toBeGreaterThan(0);
  });

  it("treats missing components as zero", () => {
    // Go's parseSemver does the same, so "1.2" and "1.2.0" must not disagree.
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
    expect(compareSemver("2", "1.9.9")).toBeGreaterThan(0);
  });

  it("strips a pre-release suffix before comparing", () => {
    expect(compareSemver("1.2.3-rc1", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.4-rc1", "1.2.3")).toBeGreaterThan(0);
  });

  it("treats an unparseable component as zero rather than NaN", () => {
    // NaN comparisons are all false, which would silently report "no upgrade"
    // for every pair — the exact failure mode this notice must not have.
    expect(compareSemver("garbage", "0.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "garbage")).toBeGreaterThan(0);
  });
});

describe("sporedUpgrade (#56)", () => {
  const running = (v: string) => inst({ tags: { "spawn:spored-version": v } });

  it("reports an available upgrade and names the command that can do it", () => {
    const n = sporedUpgrade(running("1.2.0"), "1.3.0")!;
    expect(n.text).toContain("v1.2.0 → v1.3.0");
    // spawn-ts can't perform the upgrade (it needs a shell), so it must point at
    // the Go CLI rather than imply a capability it lacks.
    expect(n.detail!.join("\n")).toContain("spawn upgrade-spored i-test");
  });

  it("says nothing when spored is current or ahead", () => {
    expect(sporedUpgrade(running("1.3.0"), "1.3.0")).toBeNull();
    expect(sporedUpgrade(running("1.4.0"), "1.3.0")).toBeNull();
  });

  it("says nothing when the running version is unknown", () => {
    // No tag, and (unlike Go) no live `spored status` output to parse. Skipping is
    // the honest outcome; claiming "up to date" would not be.
    expect(sporedUpgrade(inst(), "1.3.0")).toBeNull();
  });

  it("says nothing when the latest version is unknown", () => {
    expect(sporedUpgrade(running("1.2.0"), "")).toBeNull();
  });
});

describe("elasticIpNotice — the bill that survives a stop (#56)", () => {
  const eip = { publicIp: "52.1.2.3", allocationId: "eipalloc-abc" };

  it("warns that an EIP on a STOPPED instance keeps billing", () => {
    const n = elasticIpNotice(inst({ state: "stopped" }), { eip })!;
    expect(n.level).toBe("warn");
    expect(n.text).toContain("keeps billing");
    // The release command must be copy-pasteable and carry the real allocation id.
    expect(n.detail!.join("\n")).toContain("aws ec2 release-address --allocation-id eipalloc-abc");
  });

  it("is merely informational while the instance runs", () => {
    const n = elasticIpNotice(inst({ state: "running" }), { eip })!;
    expect(n.level).toBe("info");
    expect(n.text).not.toContain("keeps billing");
  });

  it("says nothing when no EIP is attached", () => {
    expect(elasticIpNotice(inst({ state: "stopped" }), { eip: null })).toBeNull();
  });

  it("reports a FAILED lookup rather than reading as 'none attached'", () => {
    // Go returns nil,nil on any API error (cleanup.go:219), so a missing
    // ec2:DescribeAddresses permission looks identical to a clean bill of health.
    // That collapse is the one this notice exists to prevent.
    const n = elasticIpNotice(inst({ state: "stopped" }), {
      eip: null,
      error: "UnauthorizedOperation",
    })!;
    expect(n.level).toBe("warn");
    expect(n.text).toContain("could not check");
    expect(n.text).toContain("UnauthorizedOperation");
    expect(n.detail!.join("\n")).toContain("describe-addresses");
  });
});

describe("statusNotices — composition (#56)", () => {
  it("returns the protection block, then dns, then eip, then upgrade", () => {
    const i = inst({
      state: "stopped",
      ttlMs: 3600_000,
      tags: { "spawn:dns-status": "failed", "spawn:spored-version": "1.0.0" },
    });
    const kinds = statusNotices(i, T0, {
      eip: { eip: { publicIp: "1.2.3.4", allocationId: "eipalloc-x" } },
      latestSporedVersion: "1.1.0",
    }).map((n) => n.kind);
    // No protection block: the instance is stopped.
    expect(kinds).toEqual(["dns", "elastic-ip", "spored-upgrade"]);
  });

  it("skips the optional notices when their inputs are absent", () => {
    const i = inst({ ttlMs: 3600_000, tags: { "spawn:spored-version": "1.0.0" } });
    const kinds = statusNotices(i, T0).map((n) => n.kind);
    expect(kinds).toEqual(["lifecycle-protection"]);
  });

  it("returns nothing at all for an unremarkable stopped instance", () => {
    expect(statusNotices(inst({ state: "stopped" }), T0)).toEqual([]);
  });
});
