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
`pricePerHour`, `onComplete`, `completionFile`, `completionDelay`, `plugins`, and
`allowUnbounded`. Durations are Go-form strings or ms.

> **`plugins`** carries `PluginDeclaration[]` into user-data as
> `/etc/spawn/plugins.json`, which spored reads at boot. Only the seven remote-only
> plugins can be declared this way; anything else makes `launch` **throw before an
> instance exists**, naming every rejected ref and why. See
> [data-movement.md](./data-movement.md#plugins-two-columns-not-one).

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

## Status notices

The four tag-derived blocks Go's `spawn status` appends
(`cmd/status.go:130-134`). Everything else on a status view reports what you
*configured*; these report what you should *know*.

```ts
import { statusNotices, dnsNotice, lifecycleProtection, sporedUpgrade,
         elasticIpNotice, compareSemver } from "@spore-host/spawn-ts";

statusNotices(inst, nowMs, { eip?, latestSporedVersion? }): Notice[];
// Notice = { kind, level: "info" | "warn", text, detail?: string[] }
```

Pure and SDK-free, so the CLI, the dashboard and the portal render one source
three ways. The Elastic IP *lookup* needs `ec2:DescribeAddresses` and is
therefore separate — `lookupElasticIp(instanceId, opts)` from
[`src/aws/eip.ts`](../src/aws/eip.ts) — while `elasticIpNotice` itself is pure
and takes the result.

| notice | says | source |
|---|---|---|
| `lifecycle-protection` | who enforces the deadline, the deadline, and the **worst-case compute cost** to it | tags |
| `dns` | registration **failed**, with spored's own reason | `spawn:dns-status` + `spawn:dns-error` |
| `elastic-ip` | an EIP is still billing on a **stopped** instance (~$3.60/mo), and the release command | `DescribeAddresses` |
| `spored-upgrade` | the running spored is older than the newest release | `spawn:spored-version` |

> **Absence is never smoothed into reassurance.** Each notice has an input it
> can't do without, and when that input is missing the notice is *omitted*, not
> answered optimistically:
>
> - no `spawn:dns-status` → no notice. It does **not** mean registration
>   succeeded; an older spored simply never wrote the tag.
> - no `latestSporedVersion` → no notice. It does **not** mean spored is current.
>   The value is passed in rather than fetched, because Go's release check hits
>   the GitHub API and that's the embedder's call to make.
> - no `eip` lookup → no notice; a lookup that **fails** is its own `warn`
>   notice naming the error. This is a deliberate divergence from Go's
>   `GetInstanceElasticIP` (`pkg/aws/cleanup.go:219`), which returns `nil, nil`
>   on any API error — making a missing `ec2:DescribeAddresses` permission
>   indistinguishable from a clean bill of health, in the one check whose whole
>   job is catching an unnoticed charge.
>
> The cost ceiling keeps its **"compute only"** label: it excludes EBS and
> network, so presenting it as a total would understate the bill. It's skipped
> entirely when the instance has no recorded price, rather than shown as `$0.00`.

Not ported: the remote `spored status` output these notices are appended *to*
(needs a shell on the box), and Go's fallback of parsing the spored version out
of that output. `compareSemver` is exported and matches `libs/update`'s
comparison exactly, so the two tools never disagree about whether an upgrade
exists.

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
