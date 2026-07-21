// Unit tests for the EC2 bootstrap user-data builder. These pin the shape of
// the script that makes spawn-ts's self-termination real (installs spored) and
// the base64 encoding EC2's UserData field requires.

import { describe, it, expect } from "vitest";
import { buildLinuxBootstrap, encodeUserData } from "./userdata.js";

describe("buildLinuxBootstrap", () => {
  it("installs and enables spored via systemd, matching the Go unit", () => {
    const s = buildLinuxBootstrap({ username: "ec2-user" });
    expect(s).toContain("/usr/local/bin/spored");
    // The daemon is the BARE `spored` invocation — never `spored run` (that
    // unknown subcommand crash-looped the unit, spawn-ts#19). Match Go exactly.
    expect(s).toContain("ExecStart=/usr/local/bin/spored\n");
    expect(s).not.toContain("spored run");
    expect(s).toContain("Environment=SPORE_DNS_SIGV4=1");
    expect(s).toContain("Restart=on-failure");
    expect(s).toContain("systemctl enable spored");
    expect(s).toContain("LOCAL_USERNAME=ec2-user");
  });

  it("defaults the username to ec2-user when blank", () => {
    expect(buildLinuxBootstrap({ username: "" })).toContain("LOCAL_USERNAME=ec2-user");
  });

  it("authorizes an SSH key when one is supplied, single-quote-escaped", () => {
    const s = buildLinuxBootstrap({ username: "ubuntu", publicKey: "ssh-ed25519 AAAA it's-mine" });
    expect(s).toContain("authorized_keys");
    expect(s).toContain("/home/ubuntu/.ssh");
    // The apostrophe in the key is escaped for the single-quoted shell string.
    expect(s).toContain(`'\\''`);
  });

  it("falls back to an SSM-only comment without a key", () => {
    expect(buildLinuxBootstrap({ username: "ec2-user" })).toContain("SSM-only");
  });

  it("embeds a workload command in a heredoc when provided", () => {
    const s = buildLinuxBootstrap({ username: "ec2-user", command: "python train.py" });
    expect(s).toContain("/etc/spawn/command");
    expect(s).toContain("python train.py");
    expect(s).toContain("chmod 600 /etc/spawn/command");
  });

  it("injects an idle-session-timeout block only when set", () => {
    expect(buildLinuxBootstrap({ username: "ec2-user" })).not.toContain("TMOUT");
    // 30m → TMOUT=1800, ClientAliveInterval = 1800/6 = 300s.
    const s = buildLinuxBootstrap({ username: "ec2-user", sessionTimeoutMs: 30 * 60_000 });
    expect(s).toContain("export TMOUT=1800");
    expect(s).toContain("readonly TMOUT");
    expect(s).toContain("ClientAliveInterval 300");
    expect(s).toContain("ClientAliveCountMax 3");
    expect(s).toContain("/etc/profile.d/session-timeout.sh");
  });

  it("floors the ssh keepalive interval at 60s for short timeouts", () => {
    // 2m → 120/6 = 20 → floored to 60.
    const s = buildLinuxBootstrap({ username: "ec2-user", sessionTimeoutMs: 2 * 60_000 });
    expect(s).toContain("ClientAliveInterval 60");
    expect(s).toContain("export TMOUT=120");
  });

  it("installs spored from the regional S3 bucket for the detected arch", () => {
    const s = buildLinuxBootstrap({ username: "ec2-user" });
    // Arch detection covers both amd64 and arm64 (the old script was amd64-only).
    expect(s).toContain("spored-linux-amd64");
    expect(s).toContain("spored-linux-arm64");
    expect(s).toContain('ARCH=$(uname -m)');
    // Real install path: regional S3 bucket resolved from IMDS, us-east-1 fallback.
    expect(s).toContain("spawn-binaries-");
    expect(s).toContain(".s3.amazonaws.com");
    expect(s).toContain("spawn-binaries-us-east-1.s3.amazonaws.com");
    // Reads the region from IMDS.
    expect(s).toContain("169.254.169.254/latest/meta-data/placement/region");
    // Verifies a checksum and installs atomically (rename, not in-place write).
    expect(s).toContain("sha256sum");
    expect(s).toContain("mv -f");
    // The old fictional GitHub-release URL is gone (spawn-ts#17).
    expect(s).not.toContain("releases/latest/download");
    expect(s).not.toContain("github.com/spore-host/spawn/releases");
  });

  it("omits signature verification by default (checksum only)", () => {
    const s = buildLinuxBootstrap({ username: "ec2-user" });
    expect(s).not.toContain("spored-signing-key.pem");
    expect(s).not.toContain("openssl dgst");
    expect(s).toContain("sha256sum"); // checksum still present
  });

  it("adds a fail-closed signature-verify block when a signing key is supplied", () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHtestkey==\n-----END PUBLIC KEY-----";
    const s = buildLinuxBootstrap({ username: "ec2-user", sporedSigningPublicKey: pem });
    expect(s).toContain("/etc/spawn/spored-signing-key.pem");
    expect(s).toContain("MFkwEwYHtestkey==");
    expect(s).toContain('SIG_URL="${CHECKSUM_URL%.sha256}.sig"');
    expect(s).toContain("openssl dgst -sha256 -verify");
    // Fail-closed: refuses on a missing sig and on a bad sig.
    expect(s).toContain("refusing to run an unsigned binary");
    expect(s).toContain("signature verification FAILED");
    // Runs before the atomic install (verify then mv).
    expect(s.indexOf("openssl dgst")).toBeLessThan(s.indexOf("/usr/local/bin/spored"));
  });

  it("treats a blank signing key as disabled", () => {
    expect(buildLinuxBootstrap({ username: "ec2-user", sporedSigningPublicKey: "   " })).not.toContain(
      "spored-signing-key.pem",
    );
  });
});

describe("encodeUserData", () => {
  it("round-trips through base64 (UTF-8 safe)", () => {
    const script = "#!/bin/bash\necho 'héllo → wörld'";
    const encoded = encodeUserData(script);
    // Valid base64.
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // Decodes back to the original UTF-8 text.
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(script);
  });
});
