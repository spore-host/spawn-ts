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

This is why a spawn-ts launch is **wire-compatible** with the Go tool: the tags
it writes are exactly what `spored` (and `spawn list`) expect, even for behaviors
spawn-ts can't run itself. The docs are careful to say which tier a feature is in
so nothing over-promises.

## Why the catalog is offline (and where live data goes)

truffle-ts ships a bundled instance/price snapshot so `find` works with **zero
credentials and zero cost** — the same cost-safe, MockProvider-default ethos as
spawn-ts. Live AWS data (real-time `DescribeInstanceTypes`, spot prices, quotas)
needs credentials a browser can't safely hold and hits CORS, so it lives behind
truffle-ts's `Finder` seam (a Node/backend implementation), not in the default
browser path. See truffle-ts's [catalog](https://github.com/spore-host/truffle-ts/blob/main/docs/catalog.md)
and [architecture](https://github.com/spore-host/truffle-ts/blob/main/docs/architecture.md) docs.

## The spored relationship, in one line

The browser is the **launcher and viewer**; the `spored` daemon on the instance
is the **enforcer**. spawn-ts installs `spored` via the bootstrap
([userdata.ts](../src/aws/userdata.ts)) — arch-detected download, SHA256
checksum, and optional publisher-signature verification — so the
self-termination guarantee holds even after the browser tab is closed. That
guarantee is validated end-to-end on real AWS (see the closed issue #2).
