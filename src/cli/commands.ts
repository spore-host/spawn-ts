// spawn CLI command handlers. Each maps a parsed command line to provider
// calls, mirroring the real spawn subcommands (launch/list/status/connect/
// extend/stop/start/terminate). Output is returned as text lines so the same
// handlers work in the browser terminal and in tests.

import type { Provider } from "../core/provider.js";
import type { LaunchSpec, ManagedInstance } from "../core/types.js";
import { parseDuration, formatDuration, humanRemaining } from "../core/duration.js";
import { accumulatedCost } from "../core/lifecycle.js";
import { tag } from "../core/tags.js";
import { parseArgs, flagStr, flagBool, type ParsedArgs } from "./args.js";

/** Ambient context a command runs in. */
export interface ShellCtx {
  provider: Provider;
  /** Current time in ms (the sim/real clock the UI owns). */
  now: () => number;
  /** Confirm a destructive action; UI supplies a prompt. `-y` bypasses. */
  confirm: (msg: string) => Promise<boolean>;
}

/** Result of running a command: text output + whether it errored. */
export interface CmdResult {
  lines: string[];
  error?: boolean;
}

const ok = (...lines: string[]): CmdResult => ({ lines });
const err = (...lines: string[]): CmdResult => ({ lines, error: true });

const BOOLEAN_FLAGS = new Set([
  "spot",
  "hibernate-on-idle",
  "yes",
  "y",
  "all",
  "json",
]);

/** Entry point: parse a raw line and dispatch. */
export async function runCommand(line: string, ctx: ShellCtx): Promise<CmdResult> {
  const argv = tokenizeLine(line);
  if (argv.length === 0) return ok();
  // Allow a leading "spawn" for muscle memory.
  const rest = argv[0] === "spawn" ? argv.slice(1) : argv;
  const parsed = parseArgs(rest, BOOLEAN_FLAGS);

  switch (parsed.command) {
    case "":
      return ok();
    case "help":
      return help();
    case "launch":
      return launch(parsed, ctx);
    case "list":
    case "ls":
      return list(parsed, ctx);
    case "status":
      return status(parsed, ctx);
    case "connect":
      return connect(parsed, ctx);
    case "extend":
      return extend(parsed, ctx);
    case "stop":
      return lifecycleOp("stop", parsed, ctx);
    case "start":
      return startOp(parsed, ctx);
    case "hibernate":
      return lifecycleOp("hibernate", parsed, ctx);
    case "terminate":
      return terminate(parsed, ctx);
    default:
      return err(`unknown command: ${parsed.command}`, `try "help"`);
  }
}

// tokenize re-exported through a thin wrapper to keep import surface small.
import { tokenize } from "./args.js";
function tokenizeLine(line: string): string[] {
  return tokenize(line);
}

function help(): CmdResult {
  return ok(
    "spawn — launch and manage self-terminating EC2 instances",
    "",
    "  launch <name> [flags]   launch an instance",
    "  list                    list managed instances",
    "  status <name>           show TTL, cost, state",
    "  connect <name>          show how to connect (SSH/SSM)",
    "  extend <name> <dur>     push out the TTL deadline",
    "  stop | start <name>     stop / start an instance",
    "  hibernate <name>        hibernate (RAM to disk)",
    "  terminate <name> [-y]   terminate (permanent)",
    "",
    "launch flags: --instance-type --region --ttl --idle-timeout --hibernate-on-idle",
    "              --cost-limit --price-per-hour --on-complete --spot --ami --key",
    "",
    "durations use Go form: 4h, 90m, 1h30m, 45s",
  );
}

async function launch(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  const name = p.positionals[0] ?? flagStr(p.flags, "name");
  if (!name) return err("launch: a name is required (spawn launch <name>)");

  const ttl = durFlag(p, "ttl");
  if (ttl.error) return err(ttl.error);
  const idle = durFlag(p, "idle-timeout");
  if (idle.error) return err(idle.error);
  const delay = durFlag(p, "completion-delay");
  if (delay.error) return err(delay.error);

  const onComplete = flagStr(p.flags, "on-complete") as LaunchSpec["onComplete"];
  if (onComplete && !["terminate", "stop", "hibernate", "exit"].includes(onComplete)) {
    return err(`launch: invalid --on-complete "${onComplete}" (terminate|stop|hibernate|exit)`);
  }

  const spec: LaunchSpec = {
    name,
    instanceType: flagStr(p.flags, "instance-type", "c6a.xlarge"),
    region: flagStr(p.flags, "region", ctx.provider.label.split(":")[1] ?? "us-east-1"),
    ami: flagStr(p.flags, "ami") || undefined,
    keyPair: flagStr(p.flags, "key") || undefined,
    spot: flagBool(p.flags, "spot"),
    ttlMs: ttl.ms,
    idleTimeoutMs: idle.ms,
    hibernateOnIdle: flagBool(p.flags, "hibernate-on-idle"),
    idleCpuPercent: Number(flagStr(p.flags, "idle-cpu", "0")) || 0,
    costLimit: Number(flagStr(p.flags, "cost-limit", "0")) || 0,
    onComplete: onComplete || "",
    completionFile: flagStr(p.flags, "completion-file"),
    completionDelayMs: delay.ms,
    pricePerHour: Number(flagStr(p.flags, "price-per-hour", "0")) || 0,
  };

  if (ctx.provider.isReal && spec.ttlMs === 0 && spec.costLimit === 0) {
    // Cost-safety guard: refuse an unbounded real launch unless explicitly forced.
    if (!flagBool(p.flags, "no-timeout")) {
      return err(
        "launch: refusing to launch a REAL instance with no --ttl and no --cost-limit.",
        "This would bill indefinitely. Add --ttl 4h (recommended) or pass --no-timeout to override.",
      );
    }
  }

  const inst = await ctx.provider.launch(spec, ctx.now());
  const bounds =
    spec.ttlMs > 0 ? `TTL ${formatDuration(spec.ttlMs)}` : "no TTL";
  return ok(
    `launched ${inst.name} (${inst.instanceId}) ${inst.instanceType} in ${inst.region}`,
    `  ${bounds}${spec.onComplete ? `, on-complete=${spec.onComplete}` : ""}` +
      `${spec.idleTimeoutMs ? `, idle ${formatDuration(spec.idleTimeoutMs)}` : ""}` +
      `${spec.costLimit ? `, cost-limit $${spec.costLimit}` : ""}`,
    ctx.provider.isReal ? "  backend: REAL AWS — this is billable" : "  backend: mock — not billable",
  );
}

async function list(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  const insts = await ctx.provider.list(flagBool(p.flags, "all"));
  if (insts.length === 0) return ok("no managed instances");
  const now = ctx.now();
  const rows = insts.map((i) => {
    const rem = i.ttlDeadlineMs ? humanRemaining(i.ttlDeadlineMs - now) : "—";
    const cost = i.pricePerHour ? `$${accumulatedCost(i).toFixed(3)}` : "—";
    return pad(i.name, 16) + pad(i.state, 12) + pad(i.instanceType, 12) + pad(rem, 10) + cost;
  });
  return ok(
    pad("NAME", 16) + pad("STATE", 12) + pad("TYPE", 12) + pad("TTL LEFT", 10) + "COST",
    ...rows,
  );
}

async function status(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  const inst = await requireInstance(p, ctx);
  if ("error" in inst) return inst.result;
  const i = inst.value;
  const now = ctx.now();
  const lines = [
    `${i.name}  (${i.instanceId})`,
    `  state:        ${i.state}`,
    `  type:         ${i.instanceType}   region: ${i.region}${i.spot ? "   spot" : ""}`,
    i.publicIp ? `  public ip:    ${i.publicIp}` : `  public ip:    —`,
  ];
  if (i.ttlDeadlineMs) {
    lines.push(
      `  ttl:          ${i.ttlMs ? formatDuration(i.ttlMs) : "?"} — ${humanRemaining(
        i.ttlDeadlineMs - now,
      )} left (terminates)`,
    );
  }
  if (i.idleTimeoutMs) {
    lines.push(
      `  idle:         ${formatDuration(i.idleTimeoutMs)} → ${i.hibernateOnIdle ? "hibernate" : "stop"}`,
    );
  }
  if (i.pricePerHour) {
    lines.push(
      `  cost:         $${accumulatedCost(i).toFixed(4)} @ $${i.pricePerHour}/hr` +
        (i.costLimit ? ` (limit $${i.costLimit})` : ""),
    );
  }
  if (i.onComplete) lines.push(`  on-complete:  ${i.onComplete} (${i.completionFile || "signal"})`);
  return ok(...lines);
}

async function connect(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  const inst = await requireInstance(p, ctx);
  if ("error" in inst) return inst.result;
  const i = inst.value;
  if (i.state !== "running") {
    return err(`connect: ${i.name} is ${i.state}; start it first (spawn start ${i.name})`);
  }
  // A browser can't open an interactive SSH session. Surface the exact command,
  // rather than pretending — same honesty the real tool shows for SSM.
  const host = i.publicIp || "<public-ip>";
  return ok(
    `${i.name} is running at ${host}`,
    "",
    "a browser can't open an interactive shell. connect from a terminal:",
    `  ssh ec2-user@${host}`,
    `  # or via SSM:  aws ssm start-session --target ${i.instanceId}`,
    ...(p.rest.length
      ? ["", "one-shot command to run:", `  ssh ec2-user@${host} -- ${p.rest.join(" ")}`]
      : []),
  );
}

async function extend(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  const name = p.positionals[0];
  const durStr = p.positionals[1];
  if (!name || !durStr) return err("extend: usage: spawn extend <name> <duration>");
  const ms = parseDuration(durStr);
  if (ms === null || ms <= 0) return err(`extend: invalid duration "${durStr}"`);

  const i = await ctx.provider.get(name);
  if (!i) return err(`extend: no instance named "${name}"`);
  if (!i.ttlDeadlineMs) return err(`extend: ${name} has no TTL to extend`);

  const newDeadline = i.ttlDeadlineMs + ms;
  await ctx.provider.setTags(i.instanceId, {
    [tag("ttl-deadline")]: new Date(newDeadline).toISOString(),
  });
  return ok(
    `extended ${name} by ${formatDuration(ms)}`,
    `  new deadline: ${humanRemaining(newDeadline - ctx.now())} from now`,
  );
}

async function startOp(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  const inst = await requireInstance(p, ctx);
  if ("error" in inst) return inst.result;
  await ctx.provider.start(inst.value.instanceId);
  return ok(`starting ${inst.value.name}`);
}

async function lifecycleOp(
  op: "stop" | "hibernate",
  p: ParsedArgs,
  ctx: ShellCtx,
): Promise<CmdResult> {
  const inst = await requireInstance(p, ctx);
  if ("error" in inst) return inst.result;
  if (op === "stop") await ctx.provider.stop(inst.value.instanceId, "user request");
  else await ctx.provider.hibernate(inst.value.instanceId);
  return ok(`${op === "stop" ? "stopping" : "hibernating"} ${inst.value.name}`);
}

async function terminate(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  const inst = await requireInstance(p, ctx);
  if ("error" in inst) return inst.result;
  const i = inst.value;
  const yes = flagBool(p.flags, "yes") || flagBool(p.flags, "y");
  if (!yes) {
    const proceed = await ctx.confirm(`terminate ${i.name} (${i.instanceId})? This is permanent.`);
    if (!proceed) return ok("aborted");
  }
  await ctx.provider.terminate(i.instanceId, "user request");
  return ok(`terminating ${i.name}`);
}

// ---- helpers ----

function durFlag(p: ParsedArgs, name: string): { ms: number; error?: string } {
  const raw = flagStr(p.flags, name);
  if (!raw) return { ms: 0 };
  const ms = parseDuration(raw);
  if (ms === null) return { ms: 0, error: `invalid --${name} duration "${raw}"` };
  return { ms };
}

type Resolved =
  | { value: ManagedInstance }
  | { error: true; result: CmdResult };

async function requireInstance(p: ParsedArgs, ctx: ShellCtx): Promise<Resolved> {
  const name = p.positionals[0];
  if (!name) return { error: true, result: err("a <name> is required") };
  const i = await ctx.provider.get(name);
  if (!i) return { error: true, result: err(`no instance named "${name}"`) };
  return { value: i };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}
