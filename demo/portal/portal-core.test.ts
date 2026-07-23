import { describe, it, expect, vi } from "vitest";
import { STSClient } from "@aws-sdk/client-sts";
import { EC2Provider } from "../../src/aws/ec2.js";
import {
  clientForUserAccount,
  toPortalView,
  portalConfigFromEnv,
  type PortalConfig,
} from "./portal-core.js";
import type { ManagedInstance } from "../../src/core/types.js";

const CFG: PortalConfig = {
  roleArn: "arn:aws:iam::435415984226:role/spawn-ts-portal-launch",
  externalId: "ext-123",
  region: "us-east-1",
  instanceProfile: "spored-instance-profile",
};

function makeInstance(over: Partial<ManagedInstance> = {}): ManagedInstance {
  return {
    instanceId: "i-0abc",
    name: "portal-demo",
    region: "us-east-1",
    instanceType: "t4g.nano",
    state: "running",
    publicIp: "203.0.113.7",
    privateIp: "10.0.0.7",
    spot: false,
    tags: { "spawn:managed": "true" },
    launchTimeMs: 1_000,
    ttlDeadlineMs: 301_000,
    ttlMs: 300_000,
    idleTimeoutMs: 0,
    hibernateOnIdle: false,
    idleCpuPercent: 0,
    costLimit: 0,
    pricePerHour: 0.0042,
    onComplete: "",
    completionFile: "",
    completionDelayMs: 0,
    computeSeconds: 0,
    lastActivityMs: 1_000,
    cpuPercent: 0,
    ...over,
  };
}

describe("portalConfigFromEnv", () => {
  it("reads role + external id and applies defaults", () => {
    const cfg = portalConfigFromEnv({
      PORTAL_LAUNCH_ROLE_ARN: "arn:aws:iam::435415984226:role/r",
      PORTAL_EXTERNAL_ID: "e",
    } as NodeJS.ProcessEnv);
    expect(cfg.roleArn).toBe("arn:aws:iam::435415984226:role/r");
    expect(cfg.externalId).toBe("e");
    expect(cfg.region).toBe("us-east-1");
    expect(cfg.instanceProfile).toBe("spored-instance-profile");
  });

  it("honors region + instance-profile overrides", () => {
    const cfg = portalConfigFromEnv({
      PORTAL_LAUNCH_ROLE_ARN: "r",
      PORTAL_EXTERNAL_ID: "e",
      PORTAL_REGION: "eu-west-1",
      PORTAL_INSTANCE_PROFILE: "custom-profile",
    } as NodeJS.ProcessEnv);
    expect(cfg.region).toBe("eu-west-1");
    expect(cfg.instanceProfile).toBe("custom-profile");
  });

  it("throws when the role or external id is missing (fail-closed)", () => {
    expect(() => portalConfigFromEnv({ PORTAL_EXTERNAL_ID: "e" } as NodeJS.ProcessEnv)).toThrow(/required/);
    expect(() => portalConfigFromEnv({ PORTAL_LAUNCH_ROLE_ARN: "r" } as NodeJS.ProcessEnv)).toThrow(/required/);
    expect(() => portalConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(/required/);
  });
});

describe("toPortalView", () => {
  it("projects only portal-mediated fields (no direct-access affordance)", () => {
    const v = toPortalView(makeInstance());
    expect(v).toEqual({
      instanceId: "i-0abc",
      name: "portal-demo",
      state: "running",
      instanceType: "t4g.nano",
      region: "us-east-1",
      ttlDeadlineMs: 301_000,
      managedBy: "portal",
    });
  });

  it("omits credentials, ssh/key, and IPs — the user cannot reach the box directly", () => {
    const v = toPortalView(makeInstance()) as unknown as Record<string, unknown>;
    expect(v.publicIp).toBeUndefined();
    expect(v.privateIp).toBeUndefined();
    expect(v.tags).toBeUndefined();
    expect(v.keyPair).toBeUndefined();
  });

  it("always marks the box as portal-owned regardless of instance data", () => {
    expect(toPortalView(makeInstance({ state: "shutting-down" })).managedBy).toBe("portal");
  });
});

describe("clientForUserAccount", () => {
  it("assumes the role with the external id and builds a real EC2Provider from the temp creds", async () => {
    const send = vi.fn().mockResolvedValue({
      Credentials: {
        AccessKeyId: "ASIA_TEMP",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: new Date(0),
      },
    });
    const sts = { send } as unknown as STSClient;

    const client = await clientForUserAccount(sts, CFG);

    // The AssumeRoleCommand carried the role + external id + session name.
    const cmd = send.mock.calls[0][0];
    expect(cmd.input).toMatchObject({
      RoleArn: CFG.roleArn,
      ExternalId: CFG.externalId,
      RoleSessionName: "spawn-ts-portal",
    });
    // The resulting client is bound to a real (billable) EC2Provider in-region.
    expect(client.activeProvider).toBeInstanceOf(EC2Provider);
    expect(client.activeProvider.isReal).toBe(true);
    expect(client.activeProvider.label).toBe("aws:us-east-1");
  });

  it("throws when AssumeRole returns no usable credentials", async () => {
    const sts = { send: vi.fn().mockResolvedValue({ Credentials: undefined }) } as unknown as STSClient;
    await expect(clientForUserAccount(sts, CFG)).rejects.toThrow(/no credentials/);
  });

  it("propagates an AssumeRole denial (e.g. wrong external id)", async () => {
    const sts = {
      send: vi.fn().mockRejectedValue(new Error("AccessDenied: not authorized to perform: sts:AssumeRole")),
    } as unknown as STSClient;
    await expect(clientForUserAccount(sts, CFG)).rejects.toThrow(/sts:AssumeRole/);
  });
});
