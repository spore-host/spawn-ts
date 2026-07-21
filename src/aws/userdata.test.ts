// Unit tests for the EC2 bootstrap user-data builder. These pin the shape of
// the script that makes spawn-ts's self-termination real (installs spored) and
// the base64 encoding EC2's UserData field requires.

import { describe, it, expect } from "vitest";
import { buildLinuxBootstrap, encodeUserData } from "./userdata.js";

describe("buildLinuxBootstrap", () => {
  it("installs and enables spored via systemd", () => {
    const s = buildLinuxBootstrap({ username: "ec2-user" });
    expect(s).toContain("/usr/local/bin/spored");
    expect(s).toContain("systemctl enable --now spored.service");
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

  it("uses the latest release URL by default and a pinned URL for a version", () => {
    expect(buildLinuxBootstrap({ username: "ec2-user" })).toContain("releases/latest/download");
    const pinned = buildLinuxBootstrap({ username: "ec2-user", sporedVersion: "v1.2.3" });
    expect(pinned).toContain("releases/download/v1.2.3/");
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
