import { describe, it, expect } from "vitest";
import { runCommand, type ShellCtx } from "./commands.js";
import { MockProvider } from "../core/mock.js";
import { SpawnClient } from "../core/client.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function ctx(): ShellCtx {
  return { provider: new MockProvider(), now: () => T0, confirm: async () => true };
}

/** A shell bound to a real SpawnClient (needed by the sweep command). */
function clientCtx(): { ctx: ShellCtx; client: SpawnClient } {
  const client = new SpawnClient({ provider: new MockProvider(), startMs: T0, clock: 1 });
  return {
    client,
    ctx: {
      provider: client.activeProvider,
      now: () => client.now(),
      confirm: async () => true,
      client,
    },
  };
}

describe("CLI commands", () => {
  it("launch then list shows the instance", async () => {
    const c = ctx();
    const r = await runCommand("spawn launch job --ttl 4h --price-per-hour 0.153", c);
    expect(r.error).toBeFalsy();
    expect(r.lines.join("\n")).toContain("launched job");

    const l = await runCommand("list", c);
    expect(l.lines.join("\n")).toContain("job");
    expect(l.lines.join("\n")).toContain("running");
  });

  describe("launch cost-safety guard on a REAL backend (#55)", () => {
    // The CLI's `launch` calls provider.launch directly rather than going through
    // SpawnClient, so it needs its own coverage — that separate path is exactly
    // how the guard came to be stated twice and inconsistently.
    function realCtx(confirm: (m: string) => Promise<boolean> = async () => true): ShellCtx {
      const provider = new MockProvider();
      Object.defineProperty(provider, "isReal", { value: true });
      return { provider, now: () => T0, confirm };
    }

    it("refuses a launch with no bound at all, and suggests both real bounds", async () => {
      const r = await runCommand("launch naked", realCtx());
      expect(r.error).toBe(true);
      const out = r.lines.join("\n");
      expect(out).toMatch(/bill indefinitely/);
      expect(out).toMatch(/--ttl 4h/);
      expect(out).toMatch(/--idle-timeout/); // was absent: the refused-but-valid bound
    });

    it("accepts --idle-timeout alone", async () => {
      const r = await runCommand("launch idle --idle-timeout 1h", realCtx());
      expect(r.error).toBeFalsy();
      expect(r.lines.join("\n")).toContain("launched idle");
    });

    it("accepts --cost-limit alone but prints the warning", async () => {
      const r = await runCommand("launch soft --cost-limit 10", realCtx());
      expect(r.error).toBeFalsy();
      const out = r.lines.join("\n");
      expect(out).toContain("launched soft");
      expect(out).toMatch(/warning:/);
      expect(out).toMatch(/spored/);
    });

    it("prints no warning when --ttl is given", async () => {
      const r = await runCommand("launch fine --ttl 4h --cost-limit 10", realCtx());
      expect(r.lines.join("\n")).not.toMatch(/warning:/);
    });

    it("--no-timeout requires an acknowledgement, and aborts when declined", async () => {
      // Matching Go, where --no-timeout means "disabling the cost guardrails is an
      // explicit, acknowledged choice" (cmd/zombie_guard.go:58). A flag on its own
      // can be a typo or a copy-pasted command line.
      const r = await runCommand("launch forced --no-timeout", realCtx(async () => false));
      expect(r.error).toBe(true);
      expect(r.lines.join("\n")).toMatch(/aborted/);
    });

    it("--no-timeout proceeds when acknowledged", async () => {
      const r = await runCommand("launch forced --no-timeout", realCtx(async () => true));
      expect(r.error).toBeFalsy();
      expect(r.lines.join("\n")).toContain("launched forced");
    });

    it("--no-timeout --yes skips the prompt", async () => {
      let asked = false;
      const c = realCtx(async () => {
        asked = true;
        return true;
      });
      const r = await runCommand("launch forced --no-timeout --yes", c);
      expect(r.error).toBeFalsy();
      expect(asked).toBe(false);
    });

    it("--no-timeout works BEFORE the instance name too", async () => {
      // Regression: --no-timeout wasn't in BOOLEAN_FLAGS, so in this word order
      // parseArgs consumed "forced" as the flag's value — the instance name was
      // lost and the flag read false. It failed safe (refused), but was inert.
      const r = await runCommand("launch --no-timeout forced --yes", realCtx());
      expect(r.error).toBeFalsy();
      expect(r.lines.join("\n")).toContain("launched forced");
    });

    it("an unbounded MOCK launch neither refuses nor prompts", async () => {
      let asked = false;
      const c: ShellCtx = {
        ...ctx(),
        confirm: async () => {
          asked = true;
          return true;
        },
      };
      const r = await runCommand("launch sim", c);
      expect(r.error).toBeFalsy();
      expect(asked).toBe(false);
      expect(r.lines.join("\n")).not.toMatch(/warning:/);
    });
  });

  it("rejects invalid duration", async () => {
    const r = await runCommand("launch job --ttl notaduration", ctx());
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("invalid --ttl");
  });

  it("launch --session-timeout stamps the spawn:session-timeout tag", async () => {
    const c = ctx();
    const r = await runCommand("launch job --ttl 4h --session-timeout 30m", c);
    expect(r.error).toBeFalsy();
    const inst = await c.provider.get("job");
    expect(inst?.tags["spawn:session-timeout"]).toBe("30m");
  });

  it("rejects an invalid --session-timeout duration", async () => {
    const r = await runCommand("launch job --session-timeout huh", ctx());
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("invalid --session-timeout");
  });

  it("rejects invalid on-complete", async () => {
    const r = await runCommand("launch job --on-complete explode", ctx());
    expect(r.error).toBe(true);
  });

  it("status reports TTL and cost", async () => {
    const c = ctx();
    await runCommand("launch job --ttl 2h --price-per-hour 1 --cost-limit 5", c);
    const r = await runCommand("status job", c);
    const out = r.lines.join("\n");
    expect(out).toContain("ttl:");
    expect(out).toContain("cost:");
    expect(out).toContain("limit $5");
  });

  it("extend moves the deadline", async () => {
    const c = ctx();
    await runCommand("launch job --ttl 1h", c);
    const r = await runCommand("extend job 3h", c);
    expect(r.error).toBeFalsy();
    expect(r.lines.join("\n")).toContain("extended job by 3h");
  });

  describe("extend safety floor + tag pair (#54)", () => {
    /** A shell whose clock the test can move forward, to make an instance overdue. */
    function movableCtx(): { c: ShellCtx; setNow: (ms: number) => void } {
      let now = T0;
      const provider = new MockProvider();
      return {
        c: { provider, now: () => now, confirm: async () => true },
        setNow: (ms) => {
          now = ms;
        },
      };
    }

    it("rescues an OVERDUE instance instead of leaving its deadline in the past", async () => {
      const { c, setNow } = movableCtx();
      await runCommand("launch job --ttl 1h", c); // due T0+1h
      setNow(T0 + 3 * 3600_000); // 2h overdue — spored never reaped it
      const r = await runCommand("extend job 1h", c);
      expect(r.error).toBeFalsy();

      const i = (await c.provider.get("job"))!;
      // Unclamped this was T0+2h — an hour BEFORE now, so the reaper would kill it
      // on its next pass despite the CLI reporting success.
      expect(i.ttlDeadlineMs).toBe(T0 + 4 * 3600_000);
      expect(i.ttlDeadlineMs).toBeGreaterThan(c.now());
    });

    it("says the extension was applied from now, rather than reporting bare success", async () => {
      const { c, setNow } = movableCtx();
      await runCommand("launch job --ttl 1h", c);
      setNow(T0 + 3 * 3600_000);
      const out = (await runCommand("extend job 1h", c)).lines.join("\n");
      expect(out).toMatch(/already expired/);
      expect(out).toMatch(/from now/);
    });

    it("adds no note when the instance was still live", async () => {
      const c = ctx();
      await runCommand("launch job --ttl 4h", c);
      const out = (await runCommand("extend job 1h", c)).lines.join("\n");
      expect(out).not.toMatch(/already expired/);
    });

    it("updates spawn:ttl too, so the two TTL tags don't disagree", async () => {
      const c = ctx();
      await runCommand("launch job --ttl 1h", c);
      await runCommand("extend job 2h", c);
      const i = (await c.provider.get("job"))!;
      expect(i.tags["spawn:ttl"]).toBe("3h");
      // And the pair is self-consistent: launch + ttl === deadline.
      expect(i.launchTimeMs + i.ttlMs).toBe(i.ttlDeadlineMs);
    });

    it("extends an instance carrying only spawn:ttl (no absolute deadline tag)", async () => {
      const c = ctx();
      await runCommand("launch job --ttl 1h", c);
      // Drop the deadline tag, as an instance launched by an older/other writer
      // might be. The old `!i.ttlDeadlineMs` gate rejected these outright.
      const i0 = (await c.provider.get("job"))!;
      i0.tags = { ...i0.tags, "spawn:ttl-deadline": "" };
      i0.ttlDeadlineMs = 0;
      const r = await runCommand("extend job 2h", c);
      expect(r.error).toBeFalsy();
      expect((await c.provider.get("job"))!.ttlDeadlineMs).toBe(T0 + 3 * 3600_000);
    });

    /** A real-looking ctx whose reloadAgent the test controls (or omits entirely). */
    function reloadCtx(
      reloadAgent?: (id: string) => Promise<{ ok: boolean; detail: string }>,
    ): ShellCtx {
      const provider = new MockProvider() as MockProvider & {
        isReal: boolean;
        reloadAgent?: typeof reloadAgent;
      };
      Object.defineProperty(provider, "isReal", { value: true });
      if (reloadAgent) provider.reloadAgent = reloadAgent;
      return { provider, now: () => T0, confirm: async () => true };
    }

    it("reloads spored after a successful extend, and reports it", async () => {
      const seen: string[] = [];
      const c = reloadCtx(async (id) => {
        seen.push(id);
        return { ok: true, detail: "reload requested via SSM (command abc)" };
      });
      await runCommand("launch job --ttl 1h --idle-timeout 30m", c);
      const i = (await c.provider.get("job"))!;
      const out = (await runCommand("extend job 2h", c)).lines.join("\n");
      expect(seen).toEqual([i.instanceId]);
      expect(out).toContain("reload requested via SSM");
    });

    it("still SUCCEEDS when the reload fails, and names the manual command", async () => {
      // The tag write is the durable part and it already landed; a failed nudge
      // must not turn a completed extend into an error. But it must be stated —
      // silence here reads as "spored has the new deadline", which it may not.
      const c = reloadCtx(async () => ({ ok: false, detail: "ssm:SendCommand failed: not found" }));
      await runCommand("launch job --ttl 1h --idle-timeout 30m", c);
      const r = await runCommand("extend job 2h", c);
      expect(r.error).toBeFalsy();
      const out = r.lines.join("\n");
      expect(out).toContain("extended job by 2h");
      expect(out).toMatch(/could not reload spored/);
      expect(out).toMatch(/5 minutes/); // says how long the stale window is
      expect(out).toMatch(/spored reload/); // names the manual fix
      // The hint has to be copy-pasteable: it names a login user, not a bare host.
      expect(out).toMatch(/ssh \S+@\S+ 'sudo spored reload'/);
      // And the tag still went out.
      expect((await c.provider.get("job"))!.ttlDeadlineMs).toBe(T0 + 3 * 3600_000);
    });

    it("uses spawn:local-username in the manual hint, not a hardcoded ec2-user", async () => {
      // Go's connect prefers this tag (cmd/connect.go:135); a hint naming a user
      // that doesn't exist on the box is a hint that fails when it's followed.
      const c = reloadCtx(async () => ({ ok: false, detail: "denied" }));
      await runCommand("launch job --ttl 1h --idle-timeout 30m", c);
      const i = (await c.provider.get("job"))!;
      await c.provider.setTags(i.instanceId, { "spawn:local-username": "rocky" });
      const out = (await runCommand("extend job 2h", c)).lines.join("\n");
      expect(out).toMatch(/ssh rocky@/);
    });

    it("says the backend cannot reload, rather than implying it did", async () => {
      // Absence of the capability is not success. A provider with no channel to
      // the box (substrate, a future provider) must produce a stated gap.
      const c = reloadCtx(undefined);
      await runCommand("launch job --ttl 1h --idle-timeout 30m", c);
      const out = (await runCommand("extend job 2h", c)).lines.join("\n");
      expect(out).toMatch(/can't reload spored/);
      expect(out).toMatch(/~5 minutes/);
    });

    it("attempts no reload on a mock backend — there is no box to reload", async () => {
      let called = false;
      const provider = new MockProvider() as MockProvider & { reloadAgent: () => Promise<never> };
      provider.reloadAgent = async () => {
        called = true;
        throw new Error("must not be called");
      };
      const c: ShellCtx = { provider, now: () => T0, confirm: async () => true };
      await runCommand("launch job --ttl 1h", c);
      const r = await runCommand("extend job 2h", c);
      expect(r.error).toBeFalsy();
      expect(called).toBe(false);
    });

    it("still refuses an instance with no TTL in any form", async () => {
      const c = ctx();
      await runCommand("launch job --idle-timeout 30m", c);
      const r = await runCommand("extend job 1h", c);
      expect(r.error).toBe(true);
      expect(r.lines.join("\n")).toContain("no TTL to extend");
    });
  });

  it("terminate honors confirm=false", async () => {
    const c: ShellCtx = { ...ctx(), confirm: async () => false };
    await runCommand("launch job --ttl 1h", c);
    const r = await runCommand("terminate job", c);
    expect(r.lines.join("\n")).toContain("aborted");
  });

  it("tokenizes quoted one-shot commands after --", async () => {
    const c = ctx();
    await runCommand("launch job --ttl 1h", c);
    const r = await runCommand("connect job -- 'echo hello world'", c);
    expect(r.lines.join("\n")).toContain("echo hello world");
  });

  it("status shows sweep membership and params for a swept instance", async () => {
    const { ctx: c, client } = clientCtx();
    client.startSweep({ grid: { alpha: [0.5] }, defaults: { ttl: "30m" } }, { name: "hp", id: "hp-x" });
    await client.step(1000);
    const r = await runCommand("status hp-0", c);
    const out = r.lines.join("\n");
    expect(out).toContain("sweep:");
    expect(out).toContain("hp-x");
    expect(out).toContain("alpha=0.5");
  });
});

describe("CLI sweep", () => {
  it("fans a --grid out into one instance per combination", async () => {
    const { ctx: c, client } = clientCtx();
    const r = await runCommand('sweep --grid "alpha=0.1,0.2 beta=1,2" --ttl 30m --name hp', c);
    expect(r.error).toBeFalsy();
    expect(r.lines.join("\n")).toContain("4 members");
    await client.step(1000);
    const list = await client.refresh();
    expect(list).toHaveLength(4);
    expect(list.every((i) => i.sweep?.name === "hp")).toBe(true);
  });

  it("accepts an inline JSON spec (single-quoted so double-quotes survive)", async () => {
    const { ctx: c, client } = clientCtx();
    const r = await runCommand(
      `sweep '{"params":[{"instance_type":"t3.micro"},{"instance_type":"t3.small"}],"defaults":{"ttl":"30m"}}'`,
      c,
    );
    expect(r.error).toBeFalsy();
    await client.step(1000);
    expect((await client.refresh())).toHaveLength(2);
  });

  it("honors --max-concurrent in the launch plan", async () => {
    const { ctx: c, client } = clientCtx();
    const r = await runCommand('sweep --grid "n=1,2,3,4" --ttl 30m --max-concurrent 2', c);
    expect(r.lines.join("\n")).toContain("max 2 at a time");
    await client.step(1000);
    // Only 2 launched initially under the cap.
    expect((await client.refresh()).length).toBe(2);
  });

  it("rejects a malformed grid", async () => {
    const { ctx: c } = clientCtx();
    const r = await runCommand("sweep --grid bogus", c);
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("want key=v1,v2");
  });

  it("rejects invalid inline JSON", async () => {
    const { ctx: c } = clientCtx();
    const r = await runCommand("sweep {bad json", c);
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("invalid JSON spec");
  });

  it("errors with no spec at all", async () => {
    const { ctx: c } = clientCtx();
    const r = await runCommand("sweep", c);
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("inline JSON spec or --grid");
  });

  it("is unavailable without a bound client", async () => {
    const r = await runCommand('sweep --grid "n=1,2"', ctx());
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("no SpawnClient bound");
  });
});

describe("CLI queue", () => {
  const cfg = `'{"queue_name":"p","jobs":[{"job_id":"build","command":"make","timeout":"20m"},{"job_id":"test","command":"make test","timeout":"20m","depends_on":["build"]}],"on_failure":"stop"}'`;

  it("launches a job DAG in dependency order", async () => {
    const { ctx: c, client } = clientCtx();
    const r = await runCommand(`queue ${cfg}`, c);
    expect(r.error).toBeFalsy();
    const out = r.lines.join("\n");
    expect(out).toContain("2 jobs");
    expect(out).toContain("build → test");
    expect(out).toContain("stop on failure");

    await client.step(1000);
    // Only the dependency-free "build" job is running initially.
    const running = (await client.refresh()).filter((i) => i.state === "running");
    expect(running).toHaveLength(1);
    expect(running[0].sweep?.parameters.command).toBe("make");
  });

  it("rejects an invalid config", async () => {
    const { ctx: c } = clientCtx();
    const r = await runCommand(`queue '{"jobs":[]}'`, c);
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("at least one job");
  });

  it("rejects a circular dependency", async () => {
    const { ctx: c } = clientCtx();
    const bad = `'{"jobs":[{"job_id":"a","command":"x","timeout":"1m","depends_on":["b"]},{"job_id":"b","command":"y","timeout":"1m","depends_on":["a"]}]}'`;
    const r = await runCommand(`queue ${bad}`, c);
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("circular dependency");
  });

  it("errors with no config", async () => {
    const { ctx: c } = clientCtx();
    const r = await runCommand("queue", c);
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("inline JSON queue config");
  });

  it("is unavailable without a bound client", async () => {
    const r = await runCommand(`queue ${cfg}`, ctx());
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("no SpawnClient bound");
  });
});

describe("CLI orphans", () => {
  it("lists orphans, then reaps with --reap", async () => {
    // Launcher at T0 (ttl 1h → deadline T0+1h); orphans run via a ctx whose
    // client clock is T0+2h (past deadline + grace), sharing the provider.
    const provider = new MockProvider();
    const launcher = new SpawnClient({ provider, startMs: T0, clock: 1 });
    await launcher.launch({ name: "zombie", ttl: "1h" });

    const client = new SpawnClient({ provider, startMs: T0 + 2 * 3600_000, clock: 1 });
    const ctx: ShellCtx = { provider, now: () => client.now(), confirm: async () => true, client };

    const listed = await runCommand("orphans", ctx);
    expect(listed.lines.join("\n")).toContain("1 orphan");
    expect(listed.lines.join("\n")).toContain("zombie");
    // Non-destructive without --reap.
    expect((await client.get("zombie"))!.state).toBe("running");

    const reaped = await runCommand("orphans --reap -y", ctx);
    expect(reaped.lines.join("\n")).toContain("reaped 1 orphan");
    expect((await client.get("zombie"))!.state).toBe("terminated");
  });

  it("reports none when all instances are within TTL", async () => {
    const { ctx: c } = clientCtx();
    await runCommand("launch fresh --ttl 4h", c);
    const r = await runCommand("orphans", c);
    expect(r.lines.join("\n")).toContain("no orphans");
  });

  it("is unavailable without a bound client", async () => {
    const r = await runCommand("orphans", ctx());
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("no SpawnClient bound");
  });
});

describe("CLI array (job arrays)", () => {
  it("launches N indexed members with the launch flags", async () => {
    const { ctx: c, client } = clientCtx();
    const r = await runCommand("array compute --count 3 --ttl 1h --instance-type t3.micro", c);
    expect(r.error).toBeFalsy();
    expect(r.lines.join("\n")).toContain("3 members");
    await client.step(1000);
    const list = await client.refresh();
    expect(list).toHaveLength(3);
    expect(list.every((i) => i.jobArray?.name === "compute")).toBe(true);
    expect(new Set(list.map((i) => i.jobArray!.index))).toEqual(new Set([0, 1, 2]));
  });

  it("honors --max-concurrent", async () => {
    const { ctx: c, client } = clientCtx();
    const r = await runCommand("array j --count 4 --ttl 5m --max-concurrent 2", c);
    expect(r.lines.join("\n")).toContain("max 2 at a time");
    await client.step(1000);
    expect((await client.refresh()).length).toBe(2);
  });

  it("status shows job-array membership", async () => {
    const { ctx: c, client } = clientCtx();
    await runCommand("array compute --count 2 --ttl 1h", c);
    await client.step(1000);
    const r = await runCommand("status compute-0", c);
    expect(r.lines.join("\n")).toContain("job array:");
    expect(r.lines.join("\n")).toContain("compute");
  });

  it("rejects a missing or invalid --count", async () => {
    const { ctx: c } = clientCtx();
    expect((await runCommand("array c", c)).error).toBe(true);
    expect((await runCommand("array c --count 0", c)).error).toBe(true);
    expect((await runCommand("array c --count abc", c)).error).toBe(true);
  });

  it("requires a name", async () => {
    const { ctx: c } = clientCtx();
    const r = await runCommand("array --count 2", c);
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("name is required");
  });

  it("is unavailable without a bound client", async () => {
    const r = await runCommand("array c --count 2", ctx());
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("no SpawnClient bound");
  });
});

describe("CLI on-idle + lifecycle hooks", () => {
  it("--on-idle hibernate sets the hibernate-on-idle tag", async () => {
    const c = ctx();
    await runCommand("launch job --ttl 4h --idle-timeout 30m --on-idle hibernate", c);
    expect((await c.provider.get("job"))!.tags["spawn:hibernate-on-idle"]).toBe("true");
  });

  it("--on-idle stop does not set hibernate-on-idle", async () => {
    const c = ctx();
    await runCommand("launch job --ttl 4h --idle-timeout 30m --on-idle stop", c);
    expect((await c.provider.get("job"))!.tags["spawn:hibernate-on-idle"]).toBeUndefined();
  });

  it("rejects --on-idle terminate with a pointer to --on-complete", async () => {
    const r = await runCommand("launch job --on-idle terminate", ctx());
    expect(r.error).toBe(true);
    expect(r.lines.join("\n")).toContain("on-complete terminate");
  });

  it("emits pre-stop + notify + active-processes tags a real spored honors", async () => {
    const c = ctx();
    await runCommand(
      'launch job --ttl 4h --pre-stop "sync.sh" --pre-stop-timeout 2m --notify-url https://x --notify-platform slack --active-processes python,rsync',
      c,
    );
    const t = (await c.provider.get("job"))!.tags;
    expect(t["spawn:pre-stop"]).toBe("sync.sh");
    expect(t["spawn:pre-stop-timeout"]).toBe("2m");
    expect(t["spawn:notify-url"]).toBe("https://x");
    expect(t["spawn:notify-platform"]).toBe("slack");
    expect(t["spawn:active-processes"]).toBe("python,rsync");
  });

  it("status surfaces the hooks", async () => {
    const c = ctx();
    await runCommand('launch job --ttl 4h --pre-stop "sync.sh" --notify-url https://x', c);
    const out = (await runCommand("status job", c)).lines.join("\n");
    expect(out).toContain("pre-stop:");
    expect(out).toContain("notify:");
  });

  describe("status notices (#56)", () => {
    it("surfaces a failed DNS registration with spored's diagnostic", async () => {
      // The headline case: before this, spored recorded WHY registration failed
      // into a tag the browser already fetched, and nothing ever read it — so a
      // user got a hostname that never resolves and no explanation.
      const c = ctx();
      await runCommand("launch job --ttl 4h", c);
      const i = (await c.provider.get("job"))!;
      await c.provider.setTags(i.instanceId, {
        "spawn:dns-status": "failed",
        "spawn:dns-error": "403 from function URL",
      });
      const out = (await runCommand("status job", c)).lines.join("\n");
      expect(out).toContain("DNS registration failed");
      expect(out).toContain("403 from function URL");
    });

    it("prints the worst-case bill, not only the cost so far", async () => {
      // `status` already showed accumulated cost; the ceiling is the number that
      // tells a user whether to worry.
      const c = ctx();
      await runCommand("launch job --ttl 4h --price-per-hour 2", c);
      const out = (await runCommand("status job", c)).lines.join("\n");
      expect(out).toContain("lifecycle protection:");
      expect(out).toContain("max compute cost:");
      expect(out).toContain("$8.00");
      expect(out).toContain("compute only");
    });

    it("warns about an Elastic IP billing on a stopped instance", async () => {
      const c: ShellCtx = {
        ...ctx(),
        lookupEip: async () => ({
          eip: { publicIp: "52.1.2.3", allocationId: "eipalloc-abc" },
        }),
      };
      await runCommand("launch job --ttl 4h", c);
      await runCommand("stop job -y", c);
      const out = (await runCommand("status job", c)).lines.join("\n");
      expect(out).toContain("keeps billing");
      expect(out).toContain("release-address --allocation-id eipalloc-abc");
    });

    it("reports a failed EIP lookup as a gap, not as 'none attached'", async () => {
      const c: ShellCtx = {
        ...ctx(),
        lookupEip: async () => ({ eip: null, error: "UnauthorizedOperation" }),
      };
      await runCommand("launch job --ttl 4h", c);
      await runCommand("stop job -y", c);
      const out = (await runCommand("status job", c)).lines.join("\n");
      expect(out).toContain("could not check for an attached Elastic IP");
      expect(out).toContain("UnauthorizedOperation");
    });

    it("uses the PROVIDER's lookup when the shell supplies no override", async () => {
      // Without this fallback the notice would exist but never fire in the real
      // app: terminal.ts builds a bare ShellCtx, so nothing would set lookupEip.
      const provider = new MockProvider() as MockProvider & {
        lookupElasticIp: (id: string) => Promise<{ eip: { publicIp: string; allocationId: string } }>;
      };
      provider.lookupElasticIp = async () => ({
        eip: { publicIp: "52.9.9.9", allocationId: "eipalloc-prov" },
      });
      const c: ShellCtx = { provider, now: () => T0, confirm: async () => true };
      await runCommand("launch job --ttl 4h", c);
      await runCommand("stop job -y", c);
      const out = (await runCommand("status job", c)).lines.join("\n");
      expect(out).toContain("eipalloc-prov");
    });

    it("reports an available spored upgrade when the caller knows the latest", async () => {
      const c: ShellCtx = { ...ctx(), latestSporedVersion: "1.5.0" };
      await runCommand("launch job --ttl 4h", c);
      const i = (await c.provider.get("job"))!;
      await c.provider.setTags(i.instanceId, { "spawn:spored-version": "1.2.0" });
      const out = (await runCommand("status job", c)).lines.join("\n");
      expect(out).toContain("spored upgrade available: v1.2.0 → v1.5.0");
    });

    it("makes no EIP or upgrade claim when the caller supplied neither input", async () => {
      // No lookupEip and no latestSporedVersion: both notices are absent, rather
      // than asserting "no EIP attached" / "up to date" on no evidence.
      const c = ctx();
      await runCommand("launch job --ttl 4h", c);
      const out = (await runCommand("status job", c)).lines.join("\n");
      expect(out).not.toContain("Elastic IP");
      expect(out).not.toContain("upgrade available");
      expect(out).toContain("lifecycle protection:");
    });

    it("marks the deadline past due rather than showing negative time left", async () => {
      let now = T0;
      const c: ShellCtx = {
        provider: new MockProvider(),
        now: () => now,
        confirm: async () => true,
      };
      await runCommand("launch job --ttl 1h", c);
      now = T0 + 5 * 3600_000;
      const out = (await runCommand("status job", c)).lines.join("\n");
      expect(out).toContain("past due — terminates on next check");
      // Caught by driving the CLI, not by the suite: humanRemaining() already
      // returns "expired", so the older ttl line read "expired left".
      expect(out).toContain("1h — expired (terminates)");
      expect(out).not.toContain("expired left");
    });
  });
});
