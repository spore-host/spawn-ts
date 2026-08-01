import { describe, expect, it } from "vitest";

import {
  LAUNCH_DECLARABLE_PLUGINS,
  PLUGIN_TAG_PREFIX,
  canDeclareAtLaunch,
  describePluginState,
  detectPlugins,
  instancePlugins,
  parsePluginTag,
  pluginRefName,
  serializeDeclarations,
  validateDeclarations,
} from "./plugins.js";
import type { ManagedInstance } from "./types.js";

describe("parsePluginTag", () => {
  it("round-trips the real Go tag format", () => {
    // Exactly what pluginProvenanceTagValue (cmd/plugin.go:279) writes, with
    // shortHash's 12-char truncation applied to both digests.
    const p = parsePluginTag(
      "jupyterlab",
      "version=v1.0.0;sha256=abc123def456;commit=789abc012def;verify=signature",
    );
    expect(p).toMatchObject({
      name: "jupyterlab",
      version: "v1.0.0",
      contentSha256: "abc123def456",
      commitSha: "789abc012def",
      verify: "signature",
      parsed: true,
    });
    expect(p.extra).toBeUndefined();
  });

  it("handles the minimal tag Go writes when only a version is known", () => {
    const p = parsePluginTag("docker", "version=v0.3.1");
    expect(p.version).toBe("v0.3.1");
    expect(p.contentSha256).toBeUndefined();
    expect(p.commitSha).toBeUndefined();
    // No verify= field at all: we cannot tell what verification reached.
    expect(p.verify).toBe("unknown");
    expect(p.parsed).toBe(true);
  });

  it("normalises Go's \"(none)\" display placeholder away", () => {
    // shortHash (cmd/plugin_inspect.go:101) returns the literal "(none)" for an
    // empty digest. It is a rendering placeholder, not a hash, and must not
    // travel as one — a UI showing sha256=(none) implies a digest was recorded.
    const p = parsePluginTag("rclone", "version=v2.0.0;sha256=(none);commit=(none)");
    expect(p.contentSha256).toBeUndefined();
    expect(p.commitSha).toBeUndefined();
  });

  it("keeps verify=none distinct from a missing verify=", () => {
    // The load-bearing distinction. "none" is a finding: the install ran and
    // verification reached neither signature nor manifest. "unknown" is an
    // absence of data. Collapsing them hides a supply-chain signal.
    expect(parsePluginTag("x", "version=v1;verify=none").verify).toBe("none");
    expect(parsePluginTag("x", "version=v1").verify).toBe("unknown");
    expect(parsePluginTag("x", "version=v1;verify=manifest").verify).toBe("manifest");
  });

  it("degrades an unrecognised verify value to unknown rather than passing it through", () => {
    const p = parsePluginTag("x", "verify=totally-verified-trust-me");
    expect(p.verify).toBe("unknown");
    // ...but the raw value is still available, so nothing is hidden.
    expect(p.raw).toContain("totally-verified-trust-me");
  });

  it("preserves unknown key=value pairs instead of dropping them", () => {
    // The Go builder can grow fields. A strict parser would silently lose
    // provenance on instances newer than this code.
    const p = parsePluginTag("x", "version=v1;attestation=sigstore;builder=github");
    expect(p.extra).toEqual({ attestation: "sigstore", builder: "github" });
    expect(p.version).toBe("v1");
  });

  it("reports an unparseable value as unknown, not as absent", () => {
    // A tag whose value makes no sense still proves the plugin was installed —
    // the tag's existence IS the evidence. Returning undefined here would let a
    // UI say "not installed", a stronger claim than the data supports.
    const p = parsePluginTag("mystery", "garbage-with-no-pairs");
    expect(p.parsed).toBe(false);
    expect(p.verify).toBe("unknown");
    expect(p.name).toBe("mystery");
    expect(p.raw).toBe("garbage-with-no-pairs");
    // The bare token is retained rather than discarded.
    expect(p.extra).toEqual({ "garbage-with-no-pairs": "" });
  });

  it("treats an empty value as unknown without throwing", () => {
    const p = parsePluginTag("x", "");
    expect(p.parsed).toBe(false);
    expect(p.verify).toBe("unknown");
    expect(p.extra).toBeUndefined();
  });

  it("tolerates stray separators and whitespace", () => {
    const p = parsePluginTag("x", " version=v1 ;; verify=manifest ;");
    expect(p.version).toBe("v1");
    expect(p.verify).toBe("manifest");
  });

  it("keeps a value containing '=' intact", () => {
    // Splits on the FIRST '=' only, so a base64-ish or padded value survives.
    const p = parsePluginTag("x", "sig=aGVsbG8=");
    expect(p.extra).toEqual({ sig: "aGVsbG8=" });
  });
});

describe("detectPlugins", () => {
  it("finds every spore:plugin:* tag and ignores everything else", () => {
    const found = detectPlugins({
      Name: "dev-box",
      "spawn:managed": "true",
      "spore:plugin:jupyterlab": "version=v1.0.0;verify=signature",
      "spore:plugin:spore-sync": "version=v0.9.0;verify=manifest",
      "spore:something-else": "not a plugin",
    });
    expect(found.map((p) => p.name)).toEqual(["jupyterlab", "spore-sync"]);
    expect(found[1].verify).toBe("manifest");
  });

  it("detects plugins the browser could never have installed", () => {
    // The asymmetry that motivates this module: install is 7 of 12, detection is
    // 12 of 12. spore-sync's local half is mutagen on a developer's laptop, and
    // we still report it accurately.
    const found = detectPlugins({ "spore:plugin:spore-sync": "version=v1;verify=signature" });
    expect(found).toHaveLength(1);
    expect(canDeclareAtLaunch("spore-sync").ok).toBe(false);
  });

  it("sorts by name so a UI renders stably", () => {
    const found = detectPlugins({
      "spore:plugin:tailscale": "version=v1",
      "spore:plugin:docker": "version=v1",
      "spore:plugin:mountpoint-s3": "version=v1",
    });
    expect(found.map((p) => p.name)).toEqual(["docker", "mountpoint-s3", "tailscale"]);
  });

  it("ignores a prefix with no plugin name after it", () => {
    expect(detectPlugins({ [PLUGIN_TAG_PREFIX]: "version=v1" })).toEqual([]);
  });

  it("returns an empty list for an instance with no plugin tags", () => {
    expect(detectPlugins({ Name: "x" })).toEqual([]);
  });

  it("reads the tags off a ManagedInstance", () => {
    const inst = {
      id: "i-123",
      name: "dev",
      state: "running",
      tags: { "spore:plugin:code-server": "version=v1;verify=signature" },
    } as unknown as ManagedInstance;
    expect(instancePlugins(inst).map((p) => p.name)).toEqual(["code-server"]);
  });
});

describe("describePluginState", () => {
  it("says 'nothing reported', never 'nothing installed'", () => {
    // The #63 invariant at the UI boundary. The provenance tag is best-effort
    // (recordPluginProvenanceTag returns early when the instance isn't
    // EC2-resolvable, and only warns on tag-write failure) and is never written
    // at all for launch-time declarations. So absence means "we don't know".
    const s = describePluginState([]);
    expect(s).toMatch(/does not mean no plugins are installed/i);
    expect(s).not.toMatch(/no plugins installed\b/i);
  });

  it("names each plugin with its verification tier", () => {
    const s = describePluginState(detectPlugins({ "spore:plugin:docker": "version=v1;verify=none" }));
    expect(s).toContain("docker v1");
    expect(s).toContain("verify=none");
  });

  it("agrees with itself on singular vs plural", () => {
    expect(describePluginState(detectPlugins({ "spore:plugin:a": "version=v1" }))).toContain(
      "1 plugin reported",
    );
    expect(
      describePluginState(detectPlugins({ "spore:plugin:a": "v", "spore:plugin:b": "v" })),
    ).toContain("2 plugins reported");
  });
});

describe("pluginRefName", () => {
  it("strips a version pin", () => {
    expect(pluginRefName("jupyterlab@v1.0.0")).toBe("jupyterlab");
    expect(pluginRefName("jupyterlab")).toBe("jupyterlab");
  });

  it("does not treat a leading @ as a pin separator", () => {
    // Nothing in the registry is scoped this way today, but eating the whole
    // name would turn a valid-looking ref into an empty one.
    expect(pluginRefName("@scoped")).toBe("@scoped");
  });
});

describe("canDeclareAtLaunch", () => {
  it("accepts each of the seven remote-only plugins", () => {
    for (const name of LAUNCH_DECLARABLE_PLUGINS) {
      expect(canDeclareAtLaunch(name), name).toEqual({ ok: true });
    }
  });

  it("accepts a version-pinned ref", () => {
    expect(canDeclareAtLaunch("jupyterlab@v1.2.3").ok).toBe(true);
  });

  it("refuses the four push-dependent plugins and says why", () => {
    // These park at StatusWaitingForPush even in Go's own launch-time path
    // (pkg/pluginruntime/runtime.go:62), so accepting them would produce an
    // instance with a plugin stuck forever and nothing to explain it.
    for (const name of ["github-actions-runner", "globus-personal-endpoint", "rclone", "tailscale"]) {
      const v = canDeclareAtLaunch(name);
      expect(v.ok, name).toBe(false);
      expect(v.reason, name).toMatch(/waiting-for-push/);
      expect(v.reason, name).toMatch(/CLI/);
    }
  });

  it("refuses spore-sync for the right reason — not the push reason", () => {
    // spore-sync pushes nothing; its local half is mutagen on the developer's
    // own machine. Reporting the wrong reason would send someone looking for a
    // secret-push bug that doesn't exist.
    const v = canDeclareAtLaunch("spore-sync");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/mutagen/);
    expect(v.reason).not.toMatch(/waiting-for-push/);
  });

  it("distinguishes an unknown plugin from a known-but-unsupported one", () => {
    const v = canDeclareAtLaunch("definitely-not-a-plugin");
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not a known launch-declarable plugin/);
    // and it lists the alternatives, so a typo is self-correcting
    expect(v.reason).toContain("jupyterlab");
  });

  it("never claims a push-dependent plugin is merely unknown", () => {
    // Regression guard: if someone deletes PUSH_DEPENDENT_PLUGINS, these fall
    // through to the "unknown plugin" branch and the reason becomes misleading.
    expect(canDeclareAtLaunch("tailscale").reason).not.toMatch(/not a known/);
  });
});

describe("validateDeclarations", () => {
  it("returns the accepted set alongside the rejections", () => {
    // Rejections are returned, not thrown, so a caller can launch with what
    // works while telling the user precisely what was dropped. Silent filtering
    // would yield an instance missing a plugin the user asked for.
    const { accepted, rejected } = validateDeclarations([
      { ref: "jupyterlab" },
      { ref: "tailscale" },
      { ref: "docker@v1" },
    ]);
    expect(accepted.map((d) => d.ref)).toEqual(["jupyterlab", "docker@v1"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].ref).toBe("tailscale");
    expect(rejected[0].reason).toBeTruthy();
  });

  it("accepts an empty list without complaint", () => {
    expect(validateDeclarations([])).toEqual({ accepted: [], rejected: [] });
  });
});

describe("serializeDeclarations", () => {
  it("matches Go's Declaration JSON, including config,omitempty", () => {
    // Wire-identical to pkg/plugin/spec.go:156 so spored reads the same bytes
    // from either writer.
    expect(serializeDeclarations([{ ref: "jupyterlab" }])).toBe('[{"ref":"jupyterlab"}]');
    expect(serializeDeclarations([{ ref: "jupyterlab", config: {} }])).toBe('[{"ref":"jupyterlab"}]');
    expect(serializeDeclarations([{ ref: "code-server", config: { port: "8080" } }])).toBe(
      '[{"ref":"code-server","config":{"port":"8080"}}]',
    );
  });

  it("round-trips through JSON.parse the way spored's decoder will", () => {
    const json = serializeDeclarations([
      { ref: "mountpoint-s3", config: { bucket: "my-bucket" } },
      { ref: "docker" },
    ]);
    expect(JSON.parse(json)).toEqual([
      { ref: "mountpoint-s3", config: { bucket: "my-bucket" } },
      { ref: "docker" },
    ]);
  });
});
