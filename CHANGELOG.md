# Changelog

All notable changes to **spawn-ts** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, breaking changes bump the MINOR version.

## [Unreleased]

### Added
- **Optional spored signature verification** (#26) — an `EC2Provider`
  `sporedSigningPublicKey` (PEM) makes the bootstrap verify the downloaded
  `spored`'s detached signature (`openssl`, fail-closed) against a launcher-held
  key before install, proving authenticity — not just the SHA256 checksum
  (integrity). Ports the Go bootstrap's `SPORED_SIG_VERIFY` path. Default stays
  checksum-only, matching the Go tool when no key is compiled in.
- **Lifecycle-hook tags** (#25) — emit the `spawn:*` tags for daemon-enforced
  hooks so an instance spawn-ts launches is honored by a real spored (spawn-ts,
  a browser launcher, can't run them itself): `pre-stop` (+timeout),
  `spot-webhook-url`/`webhook-correlation`/`webhook-timeout`, `notify-url`/
  `notify-platform`/`notify-command`, and `active-processes`. New `LifecycleHooks`
  on `LaunchSpec`/`LaunchInput`, `buildHookTags`/`decodeHookTags`, decoded onto
  `ManagedInstance.hooks` and shown in `spawn status`. CLI `launch` flags + the
  dashboard exposes pre-stop and notify. Docs state these run **on the instance**.
- **`--on-idle stop|hibernate`** — the modern spelling of `--hibernate-on-idle`
  (rejects `terminate` with a pointer to `--on-complete`); both map to the same
  `spawn:hibernate-on-idle` tag.

### Changed
- `spawn:hibernate-on-idle` is now emitted **only when true** (matches the Go
  tool; an absent tag means the default idle action, stop). Decode is unchanged.

## [0.4.0] — 2026-07-21

### Added
- **Job arrays** (#24) — `spawn array <name> --count N` launches N identical,
  indexed instances from one base config, tagged with the wire-compatible
  `spawn:job-array-*` contract (so `spawn list --job-array-id` sees them and the
  instance's spored surfaces `JOB_ARRAY_INDEX`). A peer of sweeps/queue built on
  the shared `FanOut` engine (`src/core/jobarray.ts`); `SpawnClient.startJobArray`
  emits `jobarray` progress events reusing the dashboard card. Membership decodes
  onto `ManagedInstance.jobArray` and shows in `spawn status`. Scope: launch /
  status (via `list`) / cancel (via `terminate`); `retry --failed` and `logs`/
  `collect` are out (need a persisted record or node access) — follow-ups.
- **Orphan / zombie reaper** (#23) — a lifecycle safety-net for the #19 failure
  mode (spored died/never installed, so an instance never self-terminated).
  `findOrphans` (`src/core/orphans.ts`, reusing the exported `ttlDeadline`) flags
  managed, live instances past their TTL deadline + a 10-min grace;
  `SpawnClient.findOrphans` / `reapOrphans` surface + terminate them. Exposed as
  the CLI `orphans [--reap] [-y]` command and a dashboard warning banner with a
  one-click reap. Pure detection; reaping is always confirmed.
- **Session timeout** (idle-SSH-shell auto-logout, #22) — `--session-timeout` /
  `LaunchInput.sessionTimeout` writes `spawn:session-timeout` and injects an sshd
  `ClientAlive` config + a `readonly TMOUT` in the bootstrap (`src/aws/userdata.ts`),
  mirroring the Go tool. Disconnects idle SSH login sessions; distinct from the
  idle-*instance* lifecycle (which stops/terminates the box). Exposed in the CLI
  `launch` flags and the dashboard launch form.

## [0.3.0] — 2026-07-21

### Fixed
- **spored now self-terminates on TTL** (spawn-ts#19, closes #2). The systemd
  unit invoked `spored run` — an unknown subcommand — so spored exited non-zero
  and the unit crash-looped, never enforcing the TTL. The daemon is the bare
  `spored` invocation; the unit is now byte-for-byte the Go bootstrap's
  (`Type=simple`, `Environment=SPORE_DNS_SIGV4=1`, `ExecStart=/usr/local/bin/spored`,
  `Restart=on-failure`, journal output). Validated on real AWS: a t4g.nano with a
  5-min TTL self-terminated ~35s after its deadline, unattended, leak-checked clean.
- **Real-AWS bootstrap now installs spored** (spawn-ts#17, blocks #2). The
  user-data fetched a GitHub-release URL that 404s and was hardcoded to amd64, so
  spored never installed on a real instance — the self-termination guarantee was
  silently broken on real AWS (invisible because substrate doesn't run
  user-data). `buildLinuxBootstrap` now mirrors the Go tool: detect arch
  (amd64/arm64), read region from IMDS, download `spored-linux-<arch>` from the
  regional S3 bucket (`spawn-binaries-<region>`) with a us-east-1 fallback and
  prefixed/legacy paths, verify the SHA256, and install atomically.
- **EC2Provider attaches an IAM instance profile** (`iamInstanceProfile` option),
  required for spored's self-lifecycle calls (`DescribeTags` + `TerminateInstances`
  on `spawn:managed=true`) — without it a real instance could never self-terminate.
- **EC2Provider resolves an AMI** via `DescribeImages` (latest AL2023 for the
  instance's architecture) when none is supplied, so a real launch needs no
  hardcoded AMI id. Added `archForInstanceType`.

### Added
- **Real-AWS launch validated end-to-end** (#2): a t4g.nano in us-east-1
  (`spored-instance-profile`, resolved arm64 AL2023 AMI) launched, reached
  `running`, and **self-terminated on its TTL via spored** — unattended, ~35s
  past the deadline, leak-checked clean. The full self-termination guarantee is
  proven on real AWS, not just substrate.
- **Truffle instance picker** in the launch form — a natural-language query box
  ("h100 efa", "cheapest graviton 32gb") backed by
  [`@spore-host/truffle-ts`](https://github.com/spore-host/truffle-ts) resolves
  to matching EC2 instance types (offline, no AWS); picking one auto-fills the
  instance-type field and its estimated $/hr. truffle-ts is a git dependency;
  CI/Pages rewrite `git@github`→HTTPS so `npm ci` clones it. spawn-ts owns the
  picker UI — truffle-ts only supplies data + logic.
- Bumped `@spore-host/truffle-ts` to `v0.2.0`, so the picker also accepts
  **glob/regex patterns** (`m7i*`, `c[6-8]i.large`) alongside natural-language
  queries.
- Bumped `@spore-host/truffle-ts` to `v0.3.0`, whose bundled catalog is now
  **real AWS data** ("as of 2026-07") — the picker shows accurate specs and the
  auto-filled $/hr reflects current on-demand pricing (e.g. `p5.48xlarge`
  $55.04/hr).

## [0.2.0] — 2026-07-20

### Added
- **Batch job queues** (`spawn queue`, issue #5) — launch a DAG of jobs, one
  instance per job, as dependencies complete and capacity allows. Built on the
  sweep's fan-out engine, now extended with generic **dependency gating**
  (`dependsOn`), **launch retries** (`maxAttempts` + `retryDelayMs`), and an
  **on-failure policy** (`stop` halts the queue; `continue` keeps launching
  independent jobs; a failed job always skips its dependents). The core
  (`src/core/queue.ts`) ports `pkg/queue` — config validation, Kahn's-algorithm
  topological ordering with cycle detection, and the retry model — and loads an
  existing Go `simple-queue.json` / `ml-pipeline-queue.json` unchanged. Each
  job's instance carries the queue as `spawn:sweep-*` tags with the command +
  env as `spawn:param:*`. Wired into the terminal (`spawn queue '<json>'`) and
  the dashboard (a config editor + progress cards showing blocked/skipped jobs).
  The Go tool's on-box sequential runner and S3/Lambda result collection are out
  of scope for the browser. See [docs/queues.md](docs/queues.md).
- **Parameter sweeps** (`spawn sweep`, issue #4) — fan a parameter grid out into
  many instances. A pure, testable core (`src/core/params.ts`, `sweep.ts`)
  expands a spec (`params` list and/or cartesian `grid`, with `defaults`) into
  members, then launches them over the existing `SpawnClient` via a new reusable
  fan-out engine (`src/core/fanout.ts`) that honors a concurrency cap and an
  inter-launch delay — a port of the Go tool's rolling queue. Each instance is
  tagged with the wire-compatible `spawn:sweep-*` / `spawn:param:*` contract
  (`tags.ts`), so a sweep launched here is visible to the Go `spawn list` and
  vice-versa. Wired into the terminal (`spawn sweep --grid "lr=0.1,0.2 bs=32,64"`
  or an inline JSON spec) and the dashboard (a grid form + live progress cards),
  with sweep membership surfaced in `spawn status`. The fan-out abstraction is
  shared ground for the batch queue (issue #5).
- **Generated TypeDoc API reference** — `npm run docs` (TypeDoc) generates a full
  reference from the `src/index.ts` exports into `dist/api/`, published alongside
  the Pages demo at `/api/`. Wired into `npm run build` so Pages picks it up with
  no workflow change; `docs/api.md` links to it. Exported `TickInput` to complete
  the public surface (issue #6).
- **Concepts guide** (`docs/concepts.md`) — a newcomer-friendly narrative of the
  cost-safety model: TTL vs idle vs cost limit, why TTL always terminates (never
  stops), and the absolute-deadline invariant. Cross-linked with
  `docs/lifecycle.md` (issue #7).
- **Hermetic EC2Provider unit tests** (`src/aws/ec2.test.ts`) — stub the AWS SDK
  `send` so the real command classes still build their request, covering state
  mapping, tag decode, filter/market-option construction, and error paths with
  no substrate emulator required (issue #8).
- **UI test coverage** (`src/ui/*.test.ts`) — happy-dom-based tests for the
  dashboard (launch-form wiring, instance-card actions, meters, log), the
  terminal (command execution, history, refresh-on-mutate), and the modals
  (confirm + backend picker). Added `happy-dom` as a dev dependency (issue #1).
- **user-data bootstrap tests** (`src/aws/userdata.test.ts`) — spored install
  script shape and UTF-8-safe base64 encoding.
- Coverage now ~91% overall (from ~51%), clearing the v0.2.0 ≥75% target.
- Initial public release scaffolding: Apache-2.0 license, contributor guide,
  CI (typecheck + test + build), and documentation.
- **Core lifecycle engine** (`src/core/lifecycle.ts`) — a faithful port of the
  spore.host `spored` monitor loop: completion → TTL (always terminate) → cost
  limit → idle, with 5-minute / 90%-budget warnings. Pure and deterministic.
- **`SpawnClient`** (`src/core/client.ts`) — the public API: a provider-agnostic
  façade with a clock (real or accelerated sim), a monitor loop, and a typed
  event stream.
- **Providers** — `MockProvider` (in-memory, default, non-billable) and
  `EC2Provider` (`@aws-sdk/client-ec2` v3, direct to AWS or a substrate emulator).
- **`spawn:*` tag contract** (`src/core/tags.ts`) — wire-compatible with the Go
  `spawn` tool, including Go-form durations and RFC3339 timestamps.
- **GUI** (primary) — launch form, live instance cards with action buttons,
  TTL/cost meters, lifecycle log, backend/credentials picker, sim-speed control.
- **Terminal** (secondary) — the full `spawn` CLI surface over the same client.
- **Tests** — lifecycle, client end-to-end, CLI, and live integration tests
  against a substrate emulator (auto-skip when unreachable).

[Unreleased]: https://github.com/spore-host/spawn-ts/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/spore-host/spawn-ts/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/spore-host/spawn-ts/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/spore-host/spawn-ts/releases/tag/v0.2.0
