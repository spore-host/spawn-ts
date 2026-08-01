// spawn CLI command handlers. Each maps a parsed command line to provider
// calls, mirroring the real spawn subcommands (launch/list/status/connect/
// extend/stop/start/terminate). Output is returned as text lines so the same
// handlers work in the browser terminal and in tests.

import type { Provider } from "../core/provider.js";
import type { SpawnClient, LaunchInput } from "../core/client.js";
import type { LaunchSpec, ManagedInstance, LifecycleHooks } from "../core/types.js";
import type { ParamSpec, ParamSet } from "../core/params.js";
import { parseGridShorthand } from "../core/params.js";
import { parseQueueConfig } from "../core/queue.js";
import { parseDuration, formatDuration, humanRemaining } from "../core/duration.js";
import { accumulatedCost, computeExtension, ttlDeadline } from "../core/lifecycle.js";
import { evaluateBounds } from "../core/bounds.js";
import { statusNotices, type ElasticIpLookup } from "../core/notices.js";
import {
  describePluginState,
  instancePlugins,
  LAUNCH_DECLARABLE_PLUGINS,
  validateDeclarations,
  type PluginDeclaration,
} from "../core/plugins.js";
import { parseArgs, flagStr, flagBool, flagList, type ParsedArgs } from "./args.js";

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
  /**
   * Optional override for `status`'s Elastic IP lookup. Defaults to the
   * provider's own `lookupElasticIp` when it has one, so the real app needs no
   * wiring; this exists so tests and embedders can supply their own without the
   * CLI importing the SDK.
   *
   * Absent on both means the notice is skipped entirely — distinct from a lookup
   * that runs and fails, which `status` reports as a gap.
   */
  lookupEip?: (instanceId: string) => Promise<ElasticIpLookup>;
  /**
   * Optional: the newest published spored version, for `status`'s upgrade
   * notice. A value, not a fetcher — the release lookup is the caller's call to
   * make (Go hits the GitHub API; a browser may not want to).
   */
  latestSporedVersion?: string;
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
  // `status NAME --plugins` — boolean, so "status --plugins job" doesn't eat the
  // instance name as its value (the --no-timeout bug below, same shape).
  "plugins",
  // Unregistered, `--no-timeout job` consumed "job" as the flag's VALUE (see
  // parseArgs: an unknown flag followed by a non-dash token takes it), so the
  // instance name vanished and flagBool() read false. It failed safe — the guard
  // refused the launch rather than allowing an unbounded one — but the flag was
  // silently inert in that word order.
  "no-timeout",
  // `array --mpi NAME 10` — boolean, or the array name is eaten as its value
  // (same shape as the --no-timeout bug above). Note --mpi-processes-per-node
  // deliberately stays a value flag; only the bare toggle is registered here.
  "mpi",
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
    "  status <name>           show TTL, cost, state (--plugins for plugin provenance)",
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
    "launch flags: --instance-type --region --ttl --idle-timeout --on-idle stop|hibernate",
    "              --cost-limit --price-per-hour --on-complete --spot --ami --key",
    "              --session-timeout (idle-SSH-shell auto-logout, e.g. 30m)",
    "  hooks (run by spored on the instance): --pre-stop <cmd> --pre-stop-timeout",
    "              --spot-webhook-url --webhook-correlation --notify-url --notify-platform",
    "              --active-processes <names>",
    "  --plugin <ref[@version]>  declare a plugin (repeatable; installed by spored at boot)",
    `              declarable: ${LAUNCH_DECLARABLE_PLUGINS.join(", ")}`,
    "              others need a local half and belong to the real CLI",
    "",
    "sweep: <spec> is inline JSON ({\"params\":[...]} or {\"grid\":{...}}), or use",
    "       --grid 'lr=0.1,0.2 bs=32,64' for a quick cartesian product.",
    "       flags: --name --max-concurrent --launch-delay --ttl (default applied to all)",
    "",
    "queue: <config> is an inline JSON queue (jobs[] with depends_on/retry/timeout),",
    "       one instance per job launched in dependency order.",
    "       flags: --max-concurrent --launch-delay",
    "",
    "array: flags: --count N --max-concurrent --launch-delay + the launch flags",
    "       --min-viable N   terminate the survivors if fewer than N members can",
    "                        come up (a 2-of-100 array is not a 2% success)",
    "       --mpi [--mpi-processes-per-node N]  stamp the spawn:mpi-* tags so the",
    "                        array is recognisable as MPI — tags only, no collective",
    "                        launch (see docs/execution-shapes.md)",
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

  // --on-idle stop|hibernate — the modern spelling of --hibernate-on-idle. Both
  // resolve to the same spawn:hibernate-on-idle tag (the idle daemon never
  // terminates; "terminate" is --on-complete's job). Mirrors the Go flags.
  const onIdle = flagStr(p.flags, "on-idle");
  if (onIdle && onIdle !== "stop" && onIdle !== "hibernate") {
    return err(
      `launch: invalid --on-idle "${onIdle}" (stop|hibernate)`,
      onIdle === "terminate" ? "  use --on-complete terminate to terminate on completion" : "",
    );
  }
  const hibernateOnIdle = onIdle === "hibernate" || flagBool(p.flags, "hibernate-on-idle");

  // Daemon-enforced lifecycle hooks (tag-emit only; spored runs them on the box).
  const preStopTimeout = durFlag(p, "pre-stop-timeout");
  if (preStopTimeout.error) return err(preStopTimeout.error);
  const hooks: LifecycleHooks = {};
  if (flagStr(p.flags, "pre-stop")) hooks.preStop = flagStr(p.flags, "pre-stop");
  if (preStopTimeout.ms) hooks.preStopTimeoutMs = preStopTimeout.ms;
  if (flagStr(p.flags, "spot-webhook-url")) hooks.spotWebhookUrl = flagStr(p.flags, "spot-webhook-url");
  if (flagStr(p.flags, "webhook-correlation")) hooks.webhookCorrelation = flagStr(p.flags, "webhook-correlation");
  if (flagStr(p.flags, "notify-url")) hooks.notifyUrl = flagStr(p.flags, "notify-url");
  if (flagStr(p.flags, "notify-platform")) hooks.notifyPlatform = flagStr(p.flags, "notify-platform");
  if (flagStr(p.flags, "active-processes")) hooks.activeProcesses = flagStr(p.flags, "active-processes");
  const hasHooks = Object.keys(hooks).length > 0;

  // --plugin ref[@version], repeatable (Go's is a pflag StringArray,
  // cmd/launch_flags.go:351), so it's read via flagList and not flagStr —
  // last-wins would install one and silently drop the rest.
  //
  // A ref the launch-time path can't honour aborts the launch rather than being
  // filtered out of it. The reason string is the whole point (canDeclareAtLaunch
  // distinguishes needs-a-pushed-secret / belongs-to-the-CLI / not-a-plugin, and
  // only the last is likely a typo), and it's worth far more before the launch
  // than after, when the plugin is simply absent from a running box.
  const pluginRefs = flagList(p, "plugin");
  const plugins: PluginDeclaration[] = pluginRefs.map((ref) => ({ ref }));
  const pluginVerdict = validateDeclarations(plugins);
  if (pluginVerdict.rejected.length) {
    return err(
      `launch: ${pluginVerdict.rejected.length} plugin${
        pluginVerdict.rejected.length === 1 ? "" : "s"
      } cannot be declared at launch — nothing was launched.`,
      ...pluginVerdict.rejected.map((r) => `  ${r.reason}`),
    );
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
    hibernateOnIdle,
    idleCpuPercent: Number(flagStr(p.flags, "idle-cpu", "0")) || 0,
    costLimit: Number(flagStr(p.flags, "cost-limit", "0")) || 0,
    onComplete: onComplete || "",
    completionFile: flagStr(p.flags, "completion-file"),
    completionDelayMs: delay.ms,
    pricePerHour: Number(flagStr(p.flags, "price-per-hour", "0")) || 0,
    sessionTimeoutMs: session.ms,
    hooks: hasHooks ? hooks : undefined,
    plugins: plugins.length ? plugins : undefined,
  };

  // Cost-safety guard. This path reaches the provider directly rather than going
  // through SpawnClient.launch, so it needs its own call — but it shares the one
  // predicate (src/core/bounds.ts) instead of restating the condition, which is
  // how the two drifted apart in the first place.
  const verdict = evaluateBounds(spec, ctx.provider.isReal);
  if (verdict.refuse && !flagBool(p.flags, "no-timeout")) {
    return err(
      "launch: " + verdict.refuse,
      "Add --ttl 4h (recommended), --idle-timeout 1h, or pass --no-timeout to override.",
    );
  }
  // Go requires an acknowledgement for its equivalent override — --no-timeout
  // "disabling the cost guardrails is an explicit, acknowledged choice"
  // (cmd/zombie_guard.go:58): pass --yes or abort. A flag alone can be a typo or
  // a copied command line; a confirmation cannot.
  if (verdict.refuse && !flagBool(p.flags, "yes") && !flagBool(p.flags, "y")) {
    const okToProceed = await ctx.confirm(
      "--no-timeout disables every cost guardrail: this REAL instance will bill until you " +
        "terminate it by hand, and nothing (not spored, not the reaper, not orphan detection) " +
        "will stop it. Launch anyway?",
    );
    if (!okToProceed) return err("launch: aborted — no instance was launched.");
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
    // "declared", not "installed". The declarations are written to
    // /etc/spawn/plugins.json in user-data; spored installs them at boot, and
    // whether it succeeded is only knowable later from the spore:plugin:* tags
    // (see `spawn status`). Saying "installed" here would report an outcome we
    // haven't observed.
    ...(plugins.length
      ? [
          `  plugins declared: ${plugins.map((d) => d.ref).join(", ")}`,
          `    installed by spored at boot; check 'status ${inst.name}' for what it reports`,
        ]
      : []),
    // Printed on a real launch whose only bounds live on the box. "no TTL" above
    // states the fact; this states the consequence, which is the part a user
    // reading a success message won't otherwise infer.
    ...(verdict.warn && ctx.provider.isReal ? [`  warning: ${verdict.warn}`] : []),
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
    // humanRemaining() returns "expired" for a past deadline, so " left" can't be
    // appended unconditionally — it read "expired left".
    const left = i.ttlDeadlineMs - now;
    lines.push(
      `  ttl:          ${i.ttlMs ? formatDuration(i.ttlMs) : "?"} — ${
        left > 0 ? `${humanRemaining(left)} left` : "expired"
      } (terminates)`,
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
  // MPI is shown only when declared. Absence is not printed as "mpi: no",
  // because a missing spawn:mpi-enabled means "not declared" — a Go-launched
  // instance whose spored predates the tag reads identically to a non-MPI one,
  // and a line asserting "no" would turn that unknown into a false negative.
  if (i.mpi) {
    lines.push(
      `  mpi:          enabled` +
        (i.mpi.processesPerNode !== undefined
          ? `, ${i.mpi.processesPerNode} processes per node`
          : "") +
        " (declared by tag; orchestration is the launcher's)",
    );
  }
  if (i.hooks) {
    const h = i.hooks;
    if (h.preStop) lines.push(`  pre-stop:     ${h.preStop} (run by spored on the instance)`);
    if (h.spotWebhookUrl) lines.push(`  spot webhook: ${h.spotWebhookUrl}`);
    if (h.notifyUrl) lines.push(`  notify:       ${h.notifyPlatform ? h.notifyPlatform + " → " : ""}${h.notifyUrl}`);
    if (h.activeProcesses) lines.push(`  active-procs: ${h.activeProcesses}`);
  }

  // Plugins, decoded from the spore:plugin:* tags DescribeInstances already
  // returns. Shown when at least one tag is present, or on demand with
  // --plugins.
  //
  // The gate matters: an instance with no plugin tags is the common case, and
  // `describePluginState`'s explanation of what that absence does and does not
  // mean is three lines long. Printing it under every status would train the
  // reader to skip the block — but suppressing it entirely when someone actually
  // asked about plugins would leave them to infer "none installed", which the tag
  // cannot establish. So: silence makes no claim, and --plugins gets the full
  // caveat.
  const plugins = instancePlugins(i);
  if (plugins.length > 0 || flagBool(p.flags, "plugins")) {
    lines.push(
      "",
      plugins.length
        ? `  plugins:      ${plugins.length} reported`
        : "  plugins:      none reported",
      // describePluginState() owns the wording of what the absence means, so the
      // CLI, the dashboard and the portal can't drift into three different
      // claims about the same silence.
      ...(plugins.length ? [] : [`    ${describePluginState(plugins)}`]),
    );
    for (const pl of plugins) {
      // Fields this parser predates, split by whether they even looked like
      // provenance. Both are surfaced rather than dropped (parsePluginTag keeps
      // them precisely so a newer Go builder's provenance doesn't vanish here),
      // but a bare unparseable token must not sit in the same comma list as
      // `verify=signature` — driving the CLI, "verify=unknown, garbage-no-kv" read
      // as if the garbage were a decoded field.
      const extras = Object.entries(pl.extra || {});
      const bits = [
        pl.version ? `version ${pl.version}` : "version unknown",
        `verify=${pl.verify}`,
        ...(pl.contentSha256 ? [`sha256 ${pl.contentSha256}`] : []),
        ...(pl.commitSha ? [`commit ${pl.commitSha}`] : []),
        ...extras.filter(([, v]) => v).map(([k, v]) => `${k}=${v}`),
      ];
      lines.push(`    ${pl.name}: ${bits.join(", ")}`);
      // "installed, provenance unreadable" is a different statement from either
      // "installed and verified" or "not installed", and the tag's existence is
      // what makes the first one true.
      if (!pl.parsed) lines.push(`      (deployed, but its tag carried no readable provenance)`);
      const bare = extras.filter(([, v]) => !v).map(([k]) => k);
      if (bare.length) lines.push(`      unrecognised in its tag: ${bare.join(" ")}`);
    }
  }

  // The tag-derived notices Go's `spawn status` appends (cmd/status.go:130-134).
  // Everything above answers "what did you configure"; these answer "what should
  // you know" — a failed DNS registration, the worst-case bill, an EIP still
  // charging on a stopped box.
  // ctx.lookupEip is the test/embedder override; otherwise use the provider's own
  // (EC2Provider has it, MockProvider has no addresses to describe). Absent
  // either way means the notice is skipped, never answered as "none attached".
  const lookup = ctx.lookupEip || ctx.provider.lookupElasticIp?.bind(ctx.provider);
  const eip = lookup ? await lookup(i.instanceId) : undefined;
  const notices = statusNotices(i, now, { eip, latestSporedVersion: ctx.latestSporedVersion });
  for (const n of notices) {
    lines.push("", `  ${n.level === "warn" ? "⚠️  " : ""}${n.text}`);
    for (const d of n.detail || []) lines.push(`      ${d}`);
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
  // ttlDeadline() rather than the raw tag, so an instance carrying only spawn:ttl
  // is extendable too (its deadline is launch+ttl).
  if (!ttlDeadline(i)) return err(`extend: ${name} has no TTL to extend`);

  // Shared with SpawnClient.extend — the safety floor and the tag pair are defined
  // once, in core/lifecycle.ts.
  const ext = computeExtension(i, ms, ctx.now());
  await ctx.provider.setTags(i.instanceId, ext.tags);

  // Nudge spored, and say plainly which of the two happened. spored holds the TTL
  // in memory and re-reads tags only every ~5min (pkg/agent/agent.go:378), so
  // without this an extend of a nearly-due instance can lose the race.
  const reload: string[] = [];
  if (ctx.provider.isReal) {
    if (!ctx.provider.reloadAgent) {
      reload.push(
        `  note: this backend can't reload spored; it will pick up the new deadline`,
        `        within ~5 minutes on its own.`,
      );
    } else {
      const r = await ctx.provider.reloadAgent(i.instanceId);
      reload.push(
        r.ok
          ? `  ${r.detail}`
          : `  warning: could not reload spored (${r.detail}).`,
        ...(r.ok
          ? []
          : [
              `           the new deadline is saved to the tag, but spored may act on the`,
              `           old one for up to ~5 minutes. to apply it now:`,
              // Prefer spawn:local-username over ec2-user, as Go's `connect` does
              // (cmd/connect.go:135) — a copy-pasteable hint has to name the account
              // that actually exists on the box.
              `             ssh ${i.tags["spawn:local-username"] || "ec2-user"}@${
                i.publicIp || "<instance>"
              } 'sudo spored reload'`,
            ]),
      );
    }
  }

  return ok(
    `extended ${name} by ${formatDuration(ms)}`,
    // Say so when the floor engaged. The user asked for old+by and got now+by;
    // reporting only the happy sentence hides that their instance was already
    // overdue — which is precisely what they need to know.
    ...(ext.clamped
      ? [
          `  note: ${name}'s TTL had already expired, so the ${formatDuration(ms)} was`,
          `        applied from now instead of from the old deadline.`,
        ]
      : []),
    `  new deadline: ${humanRemaining(ext.deadlineMs - ctx.now())} from now`,
    ...reload,
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

  // --min-viable is rejected here when unusable, rather than passed on to be
  // clamped. FanOut's clamp implements Go's out-of-range behaviour (200 on a
  // 100-member array means "all of them"), but garbage is a different case:
  // `Number("hlaf")` is NaN, which lands on the default of 1 and silently
  // disables the cost guard the user explicitly asked for. A typo'd threshold
  // must fail loudly, not become a no-op.
  const mv = numFlag(p, "min-viable");
  if (mv.error) return err(`array: ${mv.error}`);
  const minViable = mv.value;

  const ppnFlag = numFlag(p, "mpi-processes-per-node");
  if (ppnFlag.error) return err(`array: ${ppnFlag.error}`);
  const ppn = ppnFlag.value;
  if (ppn !== undefined && ppn <= 0) {
    return err(`array: --mpi-processes-per-node must be a positive number, got "${ppn}"`);
  }
  // --mpi-processes-per-node without --mpi is refused rather than quietly
  // dropped: buildMpiTags emits nothing when disabled, so the flag would have no
  // effect at all, and a user who set rank density plainly believes they asked
  // for an MPI job.
  const mpiEnabled = flagBool(p.flags, "mpi");
  if (ppn !== undefined && !mpiEnabled) {
    return err("array: --mpi-processes-per-node needs --mpi");
  }

  let ja;
  try {
    ja = ctx.client.startJobArray(base, count, {
      name,
      maxConcurrent,
      launchDelayMs: delayMs,
      minViable,
      ...(mpiEnabled
        ? { mpi: { enabled: true, ...(ppn !== undefined ? { processesPerNode: ppn } : {}) } }
        : {}),
    });
  } catch (e) {
    return err(`array: ${(e as Error).message}`);
  }

  const s = ja.summary;
  const lines = [
    `array ${ja.id} — ${ja.size} member${ja.size === 1 ? "" : "s"}`,
    `  ${maxConcurrent > 0 ? `max ${maxConcurrent} at a time` : "all at once"}` +
      `${delayMs > 0 ? `, ${formatDuration(delayMs)} between launches` : ""}`,
  ];
  // Report the *effective* threshold from the summary, not the flag: it may have
  // been clamped (out of range) or truncated (fractional), and echoing the raw
  // request would hide that the enforced number differs from the asked-for one.
  // Shown only when the threshold does something — 1 is the default no-op.
  const adjusted = minViable !== undefined && s.minViable !== minViable;
  if (s.minViable > 1 || adjusted) {
    lines.push(
      `  min-viable ${s.minViable} of ${ja.size}` +
        (adjusted ? ` (adjusted from ${minViable})` : "") +
        " — survivors are terminated if the array can't reach it",
    );
  }
  if (mpiEnabled) {
    lines.push(
      `  mpi tags on every member${ppn !== undefined ? `, ${ppn} processes per node` : ""}` +
        " — tags only, no collective orchestration (see docs/execution-shapes.md)",
    );
  }
  lines.push(
    `  launched ${s.running}, pending ${s.pending}${s.failed ? `, failed ${s.failed}` : ""}`,
    "  watch progress with 'list' (spawn:job-array-* tags mark membership)",
  );
  return ok(...lines);
}

// ---- helpers ----

/**
 * Read an optional numeric flag: `undefined` when absent, a number when usable,
 * an error message when not.
 *
 * Distinct from `Number(flagStr(...)) || 0` (the pattern the older flags use)
 * because a *threshold* must not silently become its default. Two cases matter:
 *
 * - Non-numeric text (`--min-viable hlaf`) → `NaN`, which would clamp to the
 *   no-op 1 and quietly disable the cost guard the user asked for.
 * - A flag with no value. parseArgs treats `--min-viable -2` as two flags (a
 *   leading `-` starts a new flag, so the value is never attached) and records
 *   `min-viable: true`. Reading that as "absent" would accept a plainly
 *   malformed threshold as a default; it's reported instead.
 */
function numFlag(
  p: ParsedArgs,
  name: string,
): { value?: number; error?: string } {
  const v = p.flags[name];
  if (v === undefined) return {};
  if (typeof v !== "string" || v.trim() === "") {
    return { error: `--${name} needs a number` };
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return { error: `--${name} must be a number, got "${v}"` };
  return { value: n };
}

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
