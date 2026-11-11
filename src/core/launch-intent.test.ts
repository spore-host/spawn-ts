// #129 / spore-host#673 at the SpawnClient: one launch intent makes one
// instance, and stop/hibernate are refused where EC2 would refuse them.

import { describe, it, expect } from "vitest";
import { SpawnClient, newLaunchToken } from "./client.js";
import { MockProvider } from "./mock.js";
import { SpawnError, isAmbiguousLaunchError, toSpawnError } from "./errors.js";
import { runCommand, type ShellCtx } from "../cli/commands.js";
import type { LaunchSpec } from "./types.js";

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);

function setup() {
  const provider = new MockProvider();
  const specs: LaunchSpec[] = [];
  const orig = provider.launch.bind(provider);
  provider.launch = (spec, now) => {
    specs.push(spec);
    return orig(spec, now);
  };
  const client = new SpawnClient({ provider, startMs: T0, clock: 1 });
  return { provider, client, specs };
}

describe("launch intent tokens", () => {
  it("newLaunchToken fits RunInstances' 64-character ClientToken", () => {
    const t = newLaunchToken();
    expect(t).toMatch(/^spawn-ts-[0-9a-f-]{36}$/);
    expect(t.length).toBeLessThanOrEqual(64);
    expect(newLaunchToken()).not.toBe(t);
  });

  it("a double-click (two concurrent launches, one token) sends one launch and returns one instance", async () => {
    const { client, specs } = setup();
    const clientToken = newLaunchToken();
    const [a, b] = await Promise.all([
      client.launch({ name: "dbl", ttl: "1h", clientToken }),
      client.launch({ name: "dbl", ttl: "1h", clientToken }),
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0].clientToken).toBe(clientToken);
    expect(b.instanceId).toBe(a.instanceId);
    expect(client.list()).toHaveLength(1);
  });

  it("a retry of the same intent after it settled returns the same instance (the provider's idempotency)", async () => {
    const { client } = setup();
    const clientToken = newLaunchToken();
    const a = await client.launch({ name: "retry", ttl: "1h", clientToken });
    const b = await client.launch({ name: "retry", ttl: "1h", clientToken });
    expect(b.instanceId).toBe(a.instanceId);
    expect(client.list()).toHaveLength(1);
  });

  it("different intents launch different instances; no token means no dedup", async () => {
    const { client } = setup();
    await client.launch({ name: "x", ttl: "1h", clientToken: newLaunchToken() });
    await client.launch({ name: "x", ttl: "1h", clientToken: newLaunchToken() });
    await client.launch({ name: "x", ttl: "1h" });
    await client.launch({ name: "x", ttl: "1h" });
    expect(client.list()).toHaveLength(4);
  });

  it("only an ambiguous failure keeps the token for the retry", () => {
    const aws = (code: string, status: number) =>
      toSpawnError(Object.assign(new Error(code), { name: code, $fault: status >= 500 ? "server" : "client", $metadata: { httpStatusCode: status } }), "launch");
    expect(isAmbiguousLaunchError(toSpawnError(new TypeError("Failed to fetch"), "launch"))).toBe(true);
    expect(isAmbiguousLaunchError(aws("InternalError", 500))).toBe(true);
    expect(isAmbiguousLaunchError(aws("InsufficientInstanceCapacity", 400))).toBe(false);
    expect(isAmbiguousLaunchError(aws("UnauthorizedOperation", 403))).toBe(false);
    // Created, then terminated after a later failure: the old token names that instance.
    expect(
      isAmbiguousLaunchError(new SpawnError({ operation: "launch", instanceId: "i-0123456789abcdef0", code: "NetworkError", aws: false, message: "x" })),
    ).toBe(false);
  });
});

describe("stop/hibernate are refused where EC2 would refuse them (#129)", () => {
  it("a one-time Spot instance can't be stopped or hibernated, and nothing is called", async () => {
    const { provider, client } = setup();
    const inst = await client.launch({ name: "spot", ttl: "1h", spot: true });
    let called = 0;
    provider.stop = async () => void called++;
    provider.hibernate = async () => void called++;
    for (const op of ["stop", "hibernate"] as const) {
      const err = await client[op](inst.instanceId).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: "SpawnError", code: "OneTimeSpot", operation: op, aws: false });
      expect((err as Error).message).toMatch(/one-time Spot request/);
    }
    expect(called).toBe(0);
  });

  it("hibernate is refused on an instance not launched hibernatable; stop still works", async () => {
    const { client } = setup();
    const inst = await client.launch({ name: "plain", ttl: "1h" });
    await expect(client.hibernate(inst.instanceId)).rejects.toMatchObject({ code: "NotHibernatable" });
    await client.stop(inst.instanceId);
    expect((await client.get(inst.instanceId))!.state).toBe("stopped");
  });

  it("hibernate goes ahead on an instance launched with hibernate on idle", async () => {
    const { client } = setup();
    const inst = await client.launch({ name: "hib", ttl: "1h", hibernateOnIdle: true });
    expect(inst.hibernationConfigured).toBe(true);
    await client.hibernate(inst.instanceId);
    expect((await client.get(inst.instanceId))!.state).toBe("hibernated");
  });

  it("stop on an already-stopped instance is refused in Go's words", async () => {
    const { client } = setup();
    const inst = await client.launch({ name: "s", ttl: "1h" });
    await client.stop(inst.instanceId);
    await expect(client.stop(inst.instanceId)).rejects.toMatchObject({
      code: "NotRunning",
      message: `instance ${inst.instanceId} is already stopped`,
    });
  });

  it("the terminal's stop refuses a one-time Spot instance as Go's `spawn stop` does", async () => {
    const { provider, client } = setup();
    await client.launch({ name: "spotty", ttl: "1h", spot: true });
    const ctx: ShellCtx = { provider, now: () => client.now(), confirm: async () => true, client };
    const r = await runCommand("stop spotty", ctx);
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toMatch(/stop: cannot stop .* one-time Spot request/);
    expect(client.list()[0].state).toBe("running");
  });
});
