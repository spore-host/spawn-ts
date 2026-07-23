// Core domain types for spawn-ts. These mirror the data model of the Go `spawn`
// tool (see ~/src/spore-host/spawn/pkg/provider and pkg/config) so instances
// launched here are indistinguishable from instances launched by the real CLI:
// same `spawn:*` tags, same lifecycle semantics.

/** Action taken when a lifecycle condition fires. */
export type LifecycleAction = "terminate" | "stop" | "hibernate" | "exit";

/**
 * LaunchSpec is what a user configures at `spawn launch`. Field names track the
 * real CLI flags. Durations are milliseconds internally; they serialize to Go
 * duration strings ("4h", "30m") on the wire tags.
 */
export interface LaunchSpec {
  name: string;
  instanceType: string;
  region: string;
  ami?: string;
  keyPair?: string;
  spot: boolean;

  /**
   * DNS label for the instance's spore.host name. spored registers
   * {dnsName}.{base36(account)}.spore.host only when this is set (mirrors the Go
   * tool, whose --dns defaults to the required --name). Undefined = default to a
   * slugified `name`; an empty result omits spawn:dns-name (DNS disabled).
   */
  dnsName?: string;

  /** TTL in ms. Always terminates on expiry — the hard cost backstop. 0 = none. */
  ttlMs: number;
  /** Idle timeout in ms. Stops (or hibernates) after inactivity. 0 = none. */
  idleTimeoutMs: number;
  hibernateOnIdle: boolean;
  /** Idle CPU threshold, percent. Below this counts as idle. */
  idleCpuPercent: number;
  /** Hard dollar ceiling on accumulated compute cost. 0 = none. */
  costLimit: number;

  /** Completion-signal action + watched file. Empty onComplete = disabled. */
  onComplete: LifecycleAction | "";
  completionFile: string;
  completionDelayMs: number;

  /** On-demand $/hr, recorded at launch for cost-limit + dashboard math. */
  pricePerHour: number;

  /**
   * Idle-SSH-shell auto-logout, in ms. 0 = disabled. Distinct from the idle
   * *instance* lifecycle (idleTimeoutMs): this disconnects idle login sessions
   * on the box (sshd ClientAlive + a readonly TMOUT), it does not stop/terminate
   * the instance. A bootstrap/userdata feature — enforced on the instance, not
   * by the in-app lifecycle engine. Written to spawn:session-timeout.
   */
  sessionTimeoutMs: number;

  /**
   * Daemon-enforced lifecycle hooks (optional). spawn-ts is a browser launcher
   * with no on-instance daemon, so it can only WRITE these as spawn:* tags — a
   * real spored on the instance runs them. Included so a spawn-ts launch is fully
   * honored by spored, and to stay wire-compatible with the Go tool. Undefined
   * fields emit no tag.
   */
  hooks?: LifecycleHooks;

  /**
   * Parameter-sweep membership (optional). Set when this instance is one member
   * of a `spawn sweep` fan-out; written to spawn:sweep-* tags so the whole sweep
   * is discoverable and wire-compatible with the Go tool. Undefined for a plain
   * single launch.
   */
  sweep?: SweepMembership;

  /**
   * Job-array membership (optional). Set when this instance is one indexed
   * member of a `spawn` job array — N identical launches from one base config,
   * differing only by index. Written to spawn:job-array-* tags. Undefined for a
   * plain single launch. Distinct from a sweep (which varies parameters per
   * member); a job array's members are identical but for JOB_ARRAY_INDEX.
   */
  jobArray?: JobArrayMembership;
}

/**
 * Daemon-enforced lifecycle hooks, written to spawn:* tags at launch and run by
 * spored ON THE INSTANCE — spawn-ts (a browser launcher) cannot execute these
 * itself. Every field maps to the identically-named tag(s) the Go tool writes
 * (pkg/aws/tags.go), so a real spored honors a spawn-ts launch. All optional.
 */
export interface LifecycleHooks {
  /** Shell command run on-instance before any lifecycle-triggered stop/terminate. spawn:pre-stop. */
  preStop?: string;
  /** Timeout for the pre-stop hook (Go duration, e.g. "5m"). spawn:pre-stop-timeout. */
  preStopTimeoutMs?: number;
  /** URL spored POSTs to on a spot-interruption notice. spawn:spot-webhook-url. */
  spotWebhookUrl?: string;
  /** Opaque blob echoed back in the webhook payload for correlation. spawn:webhook-correlation. */
  webhookCorrelation?: string;
  /** Webhook POST timeout (Go duration). spawn:webhook-timeout. */
  webhookTimeoutMs?: number;
  /** Lifecycle-notification target URL (Slack/Teams/Discord bot). spawn:notify-url. */
  notifyUrl?: string;
  /** Notification platform, e.g. "slack" | "teams" | "discord". spawn:notify-platform. */
  notifyPlatform?: string;
  /** Slash command routing hint for the notify bot. spawn:notify-command. */
  notifyCommand?: string;
  /** Comma-separated process names that keep the box non-idle while running. spawn:active-processes. */
  activeProcesses?: string;
}

/**
 * A launch's membership in a parameter sweep. `parameters` are the per-member
 * key/value pairs (the sweep's independent variables) recorded as spawn:param:*
 * tags and, on a real box, surfaced as PARAM_* env vars. Serialized to the same
 * spawn:sweep-* tags the Go `spawn sweep` writes.
 */
export interface SweepMembership {
  id: string;
  name: string;
  /** 0-based index of this member within the sweep. */
  index: number;
  /** Total members in the sweep. */
  size: number;
  parameters: Record<string, string>;
}

/**
 * A launch's membership in a job array. Serialized to the spawn:job-array-*
 * tags the Go tool writes; the instance's spored surfaces `index` as the
 * JOB_ARRAY_INDEX env var so the workload knows which slice it is.
 */
export interface JobArrayMembership {
  id: string;
  name: string;
  /** 0-based index of this member within the array. */
  index: number;
  /** Total members in the array. */
  size: number;
}

/** Lifecycle state as observed through the provider (mirrors EC2 states). */
export type InstanceState =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "hibernated"
  | "shutting-down"
  | "terminated";

/**
 * ManagedInstance is spawn's view of one instance: the provider-observable
 * identity/state plus the lifecycle config decoded from its `spawn:*` tags.
 */
export interface ManagedInstance {
  instanceId: string;
  name: string;
  region: string;
  instanceType: string;
  state: InstanceState;
  publicIp?: string;
  privateIp?: string;
  spot: boolean;

  /** Raw tag map as it exists on the instance (source of truth for config). */
  tags: Record<string, string>;

  /** Original launch time (ms epoch). Never resets on stop/start. */
  launchTimeMs: number;
  /**
   * Absolute TTL deadline (ms epoch) = launchTime + TTL. Authoritative across
   * stop/wake cycles — never recomputed from "now", so stopping and restarting
   * can't extend an instance's life past its deadline. 0 = no TTL.
   */
  ttlDeadlineMs: number;
  ttlMs: number;
  idleTimeoutMs: number;
  hibernateOnIdle: boolean;
  idleCpuPercent: number;
  costLimit: number;
  pricePerHour: number;
  onComplete: LifecycleAction | "";
  completionFile: string;
  completionDelayMs: number;

  /**
   * Accumulated compute seconds across the instance's whole life (billing only
   * runs while `running`). Mirrors spawn:compute-seconds — used so cost-limit
   * and cost display survive stop/start without resetting.
   */
  computeSeconds: number;
  /** Last time (ms epoch) activity was observed; drives idle detection. */
  lastActivityMs: number;
  /** Latest observed CPU %, for idle detection + dashboard. */
  cpuPercent: number;

  /**
   * Parameter-sweep membership, decoded from the instance's spawn:sweep-* /
   * spawn:param:* tags. Undefined when the instance is not part of a sweep.
   */
  sweep?: SweepMembership;

  /**
   * Job-array membership, decoded from the instance's spawn:job-array-* tags.
   * Undefined when the instance is not part of a job array.
   */
  jobArray?: JobArrayMembership;

  /**
   * Daemon-enforced lifecycle hooks decoded from the instance's spawn:* tags
   * (pre-stop / spot-webhook / notify / active-processes). Undefined when none
   * are set. Informational here — enforced by spored on the instance.
   */
  hooks?: LifecycleHooks;
}

/** A single lifecycle decision the engine can emit on a tick. */
export interface LifecycleDecision {
  action: LifecycleAction;
  /** Which rule fired: "ttl" | "cost-limit" | "idle" | "completion". */
  rule: "ttl" | "cost-limit" | "idle" | "completion";
  reason: string;
}

/** A non-fatal warning (5-min-remaining, 90%-budget) emitted before an action. */
export interface LifecycleWarning {
  rule: "ttl" | "cost-limit" | "idle";
  message: string;
}

/** Combined output of one lifecycle evaluation tick. */
export interface TickResult {
  decision?: LifecycleDecision;
  warnings: LifecycleWarning[];
}
