# Execution shapes

There are three ways to run a job on EC2, and they are not variations on one
theme — each makes a different demand on the launcher:

| shape | what it needs from a launcher | spawn-ts |
|---|---|---|
| **single node** | one instance, bounded | full ([launch](./api.md)) |
| **job array** | N indexed instances, a viability threshold, per-index accounting | full (this doc) |
| **MPI** | N instances placed *together*, an EFA fabric, a peers file pushed to every rank | **tags only** |

The first two are browser-native. The third is not, and the interesting part of
this document is *why* — because the reason is not "browsers are limited".

## Job arrays

`spawn array <name> --count N` launches N identical instances that differ only
by index, each stamped with the `spawn:job-array-*` tags so the array is
discoverable from the Go CLI and the portal. The instance's `spored` surfaces its
index as `JOB_ARRAY_INDEX`, which is how the workload knows which slice it is.

Arrays run on the same [fan-out engine](./sweeps.md#the-fan-out-engine) as
sweeps and [queues](./queues.md), so `--max-concurrent` and `--launch-delay`
behave identically. What an array adds is the two things indexed work needs and a
flat fan-out doesn't: a **viability threshold** and **per-index accounting**.

### `--min-viable` — a threshold on the set, not a policy per member

```
spawn array train --count 100 --min-viable 50 --ttl 2h
```

Read this as: *fewer than 50 members up means this array isn't worth running.*

It is easy to mistake this for the failure policy queues already have, so the
distinction is worth stating plainly. `on_failure` is a **per-member** rule that
decides whether to keep launching, and `"stop"` leaves everything already
launched **running**. So under `on_failure` alone, a 100-member array that comes
up 2-of-100 is not reported as a failure — it is two billable instances quietly
working on a job that needs a hundred.

`--min-viable` asks the other question, about the set as a whole, and acts on the
answer:

- **The gate latches.** Once too many members have failed or been skipped for the
  threshold to be reachable *even if every remaining member succeeds*, the array
  is non-viable. A set cannot become viable again, so this is a latch rather than
  something that flickers.
- **Launching stops immediately.** The remaining members are skipped rather than
  launched into a set already known to be unusable — the port of cohort's
  `fastFailCancel` (`cohort/reconcile.go:243`).
- **Survivors are terminated.** This is the half that costs money if it's
  missing. Go drains for a stated reason — *"Drain surviving instances so nothing
  idles and bills"* (`cohort/reconcile.go:298`) — and spawn-ts does it
  automatically on the monitor loop's next pump, emitting a
  `terminate` / `min-viable` action event per instance. An instance that could
  **not** be terminated emits a warning instead of being dropped: a failed drain
  is precisely the case where money keeps being spent.

Non-viability is *reported* by the fan-out engine and *enforced* by the job
array. That split is deliberate: `FanOut` is shared with sweeps and queues, and
every other state change it makes is a launch. A shared engine that silently
terminated instances would surprise its other two callers.

Each survivor is reported **once**, even though two pumps can overlap (starting an
array kicks one without awaiting it) and a member stays `running` in the fan-out's
record until the following pump reconciles it. Re-terminating would be harmless in
itself, but the caller acts on the returned ids: the monitor loop turns each into a
user-visible `terminate` event, so a duplicate reads as two instances wound down.
A terminate that *failed* stays retryable — that instance is still billing.

In the dashboard this surfaces on the array's card: the threshold when one is set,
and on going non-viable, the shortfall in red plus what follows, with the state
chip reading **non-viable** instead of the green `done`. An array that was torn
down must not look like one that finished. `minviable.harness.html` (dev-only,
under `npm run dev`) reaches that state by making two members unlaunchable — no
control in the UI can produce a capacity failure, which is what makes it the state
most likely to rot unnoticed.

Two behaviours worth knowing:

- **Out-of-range values are clamped, not rejected** — below 1 becomes 1, above
  the member count becomes the member count, matching Go
  (`cmd/launch_jobarray.go:576-582`). `--min-viable 200` on a 100-member array is
  an obvious "all of them", and failing the whole launch over an off-by-one would
  be worse. The CLI echoes the effective threshold, and says so when it clamped.
- **A non-numeric value is an error**, though. `Number("hlaf")` is `NaN`, which
  would land on the default of 1 and silently disable the cost guard the user
  explicitly asked for. A typo'd threshold fails loudly.
- **`--min-viable 1` (the default) is a no-op**, matching a plain Go array. Any
  single member makes the set viable.

### Sparse indexes

A threshold on its own would trade one wrong answer for another. "97 of 100
running" hides *which* three slices have no worker, and for indexed work that is
the only part that matters — index 43 having no worker means slice 43 of the
data is unprocessed, however healthy the aggregate looks.

So the summary also carries `missingIndexes`: every index with no member in a
live state. It follows Go's rule (`missingIndexes` / `retryIndexes`,
`cmd/arraygroup.go:100`, `:228`), whose live set is built from exactly the
`running` and `pending` EC2 states — so a **terminated** member's index counts as
missing too, not just one that never launched. Both are indexes with no live
worker, and anything relaunching or collecting results has to treat them alike.

One consequence to read correctly: **every index is missing on the first pump**,
because nothing has launched yet. That is truthful rather than alarming — read it
next to `pending` and `running`, not alone. The alternative, calling a pending
index "present", would report full coverage for an array that has launched
nothing, and this field exists to stop exactly that kind of optimistic reading.

## MPI: tags, deliberately

```
spawn array solver --count 8 --mpi --mpi-processes-per-node 4
```

This stamps `spawn:mpi-enabled=true` and `spawn:mpi-processes-per-node=4` on
every member, wire-identical to Go (`cmd/launch_single.go:704-706`). The effect
is that a spawn-ts-launched array is **recognisable** as an MPI job by the Go
CLI, by `spored`, and by the portal.

It does not orchestrate a collective launch, and that boundary is a design
decision rather than a shortfall.

**The upstream design is unresolved.** Go's `pkg/mpicohort` is a self-declared
spike. Its own header says it "does NOT yet replace launchJobArray; that's a
later stage", and states the problem it exists to surface:

> What this spike deliberately surfaces: cohort's Placement is PER-ENTITY, but
> an MPI cluster's placement group and EFA fabric are COLLECTIVE constraints.

That is the crux. A job array's members are independent, so a per-entity
placement model fits: each member can land wherever there is capacity, and
`--min-viable` is meaningful precisely because members are interchangeable. An
MPI cohort is the opposite — one rank's placement is not independent of another's,
because the ranks must share a placement group and an EFA fabric to communicate
at all. In cohort's model, `placesAsUnit()` is true only when
`MinViable == len(members)`: an all-or-nothing cohort, where a partial launch is
not a degraded success but a different, useless thing.

Porting a spike would commit spawn-ts to a shape Go is still deciding, and the
`spawn:*` tag contract is the thing both tools have to agree on. So spawn-ts
emits the tags — which are settled — and stops there.

**Two knobs are out of a browser's reach regardless.** Even with the design
settled, MPI orchestration needs:

- **EFA validation**, which must run *in the launch region* — an instance type's
  EFA support is a region-scoped fact, and validating against the wrong region
  gives a confidently wrong answer (Go's `ValidateInstanceTypeForEFAInRegion`).
  spawn-ts can't do this until truffle-ts carries region identity on its
  instance-type model (truffle-ts#33).
- **Placement groups**, which `--auto-placement-group` *creates* — a real AWS
  resource with its own lifecycle, and creating one is beyond what a launcher
  that only ever calls `RunInstances` should do from a page.

So MPI sits at tier C for tags and tier D for orchestration, in the
[tag-emit-vs-execution model](./integration.md#the-load-bearing-boundary-tag-emit-vs-execution).

### Absence is not a negative claim

A missing `spawn:mpi-enabled` tag means **"not declared"**, not "not MPI". A
Go-launched instance whose `spored` predates the tags reads identically to a
non-MPI one, so `spawn status` prints an MPI line only when the tag is present —
it never prints "mpi: no". Turning an unknown into a false negative would be
worse than saying nothing, and it's the same rule the
[plugin tags](./data-movement.md) follow.

For the same reason `spawn:mpi-enabled=false` is never written. Go reaches its
tag block only inside `if mpiEnabled`, so it has no notion of writing a false —
and an explicit "false" would invite a reader to treat MPI-ness as a field that
is always recorded. It isn't; like every `spawn:*` tag, it's best-effort.

## What's out of reach for arrays too

`spawn`'s array surface has three commands spawn-ts does not port, for the same
structural reason rather than three separate ones — each needs a shell on the
node or a persisted record of the array:

| command | why not |
|---|---|
| `array logs` | reads files on the instance; needs a node shell |
| `array collect` | gathers per-index results off the nodes into S3 |
| `array retry --failed` | needs the launch record, which lives on a filesystem |

The first two are tier D for the obvious reason. `retry` is the interesting one,
and Go's own help states the blocker better than an inference would:

> retry reads the local launch record spawn wrote at launch
> (`~/.config/spore/arrays/`), so it faithfully reuses the original AMI, subnet,
> security groups, user-data, TTL, and command — **none of which a surviving
> member's tags fully carry**.
>
> Note: retry must run from the machine that launched the array (that's where the
> launch record lives).

So even the Go tool can't reconstruct a retry from AWS state alone. spawn-ts knows
`missingIndexes` *while the tab is open*, but a browser has nowhere to put the
equivalent record, and the `spawn:job-array-*` tags on survivors describe who
**did** launch rather than what was asked for. Inferring the array's intent from
the members that came up is exactly the wrong direction.
