# Contributing to spawn-ts

Thanks for your interest in spawn-ts — a browser-native reimplementation of the
spore.host `spawn` lifecycle model.

## Development

```bash
npm install
npm run dev         # Vite dev server (GUI + terminal)
npm test            # vitest — unit + end-to-end
npm run test:cov    # with coverage
npm run typecheck   # tsc --noEmit
npm run build       # static production bundle in dist/
```

Node 20+ is required.

## Project layout

- `src/core/` — the framework-free API (types, duration, tags, lifecycle,
  provider, mock, client). **No DOM imports here.** This is the heart of the
  project and should stay well-tested.
- `src/aws/` — the real `@aws-sdk/client-ec2` provider and instance bootstrap.
- `src/cli/` — the `spawn` command parser + handlers.
- `src/ui/` — the GUI dashboard and terminal (the only DOM code).
- `src/index.ts` — public library barrel.

## Guidelines

- **Match the lifecycle semantics of the Go tool.** The priority order
  (completion → TTL → cost → idle) and the "TTL always terminates" invariant are
  load-bearing; see `src/core/lifecycle.ts` and the tests before changing them.
- **Keep `src/core` DOM-free and tested.** New logic there needs unit tests.
- **Update `CHANGELOG.md`** under `## [Unreleased]` for any user-visible change,
  in the same PR.
- **Never commit credentials.** `.env*` is gitignored; AWS credentials are
  runtime-only and held in memory.
- Run `npm run typecheck` and `npm test` before opening a PR. CI enforces both.

## Issues & tracking

Work is tracked with GitHub Issues, Milestones, and Labels. Please file an issue
before large changes so we can align on scope.

## License

By contributing you agree that your contributions are licensed under the
Apache License 2.0.
