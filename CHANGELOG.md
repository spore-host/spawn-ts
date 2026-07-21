# Changelog

All notable changes to **spawn-ts** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, breaking changes bump the MINOR version.

## [Unreleased]

### Added
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

[Unreleased]: https://github.com/spore-host/spawn-ts/commits/main
