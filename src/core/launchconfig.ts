// The per-launch config object (Go spawn#1359, pkg/launchconfig): the spored
// settings fixed at launch, moved out of instance tags into one JSON object
// that spored reads once.
//
// spored from spawn v0.150.0 reads these settings ONLY from the object, which
// the instance names with one tag, spawn:config=<sha256>. A tag carrying one of
// them is ignored (and logged as ignored). There is no tag fallback: it is a
// same-version contract, which holds because spawn-ts pins the spored it
// installs (SPAWN_BOOTSTRAP_VERSION, src/aws/userdata.ts).
//
// Transport. Go stores the object in the account's staging bucket and spored
// fetches it; a detached sweep member instead gets it seeded into spored's cache
// by its user data. spored reads the cache first and uses it only if it hashes
// to the instance's own spawn:config (launchconfig.Load), so the seed is a
// complete delivery. spawn-ts uses the seed for every launch: a browser writing
// to the staging bucket would need CORS the bucket does not have, the bucket
// setup calls (EnsureStagingBucket), and an instance-role grant a caller's own
// profile may lack. The one reader the seed does not reach is a persistent-Spot
// replacement (fresh root volume, fetches from S3); spawn-ts makes only one-time
// Spot requests (core/bounds.ts checkSpotStoppable), so it has none.

import { goMarshal, goStruct } from "./gojson.js";

/** The tag naming the object: spawn:config=<sha256>. */
export const LAUNCH_CONFIG_TAG = "spawn:config";

/** The object schema this spawn-ts writes (launchconfig.Schema). */
export const LAUNCH_CONFIG_SCHEMA = 1;

/** The first spored release that reads the object (launchconfig.FirstSporedVersion). */
export const LAUNCH_CONFIG_FIRST_SPORED_VERSION = "0.150.0";

/** Where spored caches the object, and where the bootstrap seeds it (LinuxCachePath). */
export const LAUNCH_CONFIG_CACHE_PATH = "/etc/spawn/launch-config.json";

/**
 * The settings that live in the object and nowhere else, by tag name without
 * the spawn: prefix (launchconfig.SettingKeys, sorted). spawn-ts writes nine of
 * them: the eight hook settings and idle-cpu.
 */
export const LAUNCH_CONFIG_SETTINGS: readonly string[] = [
  "active-ports",
  "active-processes",
  "app-mode",
  "completion-webhook-url",
  "idle-cpu",
  "metrics-bind",
  "metrics-path",
  "metrics-port",
  "notify-command",
  "notify-platform",
  "notify-url",
  "ready-path",
  "ready-port",
  "slack-workspace-id",
  "spot-webhook-url",
  "tracing-enabled",
  "tracing-exporter",
  "tracing-sampling",
  "web-auth",
  "webhook-correlation",
  "webhook-timeout",
];

const SETTING_SET = new Set(LAUNCH_CONFIG_SETTINGS);

/** Is `key` (with or without spawn:) one of the object's settings? */
export function isLaunchConfigSetting(key: string): boolean {
  return SETTING_SET.has(key.startsWith("spawn:") ? key.slice("spawn:".length) : key);
}

/**
 * Split a launch's tag map: the object's settings come out (keyed without the
 * prefix, values exactly as the tags carried them, which is what spored parses),
 * everything else stays a tag. The input is not modified.
 */
export function splitLaunchConfigTags(tags: Record<string, string>): {
  tags: Record<string, string>;
  settings: Record<string, string>;
} {
  const out: Record<string, string> = {};
  const settings: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (k.startsWith("spawn:") && isLaunchConfigSetting(k)) settings[k.slice("spawn:".length)] = v;
    else out[k] = v;
  }
  return { tags: out, settings };
}

/** Lowercase hex sha256 of a string's UTF-8 bytes. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Go's launchconfig.Encode: the object for `settings`, its canonical bytes and
 * their sha256. Empty values are dropped; no settings means no object (null),
 * and the launch writes no spawn:config tag. A key that is not a setting is an
 * error: no spored would read it.
 *
 * Canonical: `{"schema":1,"settings":{...}}`, keys sorted, no HTML escaping, no
 * trailing newline (encoding/json with SetEscapeHTML(false)), so the bytes, and
 * so the sha, are the ones Go produces for the same settings.
 */
export async function encodeLaunchConfig(
  settings: Record<string, string>,
): Promise<{ body: string; sha256: string } | null> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (!SETTING_SET.has(k)) {
      throw new Error(`launch config object: "${k}" is not a launch-fixed spored setting`);
    }
    if (v !== "") clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return null;
  const body = goMarshal(
    goStruct([
      ["schema", LAUNCH_CONFIG_SCHEMA],
      ["settings", clean],
    ]),
    false,
  );
  return { body, sha256: await sha256Hex(body) };
}
