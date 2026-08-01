import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildSweepTags,
  decodeSweepTags,
  buildJobArrayTags,
  decodeJobArrayTags,
  buildMpiTags,
  decodeMpiTags,
  buildHookTags,
  decodeHookTags,
  buildLaunchTags,
  slugifyDnsLabel,
  tag,
  PARAM_TAG_PREFIX,
  AWS_TAG_LIMIT,
  LIB_VERSION,
  buildIdentityTags,
} from "./tags.js";
import type { LaunchSpec, SweepMembership, JobArrayMembership, LifecycleHooks } from "./types.js";

const membership: SweepMembership = {
  id: "hp-20260720-000000",
  name: "hp",
  index: 2,
  size: 9,
  parameters: { alpha: "0.1", beta: "0.5" },
};

function baseSpec(sweep?: SweepMembership): LaunchSpec {
  return {
    name: "hp-2",
    instanceType: "t3.micro",
    region: "us-east-1",
    spot: false,
    ttlMs: 30 * 60_000,
    idleTimeoutMs: 0,
    hibernateOnIdle: false,
    idleCpuPercent: 0,
    costLimit: 0,
    onComplete: "",
    completionFile: "",
    completionDelayMs: 0,
    pricePerHour: 0,
    sessionTimeoutMs: 0,
    sweep,
  };
}

describe("dns-name tag", () => {
  it("defaults spawn:dns-name to the slugified launch name (so spored registers DNS)", () => {
    // spored (agent.go) only registers {name}.{base36(account)}.spore.host when
    // config.DNSName — from spawn:dns-name — is non-empty. The Go launcher's
    // --dns defaults to --name; we mirror that. (Regression guard for spawn#435.)
    expect(buildLaunchTags(baseSpec(), 0)[tag("dns-name")]).toBe("hp-2");
  });

  it("honors an explicit dnsName override", () => {
    expect(buildLaunchTags({ ...baseSpec(), dnsName: "my-box" }, 0)[tag("dns-name")]).toBe("my-box");
  });

  it("slugifies a name with DNS-unsafe characters", () => {
    expect(buildLaunchTags({ ...baseSpec(), name: "My Box_v2!" }, 0)[tag("dns-name")]).toBe("my-box-v2");
  });

  it("omits the tag when the name slugifies to empty (DNS disabled)", () => {
    expect(buildLaunchTags({ ...baseSpec(), name: "!!!" }, 0)[tag("dns-name")]).toBeUndefined();
  });

  it("slugifyDnsLabel matches the Go rules", () => {
    expect(slugifyDnsLabel("Hello World")).toBe("hello-world");
    expect(slugifyDnsLabel("a__b..c")).toBe("a-b-c");
    expect(slugifyDnsLabel("-lead-and-trail-")).toBe("lead-and-trail");
    expect(slugifyDnsLabel("UPPER")).toBe("upper");
    expect(slugifyDnsLabel("###")).toBe("");
    expect(slugifyDnsLabel("x".repeat(80)).length).toBe(63);
  });
});

describe("sweep tags", () => {
  it("buildSweepTags emits the wire-compatible spawn:sweep-* / spawn:param:* set", () => {
    const tags = buildSweepTags(membership);
    expect(tags[tag("sweep-id")]).toBe("hp-20260720-000000");
    expect(tags[tag("sweep-name")]).toBe("hp");
    expect(tags[tag("sweep-index")]).toBe("2");
    expect(tags[tag("sweep-size")]).toBe("9");
    expect(tags[`${PARAM_TAG_PREFIX}alpha`]).toBe("0.1");
    expect(tags[`${PARAM_TAG_PREFIX}beta`]).toBe("0.5");
  });

  it("round-trips through decodeSweepTags", () => {
    expect(decodeSweepTags(buildSweepTags(membership))).toEqual(membership);
  });

  it("decodeSweepTags returns undefined when there is no sweep-id", () => {
    expect(decodeSweepTags({ [tag("managed")]: "true" })).toBeUndefined();
  });

  it("decodeSweepTags tolerates malformed numeric tags (fall back to 0)", () => {
    const decoded = decodeSweepTags({
      [tag("sweep-id")]: "s",
      [tag("sweep-index")]: "notanumber",
      [tag("sweep-size")]: "",
    });
    expect(decoded).toMatchObject({ id: "s", index: 0, size: 0, parameters: {} });
  });

  it("caps parameter tags against the remaining AWS tag budget", () => {
    // This asserted a flat 35 and therefore asserted the bug. Go's comment claims
    // 35 keeps a member "under AWS 50-tag limit" (pkg/aws/tags.go:247), but the
    // sweep block is 4 tags and a configured launch carries ~30 more, so a maximal
    // sweep member reached 73 tags and RunInstances rejected the launch outright.
    // The cap is now a budget, so the assertion is the invariant, not a number.
    const parameters: Record<string, string> = {};
    for (let i = 0; i < 60; i++) parameters[`p${String(i).padStart(2, "0")}`] = String(i);
    const tags = buildSweepTags({ ...membership, parameters });
    expect(Object.keys(tags).length).toBeLessThanOrEqual(AWS_TAG_LIMIT);
    // Standalone, the 4 sweep tags leave 46 slots for parameters.
    expect(Object.keys(tags).filter((k) => k.startsWith(PARAM_TAG_PREFIX))).toHaveLength(46);
    // Sorted order, so the surviving subset is deterministic rather than
    // dependent on object insertion order.
    expect(tags[`${PARAM_TAG_PREFIX}p00`]).toBe("0");
    expect(tags[`${PARAM_TAG_PREFIX}p59`]).toBeUndefined();
  });

  it("a MAXIMAL sweep launch stays within the AWS tag limit", () => {
    // The end-to-end version of the above, and the one that would actually have
    // caught the bug: every optional block populated at once. A launch over 50
    // tags doesn't degrade, it fails.
    const parameters: Record<string, string> = {};
    for (let i = 0; i < 40; i++) parameters[`p${String(i).padStart(2, "0")}`] = String(i);
    const spec: LaunchSpec = {
      ...baseSpec({ ...membership, parameters }),
      costLimit: 10,
      pricePerHour: 0.5,
      onComplete: "stop",
      completionFile: "/tmp/done",
      completionDelayMs: 60_000,
      sessionTimeoutMs: 3600_000,
      idleTimeoutMs: 600_000,
      hibernateOnIdle: true,
      idleCpuPercent: 5,
      hooks: {
        preStop: "sync.sh",
        preStopTimeoutMs: 30_000,
        spotWebhookUrl: "https://example.invalid/spot",
        webhookCorrelation: "corr",
        webhookTimeoutMs: 5_000,
        notifyUrl: "https://example.invalid/notify",
        notifyPlatform: "slack",
        notifyCommand: "/spawn",
        activeProcesses: "R,python",
        activePorts: "8787",
      },
    };
    const tags = buildLaunchTags(spec, 0, {
      accountId: "123456789012",
      userArn: "arn:aws:iam::123456789012:user/alice",
      accountName: "my-lab",
    });
    // +1 for spawn:local-username, which EC2Provider adds after this returns.
    expect(Object.keys(tags).length + 1).toBeLessThanOrEqual(AWS_TAG_LIMIT);
    // The identity block survives the squeeze — parameters are what get dropped,
    // never the tag the portal needs to own the instance.
    expect(tags[tag("iam-user")]).toBe("arn:aws:iam::123456789012:user/alice");
  });

  it("buildLaunchTags includes sweep tags only when a membership is set", () => {
    expect(buildLaunchTags(baseSpec(), 0)[tag("sweep-id")]).toBeUndefined();
    const withSweep = buildLaunchTags(baseSpec(membership), 0);
    expect(withSweep[tag("sweep-id")]).toBe("hp-20260720-000000");
  });
});

describe("job-array tags", () => {
  const m: JobArrayMembership = { id: "arr-20260721-0000ab", name: "compute", index: 2, size: 5 };

  it("buildJobArrayTags emits the wire-compatible spawn:job-array-* set", () => {
    const tags = buildJobArrayTags(m);
    expect(tags[tag("job-array-id")]).toBe("arr-20260721-0000ab");
    expect(tags[tag("job-array-name")]).toBe("compute");
    expect(tags[tag("job-array-size")]).toBe("5");
    expect(tags[tag("job-array-index")]).toBe("2");
  });

  it("round-trips through decodeJobArrayTags", () => {
    expect(decodeJobArrayTags(buildJobArrayTags(m))).toEqual(m);
  });

  it("decodeJobArrayTags returns undefined without a job-array-id", () => {
    expect(decodeJobArrayTags({ [tag("managed")]: "true" })).toBeUndefined();
  });

  it("buildLaunchTags includes job-array tags only when membership is set", () => {
    expect(buildLaunchTags(baseSpec(), 0)[tag("job-array-id")]).toBeUndefined();
    const withArr = buildLaunchTags({ ...baseSpec(), jobArray: m }, 0);
    expect(withArr[tag("job-array-id")]).toBe("arr-20260721-0000ab");
  });
});

describe("mpi tags (#52)", () => {
  it("emits the wire-compatible pair", () => {
    const tags = buildMpiTags({ enabled: true, processesPerNode: 4 });
    expect(tags).toEqual({
      [tag("mpi-enabled")]: "true",
      [tag("mpi-processes-per-node")]: "4",
    });
  });

  it("omits processes-per-node unless > 0, mirroring Go's guard", () => {
    // A zero would be written as "0" and read back as a real declaration of zero
    // processes per node.
    for (const ppn of [undefined, 0, -1, NaN, Infinity]) {
      const tags = buildMpiTags({ enabled: true, processesPerNode: ppn as number });
      expect(tags[tag("mpi-enabled")]).toBe("true");
      expect(tags[tag("mpi-processes-per-node")]).toBeUndefined();
    }
  });

  it("floors a fractional count rather than tagging a decimal", () => {
    expect(buildMpiTags({ enabled: true, processesPerNode: 4.7 })[tag("mpi-processes-per-node")]).toBe(
      "4",
    );
  });

  it("emits nothing at all when disabled — never mpi-enabled=false", () => {
    // Go reaches its tag block only inside `if mpiEnabled`, so it has no notion
    // of writing a false; an explicit "false" would invite a reader to treat
    // MPI-ness as a field that is always recorded.
    expect(buildMpiTags({ enabled: false })).toEqual({});
    expect(buildMpiTags({ enabled: false, processesPerNode: 4 })).toEqual({});
  });

  it("round-trips through decodeMpiTags", () => {
    const m = { enabled: true as const, processesPerNode: 8 };
    expect(decodeMpiTags(buildMpiTags(m))).toEqual(m);
    expect(decodeMpiTags(buildMpiTags({ enabled: true }))).toEqual({ enabled: true });
  });

  it("decodes absence as undefined, not as {enabled: false}", () => {
    // "Not an MPI launch" and "an MPI launch we know nothing else about" must stay
    // distinguishable — a Go-launched instance whose spored predates the tags
    // reads identically to a non-MPI one.
    expect(decodeMpiTags({})).toBeUndefined();
    expect(decodeMpiTags({ [tag("managed")]: "true" })).toBeUndefined();
    expect(decodeMpiTags({ [tag("mpi-enabled")]: "false" })).toBeUndefined();
    expect(decodeMpiTags({ [tag("mpi-enabled")]: "1" })).toBeUndefined();
  });

  it("keeps enabled=true when the rank density is unreadable", () => {
    // The instance is still an MPI member; we just can't read how dense it is.
    for (const raw of ["", "lots", "0", "-2"]) {
      expect(
        decodeMpiTags({ [tag("mpi-enabled")]: "true", [tag("mpi-processes-per-node")]: raw }),
      ).toEqual({ enabled: true });
    }
  });

  it("buildLaunchTags includes mpi tags only when declared", () => {
    expect(buildLaunchTags(baseSpec(), 0)[tag("mpi-enabled")]).toBeUndefined();
    const withMpi = buildLaunchTags({ ...baseSpec(), mpi: { enabled: true, processesPerNode: 2 } }, 0);
    expect(withMpi[tag("mpi-enabled")]).toBe("true");
    expect(withMpi[tag("mpi-processes-per-node")]).toBe("2");
  });

  it("counts against the sweep parameter budget rather than overflowing it", () => {
    // The mpi block is emitted BEFORE the sweep block so its tags are inside the
    // budget when the parameter cap is computed. Otherwise a maximal sweep member
    // could be pushed past AWS's 50-tag limit after the cap was already decided.
    const params: Record<string, string> = {};
    for (let i = 0; i < 60; i++) params[`p${i}`] = String(i);
    const sweep: SweepMembership = { id: "s", name: "s", index: 0, size: 1, parameters: params };
    const withMpi = buildLaunchTags(
      { ...baseSpec(sweep), mpi: { enabled: true, processesPerNode: 2 } },
      0,
    );
    expect(Object.keys(withMpi).length).toBeLessThanOrEqual(AWS_TAG_LIMIT);
    expect(withMpi[tag("mpi-enabled")]).toBe("true");
  });
});

describe("lifecycle-hook tags", () => {
  const hooks: LifecycleHooks = {
    preStop: "aws s3 sync /out s3://bucket/",
    preStopTimeoutMs: 5 * 60_000,
    spotWebhookUrl: "https://hook.example/spot",
    webhookCorrelation: "run-42",
    webhookTimeoutMs: 2000,
    notifyUrl: "https://hooks.slack.com/x",
    notifyPlatform: "slack",
    notifyCommand: "/deploys",
    activeProcesses: "python,rsync",
  };

  it("buildHookTags emits the wire-compatible spawn:* tag set", () => {
    const t = buildHookTags(hooks);
    expect(t[tag("pre-stop")]).toBe("aws s3 sync /out s3://bucket/");
    expect(t[tag("pre-stop-timeout")]).toBe("5m");
    expect(t[tag("spot-webhook-url")]).toBe("https://hook.example/spot");
    expect(t[tag("webhook-correlation")]).toBe("run-42");
    expect(t[tag("webhook-timeout")]).toBe("2s");
    expect(t[tag("notify-url")]).toBe("https://hooks.slack.com/x");
    expect(t[tag("notify-platform")]).toBe("slack");
    expect(t[tag("notify-command")]).toBe("/deploys");
    expect(t[tag("active-processes")]).toBe("python,rsync");
  });

  it("round-trips through decodeHookTags", () => {
    expect(decodeHookTags(buildHookTags(hooks))).toEqual(hooks);
  });

  it("omits webhook companions when no url, and returns undefined when empty", () => {
    // correlation/timeout without a URL → not emitted.
    expect(buildHookTags({ webhookCorrelation: "x", webhookTimeoutMs: 1000 })).toEqual({});
    expect(decodeHookTags({ [tag("managed")]: "true" })).toBeUndefined();
  });

  it("buildLaunchTags includes hook tags only when hooks are set", () => {
    expect(buildLaunchTags(baseSpec(), 0)[tag("pre-stop")]).toBeUndefined();
    const withHooks = buildLaunchTags({ ...baseSpec(), hooks: { preStop: "sync.sh" } }, 0);
    expect(withHooks[tag("pre-stop")]).toBe("sync.sh");
  });
});

describe("session-timeout tag", () => {
  it("writes spawn:session-timeout as a Go duration when set, omits it at 0", () => {
    expect(buildLaunchTags(baseSpec(), 0)[tag("session-timeout")]).toBeUndefined();
    const s = { ...baseSpec(), sessionTimeoutMs: 30 * 60_000 };
    expect(buildLaunchTags(s, 0)[tag("session-timeout")]).toBe("30m");
  });
});

describe("base identity tags", () => {
  const id = {
    accountId: "123456789012",
    userArn: "arn:aws:iam::123456789012:user/alice",
  };

  it("LIB_VERSION matches package.json", () => {
    // spawn:version is read by Go's pkg/aws/ami_mgmt.go:170. The constant is
    // hand-maintained (a browser lib can't read package.json at runtime, and
    // importing src/index.ts here would be circular), so this is the guard that
    // stops a release shipping a stale value. truffle-ts's 0.5.0 bump missed its
    // equivalent constant and lagotto-ts's guard fired on its 0.2.0 bump.
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(LIB_VERSION).toBe(pkg.version);
  });

  it("emits Go's always-present base-identity block", () => {
    const t = buildIdentityTags(id);
    expect(t[tag("managed")]).toBe("true");
    expect(t[tag("root")]).toBe("true");
    expect(t[tag("version")]).toBe(LIB_VERSION);
    expect(t[tag("account-id")]).toBe("123456789012");
    expect(t[tag("iam-user")]).toBe(id.userArn);
  });

  it("derives account-base36 with the same encoder spored's DNS uses", () => {
    // spored builds the notification FQDN from this tag, not from IMDS
    // (pkg/agent/notifier.go:66). Absent, every notification carries the bare
    // label ("my-box") instead of "my-box.1kpqzg2c.spore.host" — an unusable link.
    expect(buildIdentityTags(id)[tag("account-base36")]).toBe("1kpqzg2c");
  });

  it("records created-by as spawn-ts, not spawn", () => {
    // No Go reader compares this for equality, and an operator benefits from
    // being able to tell which launcher produced an instance.
    expect(buildIdentityTags(id)[tag("created-by")]).toBe("spawn-ts");
  });

  it("slugifies account-name and omits it when it slugifies to nothing", () => {
    expect(buildIdentityTags({ ...id, accountName: "Kempner Lab" })[tag("account-name")]).toBe(
      "kempner-lab",
    );
    // An empty tag value is worse than an absent tag — it looks like a real answer.
    expect(buildIdentityTags({ ...id, accountName: "!!!" })[tag("account-name")]).toBeUndefined();
    expect(buildIdentityTags(id)[tag("account-name")]).toBeUndefined();
  });

  it("rejects a non-numeric account id rather than writing a bogus subdomain", () => {
    expect(() => buildIdentityTags({ ...id, accountId: "not-an-account" })).toThrow(/invalid account id/);
  });

  it("buildLaunchTags omits the identity block when no identity is given", () => {
    // The MockProvider path: offline, no AWS call, so there is no identity to
    // stamp. It must not invent one — a fabricated ARN would be worse than none.
    const t = buildLaunchTags(baseSpec(), 0);
    expect(t[tag("iam-user")]).toBeUndefined();
    expect(t[tag("managed")]).toBe("true"); // still managed
  });

  it("stamps spawn:os explicitly rather than leaving it absent", () => {
    // Go's connect branches on `== "windows"` (cmd/connect.go:120) and treats
    // absent and "linux" alike today, but wire-compatibility means stating it.
    expect(buildLaunchTags(baseSpec(), 0)[tag("os")]).toBe("linux");
  });
});
