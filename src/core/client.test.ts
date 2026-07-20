import { describe, it, expect } from "vitest";
import { SpawnClient, type SpawnEvent } from "./client.js";
import { MockProvider } from "./mock.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function client() {
  // Sim clock, no wall timer — we drive it manually via step().
  return new SpawnClient({ provider: new MockProvider(), startMs: T0, clock: 1 });
}

describe("SpawnClient end-to-end", () => {
  it("launches an instance and lists it", async () => {
    const c = client();
    const inst = await c.launch({ name: "job", ttl: "4h", pricePerHour: 1 });
    expect(inst.name).toBe("job");
    expect(inst.state).toBe("running");
    const list = await c.refresh();
    expect(list.length).toBe(1);
  });

  it("self-terminates on TTL expiry via the monitor tick", async () => {
    const c = client();
    const events: SpawnEvent[] = [];
    c.on((e) => events.push(e));
    await c.launch({ name: "job", ttl: "1h", pricePerHour: 1 });

    // Advance 61 minutes of sim time in one step; the tick should terminate it.
    await c.step(61 * 60_000);

    const inst = await c.get("job");
    expect(inst?.state).toBe("terminated");
    const action = events.find((e) => e.type === "action" && e.rule === "ttl");
    expect(action).toBeTruthy();
  });

  it("accrues compute cost while running", async () => {
    const c = client();
    await c.launch({ name: "job", ttl: "4h", pricePerHour: 3.6 });
    await c.step(30 * 60_000); // 30 min
    const inst = await c.get("job");
    // 0.5h * $3.6/hr ≈ $1.80 (allow slack for the double-refresh in tick).
    expect(inst!.computeSeconds).toBeGreaterThan(1700);
    expect(inst!.computeSeconds).toBeLessThan(1900);
  });

  it("extend pushes out the TTL deadline", async () => {
    const c = client();
    await c.launch({ name: "job", ttl: "1h" });
    const before = (await c.get("job"))!.ttlDeadlineMs;
    const after = await c.extend("job", "2h");
    expect(after).toBe(before + 2 * 3600_000);
  });

  it("refuses unbounded launch only on a real backend", async () => {
    const c = client(); // mock is not real → allowed
    await expect(c.launch({ name: "unbounded" })).resolves.toBeTruthy();
  });

  it("signalComplete applies the on-complete action", async () => {
    const c = client();
    await c.launch({ name: "job", ttl: "4h", onComplete: "stop", completionFile: "/tmp/done" });
    await c.signalComplete("job");
    expect((await c.get("job"))!.state).toBe("stopped");
  });
});
