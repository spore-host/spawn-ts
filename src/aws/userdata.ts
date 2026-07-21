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

  return `#!/bin/bash
set -e

LOCAL_USERNAME=${user}
mkdir -p /home/${user}/.ssh && chmod 700 /home/${user}/.ssh
${keyLine}
chown -R ${user}:${user} /home/${user}/.ssh 2>/dev/null || true

${commandBlock}
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
