# The lifecycle engine

> New here? Start with the [concepts guide](./concepts.md) for the _why_ —
> TTL vs idle vs cost limit, why TTL always terminates, and the
> absolute-deadline invariant. This page is the precise reference.

`src/core/lifecycle.ts` is a faithful, **pure** port of the spore.host `spored`
monitor loop (`spawn/pkg/agent/agent.go` `checkAndAct`). Given an instance's
observed state at a moment `now`, it returns at most one action plus any
warnings. It has no clock and no I/O — the caller supplies `now` and the
activity signals.

## Priority order (load-bearing)

Rules are evaluated in this exact order; the first to fire wins:

1. **Completion signal** — the watched file appears → run the `on-complete`
   action (`exit` maps to `terminate`).
2. **TTL** — on expiry, **always terminate**. Never stop or hibernate. This is
   the unconditional cost backstop: a stopped instance still bills for EBS and
   runs no daemon to re-check its TTL. Invariant carried over from the Go tool.
3. **Cost limit** — terminate when accumulated compute cost ≥ the limit.
4. **Idle** — after the idle timeout, **stop** (default) or **hibernate** (with
   `hibernateOnIdle`). Idle never terminates: it must not destroy data.

Warnings (non-fatal) are emitted before an action fires:

- **TTL** and **idle**: once, when ≤ 5 minutes remain.
- **Cost**: once, at ≥ 90% of the budget.

## The absolute-deadline invariant

TTL uses an **absolute deadline** (`spawn:ttl-deadline`, RFC3339) anchored to the
original launch time — not a "launch + TTL recomputed from now". This means
stop/start cycles cannot extend an instance past its deadline. Accumulated cost
likewise uses total compute-seconds across the instance's life
(`spawn:compute-seconds`), so a repeatedly-resumed instance can't reset its cost
clock. Both mirror the Go tool's behavior.

### The extend floor: the one exception

Anchoring has a failure mode, and `extend` handles it explicitly. If an
instance's deadline has already passed — spored never started, or crashed, the
[orphan](../src/core/orphans.ts) case — then `old deadline + by` is a timestamp
**in the past**. Extending would report success and change nothing, and the
reaper would terminate the instance on its next pass. So `computeExtension`
applies a floor: the result is never earlier than `now + by` (matching Go's
`cmd/extend.go:126`).

The two rules compose — the floor is a lower bound on the anchored sum, not a
replacement for it. A live instance still gets `old + by`, so stop/start still
buys nothing. Only an already-overdue one is pulled forward, and both the library
(an `info` event) and the CLI (a `note:` line) say when that happened: the user
asked for one deadline and got another.

`extend` writes **both** `spawn:ttl-deadline` and `spawn:ttl`, recomputing the
latter from the launch anchor. The deadline tag is what the reaper and spored
read, but Go's `extend` and spored's deadline-synthesis path both read
`spawn:ttl`, and two TTL tags that disagree are a trap for whichever reads the
stale one.

### Why extend nudges the instance

spored evaluates TTL against an **in-memory** config that it re-reads from tags
only every ~5 monitor ticks (`pkg/agent/agent.go:378`). Between an `extend` and
that refresh it still holds the old deadline — so extending an instance that is
nearly (or already) due can lose the race and be terminated anyway.

So after writing the tags, `extend` asks spored to reload now. Go does this over
SSH (`triggerReload`); a browser has no private key, so spawn-ts uses
`ssm:SendCommand` with `AWS-RunShellScript` to run the same
`sudo spored reload` — the SSM endpoint is CORS-open, so no proxy is involved.
This needs **`ssm:SendCommand`** in addition to the EC2 permissions, and the
instance must be SSM-managed (SSM Agent running, `AmazonSSMManagedInstanceCore`
on its instance profile).

It's best-effort by design, and never fatal: the tag write is the durable,
authoritative part and has already succeeded. When the reload fails — or the
provider has no channel to the box at all — the result is a **stated gap** naming
the ~5-minute window and the manual `sudo spored reload`, never silence. A `Provider`
without `reloadAgent` is treated exactly like one whose reload failed.

## Telling the user what the engine is about to do

`evaluate` decides; **`src/core/notices.ts`** explains. `lifecycleProtection()`
renders the same tags the engine reads into a block naming who enforces the
deadline, when it falls, and the **worst-case compute cost** up to it — the
counterpart to `accumulatedCost()`, which reports only what has been spent so
far. A user deciding whether to worry needs the ceiling, not the running total.

Two honesty constraints, both inherited from Go's `lifecycleProtectionBlock`
(`cmd/status.go:149`) and both asserted in tests:

- The out-of-band reaper runs in the **infra** account and isn't authoritatively
  visible from the launch account, so it's described as a backstop *"if
  deployed"*. spawn-ts must not claim an enforcement it cannot confirm.
- A past-due deadline reads **"past due — terminates on next check"**, not a
  negative duration. The overdue instance is precisely the one whose state must
  be legible; see [the extend floor](#the-extend-floor-the-one-exception) for the
  other half of that case.

See [api.md](./api.md#status-notices) for the full set.

## Why it's pure

Keeping the engine free of a clock and I/O means:

- **Testable** — feed a `now` and assert the decision (see
  `src/core/lifecycle.test.ts`).
- **Deterministic** — no flakiness from wall-clock timing.
- **Backend-agnostic** — the same function decides for the mock provider, real
  AWS, and a time-controlled substrate emulator.

`SpawnClient` owns the clock and the loop that calls `evaluate` each tick, then
applies the returned action via the provider and emits events.
