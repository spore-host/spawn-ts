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
