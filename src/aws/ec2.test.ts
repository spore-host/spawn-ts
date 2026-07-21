// Hermetic unit tests for EC2Provider. Rather than a live substrate emulator
// (see ec2.integration.test.ts), these stub EC2Client.prototype.send so the
// real @aws-sdk/client-ec2 command classes still build their `.input` — letting
// us assert on the exact request shape (TagSpecifications, Filters, market
// options) AND on how canned responses map back into ManagedInstance.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  CreateTagsCommand,
} from "@aws-sdk/client-ec2";
import { EC2Provider } from "./ec2.js";
import type { LaunchSpec } from "../core/types.js";
import { tag } from "../core/tags.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

// Records every command instance passed to client.send, and returns whatever
// the current handler yields. Tests set `handler` to shape the response.
let sent: any[];
let handler: (cmd: any) => any;

beforeEach(() => {
  sent = [];
  handler = () => ({});
  vi.spyOn(EC2Client.prototype, "send").mockImplementation(function (this: unknown, cmd: any) {
    sent.push(cmd);
    return Promise.resolve(handler(cmd));
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function provider(overrides: Partial<ConstructorParameters<typeof EC2Provider>[0]> = {}) {
  return new EC2Provider({
    region: "us-east-1",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "secret",
    endpoint: "http://localhost:4566",
    ...overrides,
  });
}

const baseSpec: LaunchSpec = {
  name: "job",
  instanceType: "c6a.xlarge",
  region: "us-east-1",
  ami: "ami-12345678",
  spot: false,
  ttlMs: 4 * 3600_000,
  idleTimeoutMs: 0,
  hibernateOnIdle: false,
  idleCpuPercent: 0,
  costLimit: 0,
  onComplete: "terminate",
  completionFile: "",
  completionDelayMs: 0,
  pricePerHour: 0.153,
};

function lastOf<T>(type: new (...a: any[]) => T): T {
  const found = [...sent].reverse().find((c) => c instanceof type);
  if (!found) throw new Error(`no ${type.name} was sent`);
  return found;
}

describe("EC2Provider label / isReal", () => {
  it("marks an endpoint-backed provider as non-real and substrate-labelled", () => {
    const p = provider();
    expect(p.isReal).toBe(false);
    expect(p.label).toBe("substrate:us-east-1");
  });

  it("marks a no-endpoint provider as real AWS", () => {
    const p = provider({ endpoint: undefined });
    expect(p.isReal).toBe(true);
    expect(p.label).toBe("aws:us-east-1");
  });

  it("treats an empty-string endpoint as real AWS", () => {
    const p = provider({ endpoint: "" });
    expect(p.isReal).toBe(true);
    expect(p.label).toBe("aws:us-east-1");
  });
});

describe("EC2Provider.launch", () => {
  it("sends a RunInstancesCommand carrying the full spawn:* tag contract", async () => {
    handler = (cmd) => {
      if (cmd instanceof RunInstancesCommand)
        return { Instances: [{ InstanceId: "i-abc", State: { Name: "pending" } }] };
      return {};
    };
    const inst = await provider().launch(baseSpec, T0);

    const run = lastOf(RunInstancesCommand);
    expect(run.input.ImageId).toBe("ami-12345678");
    expect(run.input.InstanceType).toBe("c6a.xlarge");
    expect(run.input.MinCount).toBe(1);
    expect(run.input.MaxCount).toBe(1);
    expect(run.input.UserData).toBeTruthy(); // base64 bootstrap

    // The tag set sent over the wire must include the managed marker + TTL.
    const tags = run.input.TagSpecifications![0].Tags!;
    const byKey = Object.fromEntries(tags.map((t: any) => [t.Key, t.Value]));
    expect(byKey.Name).toBe("job");
    expect(byKey[tag("managed")]).toBe("true");
    expect(byKey[tag("ttl")]).toBe("4h");

    // Returned instance trusts the tags we sent, decoding TTL deadline from them.
    expect(inst.instanceId).toBe("i-abc");
    expect(inst.name).toBe("job");
    expect(inst.state).toBe("pending");
    expect(inst.ttlDeadlineMs).toBe(T0 + 4 * 3600_000);
    expect(inst.tags[tag("managed")]).toBe("true");
  });

  it("omits InstanceMarketOptions for on-demand and sets it for spot", async () => {
    handler = () => ({ Instances: [{ InstanceId: "i-1", State: { Name: "pending" } }] });

    await provider().launch(baseSpec, T0);
    expect(lastOf(RunInstancesCommand).input.InstanceMarketOptions).toBeUndefined();

    sent = [];
    await provider().launch({ ...baseSpec, spot: true }, T0);
    expect(lastOf(RunInstancesCommand).input.InstanceMarketOptions).toEqual({ MarketType: "spot" });
  });

  it("passes KeyName only when a keyPair is set", async () => {
    handler = () => ({ Instances: [{ InstanceId: "i-1", State: { Name: "pending" } }] });

    await provider().launch(baseSpec, T0);
    expect(lastOf(RunInstancesCommand).input.KeyName).toBeUndefined();

    sent = [];
    await provider().launch({ ...baseSpec, keyPair: "my-key" }, T0);
    expect(lastOf(RunInstancesCommand).input.KeyName).toBe("my-key");
  });

  it("throws when RunInstances returns no instance", async () => {
    handler = () => ({ Instances: [] });
    await expect(provider().launch(baseSpec, T0)).rejects.toThrow(/no instance/);
  });
});

describe("EC2Provider.list", () => {
  it("filters on tag:spawn:managed=true and maps reservations", async () => {
    handler = (cmd) => {
      if (cmd instanceof DescribeInstancesCommand)
        return {
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: "i-live",
                  InstanceType: "c6a.xlarge",
                  State: { Name: "running" },
                  PublicIpAddress: "1.2.3.4",
                  PrivateIpAddress: "10.0.0.1",
                  InstanceLifecycle: "spot",
                  Tags: [
                    { Key: "Name", Value: "job" },
                    { Key: tag("managed"), Value: "true" },
                    { Key: tag("ttl"), Value: "4h" },
                  ],
                },
              ],
            },
          ],
        };
      return {};
    };

    const list = await provider().list();
    const dfilter = lastOf(DescribeInstancesCommand).input.Filters!;
    expect(dfilter).toEqual([{ Name: `tag:${tag("managed")}`, Values: ["true"] }]);

    expect(list).toHaveLength(1);
    expect(list[0].instanceId).toBe("i-live");
    expect(list[0].name).toBe("job");
    expect(list[0].state).toBe("running");
    expect(list[0].publicIp).toBe("1.2.3.4");
    expect(list[0].spot).toBe(true);
  });

  it("drops instances lacking the managed tag", async () => {
    handler = () => ({
      Reservations: [
        { Instances: [{ InstanceId: "i-unmanaged", State: { Name: "running" }, Tags: [] }] },
      ],
    });
    expect(await provider().list()).toHaveLength(0);
  });

  it("excludes terminated instances unless asked", async () => {
    const managed = [
      { Key: tag("managed"), Value: "true" },
      { Key: "Name", Value: "dead" },
    ];
    handler = () => ({
      Reservations: [
        { Instances: [{ InstanceId: "i-dead", State: { Name: "terminated" }, Tags: managed }] },
      ],
    });
    expect(await provider().list()).toHaveLength(0);
    expect(await provider().list(true)).toHaveLength(1);
  });

  it("tolerates empty / missing reservation arrays", async () => {
    handler = () => ({});
    expect(await provider().list()).toEqual([]);
  });
});

describe("EC2Provider.get", () => {
  it("looks up by instance-id when the arg starts with i-", async () => {
    handler = (cmd) => {
      if (cmd instanceof DescribeInstancesCommand)
        return {
          Reservations: [
            { Instances: [{ InstanceId: "i-xyz", State: { Name: "running" }, Tags: [] }] },
          ],
        };
      return {};
    };
    const inst = await provider().get("i-xyz");
    expect(inst?.instanceId).toBe("i-xyz");
    expect(lastOf(DescribeInstancesCommand).input.InstanceIds).toEqual(["i-xyz"]);
    expect(lastOf(DescribeInstancesCommand).input.Filters).toBeUndefined();
  });

  it("looks up by tag:Name filter otherwise", async () => {
    handler = () => ({
      Reservations: [
        { Instances: [{ InstanceId: "i-named", State: { Name: "stopped" }, Tags: [] }] },
      ],
    });
    const inst = await provider().get("job");
    expect(inst?.state).toBe("stopped");
    const cmd = lastOf(DescribeInstancesCommand);
    expect(cmd.input.Filters).toEqual([{ Name: "tag:Name", Values: ["job"] }]);
    expect(cmd.input.InstanceIds).toBeUndefined();
  });

  it("returns null when nothing matches", async () => {
    handler = () => ({ Reservations: [] });
    expect(await provider().get("ghost")).toBeNull();
  });
});

describe("EC2Provider lifecycle operations", () => {
  it("terminate → TerminateInstancesCommand", async () => {
    await provider().terminate("i-1", "cleanup");
    expect(lastOf(TerminateInstancesCommand).input.InstanceIds).toEqual(["i-1"]);
  });

  it("stop → StopInstancesCommand without Hibernate", async () => {
    await provider().stop("i-1");
    const cmd = lastOf(StopInstancesCommand);
    expect(cmd.input.InstanceIds).toEqual(["i-1"]);
    expect(cmd.input.Hibernate).toBeUndefined();
  });

  it("start → StartInstancesCommand", async () => {
    await provider().start("i-1");
    expect(lastOf(StartInstancesCommand).input.InstanceIds).toEqual(["i-1"]);
  });

  it("hibernate → StopInstancesCommand with Hibernate:true", async () => {
    await provider().hibernate("i-1");
    const cmd = lastOf(StopInstancesCommand);
    expect(cmd.input.InstanceIds).toEqual(["i-1"]);
    expect(cmd.input.Hibernate).toBe(true);
  });

  it("setTags → CreateTagsCommand mapping the tag record", async () => {
    await provider().setTags("i-1", { [tag("ttl-deadline")]: "2026-07-20T16:00:00.000Z" });
    const cmd = lastOf(CreateTagsCommand);
    expect(cmd.input.Resources).toEqual(["i-1"]);
    expect(cmd.input.Tags).toEqual([
      { Key: tag("ttl-deadline"), Value: "2026-07-20T16:00:00.000Z" },
    ]);
  });
});

describe("EC2Provider state mapping", () => {
  const cases: Array<[string | undefined, string]> = [
    ["pending", "pending"],
    ["running", "running"],
    ["stopping", "stopping"],
    ["stopped", "stopped"],
    ["shutting-down", "shutting-down"],
    ["terminated", "terminated"],
    [undefined, "pending"], // unknown / missing → pending
    ["bogus", "pending"],
  ];

  for (const [awsState, expected] of cases) {
    it(`maps EC2 state ${awsState ?? "(none)"} → ${expected}`, async () => {
      handler = () => ({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-state",
                State: awsState ? { Name: awsState } : undefined,
                Tags: [{ Key: tag("managed"), Value: "true" }],
              },
            ],
          },
        ],
      });
      const list = await provider().list(true);
      expect(list[0].state).toBe(expected);
    });
  }
});
