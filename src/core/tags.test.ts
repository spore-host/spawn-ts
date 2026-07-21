import { describe, it, expect } from "vitest";
import {
  buildSweepTags,
  decodeSweepTags,
  buildLaunchTags,
  tag,
  PARAM_TAG_PREFIX,
} from "./tags.js";
import type { LaunchSpec, SweepMembership } from "./types.js";

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

describe("session-timeout tag", () => {
  it("writes spawn:session-timeout as a Go duration when set, omits it at 0", () => {
    expect(buildLaunchTags(baseSpec(), 0)[tag("session-timeout")]).toBeUndefined();
    const s = { ...baseSpec(), sessionTimeoutMs: 30 * 60_000 };
    expect(buildLaunchTags(s, 0)[tag("session-timeout")]).toBe("30m");
  });
});
