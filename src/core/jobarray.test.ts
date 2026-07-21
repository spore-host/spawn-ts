import { describe, it, expect } from "vitest";
import { buildJobArray, generateJobArrayId, JobArray } from "./jobarray.js";
import { SpawnClient, type LaunchInput } from "./client.js";
import { MockProvider } from "./mock.js";
import { tag } from "./tags.js";

const T0 = Date.UTC(2026, 6, 21, 12, 0, 0);
const client = () => new SpawnClient({ provider: new MockProvider(), startMs: T0, clock: 1 });
const base: LaunchInput = { name: "compute", instanceType: "t3.micro", ttl: "1h" };

describe("generateJobArrayId", () => {
  it("has the <name>-<YYYYMMDD>-<6 hex> shape and is deterministic", () => {
    const id = generateJobArrayId("compute", T0);
    expect(id).toMatch(/^compute-\d{8}-[0-9a-f]{6}$/);
    expect(generateJobArrayId("compute", T0)).toBe(id);
  });
});

describe("buildJobArray", () => {
  it("builds N indexed members with per-index names + membership", () => {
    const built = buildJobArray(base, 3, { id: "arr-1" });
    expect(built.size).toBe(3);
    expect(built.members.map((m) => m.key)).toEqual(["arr-1#0", "arr-1#1", "arr-1#2"]);
    expect(built.members.map((m) => m.input.name)).toEqual(["compute-0", "compute-1", "compute-2"]);
    const m1 = built.members[1].input;
    expect(m1.jobArray).toEqual({ id: "arr-1", name: "compute", index: 1, size: 3 });
    // Base fields carry through to each member.
    expect(m1.instanceType).toBe("t3.micro");
    expect(m1.ttl).toBe("1h");
  });

  it("drops any sweep membership from the base (a launch is one or the other)", () => {
    const withSweep: LaunchInput = { ...base, sweep: { id: "s", name: "s", index: 0, size: 1, parameters: {} } };
    const built = buildJobArray(withSweep, 2, { id: "arr" });
    expect(built.members.every((m) => m.input.sweep === undefined)).toBe(true);
    expect(built.members.every((m) => m.input.jobArray !== undefined)).toBe(true);
  });

  it("rejects a non-positive or non-integer size", () => {
    expect(() => buildJobArray(base, 0)).toThrow(/positive integer/);
    expect(() => buildJobArray(base, -1)).toThrow(/positive integer/);
    expect(() => buildJobArray(base, 2.5)).toThrow(/positive integer/);
  });

  it("defaults the name from the base when no option is given", () => {
    expect(buildJobArray(base, 1, { id: "x" }).name).toBe("compute");
    expect(buildJobArray({ name: "" }, 1, { id: "x" }).name).toBe("array");
  });
});

describe("JobArray + SpawnClient integration", () => {
  it("launches every member and stamps spawn:job-array-* tags", async () => {
    const c = client();
    c.startJobArray(base, 3, { id: "arr-1" });
    await c.step(1000);
    const list = await c.refresh();
    expect(list).toHaveLength(3);
    for (const inst of list) {
      expect(inst.tags[tag("job-array-id")]).toBe("arr-1");
      expect(inst.tags[tag("job-array-size")]).toBe("3");
      expect(inst.jobArray?.name).toBe("compute");
    }
    expect(new Set(list.map((i) => i.jobArray!.index))).toEqual(new Set([0, 1, 2]));
  });

  it("respects maxConcurrent", async () => {
    const c = client();
    const seen: number[] = [];
    c.on((e) => {
      if (e.type === "jobarray") seen.push(e.summary.running);
    });
    c.startJobArray({ ...base, ttl: "5m" }, 4, { id: "arr", maxConcurrent: 2 });
    await c.step(1000);
    expect(Math.max(...seen)).toBeLessThanOrEqual(2);
  });

  it("emits a terminal jobarray event with done=true", async () => {
    const c = client();
    let done: unknown;
    c.on((e) => {
      if (e.type === "jobarray" && e.done) done = e;
    });
    c.startJobArray({ ...base, ttl: "5m" }, 1, { id: "arr" });
    for (let i = 0; i < 3; i++) await c.step(6 * 60_000);
    expect(done).toBeTruthy();
  });

  it("JobArray.create builds a wrapper without registering it", () => {
    const c = client();
    const ja = JobArray.create(c, base, 2, { id: "arr-2" });
    expect(ja.size).toBe(2);
    expect(c.activeSweeps()).toHaveLength(0);
  });

  it("a manually-created JobArray drives via pump() and reports progress", async () => {
    const c = client();
    const ja = JobArray.create(c, { ...base, ttl: "5m" }, 1, { id: "arr-3" });
    expect(ja.isComplete).toBe(false);
    await ja.pump(c.now());
    await c.refresh();
    expect(ja.summary.running).toBe(1);
    await c.terminate(ja.summary.members[0].instanceId!);
    await ja.pump(c.now());
    expect(ja.isComplete).toBe(true);
  });
});
