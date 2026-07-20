# Changelog

All notable changes to **spawn-ts** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0, breaking changes bump the MINOR version.

## [Unreleased]

### Added
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
