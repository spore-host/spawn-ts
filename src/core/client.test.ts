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

  describe("extend safety floor (#54)", () => {
    it("clamps an overdue instance forward of now, and says it did", async () => {
      // Two clients over one provider: the launcher at T0, the extender 2h after
      // the deadline — the #19 orphan situation extend is most used in.
      const provider = new MockProvider();
      const launcher = new SpawnClient({ provider, startMs: T0, clock: 1 });
      await launcher.launch({ name: "late", ttl: "1h" });

      const now = T0 + 3 * 3600_000;
      const rescuer = new SpawnClient({ provider, startMs: now, clock: 1 });
      const events: SpawnEvent[] = [];
      rescuer.on((e) => events.push(e));

      const deadline = await rescuer.extend("late", "1h");
      expect(deadline).toBe(now + 3600_000);
      // Not merely "later than before" — later than NOW, which is the property
      // that decides whether the reaper spares it.
      expect(deadline).toBeGreaterThan(rescuer.now());
      const info = events.find((e) => e.type === "info" && /already expired/.test(e.message));
      expect(info).toBeTruthy();
    });

    it("emits no clamp notice for a live instance", async () => {
      const c = client();
      await c.launch({ name: "job", ttl: "4h" });
      const events: SpawnEvent[] = [];
      c.on((e) => events.push(e));
      await c.extend("job", "1h");
      expect(events.some((e) => e.type === "info" && /already expired/.test(e.message))).toBe(false);
    });

    it("writes both TTL tags", async () => {
      const c = client();
      await c.launch({ name: "job", ttl: "1h" });
      await c.extend("job", "2h");
      const i = (await c.get("job"))!;
      expect(i.tags["spawn:ttl"]).toBe("3h");
      expect(i.tags["spawn:ttl-deadline"]).toBe(new Date(T0 + 3 * 3600_000).toISOString());
    });

    it("rejects a non-positive or unparseable duration", async () => {
      const c = client();
      await c.launch({ name: "job", ttl: "1h" });
      await expect(c.extend("job", "nonsense")).rejects.toThrow(/invalid duration/);
      await expect(c.extend("job", 0)).rejects.toThrow(/invalid duration/);
    });

    it("throws for an instance with no TTL at all", async () => {
      const c = client();
      await c.launch({ name: "job", idleTimeout: "30m" });
      await expect(c.extend("job", "1h")).rejects.toThrow(/no TTL to extend/);
    });

    describe("the spored reload nudge", () => {
      function reloadClient(
        reloadAgent?: (id: string) => Promise<{ ok: boolean; detail: string }>,
      ) {
        const p = new MockProvider() as MockProvider & {
          isReal: boolean;
          reloadAgent?: typeof reloadAgent;
        };
        Object.defineProperty(p, "isReal", { value: true });
        if (reloadAgent) p.reloadAgent = reloadAgent;
        return new SpawnClient({ provider: p, startMs: T0, clock: 1 });
      }

      it("requests a reload and reports the outcome", async () => {
        const c = reloadClient(async () => ({ ok: true, detail: "reload requested via SSM" }));
        await c.launch({ name: "job", ttl: "1h" });
        const events: SpawnEvent[] = [];
        c.on((e) => events.push(e));
        await c.extend("job", "2h");
        expect(events.some((e) => e.type === "info" && /reload requested/.test(e.message))).toBe(
          true,
        );
      });

      it("returns the new deadline even when the reload fails", async () => {
        // The extend succeeded — the tag is written. A failed nudge downgrades the
        // promptness, not the result, and must be surfaced as a gap.
        const c = reloadClient(async () => ({ ok: false, detail: "ssm:SendCommand failed: denied" }));
        await c.launch({ name: "job", ttl: "1h" });
        // A real provider pins the clock to wall time, so compare against the
        // deadline the launch actually produced rather than the sim epoch.
        const before = (await c.get("job"))!.ttlDeadlineMs;
        const events: SpawnEvent[] = [];
        c.on((e) => events.push(e));
        const deadline = await c.extend("job", "2h");
        expect(deadline).toBe(before + 2 * 3600_000);
        const info = events.find((e) => e.type === "info" && /could not reload/.test(e.message));
        expect(info).toBeTruthy();
        expect((info as { message: string }).message).toMatch(/IS saved/);
        expect((info as { message: string }).message).toMatch(/spored reload/);
      });

      it("does not call reloadAgent on a mock provider", async () => {
        let called = false;
        const p = new MockProvider() as MockProvider & { reloadAgent: () => Promise<never> };
        p.reloadAgent = async () => {
          called = true;
          throw new Error("must not be called");
        };
        const c = new SpawnClient({ provider: p, startMs: T0, clock: 1 });
        await c.launch({ name: "job", ttl: "1h" });
        await c.extend("job", "2h");
        expect(called).toBe(false);
      });
    });
  });

  it("refuses unbounded launch only on a real backend", async () => {
    const c = client(); // mock is not real → allowed
    await expect(c.launch({ name: "unbounded" })).resolves.toBeTruthy();
  });

  describe("the unbounded-launch guard on a REAL backend (#55)", () => {
    // A MockProvider that lies about being real, so the guard engages without any
    // AWS call. Only `isReal` differs — everything else is the mock's behaviour.
    function realish() {
      const p = new MockProvider() as MockProvider & { isReal: boolean };
      Object.defineProperty(p, "isReal", { value: true });
      return new SpawnClient({ provider: p, startMs: T0, clock: 1 });
    }

    it("refuses a launch with no bound whatsoever", async () => {
      await expect(realish().launch({ name: "naked" })).rejects.toThrow(/bill indefinitely/);
    });

    it("ACCEPTS an idleTimeout-only launch", async () => {
      // Previously refused, although Go auto-applies exactly this as its default.
      await expect(realish().launch({ name: "idle", idleTimeout: "1h" })).resolves.toBeTruthy();
    });

    it("permits a costLimit-only launch but emits a warning naming the risk", async () => {
      // The dangerous half: this used to pass the guard in total silence, so a
      // caller reasonably concluded the launch was bounded. It isn't — spored
      // enforces the cost limit, and an instance with no TTL is also skipped by
      // findOrphans (orphans.ts:46), so nothing catches it if spored never starts.
      const c = realish();
      const events: SpawnEvent[] = [];
      c.on((e) => events.push(e));
      await expect(c.launch({ name: "soft", costLimit: 10 })).resolves.toBeTruthy();
      const warn = events.find((e) => e.type === "warning" && e.rule === "unbounded");
      expect(warn).toBeTruthy();
      expect((warn as { message: string }).message).toMatch(/spored/);
    });

    it("emits no warning when a ttl is present", async () => {
      const c = realish();
      const events: SpawnEvent[] = [];
      c.on((e) => events.push(e));
      await c.launch({ name: "bounded", ttl: "4h", costLimit: 10 });
      expect(events.some((e) => e.type === "warning" && e.rule === "unbounded")).toBe(false);
    });

    it("allowUnbounded clears the refusal", async () => {
      await expect(
        realish().launch({ name: "forced", allowUnbounded: true }),
      ).resolves.toBeTruthy();
    });

    it("emits no unbounded warning on a MOCK launch — it bills nothing", async () => {
      const c = client();
      const events: SpawnEvent[] = [];
      c.on((e) => events.push(e));
      await c.launch({ name: "sim", costLimit: 10 });
      expect(events.some((e) => e.type === "warning" && e.rule === "unbounded")).toBe(false);
    });
  });

  it("signalComplete applies the on-complete action", async () => {
    const c = client();
    await c.launch({ name: "job", ttl: "4h", onComplete: "stop", completionFile: "/tmp/done" });
    await c.signalComplete("job");
    expect((await c.get("job"))!.state).toBe("stopped");
  });

  it("findOrphans + reapOrphans over a shared provider (spored-failed instance)", async () => {
    // Launch on a client at T0 (deadline T0+1h), then view via a second client
    // whose clock is at T0+2h — past deadline+grace — sharing the same provider.
    const provider = new MockProvider();
    const launcher = new SpawnClient({ provider, startMs: T0, clock: 1 });
    await launcher.launch({ name: "zombie", ttl: "1h", pricePerHour: 1 });

    const viewer = new SpawnClient({ provider, startMs: T0 + 2 * 3600_000, clock: 1 });
    await viewer.refresh();
    const orphans = viewer.findOrphans();
    expect(orphans).toHaveLength(1);
    expect(orphans[0].instance.name).toBe("zombie");

    const reaped = await viewer.reapOrphans(orphans);
    expect(reaped).toHaveLength(1);
    expect((await viewer.get("zombie"))!.state).toBe("terminated");
    expect(viewer.findOrphans()).toEqual([]);
  });

  describe("plugin declarations at launch (#53)", () => {
    it("passes declarations through to the spec the provider receives", async () => {
      const provider = new MockProvider();
      const seen: string[][] = [];
      const orig = provider.launch.bind(provider);
      provider.launch = async (spec, now) => {
        seen.push((spec.plugins ?? []).map((d) => d.ref));
        return orig(spec, now);
      };
      const c = new SpawnClient({ provider, startMs: T0, clock: 1 });
      await c.launch({
        name: "job",
        ttl: "4h",
        plugins: [{ ref: "jupyterlab" }, { ref: "docker", config: { rootless: "true" } }],
      });
      expect(seen).toEqual([["jupyterlab", "docker"]]);
    });

    it("refuses a plugin the launch-time path can't honour, before anything launches", async () => {
      // Diverges from Go, which writes the ref into /etc/spawn/plugins.json and
      // lets it park at StatusWaitingForPush on the box — a failure invisible from
      // the launch side. Nothing is billed yet here and the fix is a one-word
      // edit, so refusing costs a retry while launching costs an instance that
      // can't do the job it was launched for.
      const provider = new MockProvider();
      const c = new SpawnClient({ provider, startMs: T0, clock: 1 });
      await expect(
        c.launch({ name: "job", ttl: "4h", plugins: [{ ref: "tailscale" }] }),
      ).rejects.toThrow(/mints an auth key and pushes it/);
      expect(await provider.get("job")).toBeNull();
    });

    it("names every rejected plugin, not only the first", async () => {
      const c = client();
      await expect(
        c.launch({
          name: "job",
          ttl: "4h",
          plugins: [{ ref: "docker" }, { ref: "tailscale" }, { ref: "nonesuch" }],
        }),
      ).rejects.toThrow(/tailscale[\s\S]*nonesuch/);
    });

    it("launches normally when no plugins are declared", async () => {
      const c = client();
      const inst = await c.launch({ name: "job", ttl: "4h" });
      expect(inst.state).toBe("running");
    });
  });
});
