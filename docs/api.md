# API reference — `SpawnClient`

`SpawnClient` is the public entry point. Import from the package root:

```ts
import { SpawnClient, MockProvider, EC2Provider } from "spawn-ts";
```

> **Generated reference:** this page is a hand-written tour of the API. For the
> full, always-in-sync reference generated from the source types, see the
> [**TypeDoc API reference**](https://spore-host.github.io/spawn-ts/api/) —
> every exported class, function, and type from `src/index.ts`. Regenerate it
> locally with `npm run docs` (output lands in `dist/api/`).

## Construction

```ts
new SpawnClient(options?: ClientOptions)
```

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `provider` | `Provider` | `new MockProvider()` | Compute backend. |
| `clock` | `"real" \| number` | `"real"` | A number is a sim-speed multiplier (`60` = 1 sim-minute/sec). Real providers are pinned to realtime. |
| `startMs` | `number` | fixed 2026-07-20 epoch | Sim clock start; fixed default keeps demos reproducible. |

## Lifecycle loop

```ts
client.startMonitor(intervalMs = 250);  // begin the monitor loop
client.stopMonitor();
await client.step(by);                   // advance sim clock by a duration + one tick
```

`step` accepts a Go-form duration string (`"4h"`) or milliseconds. Use it in
tests to fast-forward without wall time.

## Operations

```ts
await client.launch(input: LaunchInput): Promise<ManagedInstance>;
await client.refresh(): Promise<ManagedInstance[]>;
client.list(): ManagedInstance[];              // last refreshed snapshot
await client.get(nameOrId): Promise<ManagedInstance | null>;
await client.terminate(nameOrId, reason?);
await client.stop(nameOrId, reason?);
await client.start(nameOrId);
await client.hibernate(nameOrId);
await client.extend(nameOrId, by): Promise<number>;   // returns new deadline (ms)
                                                      // floored at now+by; nudges spored
await client.signalComplete(nameOrId);          // fire the completion action
```

`LaunchInput` accepts `name`, `instanceType`, `region`, `ami`, `keyPair`,
`spot`, `ttl`, `idleTimeout`, `hibernateOnIdle`, `idleCpuPercent`, `costLimit`,
`pricePerHour`, `onComplete`, `completionFile`, `completionDelay`, and
`allowUnbounded`. Durations are Go-form strings or ms.

> **Cost safety:** on a **real** backend, `launch` throws if _none_ of `ttl`,
> `idleTimeout` or `costLimit` is set, unless `allowUnbounded: true`. If the only
> bounds are `idleTimeout`/`costLimit` it launches but emits a `"warning"` event:
> those are enforced by spored **on** the instance, so they don't survive a failed
> bootstrap, and an instance with no TTL deadline is also skipped by orphan
> detection. Only `ttl` is enforced from outside the box. See
> [`evaluateBounds`](../src/core/bounds.ts). The mock backend never throws.

> **`extend`** adds the duration to the current deadline (so stop/start buys
> nothing), but never returns a deadline earlier than `now + by` — extending an
> already-expired instance would otherwise leave it still expired. It writes both
> `spawn:ttl-deadline` and `spawn:ttl`, and asks spored to reload via
> `ssm:SendCommand` (best-effort; a failure is reported, never thrown). See
> [lifecycle.md](./lifecycle.md#the-extend-floor-the-one-exception).

## Backend + clock

```ts
client.backend;              // { label, isReal }
client.activeProvider;       // the Provider (used to build a CLI ShellCtx)
client.now();                // current clock (ms)
client.setProvider(p);       // swap backends at runtime
client.setSpeed(multiplier); // sim speed (mock only)
```

## Events

```ts
const off = client.on((e: SpawnEvent) => { /* ... */ });
```

`SpawnEvent` is a discriminated union on `type`:

| `type` | Payload |
|--------|---------|
| `instances` | `{ instances: ManagedInstance[] }` — emitted on every refresh. |
| `launched` | `{ instance }` |
| `action` | `{ instance, action, rule, reason }` — a lifecycle action fired. |
| `warning` | `{ instance, rule, message }` |
| `info` | `{ instance, message }` |
| `provider` | `{ label, isReal }` — backend changed. |

## Example

```ts
const spawn = new SpawnClient({ clock: 60 });
spawn.on((e) => { if (e.type === "action") console.log(e.instance, e.reason); });
spawn.startMonitor();

await spawn.launch({ name: "job", ttl: "4h", onComplete: "terminate", pricePerHour: 0.153 });
// The monitor terminates it when the TTL expires, emitting an "action" event.
```
