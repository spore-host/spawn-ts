import { describe, it, expect } from "vitest";
import { buildSweep, generateSweepId, Sweep } from "./sweep.js";
import { SpawnClient } from "./client.js";
import { MockProvider } from "./mock.js";
import { tag, PARAM_TAG_PREFIX } from "./tags.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function client() {
  return new SpawnClient({ provider: new MockProvider(), startMs: T0, clock: 1 });
}

describe("generateSweepId", () => {
  it("has the <name>-<YYYYMMDD>-<6 digits> shape and is deterministic", () => {
    const id = generateSweepId("hp", T0);
    expect(id).toMatch(/^hp-\d{8}-\d{6}$/);
    expect(generateSweepId("hp", T0)).toBe(id);
  });
});

describe("buildSweep", () => {
  it("resolves members, assigns index/size, and maps known keys to launch fields", () => {
    const built = buildSweep(
      {
        defaults: { region: "us-west-2", ttl: "30m" },
        params: [
          { instance_type: "t3.micro", alpha: 0.1 },
          { instance_type: "t3.small", alpha: 0.2, spot: true },
        ],
      },
      { name: "hp", id: "hp-fixed" },
    );

    expect(built.size).toBe(2);
    expect(built.id).toBe("hp-fixed");

    const m0 = built.members[0].input;
    expect(m0.instanceType).toBe("t3.micro");
    expect(m0.region).toBe("us-west-2");
    expect(m0.ttl).toBe("30m");
    expect(m0.name).toBe("hp-0");
    // Unknown key alpha rides along as a sweep parameter.
    expect(m0.sweep?.parameters).toEqual({ alpha: "0.1" });
    expect(m0.sweep).toMatchObject({ id: "hp-fixed", name: "hp", index: 0, size: 2 });

    const m1 = built.members[1].input;
    expect(m1.spot).toBe(true);
    expect(m1.sweep?.index).toBe(1);
  });

  it("member keys are unique and stable", () => {
    const built = buildSweep({ grid: { n: [1, 2, 3] } }, { id: "s1" });
    expect(built.members.map((m) => m.key)).toEqual(["s1#0", "s1#1", "s1#2"]);
  });
});

describe("Sweep + SpawnClient integration", () => {
  it("launches every member and stamps the spawn:sweep-* / spawn:param:* tags", async () => {
    const c = client();
    c.startSweep(
      { grid: { alpha: [0.1, 0.2, 0.3] }, defaults: { ttl: "30m" } },
      { name: "hp", id: "hp-1" },
    );
    // startSweep kicks the first pump asynchronously; a tick settles it.
    await c.step(1000);

    const list = await c.refresh();
    expect(list).toHaveLength(3);
    for (const inst of list) {
      expect(inst.tags[tag("sweep-id")]).toBe("hp-1");
      expect(inst.tags[tag("sweep-size")]).toBe("3");
      expect(inst.sweep?.name).toBe("hp");
      // The alpha axis became a spawn:param:alpha tag and decoded back.
      expect(inst.sweep?.parameters.alpha).toBeDefined();
      expect(inst.tags[`${PARAM_TAG_PREFIX}alpha`]).toBeDefined();
    }
    // Indexes 0..2 all present.
    expect(new Set(list.map((i) => i.sweep!.index))).toEqual(new Set([0, 1, 2]));
  });

  it("respects maxConcurrent, launching more as members complete", async () => {
    const c = client();
    const seen: number[] = [];
    c.on((e) => {
      if (e.type === "sweep") seen.push(e.summary.running);
    });
    // 4 members, cap 2, each self-terminates at a short TTL so slots free up.
    c.startSweep(
      { grid: { n: [1, 2, 3, 4] }, defaults: { ttl: "5m" } },
      { id: "s", maxConcurrent: 2 },
    );
    await c.step(1000);
    // Never more than the cap running at once.
    expect(Math.max(...seen)).toBeLessThanOrEqual(2);

    // Advance past the TTL repeatedly; the fan-out should drain to completion.
    for (let i = 0; i < 6; i++) await c.step(6 * 60_000);
    const all = await c.activeProvider.list(true);
    expect(all.filter((i) => i.state === "terminated")).toHaveLength(4);
    expect(c.activeSweeps()).toHaveLength(0);
  });

  it("emits a terminal 'sweep' event with done=true", async () => {
    const c = client();
    let doneEvt: unknown;
    c.on((e) => {
      if (e.type === "sweep" && e.done) doneEvt = e;
    });
    c.startSweep({ grid: { n: [1] }, defaults: { ttl: "5m" } }, { id: "s" });
    for (let i = 0; i < 3; i++) await c.step(6 * 60_000);
    expect(doneEvt).toBeTruthy();
  });

  it("Sweep.create builds a wrapper without registering it on the client", () => {
    const c = client();
    const sw = Sweep.create(c, { grid: { n: [1, 2] } }, { id: "s2" });
    expect(sw.size).toBe(2);
    expect(c.activeSweeps()).toHaveLength(0); // not auto-registered
  });

  it("a manually-created Sweep can be driven via pump() and reports progress", async () => {
    const c = client();
    const sw = Sweep.create(c, { grid: { n: [1] }, defaults: { ttl: "5m" } }, { id: "s3" });
    expect(sw.summary.pending).toBe(1);
    expect(sw.isComplete).toBe(false);

    await sw.pump(c.now());
    await c.refresh();
    expect(sw.summary.running).toBe(1);

    // Terminate it and pump once more → member reaches a terminal state.
    await c.terminate(sw.summary.members[0].instanceId!);
    await sw.pump(c.now());
    expect(sw.isComplete).toBe(true);
  });
});
