// The launch config object against Go's pkg/launchconfig (spawn#1359).
// src/aws/testdata/stub-fixtures.v0.150.0.json carries launchconfig.Encode's
// bytes and sha for each fixture's settings; launchconfig-setting-keys.go.json
// is launchconfig.SettingKeys() (scripts/gen-go-fixtures.sh).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  LAUNCH_CONFIG_SETTINGS,
  encodeLaunchConfig,
  isLaunchConfigSetting,
  splitLaunchConfigTags,
} from "./launchconfig.js";
import { buildHookTags, buildLaunchTags, tag } from "./tags.js";
import type { LaunchSpec } from "./types.js";

const fixtures: { name: string; settings: Record<string, string> | null; object: string; sha256: string }[] =
  JSON.parse(readFileSync(new URL("../aws/testdata/stub-fixtures.v0.150.0.json", import.meta.url), "utf8"));
const goKeys: string[] = JSON.parse(
  readFileSync(new URL("./testdata/launchconfig-setting-keys.go.json", import.meta.url), "utf8"),
);

describe("encodeLaunchConfig matches Go's launchconfig.Encode", () => {
  for (const f of fixtures) {
    it(`same bytes and sha256 as Go: ${f.name}`, async () => {
      const got = await encodeLaunchConfig(f.settings ?? {});
      if (!f.object) {
        expect(got).toBeNull();
      } else {
        expect(got).toEqual({ body: f.object, sha256: f.sha256 });
      }
    });
  }

  it("has a fixture with an object to compare", () => {
    expect(fixtures.filter((f) => f.object).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a key no spored reads from the object", async () => {
    await expect(encodeLaunchConfig({ ttl: "4h" })).rejects.toThrow('"ttl" is not a launch-fixed spored setting');
  });
});

describe("the settings list is Go's", () => {
  it("equals launchconfig.SettingKeys()", () => {
    expect([...LAUNCH_CONFIG_SETTINGS]).toEqual(goKeys);
  });
});

describe("splitLaunchConfigTags", () => {
  it("moves every hook tag spawn-ts writes, and idle-cpu, out of the tags (#108)", () => {
    const hookTags = buildHookTags({
      preStop: "sync",
      preStopTimeoutMs: 60_000,
      spotWebhookUrl: "https://h",
      webhookCorrelation: "c",
      webhookTimeoutMs: 30_000,
      notifyUrl: "https://n",
      notifyPlatform: "slack",
      notifyCommand: "/s",
      activeProcesses: "python",
      activePorts: "8787",
    });
    const { tags, settings } = splitLaunchConfigTags({ ...hookTags, [tag("idle-cpu")]: "5", [tag("ttl")]: "4h" });
    expect(Object.keys(settings).sort()).toEqual([
      "active-ports",
      "active-processes",
      "idle-cpu",
      "notify-command",
      "notify-platform",
      "notify-url",
      "spot-webhook-url",
      "webhook-correlation",
      "webhook-timeout",
    ]);
    // pre-stop stays a tag: the reaper runs it before an external terminate.
    expect(Object.keys(tags).sort()).toEqual([tag("pre-stop"), tag("pre-stop-timeout"), tag("ttl")].sort());
    expect(settings["webhook-timeout"]).toBe("30s");
  });

  it("leaves no tag spawn-ts writes that is an object setting", () => {
    const spec: LaunchSpec = {
      name: "x", instanceType: "t3.micro", region: "us-east-1", spot: false, ttlMs: 3600_000,
      idleTimeoutMs: 3600_000, hibernateOnIdle: true, idleCpuPercent: 5, costLimit: 1, onComplete: "terminate",
      completionFile: "/tmp/D", completionDelayMs: 1000, pricePerHour: 0.1, sessionTimeoutMs: 60_000,
      hooks: { spotWebhookUrl: "u", webhookCorrelation: "c", webhookTimeoutMs: 1000, notifyUrl: "n",
        notifyPlatform: "p", notifyCommand: "c", activeProcesses: "a", activePorts: "1", preStop: "s" },
    };
    const { tags } = splitLaunchConfigTags(buildLaunchTags(spec, 0));
    expect(Object.keys(tags).filter(isLaunchConfigSetting)).toEqual([]);
  });
});
