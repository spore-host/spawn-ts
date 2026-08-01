# spawn-ts documentation

- **[Concepts](concepts.md)** — the cost-safety model for newcomers: TTL vs idle
  vs cost limit, why TTL always terminates, the absolute-deadline invariant.
- **[Architecture](architecture.md)** — layers, the provider seam, design principles.
- **[Lifecycle engine](lifecycle.md)** — the priority order and invariants ported
  from spore.host `spored`.
- **[Parameter sweeps](sweeps.md)** — fan a parameter grid out into many
  instances; the spec format, the `spawn:sweep-*` tag contract, and the shared
  fan-out engine.
- **[Batch job queues](queues.md)** — launch a DAG of jobs as dependencies
  complete and capacity allows; the config format, dependency gating, retries,
  and the on-failure policy.
- **[Execution shapes](execution-shapes.md)** — single node, job array, MPI. Job
  arrays with `--min-viable` and sparse-index accounting; why MPI is tags only.
- **[API reference](api.md)** — the `SpawnClient` public API. The generated
  [TypeDoc reference](https://spore-host.github.io/spawn-ts/api/) is published
  alongside the demo.
- **[Data movement and plugins](data-movement.md)** — browser-native Globus
  Transfer (no local machine required), and the plugin split: 7 of 12 declarable
  at launch, 12 of 12 detectable via the `spore:plugin:*` tag.
- **[Integration with truffle-ts](integration.md)** — how the launcher/lifecycle
  (spawn-ts) and instance-discovery (truffle-ts) tools compose, and the
  tag-emit-vs-execution boundary.

For a quick start and backend setup, see the [top-level README](../README.md).
