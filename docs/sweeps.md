# Parameter sweeps

A **parameter sweep** launches many instances at once, one per point in a
parameter grid — the browser port of the Go tool's `spawn sweep`. It's how you
run a hyperparameter search, a CI test matrix, or any "same job, N different
inputs" fan-out, with every instance still governed by the same
[cost-safety model](./concepts.md) as a single launch.

Everything here runs over the existing [`SpawnClient`](./api.md): a sweep is
just many `launch` calls, throttled by a concurrency cap, each stamped with tags
that mark it as a member of the sweep.

## The spec

A sweep is described by a **parameter spec** — a plain object (or JSON) with
three optional parts:

```jsonc
{
  "defaults": { "region": "us-east-1", "ttl": "30m", "spot": true },
  "params": [
    { "instance_type": "t3.micro", "alpha": 0.1 },
    { "instance_type": "t3.small", "alpha": 0.2 }
  ],
  "grid": { "learning_rate": [0.01, 0.1], "batch_size": [32, 64] }
}
```

- **`defaults`** apply to every member. A member's own value for a key wins over
  the default.
- **`params`** is an explicit list — one member per entry.
- **`grid`** is expanded into the **cartesian product** of its named value lists
  and appended after any explicit `params`. The grid above yields four members
  (`0.01×32`, `0.01×64`, `0.1×32`, `0.1×64`).

Grid keys are iterated in **sorted order**, each key's values in declaration
order, so the sequence — and therefore the sweep **index** assigned to each
member — is deterministic across runs. A spec must yield at least one member.

### Known keys vs. sweep parameters

Keys that name a launch field (`instance_type`, `region`, `ttl`, `spot`,
`idle_timeout`, `cost_limit`, `price_per_hour`, `on_complete`, …) configure the
instance. **Every other key is a sweep parameter** — the independent variable
you're actually sweeping (`alpha`, `learning_rate`, `suite`, …). Sweep
parameters ride along as `spawn:param:<key>` tags and, on a real box, are the
values a job reads to know which point of the grid it is.

## From the terminal

Two forms. A compact `--grid` shorthand for a quick cartesian sweep:

```
spawn sweep --grid "learning_rate=0.01,0.1 batch_size=32,64" \
            --ttl 30m --max-concurrent 2 --name hp
```

…or an inline JSON spec (single-quote it so the shell keeps the double quotes):

```
spawn sweep '{"params":[{"instance_type":"t3.micro"},{"instance_type":"t3.small"}],"defaults":{"ttl":"30m"}}'
```

Command-line `--ttl`, `--idle-timeout`, `--instance-type`, `--region`,
`--price-per-hour`, and `--spot` seed the spec's `defaults`, so every member
inherits the same cost bound unless its own param set overrides it. `spawn
status <name>` shows a swept instance's sweep membership and parameters.

Flags: `--name`, `--max-concurrent` (0 = launch all at once), `--launch-delay`
(a Go duration between launches).

## From the dashboard

The **Parameter sweep** panel has a grid form (same `k=v1,v2` shorthand) and a
live progress card per sweep: members launched / running / completed / failed,
with a progress meter. Cards settle to *done* once every member reaches a
terminal state.

## The fan-out engine

Launching is handled by a reusable engine, [`FanOut`](./api.md)
(`src/core/fanout.ts`), that the `SpawnClient` monitor pumps on each tick:

- launch an initial batch up to `maxConcurrent`;
- each time a running member winds down (its TTL/completion fires), launch the
  next pending member — a faithful port of the Go rolling queue;
- `launchDelayMs` spreads launches over successive ticks;
- a member whose launch throws is recorded as **failed** and never aborts the
  rest — sweep members are independent.

`maxConcurrent: 0` launches everything at once. The engine is pure
orchestration (no timers, no clock of its own), so it's deterministic and
testable, and it is the shared substrate for the batch job queue.

## The tag contract

Each launched instance carries the same `spawn:*` tags the Go `spawn sweep`
writes, so a sweep launched from the browser is visible to `spawn list` on the
CLI and vice-versa:

| Tag | Meaning |
|-----|---------|
| `spawn:sweep-id` | unique sweep id (`<name>-<YYYYMMDD>-<6 digits>`) |
| `spawn:sweep-name` | the sweep's name |
| `spawn:sweep-index` | this member's 0-based index |
| `spawn:sweep-size` | total members in the sweep |
| `spawn:param:<key>` | one sweep parameter (capped at 35 to stay under AWS's 50-tag limit) |

See [`src/core/tags.ts`](./architecture.md) for the encode/decode, which is
shared verbatim with single launches.
