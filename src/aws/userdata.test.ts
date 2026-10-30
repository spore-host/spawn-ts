// Unit tests for the EC2 bootstrap user-data builder.
//
// The load-bearing ones compare against Go's own output. testdata/
// stub-fixtures.v0.150.0.json is launcher.BuildLinuxBootstrap from spawn
// v0.150.0, rendered as a release build would (stub, not inline body) for each
// input set; testdata/bootstrap-body.v0.150.0.sh is `spawn bootstrap-body` at the
// same tag. Both come from scripts/gen-go-fixtures.sh, so the two
// implementations cannot drift without a test going red.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  BOOTSTRAP_BODY_SHA256,
  MAX_ENCODED_USER_DATA_BYTES,
  MAX_USER_DATA_BYTES,
  SPAWN_BOOTSTRAP_VERSION,
  SPORED_SIGNING_KEY_PEM,
  UserDataTooLargeError,
  buildLinuxBootstrap,
  checkUserDataSize,
  encodeLinuxUserData,
  encodeUserData,
  userDataSize,
} from "./userdata.js";
import { LAUNCH_CONFIG_FIRST_SPORED_VERSION } from "../core/launchconfig.js";

const here = new URL("./testdata/", import.meta.url);

interface StubFixture {
  name: string;
  username: string;
  publicKey: string;
  command: string;
  completionFile: string;
  plugins: { ref: string; config?: Record<string, string> }[] | null;
  settings: Record<string, string> | null;
  object: string;
  sha256: string;
  script: string;
  decodedBytes: number;
}

const fixtures: StubFixture[] = JSON.parse(
  readFileSync(new URL("stub-fixtures.v0.150.0.json", here), "utf8"),
);

describe("buildLinuxBootstrap matches Go's release-build stub (v0.150.0)", () => {
  it("has fixtures to compare against", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  for (const f of fixtures) {
    it(`renders the same bytes as Go: ${f.name}`, () => {
      const s = buildLinuxBootstrap({
        username: f.username,
        publicKey: f.publicKey || undefined,
        command: f.command || undefined,
        completionFile: f.completionFile || undefined,
        plugins: f.plugins ?? undefined,
        launchConfig: f.object || undefined,
      });
      expect(s).toBe(f.script);
    });
  }
});

describe("the pinned bootstrap body", () => {
  it("BOOTSTRAP_BODY_SHA256 is the sha256 of `spawn bootstrap-body` at the pinned release", () => {
    const body = readFileSync(new URL("bootstrap-body.v0.150.0.sh", here));
    expect(createHash("sha256").update(body).digest("hex")).toBe(BOOTSTRAP_BODY_SHA256);
  });

  it("pins spored to the same release the body comes from (#1412), never latest", () => {
    const s = buildLinuxBootstrap({ username: "ec2-user" });
    expect(s).toContain(`SPAWN_SPORED_VERSION='${SPAWN_BOOTSTRAP_VERSION}'`);
    expect(s).toContain(`SPAWN_BS_VERSION='${SPAWN_BOOTSTRAP_VERSION}'`);
    // The body installs from spawn/versions/<v>/ when the pin is set; the
    // unversioned path is only its dev-build branch.
    const body = readFileSync(new URL("bootstrap-body.v0.150.0.sh", here), "utf8");
    expect(body).toContain('"$2/spawn/versions/$v" "$3/spawn/versions/$v"');
  });

  it("pins 0.150.0: the first spored that reads the launch config object spawn-ts writes (#110)", () => {
    // The pin and the object move together: spored < 0.150.0 ignores the
    // object, and spored >= 0.150.0 ignores the moved tags (spawn#1359).
    expect(SPAWN_BOOTSTRAP_VERSION).toBe(LAUNCH_CONFIG_FIRST_SPORED_VERSION);
  });

  it("seeds the object before the body starts spored, 0600, only when there is one", () => {
    const seeded = fixtures.find((f) => f.object)!;
    const s = buildLinuxBootstrap({ username: "ec2-user", launchConfig: seeded.object });
    expect(s).toContain("| base64 -d > /etc/spawn/launch-config.json\nchmod 600 /etc/spawn/launch-config.json");
    expect(s.indexOf("/etc/spawn/launch-config.json")).toBeLessThan(s.indexOf(". /etc/spawn/bootstrap-body.sh"));
    expect(buildLinuxBootstrap({ username: "ec2-user" })).not.toContain("launch-config.json");
  });

  it("always verifies with the spore.host key, as a Go release build does", () => {
    const s = buildLinuxBootstrap({ username: "ec2-user" });
    expect(s).toContain("SPORED_SIG_VERIFY=1");
    expect(s).toContain(SPORED_SIGNING_KEY_PEM);
    expect(s).toContain("openssl dgst -sha256 -verify /etc/spawn/spored-signing-key.pem");
  });

  it("uses an override key only when a non-blank one is supplied", () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHtestkey==\n-----END PUBLIC KEY-----";
    expect(buildLinuxBootstrap({ username: "ec2-user", sporedSigningPublicKey: pem })).toContain(
      "MFkwEwYHtestkey==",
    );
    expect(buildLinuxBootstrap({ username: "ec2-user", sporedSigningPublicKey: "  " })).toContain(
      SPORED_SIGNING_KEY_PEM,
    );
  });

  it("retires the instance on any exit before spored is up (#1274)", () => {
    const s = buildLinuxBootstrap({ username: "ec2-user" });
    expect(s).toContain("trap spawn_exit_guard EXIT");
    expect(s.indexOf("spawn_fatal_retire()")).toBeLessThan(s.indexOf("SPAWN_BS_VERSION="));
  });

  it("writes plugins before the body that starts spored (#1023)", () => {
    const s = buildLinuxBootstrap({ username: "ec2-user", plugins: [{ ref: "docker" }] });
    expect(s.indexOf("/etc/spawn/plugins.json")).toBeLessThan(s.indexOf(". /etc/spawn/bootstrap-body.sh"));
  });
});

describe("buildLinuxBootstrap refusals (Go security.ValidateUsername)", () => {
  for (const bad of ["", "Root", "1user", "a b", "x;rm -rf /", "a".repeat(33), "$(id)"]) {
    it(`refuses username ${JSON.stringify(bad)}`, () => {
      expect(() => buildLinuxBootstrap({ username: bad })).toThrow(/username/);
    });
  }
  for (const good of ["ec2-user", "ubuntu", "a", "u_1-x", "a".repeat(32)]) {
    it(`accepts username ${JSON.stringify(good)}`, () => {
      expect(() => buildLinuxBootstrap({ username: good })).not.toThrow();
    });
  }
});

describe("encodeLinuxUserData", () => {
  it("is gzip then base64, and round-trips (UTF-8 safe)", async () => {
    const script = "#!/bin/bash\necho 'héllo → wörld'\n";
    const encoded = await encodeLinuxUserData(script);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const gz = Buffer.from(encoded, "base64");
    expect([gz[0], gz[1]]).toEqual([0x1f, 0x8b]);
    expect(gunzipSync(gz).toString("utf8")).toBe(script);
  });

  it("keeps every Go fixture well under EC2's limit, as Go's gzip does", async () => {
    for (const f of fixtures) {
      const { decoded } = userDataSize(await encodeLinuxUserData(f.script));
      // Different deflate implementations, same order of magnitude.
      expect(Math.abs(decoded - f.decodedBytes)).toBeLessThan(200);
      expect(decoded).toBeLessThan(MAX_USER_DATA_BYTES / 4);
    }
  });
});

describe("encodeUserData", () => {
  it("round-trips through plain base64 (UTF-8 safe)", () => {
    const script = "#!/bin/bash\necho 'héllo → wörld'";
    const bytes = Uint8Array.from(atob(encodeUserData(script)), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(script);
  });
});

describe("checkUserDataSize (spawn#1063, TestCheckUserDataSizeLimits)", () => {
  const enc = (n: number) => Buffer.alloc(n).toString("base64");
  const cases: { name: string; input: string; tooBig: boolean; decoded: number }[] = [
    { name: "empty", input: "", tooBig: false, decoded: 0 },
    { name: "exactly 16384 decoded", input: enc(MAX_USER_DATA_BYTES), tooBig: false, decoded: MAX_USER_DATA_BYTES },
    { name: "16385 decoded", input: enc(MAX_USER_DATA_BYTES + 1), tooBig: true, decoded: MAX_USER_DATA_BYTES + 1 },
    {
      name: "not base64, over the encoded limit",
      input: "!".repeat(MAX_ENCODED_USER_DATA_BYTES + 1),
      tooBig: true,
      decoded: MAX_ENCODED_USER_DATA_BYTES + 1,
    },
  ];
  for (const tc of cases) {
    it(tc.name, () => {
      let err: unknown;
      try {
        checkUserDataSize(tc.input);
      } catch (e) {
        err = e;
      }
      expect(err instanceof UserDataTooLargeError).toBe(tc.tooBig);
      if (tc.tooBig) expect((err as UserDataTooLargeError).decodedBytes).toBe(tc.decoded);
    });
  }

  it("measures decoded bytes with padding", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100]) {
      expect(userDataSize(enc(n)).decoded).toBe(n);
    }
  });
});
