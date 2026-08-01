// Elastic IP lookup — the one status notice that can't be answered from tags.
//
// Split from core/notices.ts on the same line as everywhere else in this repo:
// the formatting is pure and lives there, only the AWS call lives here. That
// keeps `elasticIpNotice` unit-testable with no credentials and keeps the SDK out
// of the default import graph.
//
// Port of Go's `GetInstanceElasticIP` (pkg/aws/cleanup.go:219), with one
// deliberate difference — Go returns `nil, nil` when the API call fails, which
// makes "no permission to check" indistinguishable from "no EIP attached". Since
// the notice exists to catch an EIP quietly billing on a stopped instance, that
// collapse is exactly the failure it must not have; the error is returned.

import type { AttachedEip, ElasticIpLookup } from "../core/notices.js";

export interface EipLookupOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Override endpoint for substrate/localstack. Empty => real AWS. */
  endpoint?: string;
}

/**
 * Find the Elastic IP associated with an instance, if any.
 *
 * Requires `ec2:DescribeAddresses`. Never throws: a failure is returned as
 * `{ eip: null, error }` so a caller rendering a status page can report the gap
 * instead of losing the whole page to one optional lookup.
 */
export async function lookupElasticIp(
  instanceId: string,
  opts: EipLookupOptions,
): Promise<ElasticIpLookup> {
  let EC2Client, DescribeAddressesCommand;
  try {
    ({ EC2Client, DescribeAddressesCommand } = await import("@aws-sdk/client-ec2"));
  } catch (err) {
    return { eip: null, error: `@aws-sdk/client-ec2 is unavailable: ${(err as Error).message}` };
  }
  const client = new EC2Client({
    region: opts.region,
    endpoint: opts.endpoint || undefined,
    credentials: {
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      sessionToken: opts.sessionToken,
    },
  });
  try {
    const out = await client.send(
      new DescribeAddressesCommand({
        Filters: [{ Name: "instance-id", Values: [instanceId] }],
      }),
    );
    return { eip: firstAssociatedEip(out.Addresses) };
  } catch (err) {
    return { eip: null, error: `ec2:DescribeAddresses failed: ${(err as Error).message}` };
  }
}

/**
 * Pick the first usable address from a DescribeAddresses response. Pure, so the
 * shape-handling is tested without an SDK client.
 *
 * Takes the first as Go does — an instance can technically have an EIP per ENI,
 * but the notice's job is "you have one of these billing", which one address
 * establishes. An address missing `AllocationId` (EC2-Classic, which no longer
 * exists) is skipped rather than reported with an empty release command.
 */
export function firstAssociatedEip(
  addresses: Array<{ PublicIp?: string; AllocationId?: string }> | undefined,
): AttachedEip | null {
  for (const a of addresses || []) {
    if (a.PublicIp && a.AllocationId) {
      return { publicIp: a.PublicIp, allocationId: a.AllocationId };
    }
  }
  return null;
}
