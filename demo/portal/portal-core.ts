// Portal core — the testable logic of the BYOA portal, separated from the HTTP
// server (server.ts) so it can be unit-tested without a socket.
//
// The portal assumes a role in the USER's account and launches compute there
// under the PORTAL's assumed role. These helpers cover the two pieces worth
// testing in isolation: the assume-role → spawn-ts-client factory, and the
// portal-mediated projection of an instance (which deliberately omits any
// direct-access affordance).

import type { STSClient } from "@aws-sdk/client-sts";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { SpawnClient } from "../../src/core/client.js";
import { EC2Provider } from "../../src/aws/ec2.js";
import type { ManagedInstance } from "../../src/core/types.js";

export interface PortalConfig {
  roleArn: string;
  externalId: string;
  region: string;
  instanceProfile: string;
}

/** The portal-mediated view of an instance sent to the browser. */
export interface PortalInstanceView {
  instanceId: string;
  name: string;
  state: ManagedInstance["state"];
  instanceType: string;
  region: string;
  ttlDeadlineMs: number;
  /** Always "portal": the box runs under the portal's assumed role, not the user's. */
  managedBy: "portal";
}

/**
 * Assume the user-account role via STS and return a spawn-ts client bound to the
 * resulting TEMPORARY credentials. A fresh client per call keeps each launch
 * scoped to a freshly-assumed session (creds/role are fixed at EC2Provider
 * construction — the intended multi-tenant pattern). The STSClient (the portal's
 * own infra identity) is injected so this is testable with a stub.
 */
export async function clientForUserAccount(sts: STSClient, cfg: PortalConfig): Promise<SpawnClient> {
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: cfg.roleArn,
      RoleSessionName: "spawn-ts-portal",
      ExternalId: cfg.externalId,
      DurationSeconds: 3600,
    }),
  );
  const c = assumed.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error("AssumeRole returned no credentials");
  }
  return new SpawnClient({
    provider: new EC2Provider({
      region: cfg.region,
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      iamInstanceProfile: cfg.instanceProfile,
    }),
  });
}

/**
 * Project a ManagedInstance to the portal-mediated view. Deliberately omits any
 * direct-access affordance (no SSH key, no raw credentials, no public IP) — the
 * user reaches the instance only through the portal.
 */
export function toPortalView(i: ManagedInstance): PortalInstanceView {
  return {
    instanceId: i.instanceId,
    name: i.name,
    state: i.state,
    instanceType: i.instanceType,
    region: i.region,
    ttlDeadlineMs: i.ttlDeadlineMs,
    managedBy: "portal",
  };
}

/** Read + validate portal configuration from environment variables. Throws if incomplete. */
export function portalConfigFromEnv(env: NodeJS.ProcessEnv): PortalConfig {
  const roleArn = env.PORTAL_LAUNCH_ROLE_ARN ?? "";
  const externalId = env.PORTAL_EXTERNAL_ID ?? "";
  if (!roleArn || !externalId) {
    throw new Error(
      "PORTAL_LAUNCH_ROLE_ARN and PORTAL_EXTERNAL_ID are required — the role the " +
        "portal assumes in the user's account and the confused-deputy external id.",
    );
  }
  return {
    roleArn,
    externalId,
    region: env.PORTAL_REGION ?? "us-east-1",
    instanceProfile: env.PORTAL_INSTANCE_PROFILE ?? "spored-instance-profile",
  };
}
