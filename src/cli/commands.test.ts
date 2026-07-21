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
