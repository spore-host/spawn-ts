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
} from "./core/types.js";

export { evaluate, accumulatedCost } from "./core/lifecycle.js";
export type { TickInput } from "./core/lifecycle.js";
export {
  buildLaunchTags,
  buildSweepTags,
  decodeConfigTags,
  decodeSweepTags,
  isManaged,
  tag,
  TAG_PREFIX,
  PARAM_TAG_PREFIX,
} from "./core/tags.js";
export { parseDuration, formatDuration, humanRemaining } from "./core/duration.js";

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
} from "./core/fanout.js";
export { Sweep, buildSweep, generateSweepId } from "./core/sweep.js";
export type { SweepOptions, BuiltSweep } from "./core/sweep.js";

// CLI (used by the terminal pane, but reusable for a headless REPL/test).
export { runCommand } from "./cli/commands.js";
export type { ShellCtx, CmdResult } from "./cli/commands.js";
