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

/** Fail the launches whose input name is in `names`; pass the rest through. */
function failLaunches(c: SpawnClient, names: string[]): void {
  const real = c.launch.bind(c);
  (c as unknown as { launch: SpawnClient["launch"] }).launch = ((input: LaunchInput) =>
    names.includes(input.name)
      ? Promise.reject(new Error(`no capacity for ${input.name}`))
      : real(input)) as SpawnClient["launch"];
}

describe("FanOut --min-viable (#52)", () => {
  it("clamps out of range exactly as Go does, rather than erroring", () => {
    const c = client();
    // Below 1 → 1; above the member count → the member count. Go clamps because
    // `--min-viable 200` on a 100-member array is an obvious "all of them".
    expect(new FanOut(c, members(4), { minViable: 0 }).minViable).toBe(1);
    expect(new FanOut(c, members(4), { minViable: -7 }).minViable).toBe(1);
    expect(new FanOut(c, members(4), { minViable: 99 }).minViable).toBe(4);
    expect(new FanOut(c, members(4), { minViable: 3 }).minViable).toBe(3);
    // Fractional truncates rather than half-satisfying a threshold.
    expect(new FanOut(c, members(4), { minViable: 2.7 }).minViable).toBe(2);
  });

  it("falls back to 1 for a non-finite threshold instead of NaN", () => {
    const c = client();
    // Number("x") is NaN. Comparing anything against NaN is false, so an
    // unguarded NaN would make nonViable permanently false — a silently disabled
    // guard, which is worse than a rejected one.
    expect(new FanOut(c, members(4), { minViable: NaN }).minViable).toBe(1);
    expect(new FanOut(c, members(4), { minViable: Infinity }).minViable).toBe(1);
  });

  it("defaults to 1 — any single member makes the set viable", async () => {
    const c = client();
    const f = new FanOut(c, members(3));
    expect(f.minViable).toBe(1);
    await f.pump(T0);
    expect(f.summary.nonViable).toBe(false);
  });

  it("is not non-viable merely because nothing has launched yet", () => {
    const c = client();
    // The important negative case: 0 running, 100 pending, threshold 50. A
    // predicate over *running* members would call this doomed and terminate a
    // perfectly healthy array on its first pump.
    const f = new FanOut(c, members(100), { minViable: 50 });
    expect(f.summary.running).toBe(0);
    expect(f.summary.nonViable).toBe(false);
    expect(f.summary.viableCandidates).toBe(100);
  });

  it("goes non-viable once the threshold is unreachable", async () => {
    const c = client();
    failLaunches(c, ["m0", "m1"]);
    const f = new FanOut(c, members(4), { minViable: 3 });
    await f.pump(T0);
    await c.refresh();
    // 2 of 4 lost → at most 2 can ever come up, below the 3 required.
    expect(f.summary.failed).toBe(2);
    expect(f.summary.nonViable).toBe(true);
    // And the gate latches: skipping the unstarted members drives
    // viableCandidates to 0, which keeps the verdict true rather than letting it
    // flicker back off. That monotonicity is what lets applyGating's fixpoint
    // loop terminate.
    expect(f.summary.skipped).toBe(2);
    expect(f.summary.viableCandidates).toBe(0);
    expect(f.summary.nonViable).toBe(true);
  });

  it("stays viable while the threshold is still reachable", async () => {
    const c = client();
    failLaunches(c, ["m0"]);
    const f = new FanOut(c, members(4), { minViable: 3 });
    await f.pump(T0);
    await c.refresh();
    // 1 lost, 3 up — exactly the threshold, so still viable.
    expect(f.summary.failed).toBe(1);
    expect(f.summary.nonViable).toBe(false);
  });

  it("does not turn non-viable as a successful array drains", async () => {
    const c = client();
    const f = new FanOut(c, members(2, { ttl: "5m" }), { minViable: 2 });
    await f.pump(T0);
    await c.refresh();
    expect(f.summary.running).toBe(2);
    // Both members finish their work. "completed" must count toward viability:
    // if a finished member read as a lost one, a fully successful array would
    // report non-viable at the end — and the response to that is to terminate.
    for (const m of f.summary.members) await c.terminate(m.instanceId!);
    await f.pump(T0 + 1000);
    expect(f.summary.completed).toBe(2);
    expect(f.isComplete).toBe(true);
    expect(f.summary.nonViable).toBe(false);
  });

  it("stops launching the rest once the set is doomed (fast-fail)", async () => {
    const c = client();
    // One slot at a time so the failures land before the survivors launch.
    failLaunches(c, ["m0", "m1"]);
    const f = new FanOut(c, members(4), { minViable: 3, maxConcurrent: 1 });
    for (let i = 0; i < 6; i++) await f.pump(T0 + i);
    await c.refresh();
    // m2/m3 are skipped, not launched: spending on instances for a job already
    // known to be undoable is the cost bug --min-viable exists to prevent.
    expect(f.summary.nonViable).toBe(true);
    expect(f.summary.skipped).toBe(2);
    expect(f.summary.running).toBe(0);
    expect(c.list()).toHaveLength(0);
  });

  it("reports survivors for the caller to wind down, without terminating them", async () => {
    const c = client();
    // m0 comes up first, then two failures push the set below the threshold —
    // so there is a live survivor at the moment the gate fails.
    failLaunches(c, ["m1", "m2"]);
    const f = new FanOut(c, members(4), { minViable: 3 });
    await f.pump(T0);
    await c.refresh();
    expect(f.summary.nonViable).toBe(true);
    // FanOut owns no lifecycle authority: m0 came up and is STILL RUNNING. It
    // names the survivor; JobArray decides to terminate it.
    expect(f.survivorIds).toEqual([f.status[0].instanceId]);
    expect(c.list().filter((i) => i.state === "running")).toHaveLength(1);
  });
});

describe("FanOut missingIndexes (#52)", () => {
  it("reports every index as missing before anything launches", () => {
    const c = client();
    // Truthful, not alarming: a pending slice has no worker *yet*. Read next to
    // pending/running. The alternative would report full coverage for an array
    // that has launched nothing, which is what this field exists to prevent.
    const f = new FanOut(c, members(3));
    expect(f.summary.missingIndexes).toEqual([0, 1, 2]);
  });

  it("is empty once every index has a live member", async () => {
    const c = client();
    const f = new FanOut(c, members(3));
    await f.pump(T0);
    await c.refresh();
    expect(f.summary.missingIndexes).toEqual([]);
  });

  it("names exactly the indexes that failed", async () => {
    const c = client();
    failLaunches(c, ["m1"]);
    const f = new FanOut(c, members(3));
    await f.pump(T0);
    await c.refresh();
    // The point of the field: "2 of 3 running" would hide *which* slice of the
    // workload has no worker, and for indexed work that's the only part that
    // matters.
    expect(f.summary.missingIndexes).toEqual([1]);
  });

  it("counts a completed index as missing, as Go's retryIndexes does", async () => {
    const c = client();
    const f = new FanOut(c, members(2, { ttl: "5m" }));
    await f.pump(T0);
    await c.refresh();
    expect(f.summary.missingIndexes).toEqual([]);
    await c.terminate(f.summary.members[0].instanceId!);
    await f.pump(T0 + 1000);
    // Go relaunches an index whose members are all in a non-active terminal
    // state; a terminated member's index has no live worker either.
    expect(f.summary.completed).toBe(1);
    expect(f.summary.missingIndexes).toEqual([0]);
  });
});
