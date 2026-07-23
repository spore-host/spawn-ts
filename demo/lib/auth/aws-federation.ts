// Exchange a Globus OIDC id_token for short-lived AWS credentials via STS
// AssumeRoleWithWebIdentity — the one STS call that takes a web token instead of
// AWS credentials, so it runs in the browser with nothing pre-configured. STS
// verifies the id_token's signature (against Globus's JWKS) and the trust
// policy's aud/sub conditions server-side; the browser never holds a long-lived
// key. Verified: sts.amazonaws.com is CORS-open (ACAO *).

import { STSClient, AssumeRoleWithWebIdentityCommand } from "@aws-sdk/client-sts";

export interface FederationConfig {
  /** Role in the user's account trusting the auth.globus.org OIDC provider. */
  roleArn: string;
  region?: string;
  sessionName?: string;
}

export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

/**
 * Assume the BYOA role with a Globus id_token. `client` is injectable for tests;
 * by default a credential-less STSClient is created (the command needs none).
 */
export async function credsFromIdToken(
  idToken: string,
  cfg: FederationConfig,
  client?: STSClient,
): Promise<AwsCreds> {
  const region = cfg.region ?? "us-east-1";
  const sts = client ?? new STSClient({ region });
  const out = await sts.send(
    new AssumeRoleWithWebIdentityCommand({
      RoleArn: cfg.roleArn,
      RoleSessionName: cfg.sessionName ?? "globus-byoa",
      WebIdentityToken: idToken,
      DurationSeconds: 3600,
    }),
  );
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
    throw new Error("AssumeRoleWithWebIdentity returned no credentials");
  }
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration,
  };
}
