spore_curl_retry() {
    local retries="$1" delay="$2" n=0 rc=0
    shift 2
    while [ "$n" -lt "$retries" ]; do
        rc=0
        curl "$@" 2>/dev/null || rc=$?
        [ "$rc" -eq 0 ] && return 0
        [ "$rc" -eq 2 ] && break
        n=$((n + 1))
        sleep "$delay"
    done
    curl "$@"
}
spore_selinux_relabel() {
    command -v restorecon >/dev/null 2>&1 || return 0
    if command -v selinuxenabled >/dev/null 2>&1 && ! selinuxenabled; then
        return 0
    fi
    restorecon -Fv "$@" || echo "WARNING: restorecon failed for $* — under SELinux enforcing, systemd may be unable to start spored (#1052)" >&2
    return 0
}
spore_install_verified_spored() {
    local binary="$1"; shift
    if [ -z "$binary" ] || [ $# -eq 0 ]; then
        echo "spore_install_verified_spored: need a binary name and at least one base URL" >&2
        return 1
    fi
    local tmp base bin_url sig_url chosen=""
    tmp="$(mktemp /tmp/spored.XXXXXX)" || return 1
    for base in "$@"; do
        bin_url="${base}/${binary}"
        sig_url="${base}/${binary}.sig"
        if [ "${SPORED_SIG_VERIFY:-0}" = "1" ]; then
            if ! spore_curl_retry 3 1 -fsI "$sig_url" >/dev/null 2>&1; then
                echo "No signature at ${base} — trying next source"
                continue
            fi
        fi
        if spore_curl_retry 5 2 -f -o "$tmp" "$bin_url"; then
            chosen="$base"
            echo "Downloaded spored from ${base}"
            break
        fi
    done
    if [ -z "$chosen" ]; then
        echo "Failed to download ${binary} from any source" >&2
        if [ "${SPORED_SIG_VERIFY:-0}" = "1" ]; then
            echo "  (signature verification is on — a source without a .sig is skipped)" >&2
        fi
        rm -f "$tmp"
        return 1
    fi
    echo "Verifying checksum..."
    if ! spore_curl_retry 5 2 -f -o "${tmp}.sha256" "${chosen}/${binary}.sha256"; then
        echo "No checksum published at ${chosen}/${binary}.sha256 — refusing to install an unverified spored" >&2
        rm -f "$tmp" "${tmp}.sha256"
        return 1
    fi
    local expected actual
    expected="$(awk '{print $1}' "${tmp}.sha256")"
    actual="$(sha256sum "$tmp" | awk '{print $1}')"
    if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
        echo "Checksum verification FAILED (expected ${expected:-<empty>}, got ${actual})" >&2
        rm -f "$tmp" "${tmp}.sha256"
        return 1
    fi
    rm -f "${tmp}.sha256"
    echo "Checksum verified: $actual"
    if [ "${SPORED_SIG_VERIFY:-0}" = "1" ]; then
        echo "Verifying signature..."
        if ! spore_curl_retry 5 2 -f -o "${tmp}.sig" "${chosen}/${binary}.sig"; then
            echo "Signature not found at ${chosen}/${binary}.sig — refusing to run an unsigned binary" >&2
            rm -f "$tmp" "${tmp}.sig"
            return 1
        fi
        if ! base64 -d < "${tmp}.sig" > "${tmp}.sig.der" 2>/dev/null; then
            cp "${tmp}.sig" "${tmp}.sig.der"
        fi
        if ! openssl dgst -sha256 -verify /etc/spawn/spored-signing-key.pem -signature "${tmp}.sig.der" "$tmp" >/dev/null 2>&1; then
            echo "Signature verification FAILED — refusing to run spored" >&2
            rm -f "$tmp" "${tmp}.sig" "${tmp}.sig.der"
            return 1
        fi
        rm -f "${tmp}.sig" "${tmp}.sig.der"
        echo "Signature verified (spore.host)"
    else
        echo "Signature verification not enabled in this spawn build; checksum only (corruption, not authenticity)"
    fi
    chmod +x "$tmp" || { rm -f "$tmp"; return 1; }
    systemctl stop spored 2>/dev/null || true
    if ! mv -f "$tmp" /usr/local/bin/spored; then
        echo "Failed to install spored to /usr/local/bin/spored" >&2
        rm -f "$tmp"
        return 1
    fi
    spore_selinux_relabel /usr/local/bin/spored
    return 0
}
spore_install_spored_from_buckets() {
    local v="${SPAWN_SPORED_VERSION:-}"
    if [ -n "$v" ]; then
        echo "Installing spored $v, the version of the spawn that rendered this script"
        spore_install_verified_spored "$1" "$2/spawn/versions/$v" "$3/spawn/versions/$v"
    elif ! spore_install_verified_spored "$1" "$2/spawn/current" "$3/spawn/current"; then
        if [ "${SPAWN_SPORED_READS_LAUNCH_CONFIG:-}" = 1 ]; then
            echo "no spawn/current/ spored; 0.149.0 ignores launch configs (#1419)" >&2
            return 1
        fi
        spore_install_verified_spored "$1" "$2/spawn" "$3/spawn"
    fi
}
spawn_is_spot_replacement() {
    local cache=/run/spawn/spot-replacement rc
    if [ -s "$cache" ]; then
        rc=$(cat "$cache")
    else
        if [ ! -x /usr/local/bin/spored ]; then
            echo "spawn: spored missing; cannot check for a Spot replacement, running the workload" >&2
            return 1
        fi
        rc=0
        if command -v timeout >/dev/null 2>&1; then
            timeout 120 /usr/local/bin/spored is-spot-replacement >&2 || rc=$?
        else
            /usr/local/bin/spored is-spot-replacement >&2 || rc=$?
        fi
        case "$rc" in
            0|1) mkdir -p /run/spawn && echo "$rc" > "$cache" ;;
        esac
    fi
    case "$rc" in
        0) return 0 ;;
        1) return 1 ;;
        *) echo "spawn: could not tell whether this is a Spot replacement (exit $rc); running the workload, as an original would" >&2
           return 1 ;;
    esac
}
ARCH=$(uname -m)
echo "Installing spored for architecture: $ARCH"
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" 2>/dev/null || true)
if [ -n "$TOKEN" ]; then
    REGION=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null)
else
    REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo "us-east-1")
fi
echo "Region: $REGION"
case "$ARCH" in
    x86_64)
        BINARY="spored-linux-amd64"
        ;;
    aarch64)
        BINARY="spored-linux-arm64"
        ;;
    *)
        spawn_fatal_retire "unsupported architecture $ARCH: there is no spored for it"
        ;;
esac
S3_BASE_URL="https://spawn-binaries-${REGION}.s3.amazonaws.com"
FALLBACK_URL="https://spawn-binaries-us-east-1.s3.amazonaws.com"
echo "Downloading spored binary..."
if ! spore_install_spored_from_buckets "$BINARY" "$S3_BASE_URL" "$FALLBACK_URL"; then
    spawn_fatal_retire "spored install failed; not running an unverified agent"
fi
cat > /etc/systemd/system/spored.service <<'EOFSERVICE'
[Unit]
Description=Spawn Agent - Instance self-monitoring
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# SigV4-sign DNS registration requests (#173). This is now REQUIRED, not
# anticipatory: the DNS Function URL is AuthType: AWS_IAM (verified against the
# live function 2026-10-11), so an unsigned request is rejected at the URL and the
# instance never registers. The comment here said the URL "is still AuthType:
# NONE, which ignores the signature" long after the cutover landed, which reads as
# though this variable were optional — it is load-bearing.
#
# The staged rollout it describes did work as intended: signing shipped first so a
# fleet was already signing before the flip, and old non-signing instances aged
# out under their TTLs ("everything dies").
Environment=SPORE_DNS_SIGV4=1
ExecStart=/usr/local/bin/spored
# on-failure (not always) prevents restart attempts during graceful shutdown
Restart=on-failure
RestartSec=10
# Give spored time to deregister DNS and clean up before SIGKILL
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
# Do NOT set PrivateTmp=true: spored must see the host /tmp/SPAWN_COMPLETE
# completion file written by users / spawn connect / nf-spawn. PrivateTmp
# isolates the daemon's /tmp and silently breaks --on-complete/--pre-stop (#66).

[Install]
WantedBy=multi-user.target
EOFSERVICE
spore_selinux_relabel /etc/systemd/system/spored.service
/usr/local/bin/spored discard-inherited-state || true
systemctl daemon-reload
systemctl enable spored
systemctl start spored
SPAWN_SPORED_UP=1
echo "spored installation complete"
echo "Setting up user: $LOCAL_USERNAME"
if ! id "$LOCAL_USERNAME" &>/dev/null; then
    useradd -m -s /bin/bash "$LOCAL_USERNAME"
    echo "Created user: $LOCAL_USERNAME"
fi
usermod -aG wheel "$LOCAL_USERNAME" 2>/dev/null || usermod -aG sudo "$LOCAL_USERNAME" 2>/dev/null
echo "$LOCAL_USERNAME ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/$LOCAL_USERNAME
chmod 0440 /etc/sudoers.d/$LOCAL_USERNAME
mkdir -p /home/$LOCAL_USERNAME/.ssh
chmod 700 /home/$LOCAL_USERNAME/.ssh
if [ -n "$LOCAL_SSH_KEY_BASE64" ]; then
    echo "$LOCAL_SSH_KEY_BASE64" | base64 -d > /home/$LOCAL_USERNAME/.ssh/authorized_keys
else
    touch /home/$LOCAL_USERNAME/.ssh/authorized_keys
fi
chmod 600 /home/$LOCAL_USERNAME/.ssh/authorized_keys
chown -R $LOCAL_USERNAME:$LOCAL_USERNAME /home/$LOCAL_USERNAME/.ssh
echo "✅ User $LOCAL_USERNAME configured with SSH access and sudo privileges"
echo "Configuring session timeouts..."
INSTANCE_ID=$(ec2-metadata --instance-id | cut -d " " -f 2)
SESSION_TIMEOUT=$(aws ec2 describe-tags --region $REGION \
    --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:session-timeout" \
    --query 'Tags[0].Value' --output text 2>/dev/null || echo "30m")
parse_duration() {
    local duration="$1"
    local total=0
    if [ "$duration" = "0" ] || [ "$duration" = "disabled" ]; then
        echo "0"
        return
    fi
    while [[ $duration =~ ([0-9]+)([smhd]) ]]; do
        local value="${BASH_REMATCH[1]}"
        local unit="${BASH_REMATCH[2]}"
        case "$unit" in
            s) total=$((total + value)) ;;
            m) total=$((total + value * 60)) ;;
            h) total=$((total + value * 3600)) ;;
            d) total=$((total + value * 86400)) ;;
        esac
        duration="${duration#*${BASH_REMATCH[0]}}"
    done
    echo "$total"
}
TIMEOUT_SECONDS=$(parse_duration "$SESSION_TIMEOUT")
if [ "$TIMEOUT_SECONDS" -gt 0 ]; then
    SSH_INTERVAL=$((TIMEOUT_SECONDS / 6))
    if [ $SSH_INTERVAL -lt 60 ]; then
        SSH_INTERVAL=60
    fi
    if ! grep -q "^ClientAliveInterval" /etc/ssh/sshd_config; then
        echo "ClientAliveInterval $SSH_INTERVAL" >> /etc/ssh/sshd_config
        echo "ClientAliveCountMax 3" >> /etc/ssh/sshd_config
        systemctl reload sshd 2>/dev/null || service sshd reload 2>/dev/null || true
    fi
    cat > /etc/profile.d/session-timeout.sh <<EOFTIMEOUT
# Automatic logout for idle shells ($SESSION_TIMEOUT)
# Prevents indefinite logins when users leave sessions idle
# Note: readonly prevents users from unsetting it
export TMOUT=$TIMEOUT_SECONDS
readonly TMOUT
EOFTIMEOUT
    chmod 644 /etc/profile.d/session-timeout.sh
    echo "✅ Session timeouts configured (Timeout: $SESSION_TIMEOUT)"
else
    echo "✅ Session timeouts disabled (set spawn:session-timeout tag to enable)"
fi
JOB_ARRAY_ID=$(aws ec2 describe-tags --region $REGION \
    --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:job-array-id" \
    --query 'Tags[0].Value' --output text 2>/dev/null || echo "None")
if [ "$JOB_ARRAY_ID" != "None" ]; then
    echo "Setting up job array environment..."
    JOB_ARRAY_NAME=$(aws ec2 describe-tags --region $REGION \
        --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:job-array-name" \
        --query 'Tags[0].Value' --output text 2>/dev/null || echo "")
    JOB_ARRAY_SIZE=$(aws ec2 describe-tags --region $REGION \
        --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:job-array-size" \
        --query 'Tags[0].Value' --output text 2>/dev/null || echo "0")
    JOB_ARRAY_INDEX=$(aws ec2 describe-tags --region $REGION \
        --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:job-array-index" \
        --query 'Tags[0].Value' --output text 2>/dev/null || echo "0")
    cat > /etc/profile.d/job-array.sh <<EOFJOBARRAY
# Job Array Environment Variables
# Available to all shells for coordinated distributed computing
export JOB_ARRAY_ID="$JOB_ARRAY_ID"
export JOB_ARRAY_NAME="$JOB_ARRAY_NAME"
export JOB_ARRAY_SIZE="$JOB_ARRAY_SIZE"
export JOB_ARRAY_INDEX="$JOB_ARRAY_INDEX"
EOFJOBARRAY
    chmod 644 /etc/profile.d/job-array.sh
    echo "✅ Job array environment configured (Index: $JOB_ARRAY_INDEX/$JOB_ARRAY_SIZE)"
fi
SPAWN_NAME_TAG=$(aws ec2 describe-tags --region $REGION \
    --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=Name" \
    --query 'Tags[0].Value' --output text 2>/dev/null || echo "None")
SPAWN_HOSTNAME=""
if [ -n "$SPAWN_NAME_TAG" ] && [ "$SPAWN_NAME_TAG" != "None" ]; then
    SPAWN_HOSTNAME=$(printf '%s' "$SPAWN_NAME_TAG" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' \
        | sed -e 's/--*/-/g' -e 's/^-//' | cut -c1-63 | sed -e 's/-*$//' || true)
fi
if [ -n "$SPAWN_HOSTNAME" ] && [ "$JOB_ARRAY_ID" != "None" ] && [ -n "$JOB_ARRAY_INDEX" ]; then
    if ! printf '%s' "$SPAWN_HOSTNAME" | grep -qE "(^|[^0-9])${JOB_ARRAY_INDEX}([^0-9]|\$)"; then
        SPAWN_HOSTNAME="$(printf '%s' "$SPAWN_HOSTNAME" | cut -c1-$((62 - ${#JOB_ARRAY_INDEX})))-${JOB_ARRAY_INDEX}"
    fi
fi
if [ -n "$SPAWN_HOSTNAME" ]; then
    hostnamectl set-hostname "$SPAWN_HOSTNAME" 2>/dev/null || hostname "$SPAWN_HOSTNAME" 2>/dev/null || true
    echo "$SPAWN_HOSTNAME" > /etc/hostname 2>/dev/null || true
    mkdir -p /etc/cloud/cloud.cfg.d 2>/dev/null || true
    echo "preserve_hostname: true" > /etc/cloud/cloud.cfg.d/99-spawn-hostname.cfg 2>/dev/null || true
    SPAWN_PRIVATE_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4 2>/dev/null || true)
    [[ "$SPAWN_PRIVATE_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || SPAWN_PRIVATE_IP=""
    if ! grep -qE "[[:space:]]${SPAWN_HOSTNAME}([[:space:]]|\$)" /etc/hosts 2>/dev/null; then
        echo "${SPAWN_PRIVATE_IP:-127.0.1.1} ${SPAWN_HOSTNAME}" >> /etc/hosts 2>/dev/null || true
    fi
    echo "✅ Hostname set to $SPAWN_HOSTNAME (from the Name tag)"
fi
SWEEP_ID=$(aws ec2 describe-tags --region $REGION \
    --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:sweep-id" \
    --query 'Tags[0].Value' --output text 2>/dev/null || echo "None")
if [ "$SWEEP_ID" != "None" ]; then
    echo "Setting up parameter sweep environment..."
    SWEEP_NAME=$(aws ec2 describe-tags --region $REGION \
        --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:sweep-name" \
        --query 'Tags[0].Value' --output text 2>/dev/null || echo "")
    SWEEP_SIZE=$(aws ec2 describe-tags --region $REGION \
        --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:sweep-size" \
        --query 'Tags[0].Value' --output text 2>/dev/null || echo "0")
    SWEEP_INDEX=$(aws ec2 describe-tags --region $REGION \
        --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:sweep-index" \
        --query 'Tags[0].Value' --output text 2>/dev/null || echo "0")
    PARAM_TAGS=$(aws ec2 describe-tags --region $REGION \
        --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:param:*" \
        --query 'Tags[*].[Key,Value]' --output text 2>/dev/null || echo "")
    cat > /etc/profile.d/spawn-params.sh <<EOFPARAMS
# Parameter Sweep Environment Variables
# Available to all shells for parameter sweep workloads
export SWEEP_ID="$SWEEP_ID"
export SWEEP_NAME="$SWEEP_NAME"
export SWEEP_SIZE="$SWEEP_SIZE"
export SWEEP_INDEX="$SWEEP_INDEX"

# Parse and export PARAM_* environment variables from tags
EOFPARAMS
    echo "$PARAM_TAGS" | while IFS=$'\t' read -r key value; do
        if [[ $key == spawn:param:* ]]; then
            param_name=${key#spawn:param:}
            escaped_value=${value//\'/\'\"\'\"\'}
            echo "export PARAM_${param_name}='${escaped_value}'" >> /etc/profile.d/spawn-params.sh
        fi
    done
    chmod 644 /etc/profile.d/spawn-params.sh
    echo "✅ Parameter sweep environment configured (Index: $SWEEP_INDEX/$SWEEP_SIZE)"
fi
if [ -s /etc/spawn/command ]; then
    WORKFLOW_COMMAND="(embedded)"
    STEP_NAME=""
else
    WORKFLOW_COMMAND=$(aws ec2 describe-tags --region $REGION \
        --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:command" \
        --query 'Tags[0].Value' --output text 2>/dev/null || echo "None")
    STEP_NAME=$(aws ec2 describe-tags --region $REGION \
        --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:step" \
        --query 'Tags[0].Value' --output text 2>/dev/null || echo "")
fi
if [ "$WORKFLOW_COMMAND" != "None" ] && [ -n "$WORKFLOW_COMMAND" ]; then
    if [ -n "$STEP_NAME" ]; then
        echo "▶️  Executing workflow step: $STEP_NAME"
    else
        echo "▶️  Executing --command"
    fi
    cat > /tmp/spawn-command.sh <<'EOFCMD'
#!/bin/bash
set -e
# errexit is ON here, and 'set -uo pipefail' does NOT clear it (#707) — so a
# script opening with that line, believing it chose its own error policy, is
# actually running -e -u -o pipefail. The two usual casualties are a SIGPIPE'd
# pipeline under pipefail ('... | head -n N' returns 141) and 'wait \$pid' on a
# failed background job, a pattern for CAPTURING a failure that -e destroys. It
# cost four r8gd.8xlarge runs and three misdiagnoses to find, because nothing
# said so. Fail-fast stays (running on after a broken step to TTL is worse).
#
# The notice that says so is NOT printed here. It used to be — two lines at the
# top of every /var/log/spawn-command.log, which is the file users actually
# read, on every member of every array, whether or not anything failed (#897).
# It is now written by the root-side caller, into the command log only when the
# command exits non-zero (the only case in which errexit can have cut a run
# short), and announced once per boot in cloud-init-output.log. Nothing in this
# script may write /var/log: it runs as $LOCAL_USERNAME via su, which cannot,
# and under set -e a failed write kills the command before it starts.
[ -f /etc/profile.d/spawn-params.sh ] && source /etc/profile.d/spawn-params.sh
EOFCMD
    if [ -s /etc/spawn/command ]; then
        cat /etc/spawn/command >> /tmp/spawn-command.sh
    else
        echo "$WORKFLOW_COMMAND" >> /tmp/spawn-command.sh
    fi
    chmod +x /tmp/spawn-command.sh
    (
        if spawn_is_spot_replacement; then
            echo "⏭️  --command NOT started: this instance is a Spot replacement; spored retires it (#1007)" | tee -a /var/log/spawn-command.log
            exit 0
        fi
        if [ -e "/var/lib/spawn/command-ran-$INSTANCE_ID" ]; then
            echo "⏭️  --command NOT started: it already ran on this instance ($INSTANCE_ID); the bootstrap ran again (cloud-init clean + reboot?). Delete /var/lib/spawn/command-ran-$INSTANCE_ID to re-run it (#1057)" | tee -a /var/log/spawn-command.log
            exit 0
        fi
        mkdir -p /var/lib/spawn
        date -u +%Y-%m-%dT%H:%M:%SZ > "/var/lib/spawn/command-ran-$INSTANCE_ID"
        if [ -s /run/spawn/required-gates ]; then
            GATE_RC=0
            while read -r GATE; do
                [ -n "$GATE" ] || continue
                WAITED=0
                while [ ! -s "$GATE" ]; do
                    if [ "$WAITED" -ge 600 ]; then
                        echo "❌ timed out after ${WAITED}s waiting for $GATE" | tee -a /var/log/spawn-command.log
                        GATE_RC=1
                        break
                    fi
                    sleep 2
                    WAITED=$((WAITED + 2))
                done
                [ "$GATE_RC" -eq 0 ] || break
                GATE_STATUS=$(cat "$GATE")
                if [ "$GATE_STATUS" != "ok" ]; then
                    echo "❌ prerequisite failed: $GATE reports $GATE_STATUS" | tee -a /var/log/spawn-command.log
                    GATE_RC=1
                    break
                fi
                echo "✅ prerequisite ready: $GATE" >> /var/log/spawn-command.log
            done < /run/spawn/required-gates
            if [ "$GATE_RC" -ne 0 ]; then
                echo "❌ --command NOT started: prerequisites unmet (see above)" | tee -a /var/log/spawn-command.log
                echo 1 > /tmp/SPAWN_EXITCODE
                mkdir -p "$(dirname -- "$SPAWN_CMD_COMPLETION_FILE")" || true
                cat > "$SPAWN_CMD_COMPLETION_FILE" <<JSONEOF
{"status": "failed", "exit_code": 1, "source": "command"}
JSONEOF
                exit 1
            fi
        fi
        su - "$LOCAL_USERNAME" -c '/tmp/spawn-command.sh' 2>&1 | tee -a /var/log/spawn-command.log
        CMD_RC=${PIPESTATUS[0]}
        echo "$CMD_RC" > /tmp/SPAWN_EXITCODE
        if [ "$CMD_RC" -eq 0 ]; then
            CMD_STATE=completed
            echo "✅ --command finished (exit 0)"
        else
            CMD_STATE=failed
            printf '%s\n' \
                "spawn: --command exited $CMD_RC. errexit is ON for --command (set -e) and set -uo pipefail does NOT clear it, so the first failing command ends the run." \
                "spawn: common causes: a SIGPIPE'd pipeline under pipefail ('... | head' returns 141), or 'wait \$pid' on a failed background job. Use set +e to opt out." \
                >> /var/log/spawn-command.log
            echo "❌ --command FAILED (exit $CMD_RC) — see /var/log/spawn-command.log"
        fi
        mkdir -p "$(dirname -- "$SPAWN_CMD_COMPLETION_FILE")" || true
        cat > "$SPAWN_CMD_COMPLETION_FILE" <<JSONEOF
{"status": "$CMD_STATE", "exit_code": $CMD_RC, "source": "command"}
JSONEOF
    ) &
    echo "▶️  --command started in the background (logs: /var/log/spawn-command.log)"
    echo "   Its exit code lands in /tmp/SPAWN_EXITCODE and drives --on-complete."
    echo "   Note: --command runs with errexit ON (set -e); set -uo pipefail does NOT clear it; use set +e to opt out."
fi
echo "Creating login banner..."
TTL_TAG=$(aws ec2 describe-tags --region $REGION \
    --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:ttl" \
    --query 'Tags[0].Value' --output text 2>/dev/null || echo "disabled")
IDLE_TIMEOUT_TAG=$(aws ec2 describe-tags --region $REGION \
    --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:idle-timeout" \
    --query 'Tags[0].Value' --output text 2>/dev/null || echo "disabled")
ON_COMPLETE_TAG=$(aws ec2 describe-tags --region $REGION \
    --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=spawn:on-complete" \
    --query 'Tags[0].Value' --output text 2>/dev/null || echo "disabled")
if [ "$JOB_ARRAY_ID" != "None" ]; then
cat > /etc/motd <<EOFMOTD
╔═══════════════════════════════════════════════════════════════╗
║                  🌱 Welcome to Spore                         ║
╚═══════════════════════════════════════════════════════════════╝

Instance: $INSTANCE_ID
Region:   $REGION

Job Array:
  • Array Name:       $JOB_ARRAY_NAME
  • Array ID:         $JOB_ARRAY_ID
  • Instance Index:   $JOB_ARRAY_INDEX / $JOB_ARRAY_SIZE

Spore Agent Configuration:
  • TTL:              $TTL_TAG
  • Idle Timeout:     $IDLE_TIMEOUT_TAG
  • On Complete:      $ON_COMPLETE_TAG
  • Session Timeout:  $SESSION_TIMEOUT

⚠️  IMPORTANT: This shell will auto-logout after $SESSION_TIMEOUT of inactivity
⚠️  SSH connections will disconnect if idle for extended periods

To view current status:
  sudo spored status

To extend TTL:
  spawn extend <instance-id> <new-ttl>

Documentation: https://github.com/spore-host/spore-host

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOFMOTD
else
cat > /etc/motd <<EOFMOTD
╔═══════════════════════════════════════════════════════════════╗
║                  🌱 Welcome to Spore                         ║
╚═══════════════════════════════════════════════════════════════╝

Instance: $INSTANCE_ID
Region:   $REGION

Spore Agent Configuration:
  • TTL:              $TTL_TAG
  • Idle Timeout:     $IDLE_TIMEOUT_TAG
  • On Complete:      $ON_COMPLETE_TAG
  • Session Timeout:  $SESSION_TIMEOUT

⚠️  IMPORTANT: This shell will auto-logout after $SESSION_TIMEOUT of inactivity
⚠️  SSH connections will disconnect if idle for extended periods

To view current status:
  sudo spored status

To extend TTL:
  spawn extend <instance-id> <new-ttl>

Documentation: https://github.com/spore-host/spore-host

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOFMOTD
fi
chmod 644 /etc/motd
echo "✅ Login banner created"
if dnf install -y acpid 2>/dev/null || yum install -y acpid 2>/dev/null; then
    systemctl enable --now acpid 2>/dev/null || echo "acpid installed but not started; stop/terminate will not shut down gracefully"
else
    echo "acpid not installed; stop/terminate will not shut down gracefully"
fi
if spawn_is_spot_replacement; then
    echo "⏭️  Spot replacement: skipping storage, the container, MPI, the task runner and custom user data; spored retires this instance (#1007)"
    exit 0
fi
