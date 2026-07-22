# Live smoke test (regression guard for self-termination)

The self-termination guarantee — an instance winds itself down on its TTL even
with the browser closed — is spawn-ts's whole reason for being, and it regressed
once silently (#19: a bad systemd unit crash-looped spored). The
`workflow_dispatch`-only **live smoke test** (`.github/workflows/live-smoke.yml`)
guards against that. It never runs on push/PR.

Two tiers, chosen by the `tier` input (`substrate` | `real-aws` | `both`):

## Tier 1 — substrate (default, zero credentials, zero cost)

Boots the [substrate](https://github.com/scttfrdmn/substrate) AWS emulator (built
from source at a pinned tag, CORS on) and runs the `EC2Provider` integration
tests against it — the real `@aws-sdk/client-ec2` request path: launch →
`spawn:*` tags → `list`/`get` → and the `SpawnClient` monitor firing a real
`TerminateInstances` on an expired TTL.

Crucially it runs with **`SUBSTRATE_REQUIRED=1`**, which turns the normal
"substrate unreachable → skip" convenience into a **hard failure** — so a
substrate that failed to boot can't produce a false green (the silent-skip trap
that let #19 hide). This tier needs no AWS account and is safe to run anytime.

## Tier 2 — real AWS (OIDC, opt-in)

Launches **one `t4g.nano`** on real AWS, waits ~5 min for `spored` to
self-terminate it on its TTL, then hard-backstops + leak-checks
(`scripts/live-smoke.mjs`). Cost is well under 1¢. It authenticates via **GitHub
OIDC — no stored AWS keys** — matching the upstream spore.host CI pattern.

**Disabled until wired.** It runs only when `vars.LIVE_SMOKE_ROLE_ARN` is set. To
enable:

1. In the target AWS account, ensure a GitHub OIDC provider exists and an IAM
   role trusts this repo's `live-smoke` environment
   (`token.actions.githubusercontent.com:sub = repo:spore-host/spawn-ts:environment:live-smoke`),
   granting `ec2:RunInstances`/`Describe*`/`TerminateInstances`/`CreateTags` +
   `iam:PassRole` for the spored instance profile. (The spore-host org already
   runs this pattern; a shared `GitHubActions-*` role can add spawn-ts to its
   `sub` allowlist.)
2. Create a `live-smoke` **environment** in the repo (optionally with required
   reviewers, so a real launch needs approval).
3. Set repo/environment variables: `LIVE_SMOKE_ROLE_ARN` (required to enable),
   `LIVE_SMOKE_REGION` (default `us-east-1`), `LIVE_SMOKE_INSTANCE_PROFILE`
   (default `spored-instance-profile`).

Then run the workflow with `tier: real-aws` (or `both`).
