// Instance lookup by id or Name (#128).
//
// A Name is a label the caller chose, not an identity: a relaunch of the same
// shape, a CLI user reusing a name, or another user in the same account all
// produce two instances called `test`. The old lookup returned the first
// DescribeInstances match, which in the portal audit was a TERMINATED `test`:
// "terminate" on the live card terminated the dead one, EC2 said OK, and the
// live one kept billing. So:
//
//   - every mutating SpawnClient method takes an instance id, never a Name
//     (`requireInstanceId`);
//   - a Name lookup, kept for read-only use and for the terminal's Go-parity
//     commands, resolves exactly as Go's `resolveInstance` does
//     (spawn/cmd/utils.go:186): case-insensitive, live instances only, a single
//     running match wins a tie, and anything still ambiguous is refused with
//     the candidate ids rather than guessed.

import type { InstanceState, ManagedInstance } from "./types.js";

/** EC2 instance ids: `i-` and 8 or 17 hex digits. */
const INSTANCE_ID = /^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/;

/** Whether `s` is shaped like an EC2 instance id. */
export function isInstanceId(s: string): boolean {
  return INSTANCE_ID.test(s);
}

/**
 * Throw unless `id` is an instance id. Mutations are by id only: a Name can name
 * a terminated instance or someone else's (#128).
 */
export function requireInstanceId(op: string, id: string): void {
  if (typeof id === "string" && isInstanceId(id)) return;
  throw new Error(
    `${op} needs an instance id (i-…), got ${JSON.stringify(id)}: an instance's Name is not unique, ` +
      "and acting by Name can hit a terminated instance or another user's that shares it",
  );
}

/**
 * The states Go's default ListInstances filter keeps (pending, running,
 * stopping, stopped; spawn/pkg/aws/client.go:1536), plus spawn-ts's own
 * `hibernated`. Name lookups never match terminated or shutting-down instances.
 */
const LIVE: ReadonlySet<InstanceState> = new Set(["pending", "running", "stopping", "stopped", "hibernated"]);

/** More than one live instance carries the Name, and no single running one wins. */
export class AmbiguousNameError extends Error {
  override readonly name = "AmbiguousNameError";
  constructor(
    readonly instanceName: string,
    readonly candidates: ManagedInstance[],
  ) {
    super(
      `multiple instances found with name: ${instanceName} (` +
        candidates.map((i) => `${i.instanceId} ${i.state}`).join(", ") +
        "). Use the instance id instead.",
    );
  }
}

/**
 * Pick the instance a Name refers to, as Go's resolveInstance does. Returns null
 * when no live instance has it. Throws AmbiguousNameError when it can't choose.
 */
export function resolveByName(instances: ManagedInstance[], name: string): ManagedInstance | null {
  const want = name.toLowerCase();
  const matches = instances.filter((i) => LIVE.has(i.state) && i.name.toLowerCase() === want);
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  // Prefer the one running instance over stopped namesakes (Go #313).
  const running = matches.filter((i) => i.state === "running");
  if (running.length === 1) return running[0];
  throw new AmbiguousNameError(name, running.length ? running : matches);
}
