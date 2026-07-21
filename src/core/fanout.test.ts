import { describe, it, expect } from "vitest";
import { FanOut, type FanOutMember } from "./fanout.js";
import { SpawnClient, type LaunchInput } from "./client.js";
import { MockProvider } from "./mock.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function client() {
  return new SpawnClient({ provider: new MockProvider(), startMs: T0, clock: 1 });
}

function members(n: number, extra?: Partial<LaunchInput>): FanOutMember[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `m${i}`,
    input: { name: `m${i}`, ttl: "5m", ...extra },
  }));
}

describe("FanOut", () => {
  it("launches all members at once when no cap is set", async () => {
    const c = client();
    const f = new FanOut(c, members(3));
    await f.pump(T0);
    await c.refresh();
    expect(f.summary.running).toBe(3);
    expect(f.summary.pending).toBe(0);
    expect(f.isComplete).toBe(false); // running, not yet terminal
  });

  it("caps concurrent launches and drains as slots free", async () => {
    const c = client();
    const f = new FanOut(c, members(4, { ttl: "5m" }), { maxConcurrent: 2 });
    await f.pump(T0);
    await c.refresh();
    expect(f.summary.running).toBe(2);
    expect(f.summary.pending).toBe(2);

    // Terminate the two running ones directly, then pump: two more should launch.
    for (const s of f.status.filter((m) => m.state === "running")) {
      await c.terminate(s.instanceId!);
    }
    await f.pump(T0 + 1000);
    await c.refresh();
    expect(f.summary.running).toBe(2); // the remaining two
    expect(f.hasPending).toBe(false);
  });

  it("throttles to one launch per pump when a launch delay is set", async () => {
    const c = client();
    const f = new FanOut(c, members(3), { launchDelayMs: 10_000 });
    await f.pump(T0);
    await c.refresh();
    // First pump launches exactly one; delay gate blocks the rest.
    expect(f.summary.running).toBe(1);

    await f.pump(T0 + 5_000); // still within the delay window → no launch
    expect(f.summary.running).toBe(1);

    await f.pump(T0 + 12_000); // delay elapsed → one more
    await c.refresh();
    expect(f.summary.running).toBe(2);
  });

  it("records a failed member without aborting the rest", async () => {
    const c = client();
    // A member with an empty name makes MockProvider still launch (name from tags),
    // so force a failure by stubbing launch to throw for one input.
    const good = members(2);
    const bad: FanOutMember = { key: "bad", input: { name: "bad", ttl: "5m" } };
    const f = new FanOut(c, [good[0], bad, good[1]]);

    const realLaunch = c.launch.bind(c);
    let calls = 0;
    (c as unknown as { launch: SpawnClient["launch"] }).launch = ((input: LaunchInput) => {
      calls++;
      if (input.name === "bad") return Promise.reject(new Error("boom"));
      return realLaunch(input);
    }) as SpawnClient["launch"];

    await f.pump(T0);
    await c.refresh();
    expect(calls).toBe(3);
    expect(f.summary.failed).toBe(1);
    expect(f.summary.running).toBe(2);
    expect(f.status.find((s) => s.key === "bad")?.error).toBe("boom");
  });

  it("onProgress fires with a status snapshot on change", async () => {
    const c = client();
    const snapshots: number[] = [];
    const f = new FanOut(c, members(2), { onProgress: (st) => snapshots.push(st.length) });
    await f.pump(T0);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)).toBe(2);
  });

  it("blocks a member until its dependency completes", async () => {
    const c = client();
    const f = new FanOut(c, [
      { key: "a", input: { name: "a", ttl: "5m" } },
      { key: "b", input: { name: "b", ttl: "5m" }, dependsOn: ["a"] },
    ]);
    await f.pump(T0);
    await c.refresh();
    // a launches; b is blocked on it.
    expect(f.status.find((s) => s.key === "a")?.state).toBe("running");
    expect(f.status.find((s) => s.key === "b")?.state).toBe("blocked");

    // Complete a → b becomes eligible and launches.
    await c.terminate(f.status.find((s) => s.key === "a")!.instanceId!);
    await f.pump(T0 + 1000);
    await c.refresh();
    expect(f.status.find((s) => s.key === "b")?.state).toBe("running");
  });

  it("skips a member whose dependency fails, cascading down the chain", async () => {
    const c = client();
    const f = new FanOut(c, [
      { key: "a", input: { name: "a", ttl: "5m" } },
      { key: "b", input: { name: "b", ttl: "5m" }, dependsOn: ["a"] },
      { key: "c", input: { name: "c", ttl: "5m" }, dependsOn: ["b"] },
    ]);
    // Force a's launch to fail.
    const real = c.launch.bind(c);
    (c as unknown as { launch: SpawnClient["launch"] }).launch = ((input: LaunchInput) =>
      input.name === "a" ? Promise.reject(new Error("nope")) : real(input)) as SpawnClient["launch"];

    await f.pump(T0);
    expect(f.summary.failed).toBe(1);
    expect(f.status.find((s) => s.key === "b")?.state).toBe("skipped");
    expect(f.status.find((s) => s.key === "c")?.state).toBe("skipped");
    expect(f.isComplete).toBe(true);
  });

  it("retries a failed launch up to maxAttempts", async () => {
    const c = client();
    let attempts = 0;
    const real = c.launch.bind(c);
    (c as unknown as { launch: SpawnClient["launch"] }).launch = ((input: LaunchInput) => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error("transient"));
      return real(input);
    }) as SpawnClient["launch"];

    const f = new FanOut(c, [{ key: "a", input: { name: "a", ttl: "5m" }, maxAttempts: 3 }]);
    // Each pump makes one attempt; retryDelayMs=0 so it retries immediately.
    await f.pump(T0);
    await f.pump(T0 + 1);
    await f.pump(T0 + 2);
    await c.refresh();
    expect(attempts).toBe(3);
    expect(f.status[0].state).toBe("running");
    expect(f.status[0].attempts).toBe(3);
  });

  it("waits retryDelayMs before re-attempting a failed launch", async () => {
    const c = client();
    let attempts = 0;
    const real = c.launch.bind(c);
    (c as unknown as { launch: SpawnClient["launch"] }).launch = ((input: LaunchInput) => {
      attempts++;
      if (attempts < 2) return Promise.reject(new Error("transient"));
      return real(input);
    }) as SpawnClient["launch"];

    const f = new FanOut(c, [{ key: "a", input: { name: "a", ttl: "5m" }, maxAttempts: 2 }], {
      retryDelayMs: 10_000,
    });
    await f.pump(T0); // attempt 1 fails → back to pending
    expect(attempts).toBe(1);
    await f.pump(T0 + 5_000); // still within the retry window → no attempt
    expect(attempts).toBe(1);
    await f.pump(T0 + 12_000); // window elapsed → attempt 2 succeeds
    await c.refresh();
    expect(attempts).toBe(2);
    expect(f.status[0].state).toBe("running");
  });

  it("on-failure 'stop' skips not-yet-started members after a failure", async () => {
    const c = client();
    // Two independent members; the first fails. With "stop", the second is
    // skipped instead of launched.
    const real = c.launch.bind(c);
    (c as unknown as { launch: SpawnClient["launch"] }).launch = ((input: LaunchInput) =>
      input.name === "a" ? Promise.reject(new Error("x")) : real(input)) as SpawnClient["launch"];

    const f = new FanOut(
      c,
      [
        { key: "a", input: { name: "a", ttl: "5m" } },
        { key: "b", input: { name: "b", ttl: "5m" } },
      ],
      { maxConcurrent: 1, onFailure: "stop" },
    );
    await f.pump(T0);
    await f.pump(T0 + 1);
    expect(f.summary.failed).toBe(1);
    expect(f.status.find((s) => s.key === "b")?.state).toBe("skipped");
  });
});
