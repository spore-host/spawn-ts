# Changelog

All notable changes to **spawn-ts** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, breaking changes bump the MINOR version.

## [Unreleased]

### Added
- **Truffle instance picker** in the launch form — a natural-language query box
  ("h100 efa", "cheapest graviton 32gb") backed by
  [`@spore-host/truffle-ts`](https://github.com/spore-host/truffle-ts) resolves
  to matching EC2 instance types (offline, no AWS); picking one auto-fills the
  instance-type field and its estimated $/hr. truffle-ts is a git dependency;
  CI/Pages rewrite `git@github`→HTTPS so `npm ci` clones it. spawn-ts owns the
  picker UI — truffle-ts only supplies data + logic.

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

[Unreleased]: https://github.com/spore-host/spawn-ts/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/spore-host/spawn-ts/releases/tag/v0.2.0
