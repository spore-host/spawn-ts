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
estimated `$/hr`. See the launch form's "find instance" input.

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

**Wire-compatible is not yet wire-complete.** Go's `buildLaunchTags`
(`spawn/pkg/aws/tags.go:32`) stamps 55 tags at launch; spawn-ts stamps 33. The
absent ones are not all tier D — the base-identity block is tier **B**, and its
absence has real consumers:

| absent tag | tier | consequence |
|---|---|---|
| `spawn:iam-user` | **B** | the portal can neither list nor terminate a spawn-ts instance (`lambda/dashboard-api/instances.go:285` → 403); `cleanup --only-mine` skips it |
| `spawn:account-base36` | **B** | `spored`'s notifier can't build the instance FQDN |
| `spawn:os`, `spawn:local-username` | **B** | `spawn connect` can't infer the SSH user |
| `spawn:version` | **B** | AMI management can't tell which launcher wrote the instance |
| `spawn:active-ports` | **C** | `spored` writes this one itself; not a launcher gap |
| FSx / EFS / DCV tags | **D** | the provisioning they describe isn't browser-reachable |

Tracked in [#51](https://github.com/spore-host/spawn-ts/issues/51); the full
50-command tier matrix is [#57](https://github.com/spore-host/spawn-ts/issues/57).

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
([userdata.ts](../src/aws/userdata.ts)) — arch-detected download, SHA256
checksum, and optional publisher-signature verification — so the
self-termination guarantee holds even after the browser tab is closed. That
guarantee is validated end-to-end on real AWS (see the closed issue #2).
