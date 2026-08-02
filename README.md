# spawn-ts

[![CI](https://github.com/spore-host/spawn-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/spore-host/spawn-ts/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

A browser-native reimplementation of [spore.host `spawn`](https://github.com/spore-host/spawn):
launch and manage self-terminating AWS EC2 instances entirely from a web page —
no backend, no server-side credentials.

It is **API-first**: the core is a framework-free TypeScript library
(`SpawnClient`) that ports spawn's lifecycle model. A GUI and an optional
terminal are bundled as two consumers of that API.

**▶ Live demo (mock backend, no credentials needed):** <https://spore-host.github.io/spawn-ts/>

## Documentation

- [Architecture](docs/architecture.md) — layers and the provider seam
- [Lifecycle engine](docs/lifecycle.md) — priority order and invariants
- [API reference](docs/api.md) — the `SpawnClient` API
- [Integration with truffle-ts](docs/integration.md) — how the two tools compose

Full index in [`docs/`](docs/README.md).

## Why this exists

The real `spawn` (Go) launches EC2 instances that manage their own death — via
**TTL, idle detection, cost limit, or a completion signal** — so you never get a
forgotten bill. The self-termination guarantee lives in `spored`, an in-instance
daemon, *not* the CLI. That means the launcher can be anything — including a web
page. spawn-ts is that web page.

## Architecture

```
src/
  core/            ← the API (no DOM, no framework)
    types.ts         domain model (LaunchSpec, ManagedInstance, …)
    duration.ts      Go-compatible duration parse/format ("4h", "1h30m")
    tags.ts          the spawn:* tag wire-contract (matches the Go tool)
    lifecycle.ts     pure decision engine — a port of spored's checkAndAct
    provider.ts      backend interface (compute abstraction)
    mock.ts          in-memory provider (default; not billable)
    client.ts        SpawnClient — public API: clock + monitor loop + events
  aws/
    ec2.ts           real EC2 provider via @aws-sdk/client-ec2 (or substrate)
    userdata.ts      bootstrap that installs spored on the instance
  cli/               spawn command parser + handlers (used by the terminal)
  ui/                the GUI (dashboard) + optional terminal pane
  index.ts           library entry / barrel export
```

### The lifecycle engine

`core/lifecycle.ts` is a faithful, pure port of
`spawn/pkg/agent/agent.go:checkAndAct`. Priority order is load-bearing and
matches the original exactly:

1. **completion signal** → run the on-complete action
2. **TTL** → *always terminate* (the hard cost backstop; never just stops)
3. **cost limit** → terminate
4. **idle** → stop, or hibernate with `hibernateOnIdle`

TTL uses an **absolute deadline** anchored at launch, so stop/start cycles can't
extend an instance past its deadline — same invariant as the Go tool.

## Using the API

```bash
npm i @spore-host/spawn-ts
```

### Entry points

| subpath | what's in it | plain Node |
|---|---|---|
| `.` | the DOM-free engine — `SpawnClient`, `EC2Provider`, tags, lifecycle, bounds, notices, orphans, plugins | yes |
| `./auth` | Globus Auth OIDC → STS federation (`credsFromIdToken`) | yes |
| `./ssm` | the SSM data-channel session (no xterm) | yes |
| `./transfer` | Globus Transfer REST client | yes |
| `./dns` | spore.host DNS naming and resolution | yes |
| `./quotas` | EC2 vCPU quota lookup | yes |
| `./portal` | portal-side helpers | yes |
| `./ui` | `Dashboard`, `Terminal`, modals (DOM components) | yes |
| `./ui/style.css` | the Dashboard's styles — **you import this** | n/a |
| `./terminal` | xterm glue: `attachTerminal()` over an SSM session | **bundler only** |

`./terminal` requires a bundler (Vite, esbuild, webpack). Two reasons, one of them
upstream: `@xterm/xterm` publishes no `exports` field, so Node resolves its CJS
`main` and ignores the ESM `module` build; and the module imports xterm's CSS as a
side effect. Everything else imports fine under plain Node — `npm run check:imports`
asserts exactly that, and holds `./terminal` to a *declared* reason so the
restriction can't quietly spread (see #70). If you only need the data channel and
not xterm rendering, use `./ssm`, which has neither constraint.

```ts
import { SpawnClient } from "@spore-host/spawn-ts";

const spawn = new SpawnClient({ clock: 60 }); // 1 sim-minute per real second
spawn.on((e) => console.log(e));              // typed event stream
spawn.startMonitor();                          // begin the lifecycle loop

await spawn.launch({ name: "job", ttl: "4h", onComplete: "terminate", pricePerHour: 0.153 });
// …instance self-terminates when its TTL expires, emitting an "action" event.
```

Swap to real AWS (credentials held in memory only, never persisted):

```ts
import { SpawnClient, EC2Provider } from "@spore-host/spawn-ts";
spawn.setProvider(new EC2Provider({ region: "us-east-1", accessKeyId, secretAccessKey }));
```

## Backends

- **mock** (default) — in-memory, not billable, accelerated sim clock. Safe for
  demos and the whole test suite.
- **substrate** — the [substrate](https://github.com/scttfrdmn/substrate) AWS
  emulator at `http://localhost:4566` (deterministic, offline, cost-visible).
  Verified working over the wire against substrate **v0.73.0**. Needs opt-in CORS
  for browser SDK clients, added in v0.72.0
  ([#346](https://github.com/scttfrdmn/substrate/issues/346)); v0.73.0 also makes
  `RunInstances` echo launch-time tags to match real EC2
  ([#351](https://github.com/scttfrdmn/substrate/issues/351)).
- **real AWS** — `@aws-sdk/client-ec2` v3 direct from the browser. Billable.
  A safety guard refuses an unbounded real launch (no TTL *and* no cost limit).

## Develop

```bash
npm install
npm run dev        # Vite dev server
npm test           # vitest — lifecycle + end-to-end client tests
npm run build      # static bundle in dist/
```

### Integration tests against substrate

`src/aws/ec2.integration.test.ts` drives the real `@aws-sdk/client-ec2` path
against a live substrate emulator. It auto-skips when substrate is unreachable,
so plain `npm test` stays hermetic. To run it:

```bash
# substrate v0.73.0+, CORS enabled (config: server.cors.enabled: true)
substrate server --config substrate-cors.yaml   # listens on :4566
SUBSTRATE_ENDPOINT=http://localhost:4566 npm test
```

It verifies the full launch → list → get → terminate round-trip and that the
SpawnClient monitor self-terminates an expired-TTL instance over the wire.

## Status

Core lifecycle scope: launch, list, status, connect (surfaces SSH/SSM command),
extend, stop/start, hibernate, terminate + the full TTL/idle/cost/completion
engine. Parameter sweeps (`spawn sweep`) fan a parameter grid out into many instances
(see [docs/sweeps.md](docs/sweeps.md)), and batch job queues (`spawn queue`)
launch a DAG of jobs as dependencies complete and capacity allows (see
[docs/queues.md](docs/queues.md)) — both over one shared fan-out engine.

The launch form's instance-type field is backed by a **truffle instance picker**:
type a natural-language query ("h100 efa", "cheapest graviton 32gb") and pick from
matched EC2 instance types, which auto-fills the type and its estimated $/hr. This
is powered by [`@spore-host/truffle-ts`](https://github.com/spore-host/truffle-ts)
(a library dependency); spawn-ts owns the picker UI.

### Versioning and what "parity" means

spawn-ts stays on `0.x.y` **indefinitely** — there is no planned 1.0.0 — so a MINOR
bump is the breaking-change signal for the life of the project, not a pre-release
convention.

Its version line is **its own**, deliberately not Go `spawn`'s: 0.6.x here against
v0.97.x there. Matching those numbers would assert a feature correspondence that
doesn't exist, and it would be the wrong thing to fix, because most of the gap isn't
a gap. Roughly 22,700 lines of Go `pkg/` plus all of `lambda/` are the
daemon/server/provisioning half of the architecture — the half spawn-ts writes
`spawn:*` **tags for** rather than reimplements in a browser tab.

So parity is a **behavioural** claim carrying **documented divergences**, audited
per-command across five tiers (at parity / portable-but-missing / tag-emit-only /
not portable / deliberately excluded) in
[#57](https://github.com/spore-host/spawn-ts/issues/57). Where spawn-ts diverges on
purpose it says so at the point of divergence — see
[docs/api.md](docs/api.md#status-notices) on the Elastic IP lookup, and
[docs/data-movement.md](docs/data-movement.md#plugins-two-columns-not-one) on
refusing an unhonourable plugin before launch instead of parking it on the box. A
divergence that isn't written down is a bug; one that is, is a design decision.
