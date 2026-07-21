# spawn-ts documentation

- **[Concepts](concepts.md)** — the cost-safety model for newcomers: TTL vs idle
  vs cost limit, why TTL always terminates, the absolute-deadline invariant.
- **[Architecture](architecture.md)** — layers, the provider seam, design principles.
- **[Lifecycle engine](lifecycle.md)** — the priority order and invariants ported
  from spore.host `spored`.
- **[Parameter sweeps](sweeps.md)** — fan a parameter grid out into many
  instances; the spec format, the `spawn:sweep-*` tag contract, and the shared
  fan-out engine.
- **[API reference](api.md)** — the `SpawnClient` public API. The generated
  [TypeDoc reference](https://spore-host.github.io/spawn-ts/api/) is published
  alongside the demo.

For a quick start and backend setup, see the [top-level README](../README.md).
