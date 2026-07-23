import { describe, it, expect } from "vitest";
import {
  buildSweepTags,
  decodeSweepTags,
  buildJobArrayTags,
  decodeJobArrayTags,
  buildHookTags,
  decodeHookTags,
  buildLaunchTags,
  slugifyDnsLabel,
  tag,
  PARAM_TAG_PREFIX,
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

  it("caps parameter tags at 35 to stay under the AWS tag limit", () => {
    const parameters: Record<string, string> = {};
    for (let i = 0; i < 50; i++) parameters[`p${String(i).padStart(2, "0")}`] = String(i);
    const tags = buildSweepTags({ ...membership, parameters });
    const paramTags = Object.keys(tags).filter((k) => k.startsWith(PARAM_TAG_PREFIX));
    expect(paramTags).toHaveLength(35);
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
