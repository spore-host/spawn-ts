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
  /** spored release channel/version to install (default: latest). */
  sporedVersion?: string;
}

/** Build the plaintext bootstrap script. */
export function buildLinuxBootstrap(opts: BootstrapOptions): string {
  const user = opts.username || "ec2-user";
  const version = opts.sporedVersion || "latest";
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

  // spored reads spawn:* tags via IMDS + ec2:DescribeTags, so the instance role
  // must allow DescribeTags/DescribeInstances and the self-lifecycle calls
  // (TerminateInstances/StopInstances) scoped to spawn:managed=true resources.
  const dl =
    version === "latest"
      ? "https://github.com/spore-host/spawn/releases/latest/download/spored_linux_amd64"
      : `https://github.com/spore-host/spawn/releases/download/${version}/spored_linux_amd64`;

  return `#!/bin/bash
set -e

LOCAL_USERNAME=${user}
mkdir -p /home/${user}/.ssh && chmod 700 /home/${user}/.ssh
${keyLine}
chown -R ${user}:${user} /home/${user}/.ssh 2>/dev/null || true

${commandBlock}
# Install spored — the in-instance lifecycle daemon. It reads the spawn:* tags
# this instance was launched with and enforces TTL/idle/cost/completion locally.
curl -fsSL -o /usr/local/bin/spored ${dl}
chmod +x /usr/local/bin/spored

cat > /etc/systemd/system/spored.service <<'EOF'
[Unit]
Description=spore.host lifecycle daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/spored run
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now spored.service
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
