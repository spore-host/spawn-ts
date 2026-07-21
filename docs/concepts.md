# Concepts: the cost-safety model

New to spawn? This is the "why" behind the lifecycle rules. If you want the
exact evaluation order and the code, read [the lifecycle engine](./lifecycle.md)
next — this page is the narrative that makes it make sense.

The whole point of spawn is simple: **a cloud instance you launch should not be
able to bill you forever.** Every managed instance carries, in its own tags, the
conditions under which it must wind itself down. Three independent mechanisms
enforce that, and it helps to know what each one is _for_ before you know how
they interact.

## Three ways an instance winds down

| Mechanism | Fires when… | Action | Destroys data? |
|-----------|-------------|--------|----------------|
| **TTL** | wall-clock deadline passes | **always terminate** | yes |
| **Cost limit** | accumulated spend ≥ budget | terminate | yes |
| **Idle** | no activity for the timeout | stop (or hibernate) | no |

They answer different questions:

- **TTL** — _"How long is this thing allowed to exist at all?"_ It's a hard
  backstop, not a guess about your workload. `ttl: "4h"` means "gone in four
  hours, no matter what."
- **Cost limit** — _"How much am I willing to spend on this?"_ Expressed in
  dollars. Useful when you care about the bill more than the wall-clock time.
- **Idle** — _"Stop paying for compute while I'm not using it, but keep my
  work."_ This is an optimization, not a safety net. It pauses; it never
  destroys.

You can set any combination. TTL and cost limit are the two that guarantee the
instance eventually ceases to bill you; idle just saves money in the meantime.

## Why TTL always **terminates** (never stops)

This is the single most important invariant, and the one newcomers trip on:

> **TTL expiry always terminates the instance. It never stops or hibernates
> it — even if you asked for hibernate-on-idle.**

The reasoning is about what "stopped" actually means on EC2:

1. **A stopped instance still costs money.** Its EBS volumes keep billing. So
   "stop on TTL" would not actually stop the bleed — it would just slow it,
   indefinitely.
2. **A stopped instance runs no daemon.** The lifecycle monitor (`spored`, or
   `SpawnClient`'s loop) runs _on the instance_ (or against it). A stopped
   instance can't re-check its own TTL, extend nothing, and clean up nothing. It
   would sit there, half-billing, with nothing left to ever act on it.

TTL is the _unconditional_ backstop — the one rule that must hold even when
everything else is misconfigured. A backstop that leaves a billable resource
running is not a backstop. So TTL terminates, full stop.

Idle is the opposite kind of rule: it's there to preserve your work while saving
money, so it must _not_ destroy data. That's why idle stops (or hibernates) and
TTL terminates. The table above isn't an arbitrary policy choice — each action
follows from what the mechanism is _for_.

## The absolute-deadline invariant

Here's the subtle part. When does the TTL clock start, and can it be reset?

When spawn launches an instance with `ttl: "4h"`, it writes **two** tags:

- `spawn:ttl` — the duration, `"4h"` (informational).
- `spawn:ttl-deadline` — an **absolute timestamp**: `launch time + 4h`, in
  RFC3339 (e.g. `2026-07-20T18:00:00Z`).

The deadline is the one that counts. And it is **computed once, at launch, and
never recomputed** — not on stop, not on start, not on wake from hibernate.

Why this matters:

> The deadline is anchored to when the instance was _first launched_, not to
> when it last started running.

Imagine it were otherwise — imagine each `start` reset the deadline to
`now + 4h`. Then an instance that idles, stops, and wakes repeatedly would keep
pushing its own deadline into the future and could live forever. That defeats
the entire purpose of a TTL. By anchoring to launch time, a stop/start cycle
_cannot_ buy the instance more life: when the original deadline passes, it
terminates, whether it's been running the whole time or just woke up.

The same principle protects the cost limit. Accumulated cost is derived from
`spawn:compute-seconds`, the **total** compute across the instance's entire
life — not just the current boot. Stopping and starting can't reset the cost
clock back to zero either.

Both invariants share one idea: **the safety limits are properties of the
instance's whole existence, not of its current run.** That's what makes them
trustworthy.

### Extending is explicit

You _can_ push the deadline out — but only deliberately, via
`client.extend(name, "2h")`. That rewrites `spawn:ttl-deadline` to a new
absolute timestamp. It's an explicit act with a clear audit trail in the tags,
not a side effect of the instance's normal running. The invariant is "the
deadline never moves _on its own_," not "the deadline can never move."

## Where this lives in the code

None of this is magic — it's a small, pure decision function you can read:

- **[`src/core/lifecycle.ts`](../src/core/lifecycle.ts)** — `evaluate()` checks
  the rules in priority order (completion → TTL → cost → idle) and returns at
  most one action. It's pure: you hand it the instance state and the current
  time, it hands back a decision.
- **[`src/core/tags.ts`](../src/core/tags.ts)** — `buildLaunchTags()` writes
  `spawn:ttl-deadline` as `launchTime + ttl` at launch, and `decodeConfigTags()`
  reads it back. This is the `spawn:*` tag contract, wire-compatible with the Go
  `spawn` tool.

Because the deadline lives in a tag on the instance itself, any monitor — the
browser client here, or a real `spored` on a real EC2 instance — reads the same
absolute deadline and reaches the same decision. The instance carries its own
expiry with it.

## See also

- [The lifecycle engine](./lifecycle.md) — the precise priority order, warnings,
  and why the engine is pure.
- [API reference](./api.md) — `SpawnClient`, including `launch`, `extend`, and
  the cost-safety guard that refuses an unbounded launch on a real backend.
