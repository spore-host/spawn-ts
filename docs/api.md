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
| `lifecycle` | `"observe" \| "simulate"` | `"simulate"` for a `MockProvider`, `"observe"` otherwise | What the monitor loop does with a lifecycle decision. `"simulate"` throws on a non-mock provider. |

## Lifecycle loop

```ts
client.startMonitor(intervalMs = 250);  // begin the monitor loop
client.stopMonitor();
await client.step(by);                   // advance sim clock by a duration + one tick
```

`step` accepts a Go-form duration string (`"4h"`) or milliseconds. Use it in
tests to fast-forward without wall time.

**On EC2 (and substrate) the loop only observes** (`client.lifecycleMode ===
"observe"`): it refreshes the list, emits TTL and cost warnings, and advances
sweeps, queues and job arrays this client started. It never stops, hibernates
or terminates an instance on a lifecycle rule. spored on the instance and the
out-of-band reaper enforce lifetimes; a browser has no activity signal for idle,
and an enforcer that only runs while a tab is open is a second, weaker one
(#126). The lifecycle engine runs and acts only over a `MockProvider`, where the
sim clock is the activity signal.

## Operations

```ts
await client.launch(input: LaunchInput): Promise<ManagedInstance>;
await client.refresh(): Promise<ManagedInstance[]>;
client.list(): ManagedInstance[];              // last refreshed snapshot
await client.get(nameOrId): Promise<ManagedInstance | null>;   // read-only
await client.terminate(instanceId, reason?);
await client.stop(instanceId, reason?);
await client.start(instanceId);
await client.hibernate(instanceId);
await client.extend(instanceId, by): Promise<number>; // returns new deadline (ms)
                                                      // floored at now+by; nudges spored
await client.signalComplete(instanceId);        // mock only: fire the completion action
```

**Every method that changes an instance takes its instance id** and rejects a
Name (#128). A Name is a label, not an identity: a relaunch, a reused CLI name
or another user's instance can share it, and acting on "the first instance
called `test`" terminated a dead `test` while the live one kept billing.
`get(nameOrId)` still reads by Name, resolved as Go's `resolveInstance` does:
live instances only, case-insensitive, a single running match wins a tie, and a
Name that is still ambiguous throws `AmbiguousNameError` with the candidate ids.

`signalComplete` throws on anything but a simulated provider: on EC2, spored
runs the on-complete action when the completion file appears.

### Errors and list state (#125)

Every operation above rejects with a **`SpawnError`**:

| Field | Meaning |
|-------|---------|
| `operation` | `"list"`, `"launch"`, `"stop"`, `"start"`, `"hibernate"`, `"terminate"`, `"extend"`, `"signalComplete"` or `"monitor"` |
| `instanceId` | the instance acted on, when there was one |
| `code` | the AWS error code (`UnauthorizedOperation`, `IncorrectInstanceState`, `UnsupportedHibernationConfiguration`, `ExpiredToken`, …) when `aws` is true; otherwise spawn-ts's own (`InvalidInstanceId`, `InstanceNotFound`, `AmbiguousName`, `NotSimulated`, `NoTtl`, `InvalidDuration`, `LaunchRefused`, `NetworkError`, `Unknown`) |
| `aws` | whether `code` came from AWS |
| `httpStatus`, `requestId` | from the AWS response, for support |
| `cause` | the original error; `message` is unchanged from it |

An action resolves only when its provider call succeeded. The refresh after it
does not turn that success into a failure; a failed refresh is reported instead.

**`refresh()` rejects when the list can't be read, and never resolves to an
empty list for a failed `DescribeInstances`.** `EC2Provider.list` reads every
page. `client.listState` is `{ status: "loading" | "ok" | "error", instances,
checkedAtMs?, error? }`. On `"error"`, `instances` is the last list that loaded
(or empty if none did), so a UI can say "couldn't check" instead of "you have no
instances". `list()` returns the same last good list.

A failure nobody awaited (a monitor tick, a post-action refresh) is emitted as an
`{ type: "error", error: SpawnError }` event, never as an unhandled rejection.
`describeSpawnError(e)` gives one plain sentence naming the action, which is what
the Dashboard shows.

`LaunchInput` accepts `name`, `instanceType`, `region`, `ami`, `keyPair`,
`spot`, `ttl`, `idleTimeout`, `hibernateOnIdle`, `idleCpuPercent`, `costLimit`,
`pricePerHour`, `onComplete`, `completionFile`, `completionDelay`, `plugins`,
`allowUnbounded` and `clientToken`. Durations are Go-form strings or ms.

> **`clientToken`** is the launch intent's RunInstances idempotency token
> (spore-host#673). Mint one per thing the user means to launch with
> `newLaunchToken()` and pass the same one on every attempt at it: concurrent
> `launch()` calls with one token share a single request, and EC2 returns the
> instance a settled earlier attempt created instead of launching another. Mint
> a new one when the user changes what they're launching, and after a failure
> that `isAmbiguousLaunchError(err)` says was definite (a 4xx left nothing
> behind; a created-then-terminated instance is what the old token would
> return). Keep it after an ambiguous one (network, 5xx), so the retry finds
> the instance if it exists. Absent: a fresh token per call, as Go does.

### What a real launch picks (Go parity, #129)

`EC2Provider` chooses as Go's `GetRecommendedAMI` does (`pkg/aws/ami.go`). The
choices are pinned by vectors rendered from spawn v0.150.0
(`src/aws/testdata/launch-parity.go.json`).

| | spawn-ts | Go source |
|---|---|---|
| Architecture | EC2 `DescribeInstanceTypes`; offline fallback `archForInstanceType`. trn/inf are **x86_64** | `resolveArchitecture`, `DetectArchitecture` |
| NVIDIA GPU types (`isNvidiaGpuInstance`, Go's exact family set) | the DLAMI "Base OSS Nvidia Driver GPU AMI (Amazon Linux 2023)" via Go's SSM parameter (`GPU_AMI_PARAMETERS`); failure refuses the launch | `DetectGPUInstance`, `GetAL2023AMI` |
| Everything else, Trainium and Inferentia included | Amazon Linux 2023 for the architecture (DescribeImages, kernel 6.1). Go gives Neuron the CPU image too; pass `ami` for the Neuron DLAMI | `GetAL2023AMI` |
| `hibernateOnIdle` or `onComplete: "hibernate"` | refused unless EC2 says the type hibernates; then `HibernationOptions.Configured` and an encrypted gp3 root on the AMI's root device, RAM + 10 GiB, never below the AMI's snapshot | `HibernationRequested`, `prepareHibernation`, `buildBlockDevices`, launch preflight |
| Spot whose lifecycle stops or hibernates | refused (spawn-ts makes one-time requests only; Go makes these persistent) | `NeedsStoppable` |
| `ClientToken` | the caller's, else `spawn-ts-<uuid>` | `launchAcrossZones` |

The extra permissions this needs are `ec2:DescribeInstanceTypes` (every launch,
best-effort) and `ssm:GetParameter` on
`arn:aws:ssm:*::parameter/aws/service/deeplearning/ami/*` (GPU launches only).

`stop` and `hibernate` refuse, before any call, what EC2 would refuse:
- an instance that isn't running (`NotRunning`);
- a one-time Spot instance (`OneTimeSpot`, Go's `oneTimeSpotStopError`);
- for hibernate, an instance whose `hibernationConfigured` is false (`NotHibernatable`).

`stopBlocker(inst, action)` exposes the same check, so a UI can hide the button.

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
