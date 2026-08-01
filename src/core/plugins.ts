// Plugin detection and declaration — the two halves of plugin support a browser
// can actually do, and they are NOT the same set.
//
// Go spawn has two plugin transports, and only one of them needs a controller:
//
//   1. `spawn plugin install` on a RUNNING instance — POSTs to
//      http://127.0.0.1:7777/v1/plugins/install through an SSH tunnel
//      (cmd/plugin.go:529 `remotePluginInstall`), authenticated with a token read
//      over SSH. A browser has no SSH, so this is not portable. Not here.
//   2. `spawn launch --plugin ref[@version]` — writes declarations into user-data
//      at /etc/spawn/plugins.json (pkg/launcher/bootstrap.go:147), which spored
//      reads back at startup (`loadPluginDeclarations`, pkg/provider/ec2.go:630).
//      That is pure user-data, so a browser can do it. `buildPluginsBlock` does.
//
// Detection, by contrast, is UNIVERSAL. Every installed plugin gets a
// `spore:plugin:<name>` EC2 tag (cmd/plugin.go:301 `recordPluginProvenanceTag`),
// and DescribeInstances already returns it into `ManagedInstance.tags`. So the
// browser can report "spore-sync deployed, verify=signature" for a plugin it could
// never have installed itself. Two columns, not one:
//
//   install: 7 of 12    detect: 12 of 12
//
// The asymmetry is the point. A UI built on the install column alone would tell a
// user nothing is deployed when five things are.

import type { ManagedInstance } from "./types.js";

/** Tag key prefix for per-plugin provenance. Mirrors the Go tool's literal. */
export const PLUGIN_TAG_PREFIX = "spore:plugin:";

/**
 * The verification tier a plugin install actually reached, in Go's precedence
 * order (`pluginProvenanceTagValue`, cmd/plugin.go:279).
 *
 * `"unknown"` is a distinct fourth value and must stay distinct: a tag with no
 * `verify=` field means we cannot tell, while `verify=none` means the install ran
 * and verification reached neither a signature nor a manifest. Collapsing those
 * two hides a real supply-chain signal — the second is a finding, the first is an
 * absence of data.
 */
export type PluginVerification = "signature" | "manifest" | "none" | "unknown";

/** One plugin's provenance, decoded from a `spore:plugin:<name>` tag. */
export interface PluginProvenance {
  /** Plugin name, from the tag KEY (the value never carries it). */
  name: string;
  /** Declared version, e.g. "v1.0.0". Undefined when the tag omitted it. */
  version?: string;
  /**
   * Content digest, truncated to 12 hex chars by Go's `shortHash`
   * (cmd/plugin_inspect.go:101). Go writes the literal string "(none)" for an
   * empty digest; that is normalised away here so a caller never renders it.
   */
  contentSha256?: string;
  /** Source commit, also 12-char truncated. Absent when the ref wasn't pinned. */
  commitSha?: string;
  /** The verification tier reached — see `PluginVerification`. */
  verify: PluginVerification;
  /**
   * Any `key=value` pair this parser does not know about, preserved verbatim.
   * The Go builder can grow fields, and a strict parser that dropped them would
   * silently lose provenance on newer instances. Render these rather than hide
   * them.
   */
  extra?: Record<string, string>;
  /** The raw tag value, so a UI can show exactly what the instance reported. */
  raw: string;
  /**
   * False when the value carried no recognisable `key=value` pair at all. The
   * plugin IS still deployed — the tag's existence is the evidence — but nothing
   * about its provenance could be read. Distinct from a *missing* tag, which
   * means the plugin may not be deployed at all.
   */
  parsed: boolean;
}

/**
 * Parse one `spore:plugin:<name>` tag value.
 *
 * Format (`pluginProvenanceTagValue`, cmd/plugin.go:279) is `;`-joined
 * `key=value` pairs, capped well under EC2's 256-char tag-value limit:
 *
 *   version=v1.0.0;sha256=abc123def456;commit=789abc;verify=signature
 *
 * Only `version` is always present; `sha256` and `commit` appear when the
 * provenance record had them, and `verify` appears whenever provenance was
 * resolved at all.
 *
 * An unrecognisable value still returns a record with `parsed: false` and
 * `verify: "unknown"`. It does NOT return undefined and it does NOT throw,
 * because the tag's presence is itself the evidence that the plugin is deployed —
 * discarding the record would turn "deployed, provenance unreadable" into
 * "not deployed", which is a stronger claim than the data supports.
 */
export function parsePluginTag(name: string, value: string): PluginProvenance {
  const out: PluginProvenance = { name, verify: "unknown", raw: value, parsed: false };
  const extra: Record<string, string> = {};

  for (const part of value.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    // A bare token with no "=" is not a key/value pair. Keep it under a synthetic
    // key rather than dropping it — it's still something the instance reported.
    if (eq < 0) {
      extra[trimmed] = "";
      continue;
    }
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    switch (key) {
      case "version":
        out.version = val || undefined;
        out.parsed = true;
        break;
      case "sha256":
        // Go's shortHash returns the literal "(none)" for an empty digest. That's
        // a display placeholder, not a hash, so it must not travel as one.
        out.contentSha256 = val && val !== "(none)" ? val : undefined;
        out.parsed = true;
        break;
      case "commit":
        out.commitSha = val && val !== "(none)" ? val : undefined;
        out.parsed = true;
        break;
      case "verify":
        out.verify = isVerification(val) ? val : "unknown";
        out.parsed = true;
        break;
      default:
        // Forward-compatibility: a field this parser predates is surfaced, not
        // swallowed.
        extra[key] = val;
        out.parsed = true;
    }
  }

  if (Object.keys(extra).length > 0) out.extra = extra;
  return out;
}

function isVerification(v: string): v is PluginVerification {
  return v === "signature" || v === "manifest" || v === "none";
}

/**
 * Decode every `spore:plugin:*` tag on a tag map, sorted by plugin name so a UI
 * renders stably.
 *
 * An empty result means **no plugin tag was found**, which is NOT the same as
 * "no plugins are installed". `recordPluginProvenanceTag` is best-effort: it
 * returns early with no tag when the instance isn't EC2-resolvable, and only
 * warns when `UpdateInstanceTags` fails. It is also never written for the
 * launch-time declaration path, since no controller runs there. So absence means
 * "we don't know" — see `describePluginState`, and don't render an empty list as
 * a negative claim.
 */
export function detectPlugins(tags: Record<string, string>): PluginProvenance[] {
  const found: PluginProvenance[] = [];
  for (const [key, value] of Object.entries(tags)) {
    if (!key.startsWith(PLUGIN_TAG_PREFIX)) continue;
    const name = key.slice(PLUGIN_TAG_PREFIX.length);
    if (!name) continue; // a bare "spore:plugin:" names nothing
    found.push(parsePluginTag(name, value));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Convenience: decode the plugin tags on a `ManagedInstance`. */
export function instancePlugins(instance: ManagedInstance): PluginProvenance[] {
  return detectPlugins(instance.tags);
}

/**
 * A user-facing sentence about what the plugin tags do and do not establish.
 *
 * This exists so the #63 invariant survives contact with the UI: an instance with
 * no plugin tags must not be rendered as "no plugins installed", because the tag
 * is written best-effort by the CLI and is never written at all for plugins
 * declared at launch. The honest statement is that nothing was *reported*.
 */
export function describePluginState(plugins: PluginProvenance[]): string {
  if (plugins.length === 0) {
    return (
      "No plugin provenance tags found. This does not mean no plugins are " +
      "installed — the tag is written best-effort by the CLI when it installs a " +
      "plugin, and is not written for plugins declared at launch."
    );
  }
  const n = plugins.length;
  return `${n} plugin${n === 1 ? "" : "s"} reported: ${plugins
    .map((p) => `${p.name}${p.version ? ` ${p.version}` : ""} (verify=${p.verify})`)
    .join(", ")}`;
}

// ---------------------------------------------------------------------------
// Declaring plugins at launch — the portable half of installation.
// ---------------------------------------------------------------------------

/**
 * A plugin to install at launch. Wire-identical to Go's `plugin.Declaration`
 * (pkg/plugin/spec.go:156) so the JSON spored reads is the same JSON either tool
 * writes:
 *
 *   type Declaration struct {
 *     Ref    string            `json:"ref"`
 *     Config map[string]string `json:"config,omitempty"`
 *   }
 */
export interface PluginDeclaration {
  /** Plugin ref, optionally version-pinned: "jupyterlab" or "jupyterlab@v1.0.0". */
  ref: string;
  /** Plugin config values. Omitted from the JSON when empty, matching Go. */
  config?: Record<string, string>;
}

/**
 * The seven registry plugins whose `plugin.yaml` has **zero** local steps, and
 * which are therefore installable from a browser with nothing but user-data.
 *
 * The other five (github-actions-runner, globus-personal-endpoint, rclone,
 * spore-sync, tailscale) each have a local half. For four of them that half
 * *pushes* a minted secret to the instance, and the launch-time path has no
 * controller to run it — so those plugins park at `StatusWaitingForPush` and are
 * never resumed. That is a documented limitation of Go's own async path
 * (pkg/pluginruntime/runtime.go:62), not a browser gap:
 *
 *   > the launch-time / async path (LoadFromDeclarations → Install with nil
 *   > pushed) has no controller to run local provision, so a plugin whose
 *   > configure step needs a pushed value still parks at StatusWaitingForPush […]
 *
 * `spore-sync` is the fifth and pushes nothing, but its local half is mutagen on
 * the developer's own machine — legitimately the CLI's job, and it stays there.
 *
 * So this list is not a conservative subset of what might work; it is the set
 * that *does* work. Declaring anything else produces an instance with a plugin
 * stuck in `waiting-for-push` and no way to unstick it, which is worse than
 * refusing.
 */
export const LAUNCH_DECLARABLE_PLUGINS = [
  "cloudwatch-agent",
  "code-server",
  "docker",
  "jupyterlab",
  "mountpoint-s3",
  "rstudio-server",
  "vscode-tunnel",
] as const;

/** Plugins with a local half that mints and pushes a secret — never declarable. */
const PUSH_DEPENDENT_PLUGINS: Record<string, string> = {
  "github-actions-runner": "its local half mints a runner registration token and pushes it",
  "globus-personal-endpoint": "its local half runs `globus whoami` and pushes credentials",
  rclone: "its local half writes an rclone config and pushes it",
  tailscale: "its local half mints an auth key and pushes it",
};

/** Plugins whose local half belongs to the CLI by design. */
const CLI_OWNED_PLUGINS: Record<string, string> = {
  "spore-sync": "its local half is mutagen running on your own machine, which is the CLI's job",
};

/** The name part of a ref, dropping any `@version` pin. */
export function pluginRefName(ref: string): string {
  const at = ref.lastIndexOf("@");
  return at > 0 ? ref.slice(0, at) : ref;
}

/**
 * Whether a plugin ref can be declared at launch from a browser, and if not, WHY.
 *
 * The reason string is the deliverable as much as the boolean is: "not supported"
 * with no explanation reads as an arbitrary limitation, when in fact three
 * distinct things are going on (needs a pushed secret / belongs to the CLI /
 * isn't in the registry) and only the third might be the caller's typo.
 */
export function canDeclareAtLaunch(ref: string): { ok: boolean; reason?: string } {
  const name = pluginRefName(ref);
  if ((LAUNCH_DECLARABLE_PLUGINS as readonly string[]).includes(name)) return { ok: true };

  const push = PUSH_DEPENDENT_PLUGINS[name];
  if (push) {
    return {
      ok: false,
      reason:
        `"${name}" cannot be declared at launch: ${push}, and the launch-time path has ` +
        `no controller to do that. It would park at waiting-for-push on the instance — ` +
        `the same limitation the Go tool documents. Install it with the CLI instead.`,
    };
  }
  const cli = CLI_OWNED_PLUGINS[name];
  if (cli) {
    return {
      ok: false,
      reason: `"${name}" cannot be declared at launch: ${cli}. Use the CLI.`,
    };
  }
  return {
    ok: false,
    reason:
      `"${name}" is not a known launch-declarable plugin. Declarable: ` +
      `${LAUNCH_DECLARABLE_PLUGINS.join(", ")}.`,
  };
}

/**
 * Validate a set of declarations, returning the reason for each rejection.
 *
 * Rejections are RETURNED rather than thrown, and the accepted set comes back
 * alongside them, so a caller can launch with what works while telling the user
 * exactly what was dropped. Silently filtering would produce an instance missing
 * a plugin the user asked for, with nothing to explain it.
 */
export function validateDeclarations(
  declarations: PluginDeclaration[],
): { accepted: PluginDeclaration[]; rejected: Array<{ ref: string; reason: string }> } {
  const accepted: PluginDeclaration[] = [];
  const rejected: Array<{ ref: string; reason: string }> = [];
  for (const d of declarations) {
    const verdict = canDeclareAtLaunch(d.ref);
    if (verdict.ok) accepted.push(d);
    else rejected.push({ ref: d.ref, reason: verdict.reason! });
  }
  return { accepted, rejected };
}

/**
 * Serialize declarations to the exact JSON spored expects at
 * /etc/spawn/plugins.json. `config` is omitted when empty to match Go's
 * `json:"config,omitempty"` — spored tolerates either, but a byte-compatible
 * payload keeps the two writers comparable when debugging an instance.
 */
export function serializeDeclarations(declarations: PluginDeclaration[]): string {
  return JSON.stringify(
    declarations.map((d) =>
      d.config && Object.keys(d.config).length > 0 ? { ref: d.ref, config: d.config } : { ref: d.ref },
    ),
  );
}
