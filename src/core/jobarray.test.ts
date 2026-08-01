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

/** Fail the launches whose input name is in `names`; pass the rest through. */
function failLaunches(c: SpawnClient, names: string[]): void {
  const real = c.launch.bind(c);
  (c as unknown as { launch: SpawnClient["launch"] }).launch = ((input: LaunchInput) =>
    names.includes(input.name)
      ? Promise.reject(new Error(`no capacity for ${input.name}`))
      : real(input)) as SpawnClient["launch"];
}

describe("JobArray --min-viable (#52)", () => {
  it("terminates the survivors of a non-viable array", async () => {
    const c = client();
    // compute-1 and compute-2 can't come up, so at most 2 of 4 can — below the 3
    // required. compute-0 launched, and is exactly the instance that would
    // otherwise bill indefinitely for a job that cannot be done.
    failLaunches(c, ["compute-1", "compute-2"]);
    const ja = JobArray.create(c, { ...base, ttl: "1h" }, 4, { id: "arr", minViable: 3 });
    await ja.pump(c.now());
    await c.refresh();
    expect(ja.summary.nonViable).toBe(true);
    expect(c.list().filter((i) => i.state === "running")).toHaveLength(1);

    const { terminated, failed } = await ja.enforceViability();
    expect(terminated).toHaveLength(1);
    expect(failed).toEqual([]);
    expect(c.list().filter((i) => i.state === "running")).toHaveLength(0);
  });

  it("is a no-op on a viable array", async () => {
    const c = client();
    const ja = JobArray.create(c, { ...base, ttl: "1h" }, 3, { id: "arr", minViable: 2 });
    await ja.pump(c.now());
    await c.refresh();
    expect(ja.summary.nonViable).toBe(false);
    expect(await ja.enforceViability()).toEqual({ terminated: [], failed: [] });
    expect(c.list().filter((i) => i.state === "running")).toHaveLength(3);
  });

  it("reports each survivor once, even before the fan-out has reconciled", async () => {
    const c = client();
    failLaunches(c, ["compute-1"]);
    const ja = JobArray.create(c, { ...base, ttl: "1h" }, 2, { id: "arr", minViable: 2 });
    await ja.pump(c.now());
    await c.refresh();
    expect((await ja.enforceViability()).terminated).toHaveLength(1);
    // The member stays `running` in the fan-out's record until a pump reconciles
    // it, so a second call within the same tick still sees it as a survivor. It
    // must not be reported again: the caller turns each returned id into a
    // user-visible terminate event, and two events for one instance reads as two
    // instances wound down.
    expect(await ja.enforceViability()).toEqual({ terminated: [], failed: [] });
    await ja.pump(c.now());
    expect(ja.summary.completed).toBe(1);
    expect(await ja.enforceViability()).toEqual({ terminated: [], failed: [] });
  });

  it("reports a survivor once even when two drains overlap", async () => {
    const c = client();
    failLaunches(c, ["compute-1"]);
    const ja = JobArray.create(c, { ...base, ttl: "1h" }, 2, { id: "arr", minViable: 2 });
    await ja.pump(c.now());
    await c.refresh();
    // Two pumps genuinely overlap on the monitor loop — startJobArray kicks one
    // without awaiting it and the first tick starts another — so the claim has to
    // be taken before the terminate resolves, not after.
    const [a, b] = await Promise.all([ja.enforceViability(), ja.enforceViability()]);
    expect([...a.terminated, ...b.terminated]).toHaveLength(1);
    expect([...a.failed, ...b.failed]).toEqual([]);
  });

  it("retries a survivor whose termination failed, and reports it once it lands", async () => {
    const c = client();
    failLaunches(c, ["compute-1", "compute-2"]);
    const ja = JobArray.create(c, { ...base, ttl: "1h" }, 4, { id: "arr", minViable: 3 });
    await ja.pump(c.now());
    await c.refresh();
    const real = c.terminate.bind(c);
    (c as unknown as { terminate: SpawnClient["terminate"] }).terminate = (() =>
      Promise.reject(new Error("RequestLimitExceeded"))) as SpawnClient["terminate"];
    expect((await ja.enforceViability()).failed).toHaveLength(1);
    // Only successes are remembered — an instance that is still billing has to
    // stay retryable, or a transient throttle would strand it forever.
    (c as unknown as { terminate: SpawnClient["terminate"] }).terminate = real;
    expect((await ja.enforceViability()).terminated).toHaveLength(1);
    expect(c.list().filter((i) => i.state === "running")).toHaveLength(0);
  });

  it("reports an un-terminable survivor instead of swallowing it", async () => {
    const c = client();
    failLaunches(c, ["compute-1", "compute-2"]);
    const ja = JobArray.create(c, { ...base, ttl: "1h" }, 4, { id: "arr", minViable: 3 });
    await ja.pump(c.now());
    await c.refresh();
    (c as unknown as { terminate: SpawnClient["terminate"] }).terminate = (() =>
      Promise.reject(new Error("AccessDenied"))) as SpawnClient["terminate"];

    const { terminated, failed } = await ja.enforceViability();
    // A caller that believes the array was wound down when it wasn't is exactly
    // the wrong outcome to hide: this is the case where money keeps being spent.
    expect(terminated).toEqual([]);
    expect(failed).toHaveLength(1);
  });

  it("keeps terminating after one termination throws", async () => {
    const c = client();
    const ja = JobArray.create(c, { ...base, ttl: "1h" }, 3, { id: "arr", minViable: 3 });
    await ja.pump(c.now());
    await c.refresh();
    // Force non-viability with all three up, so there are 3 survivors to drain.
    const real = c.terminate.bind(c);
    const ids = ja.fanOut.survivorIds;
    (c as unknown as { terminate: SpawnClient["terminate"] }).terminate = ((
      id: string,
      reason?: string,
    ) => (id === ids[0] ? Promise.reject(new Error("boom")) : real(id, reason))) as SpawnClient["terminate"];
    (ja.fanOut as unknown as { minViable: number }).minViable = 4;

    const { terminated, failed } = await ja.enforceViability();
    // The goal is to stop the billing, so one unreachable instance must not
    // leave the other two running.
    expect(failed).toEqual([ids[0]]);
    expect(terminated).toHaveLength(2);
  });

  it("winds a non-viable array down automatically on the monitor loop", async () => {
    const c = client();
    failLaunches(c, ["compute-1", "compute-2"]);
    const actions: string[] = [];
    c.on((e) => {
      if (e.type === "action" && e.rule === "min-viable") actions.push(e.instance);
    });
    // startJobArray registers the array, so the drain needs no caller action —
    // forgetting it would mean instances billing for an undoable job.
    //
    // Two ticks, because the gate can only be evaluated after the pump that
    // records the failures: tick 1 lands them and flips nonViable, tick 2 drains
    // the survivor. The delay is one monitor interval, not unbounded.
    c.startJobArray({ ...base, ttl: "1h" }, 4, { id: "arr", minViable: 3 });
    await c.step(1000);
    await c.step(1000);
    // Exactly one event per drained instance. A tick can reach the drain twice
    // (launching refreshes the client, which re-fires the pump), and before
    // `drained` this emitted the same terminate twice — which reads to a
    // dashboard as two instances wound down.
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatch(/^i-/);
    expect(new Set(actions).size).toBe(actions.length);
    expect(c.list().filter((i) => i.state === "running")).toHaveLength(0);
  });

  it("warns on the monitor loop when a survivor could not be terminated", async () => {
    const c = client();
    failLaunches(c, ["compute-1", "compute-2"]);
    const warnings: string[] = [];
    c.on((e) => {
      if (e.type === "warning" && e.rule === "min-viable") warnings.push(e.message);
    });
    // Stubbed before the array starts, because the drain lands on the first tick
    // — the same tick the failures do.
    (c as unknown as { terminate: SpawnClient["terminate"] }).terminate = (() =>
      Promise.reject(new Error("AccessDenied"))) as SpawnClient["terminate"];
    c.startJobArray({ ...base, ttl: "1h" }, 4, { id: "arr", minViable: 3 });
    await c.step(1000);
    // A failed drain is precisely the case where money keeps being spent, so it
    // is the last thing that should be quiet.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("may still be billing");
    expect(c.list().filter((i) => i.state === "running")).toHaveLength(1);
  });

  it("does not drain a sweep or queue — --min-viable is a job-array concept", async () => {
    const c = client();
    const seen: string[] = [];
    c.on((e) => {
      if (e.type === "action" && e.rule === "min-viable") seen.push(e.instance);
    });
    c.startSweep({ grid: { alpha: [1, 2] } } as never, { name: "s", nowMs: T0 });
    await c.step(1000);
    expect(seen).toEqual([]);
  });
});

describe("job array MPI tags (#52)", () => {
  it("stamps every member when --mpi is set", () => {
    const built = buildJobArray(base, 3, { id: "arr", mpi: { enabled: true, processesPerNode: 4 } });
    // Set on every member, as Go sets it on the shared baseConfig before the
    // array fans out — so a reader can identify any single instance as part of an
    // MPI job without first resolving its array.
    for (const m of built.members) {
      expect(m.input.mpi).toEqual({ enabled: true, processesPerNode: 4 });
    }
  });

  it("omits processesPerNode when not given", () => {
    const built = buildJobArray(base, 1, { id: "arr", mpi: { enabled: true } });
    expect(built.members[0].input.mpi).toEqual({ enabled: true });
  });

  it("emits nothing for a disabled declaration", () => {
    const built = buildJobArray(base, 1, { id: "arr", mpi: { enabled: false } });
    expect(built.members[0].input.mpi).toBeUndefined();
  });

  it("preserves the base's own declaration when no option is given", () => {
    const built = buildJobArray({ ...base, mpi: { enabled: true, processesPerNode: 2 } }, 1, {
      id: "arr",
    });
    expect(built.members[0].input.mpi).toEqual({ enabled: true, processesPerNode: 2 });
  });

  it("an explicit --mpi wins over the base", () => {
    const built = buildJobArray({ ...base, mpi: { enabled: true, processesPerNode: 2 } }, 1, {
      id: "arr",
      mpi: { enabled: true, processesPerNode: 8 },
    });
    expect(built.members[0].input.mpi).toEqual({ enabled: true, processesPerNode: 8 });
  });

  it("reaches the launched instance's tags and decodes back", async () => {
    const c = client();
    c.startJobArray(base, 2, { id: "arr", mpi: { enabled: true, processesPerNode: 4 } });
    await c.step(1000);
    const list = await c.refresh();
    expect(list).toHaveLength(2);
    for (const inst of list) {
      expect(inst.tags[tag("mpi-enabled")]).toBe("true");
      expect(inst.tags[tag("mpi-processes-per-node")]).toBe("4");
      expect(inst.mpi).toEqual({ enabled: true, processesPerNode: 4 });
    }
  });

  it("leaves a non-MPI array's instances with no mpi tags at all", async () => {
    const c = client();
    c.startJobArray(base, 1, { id: "arr" });
    await c.step(1000);
    const [inst] = await c.refresh();
    // Absence, not "false": a missing tag means "not declared", and a literal
    // false would invite a reader to treat MPI-ness as always recorded.
    expect(inst.tags[tag("mpi-enabled")]).toBeUndefined();
    expect(inst.mpi).toBeUndefined();
  });
});
