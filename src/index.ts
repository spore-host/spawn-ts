// Public API surface for spawn-ts as a library. Consumers (the bundled GUI, the
// terminal, or any external app) import from here. The GUI in src/ui is just one
// consumer of this API — nothing in core/ depends on the DOM.
//
//   import { SpawnClient, MockProvider } from "spawn-ts";
//   const spawn = new SpawnClient({ clock: 60 });   // 1 sim-minute / real-second
//   spawn.on(e => console.log(e));
//   spawn.start();
//   await spawn.launch({ name: "job", ttl: "4h", onComplete: "terminate" });

export { SpawnClient } from "./core/client.js";
export type {
  SpawnEvent,
  EventHandler,
  ClientOptions,
  LaunchInput,
} from "./core/client.js";

export { MockProvider } from "./core/mock.js";
export { EC2Provider } from "./aws/ec2.js";
export type { EC2ProviderOptions } from "./aws/ec2.js";

export type { Provider } from "./core/provider.js";
export type {
  LaunchSpec,
  ManagedInstance,
  InstanceState,
  LifecycleAction,
  LifecycleDecision,
  LifecycleWarning,
  TickResult,
  SweepMembership,
  JobArrayMembership,
  LifecycleHooks,
} from "./core/types.js";

export {
  evaluate,
  accumulatedCost,
  ttlDeadline,
  computeExtension,
  TTL_TAG,
  TTL_DEADLINE_TAG,
} from "./core/lifecycle.js";
export type { TickInput, ExtendResult } from "./core/lifecycle.js";
// Status notices — the tag-derived blocks Go's `spawn status` appends. Pure, so
// the CLI, the dashboard and the portal can render one source three ways. The
// Elastic IP lookup itself needs the SDK and lives in ./aws/eip.js.
export {
  dnsNotice,
  lifecycleProtection,
  sporedUpgrade,
  elasticIpNotice,
  statusNotices,
  compareSemver,
} from "./core/notices.js";
export type {
  Notice,
  NoticeLevel,
  AttachedEip,
  ElasticIpLookup,
} from "./core/notices.js";
export { lookupElasticIp, firstAssociatedEip } from "./aws/eip.js";
export type { EipLookupOptions } from "./aws/eip.js";

export { findOrphans, ORPHAN_GRACE_MS } from "./core/orphans.js";
export type { Orphan } from "./core/orphans.js";
export { evaluateBounds, ENFORCEMENT } from "./core/bounds.js";
export type { Bound, Enforcement, BoundsVerdict } from "./core/bounds.js";
export {
  buildLaunchTags,
  buildSweepTags,
  buildJobArrayTags,
  buildHookTags,
  decodeConfigTags,
  decodeSweepTags,
  decodeJobArrayTags,
  decodeHookTags,
  isManaged,
  tag,
  TAG_PREFIX,
  PARAM_TAG_PREFIX,
} from "./core/tags.js";
export { parseDuration, formatDuration, humanRemaining } from "./core/duration.js";

// Plugins: detection is universal (every installed plugin leaves a
// spore:plugin:<name> tag that DescribeInstances already returns), while
// installation from a browser covers only the seven remote-only plugins. Both
// halves live here; see core/plugins.ts for why the sets differ.
export {
  parsePluginTag,
  detectPlugins,
  instancePlugins,
  describePluginState,
  canDeclareAtLaunch,
  validateDeclarations,
  serializeDeclarations,
  pluginRefName,
  LAUNCH_DECLARABLE_PLUGINS,
  PLUGIN_TAG_PREFIX,
} from "./core/plugins.js";
export type {
  PluginProvenance,
  PluginVerification,
  PluginDeclaration,
} from "./core/plugins.js";

// Parameter sweeps (issue #4) + the shared fan-out engine (reused by #5).
export { resolveMembers, expandGrid } from "./core/params.js";
export type { ParamSpec, ParamSet, ParamValue, ResolvedMember } from "./core/params.js";
export { FanOut } from "./core/fanout.js";
export type {
  FanOutMember,
  FanOutMemberState,
  FanOutMemberStatus,
  FanOutOptions,
  FanOutSummary,
  OnFailure,
} from "./core/fanout.js";
export { Sweep, buildSweep, generateSweepId } from "./core/sweep.js";
export type { SweepOptions, BuiltSweep } from "./core/sweep.js";
export { JobArray, buildJobArray, generateJobArrayId } from "./core/jobarray.js";
export type { JobArrayOptions, BuiltJobArray } from "./core/jobarray.js";

// Batch job queues (issue #5), built on the same fan-out engine.
export {
  Queue,
  buildQueue,
  validateQueue,
  topologicalSort,
  parseQueueConfig,
  generateQueueId,
} from "./core/queue.js";
export type {
  QueueConfig,
  JobConfig,
  RetryConfig,
  QueueOptions,
  BuiltQueue,
} from "./core/queue.js";

// CLI (used by the terminal pane, but reusable for a headless REPL/test).
export { runCommand } from "./cli/commands.js";
export type { ShellCtx, CmdResult } from "./cli/commands.js";
// The flag parser, for an embedder building its own commands over the same argv
// conventions. `flagList` is the repeatable-flag reader (`--plugin a --plugin b`);
// `flagStr` is last-wins and would silently drop all but the final occurrence.
export { tokenize, parseArgs, flagStr, flagBool, flagList } from "./cli/args.js";
export type { ParsedArgs } from "./cli/args.js";
