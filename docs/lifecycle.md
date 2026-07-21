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

## Why it's pure

Keeping the engine free of a clock and I/O means:

- **Testable** — feed a `now` and assert the decision (see
  `src/core/lifecycle.test.ts`).
- **Deterministic** — no flakiness from wall-clock timing.
- **Backend-agnostic** — the same function decides for the mock provider, real
  AWS, and a time-controlled substrate emulator.

`SpawnClient` owns the clock and the loop that calls `evaluate` each tick, then
applies the returned action via the provider and emits events.
