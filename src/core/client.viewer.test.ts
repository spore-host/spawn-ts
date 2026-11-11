// #126: a SpawnClient over EC2 must never stop, hibernate or terminate anything
// from its monitor loop. spored on the box and the reaper own enforcement; the
// old loop ran the lifecycle engine in the browser with `isIdle: true` hardcoded,
// so an open portal tab stopped every busy CLI job one idle-timeout after launch.
//
// These tests build the client exactly as a browser portal does —
// `new SpawnClient({ provider: new EC2Provider({...}) })`, no lifecycle option —
// against a fake EC2 (EC2Client.prototype.send stubbed; no network), and count
// the commands sent over many monitor ticks.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { EC2Provider } from "../aws/ec2.js";
import { SpawnClient, type SpawnEvent } from "./client.js";
import { MockProvider } from "./mock.js";

const NOW = Date.UTC(2026, 10, 10, 15, 0, 0);
const HOUR = 3600_000;

/** A DescribeInstances instance record carrying spawn:* tags, as Go spawn writes them. */
function awsInstance(id: string, name: string, tags: Record<string, string>) {
  return {
    InstanceId: id,
    InstanceType: "c7g.large",
    State: { Name: "running" },
    Tags: Object.entries({ Name: name, "spawn:managed": "true", ...tags }).map(([Key, Value]) => ({ Key, Value })),
  };
}

// Every rule the engine has, already due: a CLI job past its idle timeout (the
// audit's exact case), one past its TTL, one past its cost limit, and one with an
// on-complete action. In "simulate" mode each of these would be acted on.
const FLEET = [
  awsInstance("i-0aaa000000000000a", "cli-job", {
    "spawn:launch-time": new Date(NOW - 2 * HOUR).toISOString(),
    "spawn:idle-timeout": "30m",
    "spawn:iam-user": "arn:aws:iam::123456789012:user/alice",
  }),
  awsInstance("i-0bbb000000000000b", "ttl-due", {
    "spawn:launch-time": new Date(NOW - 5 * HOUR).toISOString(),
    "spawn:ttl": "4h",
    "spawn:ttl-deadline": new Date(NOW - HOUR).toISOString(),
  }),
  awsInstance("i-0ccc000000000000c", "over-budget", {
    "spawn:launch-time": new Date(NOW - 10 * HOUR).toISOString(),
    "spawn:cost-limit": "1",
    "spawn:price-per-hour": "1",
    "spawn:compute-seconds": String(10 * 3600),
  }),
  awsInstance("i-0ddd000000000000d", "on-complete", {
    "spawn:launch-time": new Date(NOW - HOUR).toISOString(),
    "spawn:on-complete": "terminate",
    "spawn:idle-timeout": "5m",
    "spawn:hibernate-on-idle": "true",
  }),
];

let sent: unknown[];

beforeEach(() => {
  sent = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(EC2Client.prototype, "send").mockImplementation(function (this: unknown, cmd: unknown) {
    sent.push(cmd);
    if (cmd instanceof DescribeInstancesCommand) {
      return Promise.resolve({ Reservations: [{ Instances: FLEET }] });
    }
    return Promise.resolve({});
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Real AWS: no endpoint, so `isReal` is true, exactly as the portal's provider. */
function portalProvider(endpoint?: string) {
  return new EC2Provider({
    region: "us-east-1",
    accessKeyId: "ASIA_TEST",
    secretAccessKey: "secret",
    sessionToken: "token",
    endpoint,
    identity: { accountId: "123456789012", userArn: "arn:aws:sts::123456789012:assumed-role/spore-portal/alice" },
  });
}

function mutating(): string[] {
  return sent.filter((c) => !(c instanceof DescribeInstancesCommand)).map((c) => (c as object).constructor.name);
}

describe("SpawnClient over EC2 is a viewer by default (#126)", () => {
  it("defaults to observe for a real EC2 provider", () => {
    const client = new SpawnClient({ provider: portalProvider() });
    expect(client.lifecycleMode).toBe("observe");
  });

  it("makes zero mutating calls over 40 monitor ticks, with every lifecycle rule due", async () => {
    const client = new SpawnClient({ provider: portalProvider() });
    const events: SpawnEvent[] = [];
    client.on((e) => events.push(e));

    const N = 40;
    client.startMonitor(250);
    await vi.advanceTimersByTimeAsync(250 * N);
    client.stopMonitor();

    const describes = sent.filter((c) => c instanceof DescribeInstancesCommand).length;
    expect(describes).toBeGreaterThanOrEqual(N); // it really did poll every tick
    expect(mutating()).toEqual([]); // and never stopped, hibernated or terminated
    expect(events.filter((e) => e.type === "action")).toEqual([]);
    // It still shows the instances.
    expect(client.list().map((i) => i.instanceId)).toEqual(FLEET.map((i) => i.InstanceId));
  });

  it("does the same through step(), the other way a tick runs", async () => {
    const client = new SpawnClient({ provider: portalProvider() });
    for (let i = 0; i < 10; i++) await client.step(HOUR);
    expect(mutating()).toEqual([]);
  });

  it("is a viewer over a substrate endpoint too: non-billable is not the same as simulated", async () => {
    const client = new SpawnClient({ provider: portalProvider("http://localhost:4566") });
    expect(client.lifecycleMode).toBe("observe");
    for (let i = 0; i < 5; i++) await client.step(HOUR);
    expect(mutating()).toEqual([]);
  });

  it("still emits the TTL warning, once, without acting on it", async () => {
    const soon = awsInstance("i-0eee000000000000e", "ttl-soon", {
      "spawn:launch-time": new Date(NOW - HOUR).toISOString(),
      "spawn:ttl": "1h3m",
      "spawn:ttl-deadline": new Date(NOW + 3 * 60_000).toISOString(),
    });
    vi.mocked(EC2Client.prototype.send).mockImplementation(function (this: unknown, cmd: unknown) {
      sent.push(cmd);
      return Promise.resolve(cmd instanceof DescribeInstancesCommand ? { Reservations: [{ Instances: [soon] }] } : {});
    } as never);
    const client = new SpawnClient({ provider: portalProvider() });
    const warnings: SpawnEvent[] = [];
    client.on((e) => e.type === "warning" && warnings.push(e));
    for (let i = 0; i < 3; i++) await client.step(250);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ instance: "ttl-soon", rule: "ttl" });
    expect(mutating()).toEqual([]);
  });

  it("refuses lifecycle: 'simulate' on a provider that is not a simulation", () => {
    expect(() => new SpawnClient({ provider: portalProvider(), lifecycle: "simulate" })).toThrow(
      /needs a simulated provider/,
    );
  });

  it("becomes a viewer when a mock-backed client switches to EC2", async () => {
    const client = new SpawnClient({ provider: new MockProvider(), lifecycle: "simulate" });
    expect(client.lifecycleMode).toBe("simulate");
    client.setProvider(portalProvider());
    expect(client.lifecycleMode).toBe("observe");
    for (let i = 0; i < 5; i++) await client.step(HOUR);
    expect(mutating()).toEqual([]);
  });
});

describe("SpawnClient over the mock still simulates", () => {
  it("defaults to simulate, so the demo's TTL plays out", async () => {
    vi.useRealTimers();
    const client = new SpawnClient({ provider: new MockProvider(), startMs: NOW });
    expect(client.lifecycleMode).toBe("simulate");
    const inst = await client.launch({ name: "demo", ttl: "1h" });
    await client.step(61 * 60_000);
    expect((await client.get(inst.instanceId))?.state).toBe("terminated");
  });

  it("lifecycle: 'observe' on the mock makes it a viewer too", async () => {
    vi.useRealTimers();
    const client = new SpawnClient({ provider: new MockProvider(), startMs: NOW, lifecycle: "observe" });
    const inst = await client.launch({ name: "demo", ttl: "1h" });
    await client.step(61 * 60_000);
    expect((await client.get(inst.instanceId))?.state).toBe("running");
  });
});
