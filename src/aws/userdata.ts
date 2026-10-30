// Bootstrap user-data for real EC2 launches. This is what makes spawn-ts's
// self-termination guarantee real rather than tab-dependent: the browser is
// just a launcher, but the instance itself installs `spored`, which reads the
// spawn:* tags and enforces TTL/idle/cost/completion locally — so an instance
// terminates on its TTL even if the browser tab is closed.
//
// The script is Go spawn's release-build bootstrap (pkg/launcher/bootstrap.go,
// BuildLinuxBootstrap, #1274), rendered for a pinned spawn release
// (SPAWN_BOOTSTRAP_VERSION): a short stub that fetches the static bootstrap body
// that release published beside spored in every spawn-binaries-<region> bucket,
// refuses it unless its sha256 is BOOTSTRAP_BODY_SHA256 AND its signature
// verifies against the spore.host key, and only then runs it. The body installs
// that same release's spored from spawn/versions/<version>/ (#1412), never the
// unversioned latest. Everything the body does (create the user, install and
// start spored, session timeout, job-array/sweep env, --command, the Spot
// replacement stop) is therefore Go's, byte for byte, not a hand-maintained copy
// of it — which is what the previous, inline spawn-ts bootstrap was, and why it
// had drifted (no fatal-retire, no SELinux relabel, no curl retry, an unpinned
// spored, signature verification off by default).
//
// The per-launch parts spawn-ts supports (user, key, command, completion file,
// launch config object, plugins) are rendered here exactly as Go renders them;
// testdata/stub-fixtures.v0.150.0.json holds Go's own output for the same
// inputs and userdata.test.ts requires byte equality.

import { type PluginDeclaration, serializeDeclarations } from "../core/plugins.js";
import { LAUNCH_CONFIG_CACHE_PATH } from "../core/launchconfig.js";

/**
 * The spawn release whose published bootstrap body and spored a spawn-ts launch
 * installs.
 *
 * 0.150.0, the first spored that reads the launch config object (spawn#1359,
 * LAUNCH_CONFIG_FIRST_SPORED_VERSION): from it on, the hook settings and
 * idle-cpu are read only from the object, so spawn-ts writes the object
 * (core/launchconfig.ts) and stops writing those tags. The pin and the object
 * move together or not at all: a spored older than 0.150.0 ignores the object,
 * and one from 0.150.0 ignores the tags (#108, #110). The versioned path is
 * permanent (#1412), and the release workflow publishes and reads back the
 * body, spored, .sha256 and .sig there before the CLI is installable (#1415).
 *
 * Moving this pin is a contract change, not a version bump: re-generate the
 * body and fixtures with scripts/gen-go-fixtures.sh, and check which settings
 * that release's spored reads from tags and which from the object.
 */
export const SPAWN_BOOTSTRAP_VERSION = "0.150.0";

/**
 * sha256 of `spawn bootstrap-body` at SPAWN_BOOTSTRAP_VERSION, i.e. of
 * launcher.BootstrapBody(). Reproducible without a checkout:
 * `go run github.com/spore-host/spawn@v0.150.0 bootstrap-body | sha256sum`.
 * testdata/bootstrap-body.v0.150.0.sh is that output, and a test pins the hash
 * to it, so this constant cannot silently disagree with the bytes it names.
 */
export const BOOTSTRAP_BODY_SHA256 =
  "925521a3c0b1707f749eb55cceaef059a526d56a9dbce198e8c389d7f976fc30";

/**
 * The spore.host spored signing PUBLIC key (pkg/sporedinstall.SigningKeyPEM):
 * the public half of the KMS key (ECDSA_SHA_256, P-256) the release pipeline
 * signs spored and the bootstrap body with. Carried by the launcher, not served
 * from the bucket, so a bucket compromise cannot forge a signature
 * (spore-host#440).
 */
export const SPORED_SIGNING_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEOZo4nbX52lIw/vbPQdawhyXrhG+c
AtY5UKek+Y9PGbBHyqAukxdMoE5hc28ZvbcDIRiSussHivyki5gr8/QlVA==
-----END PUBLIC KEY-----`;

/** Where the bootstrap writes the signing key (sporedinstall.SigningKeyPath). */
const SIGNING_KEY_PATH = "/etc/spawn/spored-signing-key.pem";

/** Where the stub saves the body before verifying and sourcing it. */
const BODY_PATH = "/etc/spawn/bootstrap-body.sh";

/** The completion sentinel when no completionFile is given (flag default). */
const DEFAULT_COMPLETION_FILE = "/tmp/SPAWN_COMPLETE";

export interface BootstrapOptions {
  /**
   * Local Linux user the body creates (e.g. "ec2-user", "ubuntu"). Required, and
   * held to Go's `security.ValidateUsername`: it lands in the shell and in
   * /etc/sudoers.d, so it is refused rather than quoted around.
   */
  username: string;
  /** SSH public key to authorize. Empty => SSM-only (or the EC2 key pair's key). */
  publicKey?: string;
  /** Workload command, written to /etc/spawn/command (user-data, not the 256-char tag). */
  command?: string;
  /**
   * Path the --command wrapper writes its completion record to, which spored
   * watches. Must agree with spawn:completion-file or on-complete never fires
   * (spawn#1131). Empty => /tmp/SPAWN_COMPLETE.
   */
  completionFile?: string;
  /**
   * Override for the PEM signing public key the stub and the spored install
   * verify against. Defaults to SPORED_SIGNING_KEY_PEM; only a key rotation
   * needs this. Verification is not optional: the stub refuses to run a body it
   * cannot verify, exactly as a Go release build does.
   */
  sporedSigningPublicKey?: string;
  /**
   * The launch config object (core/launchconfig.ts encodeLaunchConfig), seeded
   * where spored caches it, /etc/spawn/launch-config.json (0600), before the
   * body starts spored. spored uses it only if it hashes to the instance's
   * spawn:config tag. Absent when the launch sets none of the object's settings.
   */
  launchConfig?: string;
  /**
   * Plugins to declare at launch. Written to /etc/spawn/plugins.json before
   * spored starts (spawn#1023), which spored reads once at startup.
   *
   * This is the ONLY portable plugin-install transport: `spawn plugin install`
   * needs an SSH tunnel to the on-instance controller, which a browser has not
   * got. Restricted to `LAUNCH_DECLARABLE_PLUGINS` — see `core/plugins.ts`.
   */
  plugins?: PluginDeclaration[];
}

/** Go's security.ShellQuote: single quotes, with ' as '\''. */
export function shellQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

/**
 * Go's security.ValidateUsername. The username is interpolated into the body's
 * useradd/sudoers lines, so anything outside the POSIX shape is refused.
 */
export function validateUsername(username: string): void {
  if (username === "") throw new Error("bootstrap: username is required");
  if (username.length > 32) {
    throw new Error("invalid username: username exceeds maximum length of 32 characters");
  }
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(username)) {
    throw new Error(
      "invalid username: invalid username format: must start with lowercase letter and contain only lowercase letters, digits, hyphens, and underscores",
    );
  }
}

/** sporedinstall.KeySetupScript, comment-stripped as Go splices it in. */
function keySetupScript(pem: string): string {
  return `SPORED_SIG_VERIFY=1
mkdir -p /etc/spawn
cat > ${SIGNING_KEY_PATH} <<'EOFSPOREDPUBKEY'
${pem}
EOFSPOREDPUBKEY
`;
}

/** sporedinstall.PinScript: the spored release the body installs (#1412). */
function pinScript(version: string): string {
  return "\nSPAWN_SPORED_VERSION=" + shellQuote(version) + "\n";
}

/**
 * Go's fatalRetireFunc, comment-stripped. Defines spawn_fatal_retire and an
 * EXIT trap so that ANY exit of the bootstrap before spored is running
 * terminates the instance (via the role's self-only terminate grant), or shuts
 * it down when it cannot: with no spored, nothing would enforce its TTL (#1274).
 */
const FATAL_RETIRE = `spawn_fatal_say() {
    echo "spawn: $1" >&2
    echo "spawn: $1" >> /dev/console 2>/dev/null || true
    logger -p user.crit -t spawn-bootstrap "$1" 2>/dev/null || true
}
spawn_fatal_retire() {
    local tok id region n=0
    trap - EXIT
    spawn_fatal_say "FATAL: $1 (#1274)"
    tok=$(curl -sf --connect-timeout 5 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || true)
    id=$(curl -sf --connect-timeout 5 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)
    region=$(curl -sf --connect-timeout 5 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)
    if [ -n "$id" ] && [ -n "$region" ] && command -v aws >/dev/null 2>&1; then
        while [ "$n" -lt 3 ]; do
            if aws ec2 terminate-instances --region "$region" --instance-ids "$id" --cli-connect-timeout 10 --cli-read-timeout 30 >/dev/null 2>&1; then
                spawn_fatal_say "terminating $id: with no spored, nothing would enforce its TTL"
                exit 1
            fi
            n=$((n + 1))
            sleep 5
        done
    fi
    spawn_fatal_say "could not terminate this instance (no aws CLI, instance ID or permission); shutting down instead, which STOPS it (spawn sets no InstanceInitiatedShutdownBehavior): its volumes still bill, it no longer runs"
    shutdown -h now 2>/dev/null || poweroff 2>/dev/null || true
    exit 1
}
SPAWN_SPORED_UP=0
SPAWN_MAIN_PID=$$
SPAWN_LAST_FAILED="none"
trap 'SPAWN_LAST_FAILED="line $LINENO: $BASH_COMMAND"' ERR
spawn_exit_guard() {
    local rc=$?
    [ "\${BASHPID:-$$}" = "$SPAWN_MAIN_PID" ] || return 0
    [ "$SPAWN_SPORED_UP" = 1 ] && return 0
    spawn_fatal_retire "the bootstrap exited (status $rc) before spored started; last failed command: $SPAWN_LAST_FAILED"
}
trap spawn_exit_guard EXIT
`;

/**
 * Go's bodyStubTemplate, comment-stripped: fetch the release's body (regional
 * bucket, then us-east-1, 4 tries each), require the expected sha256 AND a
 * valid signature, else spawn_fatal_retire; then source it.
 */
function bodyStub(version: string, sha256: string): string {
  const p = BODY_PATH;
  return `SPAWN_BS_VERSION=${shellQuote(version)}
SPAWN_BS_SHA256=${sha256}
SPAWN_BS_TOKEN=$(curl -sf --connect-timeout 5 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || true)
SPAWN_BS_REGION=$(curl -sf --connect-timeout 5 -H "X-aws-ec2-metadata-token: $SPAWN_BS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || true)
SPAWN_BS_OK=0
mkdir -p /etc/spawn
for SPAWN_BS_BASE in "https://spawn-binaries-\${SPAWN_BS_REGION:-us-east-1}.s3.amazonaws.com" "https://spawn-binaries-us-east-1.s3.amazonaws.com"; do
    SPAWN_BS_URL="$SPAWN_BS_BASE/spawn/versions/$SPAWN_BS_VERSION/bootstrap.sh"
    for SPAWN_BS_TRY in 1 2 3 4; do
        rm -f ${p} ${p}.sig ${p}.der
        if curl -fsS --connect-timeout 10 --max-time 60 -o ${p} "$SPAWN_BS_URL" &&
            curl -fsS --connect-timeout 10 --max-time 60 -o ${p}.sig "$SPAWN_BS_URL.sig"; then
            break
        fi
        [ "$SPAWN_BS_TRY" = 4 ] || sleep 2
    done
    if [ ! -s ${p} ] || [ ! -s ${p}.sig ]; then
        echo "spawn: no bootstrap body or signature at $SPAWN_BS_URL" >&2
        continue
    fi
    if [ "$(sha256sum ${p} | cut -d ' ' -f 1)" != "$SPAWN_BS_SHA256" ]; then
        echo "spawn: bootstrap body at $SPAWN_BS_URL is not the one spawn $SPAWN_BS_VERSION expects (sha256)" >&2
        continue
    fi
    if base64 -d < ${p}.sig > ${p}.der 2>/dev/null &&
        openssl dgst -sha256 -verify ${SIGNING_KEY_PATH} -signature ${p}.der ${p} >/dev/null 2>&1; then
        SPAWN_BS_OK=1
        break
    fi
    echo "spawn: bootstrap body signature at $SPAWN_BS_URL.sig does not verify" >&2
done
rm -f ${p}.sig ${p}.der
if [ "$SPAWN_BS_OK" != 1 ]; then
    rm -f ${p}
    spawn_fatal_retire "no verified bootstrap body for spawn $SPAWN_BS_VERSION; not running an unverified bootstrap, so spored is not installed and no workload starts"
fi
echo "Bootstrap body verified (spawn $SPAWN_BS_VERSION, sha256 $SPAWN_BS_SHA256)"
. ${p}
`;
}

/** Go's perLaunchFiles for the command (the flush hook is task-run only). */
function commandBlock(command?: string): string {
  if (!command) return "";
  return `
# Embedded --command workload (user-data, not the spawn:command tag; #214/#246)
mkdir -p /etc/spawn
cat > /etc/spawn/command <<'EOFSPAWNCMD'
${command}
EOFSPAWNCMD
chmod 600 /etc/spawn/command
`;
}

/**
 * Go's launch-config seed block (pkg/launcher perLaunchPreBody, #1359): base64,
 * so the shell carries the exact bytes whose sha256 spawn:config names. Before
 * the body, so the cache exists when spored starts; written this boot, so
 * spored's discard-inherited-state keeps it.
 */
function launchConfigBlock(body?: string): string {
  if (!body) return "";
  return `
# Launch config object (#1359), checked by spored against spawn:config
mkdir -p /etc/spawn
echo '${base64Utf8(body)}' | base64 -d > ${LAUNCH_CONFIG_CACHE_PATH}
chmod 600 ${LAUNCH_CONFIG_CACHE_PATH}
`;
}

/**
 * Go's plugin-declarations block, written before the body so spored, which
 * reads the file once at startup, never starts without it (#1023). The JSON is
 * `serializeDeclarations`, which matches Go's json.Marshal of
 * []plugin.Declaration byte for byte (sorted config keys, HTML escaping).
 */
function pluginsBlock(plugins?: PluginDeclaration[]): string {
  if (!plugins || plugins.length === 0) return "";
  return `
# Plugin declarations, read once by spored at startup, so written before it starts (#1023)
mkdir -p /etc/spawn
cat > /etc/spawn/plugins.json <<'EOFPLUGINS'
${serializeDeclarations(plugins)}
EOFPLUGINS
chmod 644 /etc/spawn/plugins.json
echo "Plugin declarations written: ${plugins.length} plugin(s)"
`;
}

/** Base64 of a string's UTF-8 bytes (Go's base64.StdEncoding of []byte). */
function base64Utf8(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Build the plaintext bootstrap: the stub user data a Go release build of
 * SPAWN_BOOTSTRAP_VERSION would send for the same inputs
 * (launcher.BuildLinuxBootstrap with InlineBody false). Throws on an invalid
 * username, as Go does.
 */
export function buildLinuxBootstrap(opts: BootstrapOptions): string {
  validateUsername(opts.username);
  const key = opts.publicKey ? base64Utf8(opts.publicKey) : "";
  const pem = opts.sporedSigningPublicKey?.trim() || SPORED_SIGNING_KEY_PEM;
  const completionFile = opts.completionFile || DEFAULT_COMPLETION_FILE;

  const prefix =
    `#!/bin/bash
set -e

# User configuration
LOCAL_USERNAME=${shellQuote(opts.username)}
LOCAL_SSH_KEY_BASE64=${shellQuote(key)}
SPAWN_CMD_COMPLETION_FILE=${shellQuote(completionFile)}
` +
    keySetupScript(pem) +
    pinScript(SPAWN_BOOTSTRAP_VERSION) +
    FATAL_RETIRE;

  const pre = commandBlock(opts.command) + launchConfigBlock(opts.launchConfig) + pluginsBlock(opts.plugins);
  return prefix + pre + bodyStub(SPAWN_BOOTSTRAP_VERSION, BOOTSTRAP_BODY_SHA256);
}

/**
 * Encode a Linux bootstrap for RunInstances UserData exactly as Go does
 * (launcher.EncodeLinuxUserData): gzip, then base64. cloud-init gunzips it.
 * Gzip is what makes EC2's 16 KiB limit (which counts the decoded bytes) leave
 * room; CompressionStream is in every browser spawn-ts targets and in Node 18+.
 */
export async function encodeLinuxUserData(script: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(script)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (let i = 0; i < gz.length; i += 0x8000) {
    bin += String.fromCharCode(...gz.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * Plain base64 of a script's UTF-8 bytes, without gzip. Kept for callers that
 * need uncompressed user data; launches use encodeLinuxUserData.
 */
export function encodeUserData(script: string): string {
  return base64Utf8(script);
}

/**
 * EC2's two user-data limits (spawn#1063, pkg/aws/userdata_limit.go): 16384
 * bytes after base64 decoding — for gzipped Linux user data, the gzip stream —
 * and 25600 characters of base64. The first is the one that binds.
 */
export const MAX_USER_DATA_BYTES = 16384;
export const MAX_ENCODED_USER_DATA_BYTES = 25600;

/** Thrown before any AWS call when user data is over an EC2 limit. */
export class UserDataTooLargeError extends Error {
  constructor(
    readonly decodedBytes: number,
    readonly encodedBytes: number,
  ) {
    super(
      `user data is ${decodedBytes} bytes after encoding (${encodedBytes} as sent, base64); ` +
        `EC2 allows ${MAX_USER_DATA_BYTES} (and ${MAX_ENCODED_USER_DATA_BYTES} base64), so RunInstances would refuse it`,
    );
    this.name = "UserDataTooLargeError";
  }
}

/**
 * Go's UserDataSize: the decoded byte count and the encoded length of
 * already-base64 user data. Invalid base64 is measured as raw bytes.
 */
export function userDataSize(encoded: string): { decoded: number; encoded: number } {
  const n = encoded.length;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return { decoded: n, encoded: n };
  }
  const pad = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return { decoded: (n / 4) * 3 - pad, encoded: n };
}

/** Go's CheckUserDataSize: throws UserDataTooLargeError over either limit. */
export function checkUserDataSize(encoded: string): void {
  if (encoded === "") return;
  const { decoded, encoded: len } = userDataSize(encoded);
  if (decoded > MAX_USER_DATA_BYTES || len > MAX_ENCODED_USER_DATA_BYTES) {
    throw new UserDataTooLargeError(decoded, len);
  }
}
