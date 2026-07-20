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
}
