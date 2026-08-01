// Provider abstraction — the seam between spawn-ts's lifecycle/CLI logic and the
// compute backend. Mirrors the role of pkg/provider.Provider in the Go tool.
//
// Two implementations:
//   - MockProvider  (src/core/mock.ts): in-memory, no network, default-ON.
//   - EC2Provider   (src/aws/ec2.ts): real AWS via @aws-sdk/client-ec2, or a
//     substrate emulator, selected by endpoint.
//
// The lifecycle engine (lifecycle.ts) is pure and provider-agnostic; the
// provider only performs observable operations (launch/describe/terminate/…).

import type { LaunchSpec, ManagedInstance } from "./types.js";
import type { ElasticIpLookup } from "./notices.js";

export interface Provider {
  /** Human label for the active backend, shown in the UI ("mock", "aws:us-east-1", "substrate"). */
  readonly label: string;

  /** Whether this provider touches real, billable resources. Drives UI warnings. */
  readonly isReal: boolean;

  /** Launch one instance from a spec at the given launch time (ms epoch). */
  launch(spec: LaunchSpec, launchTimeMs: number): Promise<ManagedInstance>;

  /** List all spawn-managed instances (spawn:managed=true), excluding terminated by default. */
  list(includeTerminated?: boolean): Promise<ManagedInstance[]>;

  /** Fetch a single instance by name or instance-id. Returns null if not found. */
  get(nameOrId: string): Promise<ManagedInstance | null>;

  /** Terminate (permanent). */
  terminate(instanceId: string, reason: string): Promise<void>;

  /** Stop (billing pauses, EBS persists). */
  stop(instanceId: string, reason: string): Promise<void>;

  /** Start a stopped/hibernated instance. */
  start(instanceId: string): Promise<void>;

  /** Hibernate (RAM saved to disk). */
  hibernate(instanceId: string): Promise<void>;

  /**
   * Overwrite/merge tags on an instance. Used by `extend` to push out
   * spawn:ttl-deadline, and by the sim to update spawn:compute-seconds.
   */
  setTags(instanceId: string, tags: Record<string, string>): Promise<void>;

  /**
   * Optional: ask spored on the instance to re-read its config from tags now,
   * rather than at its next periodic refresh.
   *
   * Why this exists at all, given the tag is authoritative: spored evaluates TTL
   * against an **in-memory** config (`a.config.TTLDeadline`,
   * pkg/agent/agent.go:419) that it refreshes from tags only every 5 monitor
   * ticks (~5 min, agent.go:378). So between an `extend` and that refresh, spored
   * still holds the OLD deadline — and if the old one falls inside that window it
   * terminates the instance the user just rescued. Go's `extend` nudges it for
   * exactly this reason (`triggerReload`, cmd/extend.go:303, over SSH).
   *
   * Optional because a provider may have no channel to the box (MockProvider has
   * no box; a substrate endpoint has no SSM). Callers MUST treat absence and
   * failure alike — as "the reload did not happen", stated to the user with the
   * manual command — never as success. Returns a human-readable detail either
   * way so the caller can report which it was.
   */
  reloadAgent?(instanceId: string): Promise<{ ok: boolean; detail: string }>;

  /**
   * Optional: find the Elastic IP associated with an instance, for `status`'s
   * billing notice (#56).
   *
   * Here rather than on the caller because the lookup needs the same credentials
   * the provider already holds — and the notice's whole point is that an EIP on a
   * **stopped** instance keeps billing (~$3.60/mo) precisely because nothing is
   * using it, which is exactly when a user believes they've stopped paying.
   *
   * Optional because a MockProvider has no addresses to describe. Must never
   * throw: a failure comes back as `{ eip: null, error }`, which callers report
   * as a gap. `{ eip: null }` with no error means "checked, none attached" — the
   * two must stay distinguishable (see ElasticIpLookup).
   */
  lookupElasticIp?(instanceId: string): Promise<ElasticIpLookup>;
}
