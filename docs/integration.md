# How spawn-ts and truffle-ts fit together

Two browser-native ports of spore.host tools compose to launch cost-safe EC2
instances entirely from a web page:

- **[spawn-ts](https://github.com/spore-host/spawn-ts)** — the **launcher +
  lifecycle** tool. It launches instances, writes their `spawn:*` tags, and (in
  the app) simulates the lifecycle; on real instances the `spored` daemon
  enforces it.
- **[truffle-ts](https://github.com/spore-host/truffle-ts)** — the **instance
  discovery** library. A natural-language / glob query resolves to matching EC2
  instance types against an offline catalog.

spawn-ts *depends on* truffle-ts (one-directional); truffle-ts never reaches
back.

## The composition

```
truffle-ts.find("nvidia h100 efa")   →  a ranked instance type + est. $/hr
        │                                  (offline, no AWS, no creds)
        ▼
spawn-ts launch form / API           →  RunInstances with spawn:* tags
        │                                  (real AWS or the MockProvider)
        ▼
the instance's spored daemon         →  enforces TTL/idle/cost/completion,
                                          runs pre-stop/webhook/notify hooks
```

In the dashboard this is literally a picker: type a query, truffle-ts returns
the matches, and choosing one fills spawn-ts's instance-type field and its
estimated `$/hr`. A type truffle-ts has no price for clears `$/hr` rather than
keeping the last pick's. A query truffle-ts can't read (from truffle-ts 0.6, one
made only of unknown words) shows its error and hint instead of matches.
See the launch form's "find instance" input. spawn-ts accepts truffle-ts
`^0.5.0 || ^0.6.0`, so an app already on either shares one copy with it.

## The load-bearing boundary: tag-emit vs execution

spawn-ts runs in a **browser**. It has no on-instance daemon, no IMDS, no node
shell. So for every behavior the spore.host model enforces *on the instance*,
spawn-ts's job is only to **write the `spawn:*` tag** — a real `spored` reads it
and does the work. Three tiers:

| Tier | Examples | spawn-ts does |
|------|----------|---------------|
| **Browser-native** | TTL/idle/cost/completion *simulation*, sweeps, queues, job arrays, orphan detection, session-timeout bootstrap | runs it, in-app, over the provider |
| **Tag-emit only** | pre-stop, spot-interruption webhook, notify, active-processes | writes the tag; `spored` executes it on the box |
| **Not portable** | FSx provisioning, DCV, on-node storage mounts, `logs`/`collect` | out of scope (needs the daemon / a backend) |

This is why a spawn-ts launch is **wire-compatible** with the Go tool for the tags
it does write: they are byte-for-byte what `spored` (and `spawn list`) expect, even
for behaviors spawn-ts can't run itself. The docs are careful to say which tier a
feature is in so nothing over-promises.

### Wire-compatible, and what that does *not* cover

"Wire-compatible" is a claim about the tags spawn-ts writes, so it's only as
useful as the list of tags it doesn't. `buildTags`
(`spawn/pkg/aws/tags.go:32`) can write 54 distinct keys; `buildLaunchTags`
(`src/core/tags.ts`) writes 43 — 13 of Go's absent, 2 of spawn-ts's own not in
Go. Every difference below is classified in the same A–E tiers, because "absent"
alone doesn't say whether it's a gap or a decision.

Since [#51](https://github.com/spore-host/spawn-ts/issues/51), the **base-identity
block is stamped**: `managed`, `root`, `created-by`, `version`, `account-id`,
`account-base36`, `iam-user`, `account-name`, plus `os` and `local-username`. That
block is what makes an instance *ownable* — the portal filters its list, its
single-instance lookup and its terminate on `spawn:iam-user`
(`lambda/dashboard-api/instances.go:60`/`:168`/`:285`, the last 403ing on a
mismatch), while `spawn list` filters on `spawn:managed` alone. An instance
missing it was therefore visible in the CLI yet invisible *and unterminatable*
in the portal, so `EC2Provider` now **refuses to launch** when it can't resolve
the identity rather than omitting the tag: an orphaned billable instance is worse
than a failed launch.

What Go writes and spawn-ts still does not:

| absent tag | tier | why |
|---|---|---|
| `spawn:fsx-*` (7 keys), `spawn:efs-id`, `spawn:efs-mount-point` | **D** | describe filesystem provisioning + on-node mounts the browser can't perform |
| `spawn:dcv-session-id`, `spawn:app-name` | **D** | DCV streaming sessions; no browser path to create one |
| `spawn:command` | **B** | observability only — the command rides user-data (`BootstrapOptions.command`, `src/aws/userdata.ts`), which is the load-bearing half; `LaunchSpec` does not carry a command yet. If added it must keep Go's `len(cmd) <= 256` guard, or `RunInstances` fails outright (spawn#214/#246) |
| `spawn:slack-workspace-id` | **B** | only meaningful once the notify path carries a workspace binding |
| `spawn:job-array-created` | **E** | deliberate: non-deterministic, no reader exists, and `spawn:launch-time` already records it (`src/core/tags.ts`) |

And two spawn-ts writes that Go's launcher doesn't, both read by Go:

| extra tag | why it's correct |
|---|---|
| `spawn:compute-seconds` | seeded at `0` so cost accounting has a defined starting point. Go leaves it absent and `spored` creates it (`pkg/agent/agent.go:404`); `pkg/provider/ec2.go:486` reads it either way |
| `spawn:idle-cpu` | Go's launcher never writes it although `pkg/provider/ec2.go:508` decodes it — so a Go-launched instance's `--idle-cpu` threshold is unreachable by the reader that wants it. spawn-ts writing it is the fix, not the divergence |

One more difference is deliberate and visible: `spawn:created-by` is
`"spawn-ts"`, not Go's `"spawn"`. No reader compares the value, and an operator
benefits from knowing which launcher produced an instance.

The full 50-command tier matrix is
[#57](https://github.com/spore-host/spawn-ts/issues/57).

### The tag budget is a real constraint

AWS caps a resource at **50 tags**, and exceeding it fails `RunInstances`
outright — it doesn't truncate. And a launch that fits is not done: `spored`
writes tags of its own once running (its heartbeat, `spawn:spored-version`, its
cost footprint and, with DNS, the DNS status), and a write past 50 fails whole.
So spawn-ts, like Go since spawn#1355, keeps a slot free for each
(`tagReserve`, Go's `postLaunchInstanceTags`; 6 for a launch with DNS) and
refuses a launch whose tags plus that reserve exceed 50, before any AWS call
(`checkTagLimit`, spawn#1336). The per-member `spawn:param:*` tags of a sweep
are the one droppable class: they get what is left (`AWS_TAG_LIMIT` less the
launch's tags and the reserve, Go's `launchTagLimit`), in sorted key order, so
the surviving subset is deterministic. Dropping parameters is itself lossy —
they're how a sweep member records which point in the space it *is* — but a
truncated tag set beats a launch that fails.

### Opening a DCV or web-app session: the access-token contract

spawn-ts has no path that opens a DCV or web-app session (both are **Not
portable** above), and it reads no session token from tags. A browser client
that does open one, such as the spore.host portal's connect slice
([spore-host#687](https://github.com/spore-host/spore-host/issues/687)), follows
the contract from [spawn#1603](https://github.com/spore-host/spawn/pull/1603),
which takes session tokens off EC2 tags. The reference implementation is Go's
`pkg/accesstoken` plus `cmd/accesstoken.go`.

**What spored publishes.** None of these tags carries a token:

| tag | value |
|---|---|
| `spawn:ready-status` | readiness of the session or app |
| `spawn:ready-url` | the URL without a token: `https://<host>:8443/#<dcv-session-id>` for DCV, `https://<host>/` for a web app |
| `spawn:ready-auth` | `token`: register a token before opening. `none`: the web proxy is ungated, so open `spawn:ready-url` as it is |

A current spored deletes `spawn:ready-token` on its first tick. If
`spawn:ready-auth` is absent, the instance's spored predates #1603 and
published its token in `spawn:ready-token` (and inside the ready-url), where
anyone with `ec2:DescribeTags` in the account can read it. Go spawn still
uses that token and prints a warning naming `spawn upgrade-spored`. A new
client doesn't need that fallback: it can ask the user to upgrade spored or
relaunch.

**What the client does** when `spawn:ready-auth` is `token`, on every connect:

1. **Mint** 32 random bytes (`crypto.getRandomValues`) and hex-encode them: a
   64-character lower-case token. Keep it in memory only.
2. **Hash** it: the lower-case hex SHA-256 of the token's hex *string*, not of
   the raw bytes (Go `accesstoken.Hash`). In a browser that is
   `crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))`.
3. **Register** the hash over SSM: `ssm:SendCommand` with
   `DocumentName: "AWS-RunShellScript"` and
   `commands: ["/usr/local/bin/spored access-token add --kind <dcv|web> --sha256 <hash> --ttl <n>s"]`.
   `<n>` is a whole number of seconds in `(0, 604800]` (at most 7 days). Go
   uses 43200 (12 h). The command runs as root, so it needs no `sudo`. Only the
   hash reaches SSM's command history.
4. **Confirm** with `ssm:GetCommandInvocation`. Success means `Status ==
   "Success"` and `ResponseCode == 0`. Output containing `unknown command`
   means the instance's spored predates registration. Go retries a refused
   `SendCommand` up to 6 times, 10 s apart, because on a freshly started
   instance the SSM agent can come online after the readiness tag.
5. **Build the URL locally**, with the host and DCV session id taken from
   `spawn:ready-url`: `https://<host>:8443/?authToken=<token>#<dcv-session-id>`
   for DCV, `https://<host>/?spore_token=<token>` for a web app.

spored checks the token's expiry on every DCV authentication and on every
proxied web request (the proxy's cookie expires with the token). A stop/start
or a reboot clears every registered token, and `spored access-token revoke-all`
clears them on demand. A new connect mints a new token, so nothing needs to be
stored or shared between tabs or machines. The IAM a client needs is
`ssm:SendCommand` (on the instance and the `AWS-RunShellScript` document) and
`ssm:GetCommandInvocation`. Anyone who can run `SendCommand` on the instance
already has root on it, so registration adds no new authority.
`EC2Provider.reloadAgent` already shows how to call `SendCommand` from a
browser.

## Why the catalog is offline (and where live data goes)

truffle-ts ships a bundled instance/price snapshot so `find` works with **zero
credentials and zero cost** — the same cost-safe, MockProvider-default ethos as
spawn-ts. Live AWS data (real-time `DescribeInstanceTypes`, spot prices, quotas)
lives behind truffle-ts's `Finder` seam so the default path stays offline and
free, **not because a browser can't reach it**.

Two claims that used to appear here were wrong, and the distinction matters
because it decides which features are portable at all:

- **CORS is not a blocker.** Preflighted live from `Origin: https://spore.host`,
  every endpoint the live finder needs returns `access-control-allow-origin: *`
  with `access-control-allow-methods: POST` and
  `access-control-allow-headers: content-type,x-amz-target,authorization`:
  `ec2.us-east-1.amazonaws.com`, `api.pricing.us-east-1.amazonaws.com`,
  `servicequotas.us-east-1.amazonaws.com`. So do `sts`, `ssm`, `tagging`, `ce`,
  `dynamodb`, `scheduler`, and `bedrock-runtime`.
- **A browser can hold usable credentials.** Not a long-lived key — a
  short-lived STS session. `credsFromIdToken` ([aws-federation.ts](../src/auth/aws-federation.ts))
  exchanges a Globus OIDC `id_token` for `AssumeRoleWithWebIdentity` credentials
  that live in the tab and expire on their own. That is the same BYOA path the
  portal already signs in with.

What *is* still true: the live finder costs API calls (and `pricing:GetProducts`
for savings annotations), needs IAM permissions the bundled path doesn't, and adds
latency. Those are the reasons `BundledFinder` remains the default — a deliberate
cost-safety choice, not a technical wall. See truffle-ts's
[catalog](https://github.com/spore-host/truffle-ts/blob/main/docs/catalog.md) and
[architecture](https://github.com/spore-host/truffle-ts/blob/main/docs/architecture.md)
docs (both carry the same stale framing — truffle-ts#35).

## The spored relationship, in one line

The browser is the **launcher and viewer**; the `spored` daemon on the instance
is the **enforcer**. spawn-ts installs `spored` via the bootstrap
([userdata.ts](../src/aws/userdata.ts)) — Go's release-build stub, pinned to
spawn 0.150.0's signed bootstrap body and `spored`, verified by sha256 and the
spore.host signature — so the self-termination guarantee holds even after the
browser tab is closed. That
guarantee is validated end-to-end on real AWS (see the closed issue #2).
