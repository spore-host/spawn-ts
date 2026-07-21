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
});
