// spawn CLI command handlers. Each maps a parsed command line to provider
// calls, mirroring the real spawn subcommands (launch/list/status/connect/
// extend/stop/start/terminate). Output is returned as text lines so the same
// handlers work in the browser terminal and in tests.

import type { Provider } from "../core/provider.js";
import type { SpawnClient, LaunchInput } from "../core/client.js";
import type { LaunchSpec, ManagedInstance } from "../core/types.js";
import type { ParamSpec, ParamSet } from "../core/params.js";
import { parseGridShorthand } from "../core/params.js";
import { parseQueueConfig } from "../core/queue.js";
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
  /**
   * The SpawnClient, when the shell is bound to one (the terminal always is).
   * Required by `sweep`, which registers a monitor-driven fan-out. Commands that
   * only touch the provider don't need it.
   */
  client?: SpawnClient;
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
  "reap",
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
    case "sweep":
      return sweep(parsed, ctx);
    case "queue":
      return queue(parsed, ctx);
    case "orphans":
      return orphans(parsed, ctx);
    case "array":
      return array(parsed, ctx);
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
    "  sweep <spec> [flags]    fan a parameter grid out into many instances",
    "  queue <config> [flags]  launch a DAG of jobs as capacity/turn allows",
    "  orphans [--reap] [-y]   find (and optionally terminate) instances past their TTL",
    "  array <name> --count N  launch N indexed copies (job array) with the launch flags",
    "",
    "launch flags: --instance-type --region --ttl --idle-timeout --hibernate-on-idle",
    "              --cost-limit --price-per-hour --on-complete --spot --ami --key",
    "              --session-timeout (idle-SSH-shell auto-logout, e.g. 30m)",
    "",
    "sweep: <spec> is inline JSON ({\"params\":[...]} or {\"grid\":{...}}), or use",
    "       --grid 'lr=0.1,0.2 bs=32,64' for a quick cartesian product.",
    "       flags: --name --max-concurrent --launch-delay --ttl (default applied to all)",
    "",
    "queue: <config> is an inline JSON queue (jobs[] with depends_on/retry/timeout),",
    "       one instance per job launched in dependency order.",
    "       flags: --max-concurrent --launch-delay",
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
  const session = durFlag(p, "session-timeout");
  if (session.error) return err(session.error);

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
    sessionTimeoutMs: session.ms,
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
  if (i.sweep) {
    const params = Object.entries(i.sweep.parameters)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    lines.push(
      `  sweep:        ${i.sweep.name} [${i.sweep.index + 1}/${i.sweep.size}] ${i.sweep.id}`,
      ...(params ? [`  params:       ${params}`] : []),
    );
  }
  if (i.jobArray) {
    lines.push(
      `  job array:    ${i.jobArray.name} [${i.jobArray.index + 1}/${i.jobArray.size}] ${i.jobArray.id}`,
    );
  }
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

async function sweep(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  if (!ctx.client) {
    return err("sweep: not available in this shell (no SpawnClient bound)");
  }

  // Build the spec: --grid shorthand, or an inline JSON positional/flag.
  let spec: ParamSpec;
  const gridFlag = flagStr(p.flags, "grid");
  const jsonSpec = p.positionals[0] ?? flagStr(p.flags, "spec");
  if (gridFlag) {
    const grid = parseGridShorthand(gridFlag);
    if ("error" in grid) return err(`sweep: ${grid.error}`);
    spec = { grid: grid.value };
  } else if (jsonSpec) {
    try {
      spec = JSON.parse(jsonSpec) as ParamSpec;
    } catch (e) {
      return err(`sweep: invalid JSON spec — ${(e as Error).message}`);
    }
  } else {
    return err(
      "sweep: provide an inline JSON spec or --grid 'k=v1,v2 ...'",
      '  e.g. spawn sweep --grid "lr=0.01,0.1 bs=32,64" --ttl 30m --max-concurrent 2',
    );
  }

  // A --ttl (and friends) on the command line seeds the spec defaults so every
  // member inherits the same cost bound unless its own param set overrides it.
  const defaults: ParamSet = { ...(spec.defaults ?? {}) };
  const seed = (key: string, flag: string) => {
    const v = flagStr(p.flags, flag);
    if (v && !(key in defaults)) defaults[key] = v;
  };
  seed("ttl", "ttl");
  seed("idle_timeout", "idle-timeout");
  seed("instance_type", "instance-type");
  seed("region", "region");
  const priceStr = flagStr(p.flags, "price-per-hour");
  if (priceStr && !("price_per_hour" in defaults)) defaults.price_per_hour = Number(priceStr) || 0;
  if (flagBool(p.flags, "spot") && !("spot" in defaults)) defaults.spot = true;
  spec = { ...spec, defaults };

  const maxConcurrent = Number(flagStr(p.flags, "max-concurrent", "0")) || 0;
  const delayMs = (() => {
    const raw = flagStr(p.flags, "launch-delay");
    return raw ? parseDuration(raw) ?? 0 : 0;
  })();

  let sw;
  try {
    sw = ctx.client.startSweep(spec, {
      name: flagStr(p.flags, "name") || undefined,
      maxConcurrent,
      launchDelayMs: delayMs,
    });
  } catch (e) {
    return err(`sweep: ${(e as Error).message}`);
  }

  const s = sw.summary;
  return ok(
    `sweep ${sw.id} — ${sw.size} member${sw.size === 1 ? "" : "s"}`,
    `  ${maxConcurrent > 0 ? `max ${maxConcurrent} at a time` : "all at once"}` +
      `${delayMs > 0 ? `, ${formatDuration(delayMs)} between launches` : ""}`,
    `  launched ${s.running}, pending ${s.pending}${s.failed ? `, failed ${s.failed}` : ""}`,
    "  watch progress with 'list' (spawn:sweep-* tags are set on each instance)",
  );
}

async function queue(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  if (!ctx.client) {
    return err("queue: not available in this shell (no SpawnClient bound)");
  }
  const json = p.positionals[0] ?? flagStr(p.flags, "config");
  if (!json) {
    return err(
      "queue: provide an inline JSON queue config",
      '  e.g. spawn queue \'{"jobs":[{"job_id":"a","command":"echo hi","timeout":"5m"}]}\'',
    );
  }

  let cfg;
  try {
    cfg = parseQueueConfig(json);
  } catch (e) {
    return err(`queue: ${(e as Error).message}`);
  }

  const maxConcurrent = Number(flagStr(p.flags, "max-concurrent", "0")) || 0;
  const delayMs = (() => {
    const raw = flagStr(p.flags, "launch-delay");
    return raw ? parseDuration(raw) ?? 0 : 0;
  })();

  let q;
  try {
    q = ctx.client.startQueue(cfg, { maxConcurrent, launchDelayMs: delayMs });
  } catch (e) {
    return err(`queue: ${(e as Error).message}`);
  }

  const s = q.summary;
  return ok(
    `queue ${q.id} — ${q.size} job${q.size === 1 ? "" : "s"} (${cfg.onFailure ?? "continue"} on failure)`,
    `  order: ${q.order.join(" → ")}`,
    `  ${maxConcurrent > 0 ? `max ${maxConcurrent} at a time` : "all eligible at once"}` +
      `${delayMs > 0 ? `, ${formatDuration(delayMs)} between launches` : ""}`,
    `  launched ${s.running}, blocked ${s.blocked}${s.failed ? `, failed ${s.failed}` : ""}`,
    "  watch progress with 'list' (spawn:sweep-* tags mark queue membership)",
  );
}

async function orphans(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  if (!ctx.client) {
    return err("orphans: not available in this shell (no SpawnClient bound)");
  }
  await ctx.client.refresh();
  const found = ctx.client.findOrphans();
  if (found.length === 0) return ok("no orphans — all managed instances are within their TTL");

  const rows = found.map((o) => {
    const i = o.instance;
    return `  ${pad(i.name, 16)}${pad(i.instanceId, 21)}${pad(i.state, 10)}${Math.round(
      o.overdueByMs / 60_000,
    )}m past TTL`;
  });

  const reap = flagBool(p.flags, "reap");
  if (!reap) {
    return ok(
      `${found.length} orphan${found.length === 1 ? "" : "s"} (managed, live, past TTL — spored didn't reap them):`,
      ...rows,
      "",
      "re-run with --reap to terminate them (add -y to skip confirm)",
    );
  }

  const yes = flagBool(p.flags, "yes") || flagBool(p.flags, "y");
  if (!yes) {
    const proceed = await ctx.confirm(`terminate ${found.length} orphaned instance(s)? This is permanent.`);
    if (!proceed) return ok("aborted");
  }
  const reaped = await ctx.client.reapOrphans(found);
  return ok(`reaped ${reaped.length} orphan${reaped.length === 1 ? "" : "s"}:`, ...reaped.map((id) => `  ${id}`));
}

async function array(p: ParsedArgs, ctx: ShellCtx): Promise<CmdResult> {
  if (!ctx.client) {
    return err("array: not available in this shell (no SpawnClient bound)");
  }
  const name = p.positionals[0] ?? flagStr(p.flags, "name");
  if (!name) return err("array: a name is required (spawn array <name> --count N)");

  const count = Number(flagStr(p.flags, "count", "0"));
  if (!Number.isInteger(count) || count < 1) {
    return err("array: --count must be a positive integer");
  }

  // Base launch config from the same flags as `launch`.
  const ttl = durFlag(p, "ttl");
  if (ttl.error) return err(ttl.error);
  const idle = durFlag(p, "idle-timeout");
  if (idle.error) return err(idle.error);

  const base: LaunchInput = {
    name,
    instanceType: flagStr(p.flags, "instance-type") || undefined,
    region: flagStr(p.flags, "region") || undefined,
    ami: flagStr(p.flags, "ami") || undefined,
    keyPair: flagStr(p.flags, "key") || undefined,
    spot: flagBool(p.flags, "spot"),
    ttl: ttl.ms || 0,
    idleTimeout: idle.ms || 0,
    pricePerHour: Number(flagStr(p.flags, "price-per-hour", "0")) || 0,
    costLimit: Number(flagStr(p.flags, "cost-limit", "0")) || 0,
  };

  const maxConcurrent = Number(flagStr(p.flags, "max-concurrent", "0")) || 0;
  const delayMs = (() => {
    const raw = flagStr(p.flags, "launch-delay");
    return raw ? parseDuration(raw) ?? 0 : 0;
  })();

  let ja;
  try {
    ja = ctx.client.startJobArray(base, count, { name, maxConcurrent, launchDelayMs: delayMs });
  } catch (e) {
    return err(`array: ${(e as Error).message}`);
  }

  const s = ja.summary;
  return ok(
    `array ${ja.id} — ${ja.size} member${ja.size === 1 ? "" : "s"}`,
    `  ${maxConcurrent > 0 ? `max ${maxConcurrent} at a time` : "all at once"}` +
      `${delayMs > 0 ? `, ${formatDuration(delayMs)} between launches` : ""}`,
    `  launched ${s.running}, pending ${s.pending}${s.failed ? `, failed ${s.failed}` : ""}`,
    "  watch progress with 'list' (spawn:job-array-* tags mark membership)",
  );
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
