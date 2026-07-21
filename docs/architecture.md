# Architecture

spawn-ts is **API-first**. The core is a framework-free TypeScript library that
ports the lifecycle model of the Go [`spawn`](https://github.com/spore-host/spawn)
tool; the GUI and terminal are two consumers of that library.

```
┌────────────────────────────────────────────────────────────┐
│                         src/ui                               │
│   dashboard.ts (GUI, primary)   terminal.ts (CLI, secondary) │
│                     modals.ts · main.ts                      │
└───────────────┬───────────────────────────┬─────────────────┘
                │ consumes                   │ consumes
        ┌───────▼───────────────────────────▼────────┐
        │              SpawnClient (core/client.ts)   │
        │  clock · monitor loop · typed event stream  │
        └───────┬───────────────────────────┬─────────┘
                │ uses                       │ drives
        ┌───────▼─────────┐         ┌────────▼──────────┐
        │ lifecycle.ts    │         │  Provider          │
        │ (pure engine)   │         │  (interface)       │
        └─────────────────┘         └───┬───────────┬────┘
                                        │           │
                              MockProvider     EC2Provider
                              (in-memory)      (aws-sdk / substrate)
```

## Layers

### `src/core` — the API (no DOM)

| File | Responsibility |
|------|----------------|
| `types.ts` | Domain model: `LaunchSpec`, `ManagedInstance`, lifecycle types. |
| `duration.ts` | Go-compatible duration parse/format (`4h`, `1h30m`). |
| `tags.ts` | The `spawn:*` tag wire-contract; encode/decode config. |
| `lifecycle.ts` | Pure decision engine — a port of `spored`'s `checkAndAct`. |
| `provider.ts` | The compute-backend interface. |
| `mock.ts` | In-memory provider (default; non-billable; sim clock). |
| `client.ts` | `SpawnClient` — public façade: clock, monitor loop, events. |

### `src/aws`

- `ec2.ts` — `EC2Provider` over `@aws-sdk/client-ec2` v3; targets real AWS or a
  substrate emulator by endpoint.
- `userdata.ts` — the instance bootstrap that installs `spored`, so instances
  self-terminate even with the browser closed. It downloads the arch-appropriate
  `spored` from the regional S3 bucket and **always verifies a SHA256 checksum**
  (guards corruption). Optionally, when an `EC2Provider` is given a
  `sporedSigningPublicKey`, it also **verifies a publisher signature** (`openssl`
  against a key carried by the launcher, not the binary's bucket — fail-closed),
  proving authenticity. Checksum-only is the default, matching the Go tool when
  no signing key is compiled in.

### `src/cli`

- `args.ts` — argv tokenizer + flag parser.
- `commands.ts` — `spawn` subcommand handlers, returning text output.

### `src/ui`

The only DOM code: the dashboard (primary), terminal (secondary), modals, and
`main.ts` wiring.

## Design principles

1. **`core` is DOM-free and deterministic.** Every decision is a pure function of
   inputs + an injected clock; no `Date.now()` inside the engine. This is what
   makes the same logic run in the browser, in tests, and against substrate's
   controllable clock.
2. **The provider is the only backend seam.** Swap mock ↔ real AWS ↔ substrate
   without touching lifecycle, CLI, or UI.
3. **Tags are the source of truth**, exactly as in the Go tool — so an instance
   launched here is managed identically by a real `spored`.

See [lifecycle.md](lifecycle.md) for the engine and [api.md](api.md) for the
`SpawnClient` reference.
