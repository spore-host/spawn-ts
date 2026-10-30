#!/usr/bin/env bash
# Regenerate the Go-derived test fixtures from a published spawn release:
#
#   src/aws/testdata/bootstrap-body.v<V>.sh       `spawn bootstrap-body` at v<V>
#   src/aws/testdata/stub-fixtures.v<V>.json      launcher.BuildLinuxBootstrap at
#                                                 v<V> for the inputs below, as a
#                                                 release build renders it (stub)
#   src/core/testdata/gojson-vectors.go.json      encoding/json escaping vectors
#   src/core/testdata/launchconfig-setting-keys.go.json
#                                                 pkg/launchconfig SettingKeys()
#   src/core/testdata/post-launch-tags.go.json    pkg/aws postLaunchInstanceTags,
#                                                 the #1355 tag reserve's list
#
# Usage: scripts/gen-go-fixtures.sh 0.150.0
#        SPAWN_SRC=/path/to/spawn scripts/gen-go-fixtures.sh 0.150.0
#
# SPAWN_SRC renders from a local spawn tree instead of the module proxy: only
# for a pre-release candidate (an unmerged PR), never for a fixture that merges.
#
# Needs a Go toolchain and network access to the Go module proxy (no AWS). The
# spawn source comes from the module proxy, checked against the sum database,
# so the fixtures are what that tag says, not what a local checkout happens to
# hold. Nothing is written outside a temp dir except the fixtures above.
#
# When moving SPAWN_BOOTSTRAP_VERSION: run this for the new version, update the
# version and BOOTSTRAP_BODY_SHA256 in src/aws/userdata.ts (the script prints
# it) and the fixture names in src/aws/userdata.test.ts, and check what that
# release's spored reads from tags (spore-host/spawn-ts#108).
set -euo pipefail

V="${1:?usage: $0 <spawn version, e.g. 0.149.0>}"
V="${V#v}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${XTMP:-${HOME}/.xtmp}"
[ -d "$SCRATCH" ] || SCRATCH="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "$SCRATCH/spawn-ts-gen.XXXXXX")"
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

export GOFLAGS=-mod=mod
if [ -n "${SPAWN_SRC:-}" ]; then
  SRC="$SPAWN_SRC"
  echo "WARNING: rendering from $SRC, not the published spawn v${V}" >&2
else
  SRC="$(cd "$WORK" && go mod download -json "github.com/spore-host/spawn@v${V}" | sed -n 's/.*"Dir": "\(.*\)".*/\1/p')"
fi
[ -n "$SRC" ] || { echo "could not download spawn v${V}" >&2; exit 1; }
cp -R "$SRC" "$WORK/spawn"
chmod -R u+w "$WORK/spawn"
cd "$WORK/spawn"

# In-package helper: buildLinuxBootstrap is unexported, and the stub is what a
# RELEASE build renders, which a `go run` of the module is not.
cat > pkg/launcher/zz_spawnts_fixtures.go <<EOF
package launcher

func SpawnTSStub(cfg BootstrapConfig) (string, error) {
	return buildLinuxBootstrap(cfg, "${V}", "${V}", BootstrapBody())
}
EOF

# In-package helper: postLaunchInstanceTags (#1355) and its applies funcs are
# unexported. applies is a func, so it is reported by probing it: "always" is
# nil (every instance); else whether a DNS launch or a Spot launch gets the tag;
# "other" is neither (a task, a web app or DCV session, an FSx mount).
cat > pkg/aws/zz_spawnts_fixtures.go <<'EOF'
package aws

type SpawnTSPostLaunchTag struct {
	Key       string `json:"key"`
	By        string `json:"by"`
	OnCommand bool   `json:"onCommand"`
	Applies   string `json:"applies"`
}

func SpawnTSPostLaunchTags() []SpawnTSPostLaunchTag {
	var out []SpawnTSPostLaunchTag
	for _, t := range postLaunchInstanceTags {
		applies := "always"
		switch {
		case t.applies == nil:
		case t.applies(LaunchConfig{DNSName: "x"}):
			applies = "dns"
		case t.applies(LaunchConfig{Spot: true}):
			applies = "spot"
		default:
			applies = "other"
		}
		out = append(out, SpawnTSPostLaunchTag{Key: t.key, By: string(t.by), OnCommand: t.onCommand, Applies: applies})
	}
	return out
}
EOF

mkdir -p internal/spawntsfixtures
cat > internal/spawntsfixtures/main.go <<'EOF'
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"

	"github.com/spore-host/spawn/pkg/aws"
	"github.com/spore-host/spawn/pkg/launchconfig"
	"github.com/spore-host/spawn/pkg/launcher"
	"github.com/spore-host/spawn/pkg/plugin"
)

type fixture struct {
	Name           string               `json:"name"`
	Username       string               `json:"username"`
	PublicKey      string               `json:"publicKey"`
	Command        string               `json:"command"`
	CompletionFile string               `json:"completionFile"`
	Plugins        []plugin.Declaration `json:"plugins"`
	Settings       map[string]string    `json:"settings"`
	Object         string               `json:"object"`
	SHA256         string               `json:"sha256"`
	Script         string               `json:"script"`
	DecodedBytes   int                  `json:"decodedBytes"`
}

func enc(v any, html bool) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(html)
	_ = e.Encode(v)
	return string(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
}

func main() {
	body := launcher.BootstrapBody()
	if err := os.WriteFile(os.Args[1], []byte(body), 0o644); err != nil {
		panic(err)
	}
	fmt.Printf("BOOTSTRAP_BODY_SHA256 = %x\n", sha256.Sum256([]byte(body)))

	cases := []fixture{
		{Name: "bare ssm-only", Username: "ec2-user"},
		{Name: "key and custom user", Username: "ubuntu", PublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample user@host\n"},
		{Name: "command with quotes and dollars", Username: "ec2-user", Command: "echo \"$HOME\" && echo 'it''s' > /tmp/out"},
		{Name: "custom completion file", Username: "ec2-user", Command: "./run.sh", CompletionFile: "/data/it's done"},
		{Name: "plugins", Username: "ec2-user", Plugins: []plugin.Declaration{{Ref: "tailscale"}, {Ref: "globus", Config: map[string]string{"collection": "a<b>&c", "z": "1"}}}},
		{Name: "launch config object: the hook settings spawn-ts writes", Username: "ec2-user",
			Plugins: []plugin.Declaration{{Ref: "docker"}}, Settings: map[string]string{
				"spot-webhook-url": "https://example.com/hook?a=1&b=<2>", "webhook-correlation": "job-42",
				"webhook-timeout": "30s", "notify-url": "https://hooks.slack.com/services/T/B/x",
				"notify-platform": "slack", "notify-command": "/spawn", "active-processes": "python,jupyter",
				"active-ports": "8787,8888", "idle-cpu": "7.5",
			}},
		{Name: "launch config object: unicode kept, empty values dropped", Username: "ubuntu", Settings: map[string]string{
			"notify-command": "caf\u00e9 \u2713\u2028", "active-ports": "",
		}},
	}
	for i := range cases {
		c := &cases[i]
		obj, sha, err := launchconfig.Encode(c.Settings)
		if err != nil {
			panic(err)
		}
		c.Object, c.SHA256 = string(obj), sha
		s, err := launcher.SpawnTSStub(launcher.BootstrapConfig{
			Username: c.Username, PublicKey: []byte(c.PublicKey), Command: c.Command,
			CompletionFile: c.CompletionFile, Plugins: c.Plugins, LaunchConfig: obj,
		})
		if err != nil {
			panic(err)
		}
		c.Script = s
		c.DecodedBytes, _ = aws.UserDataSize(launcher.EncodeLinuxUserData(s))
	}
	b, _ := json.MarshalIndent(cases, "", "  ")
	if err := os.WriteFile(os.Args[2], append(b, '\n'), 0o644); err != nil {
		panic(err)
	}

	inputs := []string{
		"plain", "", "a\"b\\c", "<script>&amp;</script>", "tab\there\nnl\rcr",
		"\b\f\x00\x01\x1f\x7f", "unicode é ✓ 日本", "line\u2028sep\u2029para",
		"https://hooks.slack.com/services/T0/B0/xyz?a=1&b=2", "emoji 🚀",
	}
	type row struct {
		In   string `json:"in"`
		HTML string `json:"html"`
		Raw  string `json:"raw"`
	}
	var rows []row
	for _, s := range inputs {
		rows = append(rows, row{In: s, HTML: enc(s, true), Raw: enc(s, false)})
	}
	m := map[string]string{"z": "1", "a": "<&>", "M": "x", "_": "y", "aa": "2"}
	out := map[string]any{"strings": rows, "mapHTML": enc(m, true), "mapRaw": enc(m, false)}
	b, _ = json.MarshalIndent(out, "", "  ")
	if err := os.WriteFile(os.Args[3], b, 0o644); err != nil {
		panic(err)
	}
	keys, _ := json.Marshal(launchconfig.SettingKeys())
	if err := os.WriteFile(os.Args[4], keys, 0o644); err != nil {
		panic(err)
	}
	b, _ = json.MarshalIndent(aws.SpawnTSPostLaunchTags(), "", "  ")
	if err := os.WriteFile(os.Args[5], append(b, '\n'), 0o644); err != nil {
		panic(err)
	}
}
EOF

go run ./internal/spawntsfixtures \
  "$ROOT/src/aws/testdata/bootstrap-body.v${V}.sh" \
  "$ROOT/src/aws/testdata/stub-fixtures.v${V}.json" \
  "$ROOT/src/core/testdata/gojson-vectors.go.json" \
  "$ROOT/src/core/testdata/launchconfig-setting-keys.go.json" \
  "$ROOT/src/core/testdata/post-launch-tags.go.json"

# The published module's own CLI must print the same body.
if [ "$(go run . bootstrap-body | shasum -a 256 | cut -d ' ' -f 1)" != \
     "$(shasum -a 256 < "$ROOT/src/aws/testdata/bootstrap-body.v${V}.sh" | cut -d ' ' -f 1)" ]; then
  echo "spawn v${V}'s bootstrap-body differs from launcher.BootstrapBody()" >&2
  exit 1
fi
echo "wrote fixtures for spawn v${V}"
