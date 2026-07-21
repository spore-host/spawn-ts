// Bootstrap user-data for real EC2 launches. This is what makes spawn-ts's
// self-termination guarantee real rather than tab-dependent: the browser is
// just a launcher, but the instance itself installs `spored`, which reads the
// spawn:* tags and enforces TTL/idle/cost/completion locally — so an instance
// terminates on its TTL even if the browser tab is closed.
//
// Mirrors the shape of ~/src/spore-host/spawn/pkg/launcher/bootstrap.go's
// BuildLinuxBootstrap: all runtime behavior comes from tags; the script only
// installs the daemon and (optionally) writes the embedded --command workload.
//
// EC2 requires UserData to be base64. cloud-init on AL2023/Ubuntu also
// transparently gunzips it, but plain base64 of the raw script is accepted too;
// we keep it simple (base64 of text) since the browser has no gzip-to-bytes
// helper as ergonomic as Go's. If size ever matters, swap in CompressionStream.

export interface BootstrapOptions {
  /** Primary login user for the instance (e.g. "ec2-user", "ubuntu"). */
  username: string;
  /** Optional SSH public key to authorize. Empty => SSM-only, keyless. */
  publicKey?: string;
  /** Optional workload command, embedded in user-data (not the length-capped tag). */
  command?: string;
  /**
   * Base host for the spored binary bucket. Defaults to the spore.host regional
   * S3 scheme (`spawn-binaries-<region>.s3.amazonaws.com`), resolved at runtime
   * from IMDS. Override only for testing/mirrors.
   */
  binaryBucketPrefix?: string;
  /**
   * Idle-SSH-shell auto-logout, in ms. 0/undefined = disabled. Writes an sshd
   * ClientAlive config + a readonly TMOUT in /etc/profile.d/. Mirrors the Go
   * bootstrap (pkg/launcher/bootstrap.go). Disconnects idle login sessions; it
   * does NOT stop/terminate the instance (that's the idle-instance lifecycle).
   */
  sessionTimeoutMs?: number;
  /**
   * PEM-encoded spore.host signing PUBLIC key. When set, the bootstrap verifies
   * the downloaded spored's detached signature against this key (fail-closed)
   * before installing — proving authenticity, not just integrity. The key is
   * carried by the launcher (trusted), NOT served from the binary's S3 bucket,
   * so a bucket compromise can't forge it (spore-host#440). Absent = checksum
   * only (guards corruption), matching the Go tool's default when no key is
   * compiled in.
   */
  sporedSigningPublicKey?: string;
}

/**
 * Build the plaintext bootstrap script. Installs spored the same way the Go tool
 * does (pkg/launcher/bootstrap.go): detect arch (amd64/arm64), read the region
 * from IMDS, download `spored-linux-<arch>` from the regional S3 bucket with a
 * us-east-1 fallback and both prefixed + legacy paths, verify the SHA256, and
 * install atomically. The earlier GitHub-release URL was a fiction (404) and
 * amd64-only — see spawn-ts#17.
 */
export function buildLinuxBootstrap(opts: BootstrapOptions): string {
  const user = opts.username || "ec2-user";
  const keyLine = opts.publicKey
    ? `echo ${shellSingleQuote(opts.publicKey)} >> /home/${user}/.ssh/authorized_keys`
    : `# no SSH key supplied — SSM-only instance`;

  const commandBlock = opts.command
    ? `mkdir -p /etc/spawn
cat > /etc/spawn/command <<'EOFSPAWNCMD'
${opts.command}
EOFSPAWNCMD
chmod 600 /etc/spawn/command
`
    : "";

  // Idle-SSH-shell auto-logout (spawn:session-timeout). Mirrors the Go bootstrap:
  // sshd ClientAlive (keepalive = 1/6 of the timeout, min 60s) disconnects idle
  // connections, and a readonly TMOUT in /etc/profile.d/ auto-logs-out idle
  // shells. Seconds are computed here so the script needs no duration parser.
  const sessionBlock = buildSessionTimeoutBlock(opts.sessionTimeoutMs ?? 0);

  // Optional publisher-signature verification of the spored binary. Empty when
  // no signing key is supplied (checksum-only, the default). Runs after the
  // SHA256 check and before the atomic install; fail-closed on any mismatch.
  const sigVerifyBlock = buildSigVerifyBlock(opts.sporedSigningPublicKey);

  return `#!/bin/bash
set -e

LOCAL_USERNAME=${user}
mkdir -p /home/${user}/.ssh && chmod 700 /home/${user}/.ssh
${keyLine}
chown -R ${user}:${user} /home/${user}/.ssh 2>/dev/null || true

${commandBlock}${sessionBlock}
# Install spored — the in-instance lifecycle daemon. It reads the spawn:* tags
# this instance was launched with (via IMDS + ec2:DescribeTags) and enforces
# TTL/idle/cost/completion locally, so the instance self-terminates even if the
# browser tab is gone. Requires an IAM instance profile allowing DescribeTags/
# DescribeInstances + TerminateInstances/StopInstances on spawn:managed=true.

# Detect architecture.
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) BINARY="spored-linux-amd64" ;;
  aarch64) BINARY="spored-linux-arm64" ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# Detect region from IMDS (v2 token first, fall back to v1, then us-east-1).
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)
if [ -n "$TOKEN" ]; then
  REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
else
  REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
fi
[ -n "$REGION" ] || REGION=us-east-1

REGIONAL="https://spawn-binaries-\${REGION}.s3.amazonaws.com"
FALLBACK="https://spawn-binaries-us-east-1.s3.amazonaws.com"
SPORED_TMP="$(mktemp /tmp/spored.XXXXXX)"

# Try regional bucket (prefixed then legacy path), then us-east-1 (same).
if curl -f -o "$SPORED_TMP" "\${REGIONAL}/spawn/\${BINARY}" 2>/dev/null; then
  CHECKSUM_URL="\${REGIONAL}/spawn/\${BINARY}.sha256"
elif curl -f -o "$SPORED_TMP" "\${REGIONAL}/\${BINARY}" 2>/dev/null; then
  CHECKSUM_URL="\${REGIONAL}/\${BINARY}.sha256"
elif curl -f -o "$SPORED_TMP" "\${FALLBACK}/spawn/\${BINARY}" 2>/dev/null; then
  CHECKSUM_URL="\${FALLBACK}/spawn/\${BINARY}.sha256"
else
  curl -f -o "$SPORED_TMP" "\${FALLBACK}/\${BINARY}" || { echo "failed to download spored" >&2; rm -f "$SPORED_TMP"; exit 1; }
  CHECKSUM_URL="\${FALLBACK}/\${BINARY}.sha256"
fi

# Verify SHA256 (best-effort: the checksum sits beside the binary, so this
# guards corruption, not authenticity — matches the Go bootstrap's default).
if curl -f -s -o /tmp/spored.sha256 "$CHECKSUM_URL" 2>/dev/null; then
  EXPECTED=$(awk '{print $1}' /tmp/spored.sha256)
  ACTUAL=$(sha256sum "$SPORED_TMP" | awk '{print $1}')
  if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "spored checksum mismatch (expected $EXPECTED, got $ACTUAL)" >&2
    rm -f "$SPORED_TMP"; exit 1
  fi
fi
${sigVerifyBlock}
# Atomic install — rename works even if an old spored is executing (#27).
chmod +x "$SPORED_TMP"
mv -f "$SPORED_TMP" /usr/local/bin/spored

# systemd unit — kept byte-for-byte identical to the Go bootstrap's
# (pkg/launcher/bootstrap.go). The daemon is the BARE spored invocation with no
# subcommand; passing an unknown subcommand makes spored exit non-zero and the
# unit crash-loops, never enforcing the TTL (spawn-ts#19). Do not diverge here.
cat > /etc/systemd/system/spored.service <<'EOF'
[Unit]
Description=Spawn Agent - Instance self-monitoring
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=SPORE_DNS_SIGV4=1
ExecStart=/usr/local/bin/spored
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable spored
systemctl start spored
`;
}

/**
 * Bootstrap fragment that verifies the spored binary's detached signature
 * against a supplied signing PUBLIC key before install. Empty when no key is
 * given (checksum-only default). Ports the Go bootstrap's SPORED_SIG_VERIFY
 * path (pkg/launcher/bootstrap.go): download `<binary>.sig` next to the
 * checksum URL, base64-decode to DER, `openssl dgst -sha256 -verify`,
 * fail-closed on missing/invalid signature.
 */
function buildSigVerifyBlock(publicKeyPem?: string): string {
  if (!publicKeyPem || !publicKeyPem.trim()) return "";
  return `
# Publisher-signature verification (spore-host#440). The checksum above only
# proves the download wasn't corrupted (it's served from the same bucket as the
# binary); this proves authenticity against a key carried by the launcher, not
# the bucket. Fail-closed.
mkdir -p /etc/spawn
cat > /etc/spawn/spored-signing-key.pem <<'EOFSPOREDPUBKEY'
${publicKeyPem.trim()}
EOFSPOREDPUBKEY
SIG_URL="\${CHECKSUM_URL%.sha256}.sig"
if ! curl -f -s -o /tmp/spored.sig "$SIG_URL"; then
  echo "spored signature not found at $SIG_URL — refusing to run an unsigned binary" >&2
  rm -f "$SPORED_TMP"; exit 1
fi
# The .sig is base64-encoded DER (ECDSA_SHA_256); decode to raw DER for openssl.
base64 -d /tmp/spored.sig > /tmp/spored.sig.der 2>/dev/null || cp /tmp/spored.sig /tmp/spored.sig.der
if openssl dgst -sha256 -verify /etc/spawn/spored-signing-key.pem -signature /tmp/spored.sig.der "$SPORED_TMP" >/dev/null 2>&1; then
  echo "spored signature verified (spore.host)"
else
  echo "spored signature verification FAILED — refusing to run spored" >&2
  rm -f "$SPORED_TMP" /tmp/spored.sig /tmp/spored.sig.der; exit 1
fi
rm -f /tmp/spored.sig /tmp/spored.sig.der
`;
}

/**
 * Bootstrap fragment for idle-SSH-shell auto-logout. Empty when disabled
 * (timeoutMs <= 0). Sets sshd ClientAlive (interval = 1/6 of the timeout, min
 * 60s, ×3 count) and a readonly TMOUT for all shells. Ports the Go bootstrap's
 * session-timeout block; the seconds are precomputed so no shell parser is needed.
 */
function buildSessionTimeoutBlock(timeoutMs: number): string {
  if (timeoutMs <= 0) return "";
  const seconds = Math.round(timeoutMs / 1000);
  const sshInterval = Math.max(60, Math.floor(seconds / 6));
  return `
# Idle session auto-logout (spawn:session-timeout).
if ! grep -q "^ClientAliveInterval" /etc/ssh/sshd_config; then
  echo "ClientAliveInterval ${sshInterval}" >> /etc/ssh/sshd_config
  echo "ClientAliveCountMax 3" >> /etc/ssh/sshd_config
  systemctl reload sshd 2>/dev/null || service sshd reload 2>/dev/null || true
fi
cat > /etc/profile.d/session-timeout.sh <<'EOFTIMEOUT'
# Automatic logout for idle shells; readonly prevents users from unsetting it.
export TMOUT=${seconds}
readonly TMOUT
EOFTIMEOUT
chmod 644 /etc/profile.d/session-timeout.sh

`;
}

/** Base64-encode the bootstrap for the RunInstances UserData field. */
export function encodeUserData(script: string): string {
  // btoa needs Latin-1; encode UTF-8 first so non-ASCII commands survive.
  const utf8 = new TextEncoder().encode(script);
  let bin = "";
  for (const b of utf8) bin += String.fromCharCode(b);
  return btoa(bin);
}

function shellSingleQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}
