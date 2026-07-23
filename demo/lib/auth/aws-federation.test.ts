import { describe, it, expect, vi } from "vitest";
import { STSClient } from "@aws-sdk/client-sts";
import { credsFromIdToken } from "./aws-federation.js";

describe("credsFromIdToken", () => {
  it("calls AssumeRoleWithWebIdentity with the token (no source creds) and maps the result", async () => {
    const expiration = new Date(1_700_000_000_000);
    const send = vi.fn().mockResolvedValue({
      Credentials: { AccessKeyId: "ASIA", SecretAccessKey: "sk", SessionToken: "st", Expiration: expiration },
    });
    const sts = { send } as unknown as STSClient;

    const creds = await credsFromIdToken("the.id.token", { roleArn: "arn:aws:iam::435415984226:role/byoa", region: "us-east-1", sessionName: "sess" }, sts);

    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe("AssumeRoleWithWebIdentityCommand");
    expect(cmd.input).toMatchObject({
      RoleArn: "arn:aws:iam::435415984226:role/byoa",
      RoleSessionName: "sess",
      WebIdentityToken: "the.id.token",
    });
    // no Credentials passed into the command — it's an unauthenticated STS call
    expect(cmd.input).not.toHaveProperty("Credentials");
    expect(creds).toEqual({ accessKeyId: "ASIA", secretAccessKey: "sk", sessionToken: "st", expiration });
  });

  it("defaults the session name", async () => {
    const send = vi.fn().mockResolvedValue({ Credentials: { AccessKeyId: "a", SecretAccessKey: "b", SessionToken: "c" } });
    await credsFromIdToken("t", { roleArn: "r" }, { send } as unknown as STSClient);
    expect(send.mock.calls[0][0].input.RoleSessionName).toBe("globus-byoa");
  });

  it("throws when STS returns no credentials", async () => {
    const send = vi.fn().mockResolvedValue({ Credentials: undefined });
    await expect(credsFromIdToken("t", { roleArn: "r" }, { send } as unknown as STSClient)).rejects.toThrow(/no credentials/);
  });

  it("propagates an STS denial (e.g. aud mismatch → InvalidIdentityToken)", async () => {
    const send = vi.fn().mockRejectedValue(new Error("InvalidIdentityToken: aud claim does not match"));
    await expect(credsFromIdToken("t", { roleArn: "r" }, { send } as unknown as STSClient)).rejects.toThrow(/InvalidIdentityToken/);
  });
});
