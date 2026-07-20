import { describe, it, expect } from "vitest";
import { runCommand, type ShellCtx } from "./commands.js";
import { MockProvider } from "../core/mock.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function ctx(): ShellCtx {
  return { provider: new MockProvider(), now: () => T0, confirm: async () => true };
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
});
