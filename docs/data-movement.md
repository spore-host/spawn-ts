# Data movement and plugins from a browser

A job is useless without a way to get data in and out. This document covers the
two capabilities that make that possible without any locally installed software,
and the one place where the browser deliberately stops.

## The correction that made this possible

Globus **Transfer** is not Globus Connect **Personal**.

The `globus-personal-endpoint` plugin needs `globus whoami` on a laptop, and for a
while that fact was read as "Globus needs a local machine". It does not. That
plugin wraps Connect *Personal* specifically — the thing that turns a laptop into
an endpoint. The Transfer API moves data between **managed collections** (an HPC
DTN, an S3 collection, campus storage) over plain REST, and every endpoint is
CORS-enabled. Preflighted live from `Origin: https://spore.host`:

| endpoint | ACAO | allow-headers |
|---|---|---|
| `POST transfer.api.globus.org/v0.10/endpoint_search` | `*` | `authorization` |
| `GET  transfer.api.globus.org/v0.10/task_list` | `*` | `authorization` |
| `POST auth.globus.org/v2/oauth2/token` | `*` | `*` |

So a browser can search collections, submit a transfer and poll it to completion
with no local client and no proxy.

## Getting a Transfer token

We already sign in to Globus (`src/auth/globus.ts`, authorization-code + PKCE).
Globus issues **one access token per resource server** and returns the extras in
`other_tokens` — the same mechanism that already carries the OIDC `id_token`. So
requesting the Transfer scope yields a Transfer token from the *same* sign-in:

```ts
import { beginLogin, completeLogin } from "@spore-host/spawn-ts/auth";

await beginLogin({ clientId, redirectUri, requestTransfer: true });
// …redirect back…
const tokens = await completeLogin({ clientId, redirectUri });
tokens.idToken;        // → AWS STS (AssumeRoleWithWebIdentity), as before
tokens.transferToken;  // → the Transfer API
```

`requestTransfer` is **opt-in, not the default**. Putting `TRANSFER_SCOPE` into
`DEFAULT_SCOPE` would show every signing-in user a consent screen asking to manage
their transfers and read and write their files — including a user who only wants
to look at their instances. Consent is asked for when data movement is actually on
offer.

`transferToken` being `undefined` is a **normal outcome**, not an error: a user can
decline the Transfer consent and still sign in. Treat it as "data movement
unavailable", not as a failure.

## Moving data

```ts
import { transferClient } from "@spore-host/spawn-ts/transfer";

const gt = transferClient({ transferToken: tokens.transferToken! });

const [dtn] = await gt.searchCollections("ncsa#dtn");
const task = await gt.submitTransfer({
  sourceCollectionId: dtn.id,
  destinationCollectionId: s3Collection.id,
  label: "run-42 results",
  items: [{ sourcePath: "/scratch/run-42/", destinationPath: "/out/run-42/", recursive: true }],
});

const final = await gt.awaitTask(task.taskId, {
  onUpdate: (t) => console.log(t.status, t.filesTransferred, "/", t.filesTotal),
});
```

`fetch` is injected throughout (the convention `completeLogin` already uses), so
the whole client is unit-tested with no credentials and no network.

Four details in that client are deliberate:

- **`submitTransfer` fetches a `submission_id` first.** That extra round-trip is
  Globus's idempotency mechanism: a retried POST carrying the same
  `submission_id` is recognised as a duplicate. Skipping it lets a network retry
  move the data **twice**.
- **An empty `items` array is refused.** Globus accepts it and returns a task that
  succeeds having moved nothing, which reads to a user as a silent failure.
- **`verifyChecksum` defaults to `true`** (Globus's own default). Trading
  integrity for speed is not this layer's call.
- **An unrecognised task status maps to `ACTIVE`.** The direction of the guess
  matters: guessing `SUCCEEDED` would report a transfer complete that never ran,
  and guessing `FAILED` would invent a failure. `ACTIVE` only causes more polling.

### Task states

`INACTIVE` is **not terminal** — Globus resumes such a task once credentials are
refreshed — so only `SUCCEEDED` and `FAILED` end the poll (`isTerminal`). When a
task is stuck, `niceStatus` / `niceStatusDescription` carry the reason; a UI
showing only `INACTIVE` leaves the user with nothing to act on.

`awaitTask`'s timeout throws with the **last observed state** in the message and
says the transfer is still running at Globus. Giving up on watching is not the same
as the transfer stopping, and a bare "timed out" loses both facts.

### Errors

`GlobusTransferError` carries Globus's own `code`, not just the HTTP status,
because the code holds more information: `ClientError.NotFound`,
`PermissionDenied` and `ConsentRequired` are all 4xx and all need different
handling. `err.needsConsent` is the one that's **fixable by re-authenticating** —
the difference between a working "Grant access" button and a dead end.

An unparseable 200 raises `MalformedResponse` rather than returning an empty list:
a broken response must not be indistinguishable from "there is nothing here".

### The other direction: `mountpoint-s3`

The `mountpoint-s3` plugin mounts an S3 bucket as a filesystem on the instance,
and it is remote-only — pure user-data, no local half. Between Globus Transfer and
`mountpoint-s3`, data moves both ways with nothing installed locally.

## Plugins: two columns, not one

Go spawn has two plugin transports and only one needs a controller:

1. **`spawn plugin install`** on a running instance POSTs to
   `http://127.0.0.1:7777/v1/plugins/install` through an SSH tunnel. A browser has
   no SSH. Not portable.
2. **`spawn launch --plugin`** writes declarations to `/etc/spawn/plugins.json` in
   user-data, which spored reads at startup. Pure user-data — a browser can do
   this.

Detection, by contrast, is **universal**: every installed plugin leaves a
`spore:plugin:<name>` EC2 tag, and `DescribeInstances` already returns it. So the
matrix has two columns, and carrying only one of them would wrongly read as "no
plugin support in the browser":

| plugin | declare at launch | detect |
|---|---|---|
| cloudwatch-agent, code-server, docker, jupyterlab, mountpoint-s3, rstudio-server, vscode-tunnel | **yes** | yes |
| github-actions-runner, globus-personal-endpoint, rclone, tailscale | no | **yes** |
| spore-sync | no | **yes** |

**7 of 12 installable; 12 of 12 detectable.**

### Why the other five are refused rather than attempted

Four of them have a local half that **mints a secret and pushes it** to the
instance (a runner registration token, an auth key, an rclone config, Globus
credentials). The launch-time path has no controller to run that step, so those
plugins park at `StatusWaitingForPush` and are never resumed — and this is a
documented limitation of **Go's own** async path, not a browser gap
(`pkg/pluginruntime/runtime.go:62`). Accepting them would produce an instance with
a plugin stuck forever and nothing to explain why, which is worse than refusing.

`spore-sync` is the fifth and pushes nothing, but its local half is mutagen running
on the developer's own machine. That is legitimately the CLI's job and it stays
there.

`canDeclareAtLaunch` returns the **reason** alongside the boolean, and the reasons
are distinct on purpose: "needs a pushed secret", "belongs to the CLI", and "not a
known plugin" are three different problems, and only the last one might be a typo.

```ts
import { validateDeclarations } from "@spore-host/spawn-ts";

const { accepted, rejected } = validateDeclarations([{ ref: "jupyterlab" }, { ref: "tailscale" }]);
// accepted: [{ ref: "jupyterlab" }]
// rejected: [{ ref: "tailscale", reason: "…would park at waiting-for-push…" }]
```

`validateDeclarations` **returns** rejections rather than throwing, because the
reason is data a caller may want to render, aggregate, or partially act on.

### Declaring at launch

```ts
await client.launch({ name: "web", ttl: "4h", plugins: [{ ref: "jupyterlab" }] });
```

Passing a ref that can't be honoured makes `launch()` **throw, before any instance
exists** — and the CLI's `--plugin` (repeatable, matching Go's pflag StringArray)
refuses the same way:

```
$ spawn launch bad --ttl 4h --plugin tailscale --plugin nonesuch
launch: 2 plugins cannot be declared at launch — nothing was launched.
  "tailscale" cannot be declared at launch: its local half mints an auth key and pushes it, …
  "nonesuch" is not a known launch-declarable plugin. Declarable: cloudwatch-agent, …
```

This is deliberately stricter than Go, which writes any ref straight into
`/etc/spawn/plugins.json` and lets a push-dependent plugin park on the box — a
failure invisible from the launch side. At the point of refusal nothing has been
billed and the fix is a one-word edit, so refusing costs a retry while launching
costs an instance that can't do the job it was launched for.

The dashboard's launch form takes it one step further and offers a **checkbox per
declarable plugin**, so the offered set *is* the supported set and a rejection
can't be reached from the form at all. The five that aren't offered are named
underneath with the reason — an unexplained absence would read as an arbitrary
omission, and worse, as "the browser has no plugin support".

On success the output says **declared**, never *installed*:

```
  plugins declared: jupyterlab, mountpoint-s3
    installed by spored at boot; check 'status web' for what it reports
```

spored does the install at boot. Whether it succeeded is only knowable later, from
the `spore:plugin:*` tags below — so a launch message must not report an outcome
nobody has observed yet.

### Reading what's deployed

```ts
import { instancePlugins, describePluginState } from "@spore-host/spawn-ts";

const found = instancePlugins(instance);
// [{ name: "spore-sync", version: "v1.2", contentSha256: "abc123def456",
//    verify: "signature", parsed: true, raw: "…" }]
```

Three things `parsePluginTag` gets right, each a place where a simpler parser
would assert something the data doesn't support:

- **An absent or unparseable tag reads as "unknown", never "not installed".** The
  tag is written best-effort (`recordPluginProvenanceTag` returns early when the
  instance isn't EC2-resolvable and only warns on a tag-write failure), and it is
  never written at all for launch-time declarations. So absence genuinely means
  "we don't know" — hence `describePluginState([])` says so in words. An
  unparseable *value* still yields a record with `parsed: false`, because the
  tag's existence is itself the evidence that the plugin is deployed.
- **`verify=none` is distinct from a missing `verify=`.** The first says "the
  install ran and verification reached neither a signature nor a manifest" — a
  supply-chain finding. The second says "we can't tell". Collapsing them hides the
  first.
- **Unknown `key=value` pairs are preserved in `extra`.** The Go builder can grow
  fields, and a strict parser would silently lose provenance on newer instances.

Go's `shortHash` writes the literal string `"(none)"` for an empty digest. That's
a display placeholder, not a hash, so it is normalised to `undefined` — otherwise
a UI would render `sha256=(none)` and imply a digest was recorded.

`spawn status` renders all of it, and `--plugins` asks the question explicitly:

```
$ spawn status web
  plugins:      5 reported
    code-server: version v4.1, verify=manifest, channel=beta
    docker: version unknown, verify=unknown
      (deployed, but its tag carried no readable provenance)
      unrecognised in its tag: garbage-no-kv
    jupyterlab: version v1.2.0, verify=signature, sha256 abc123def456, commit 789abcdef012
    mountpoint-s3: version v0.4, verify=none
    spore-sync: version v0.9, verify=unknown

$ spawn status web --plugins        # when no tag is present
  plugins:      none reported
    No plugin provenance tags found. This does not mean no plugins are installed — …
```

Two rendering rules follow from the parser's honesty, and both are load-bearing:

- **With no tags, `status` says nothing at all** unless you pass `--plugins`.
  Silence makes no claim; the full caveat is three lines long and printing it
  under every status would train the reader to skip the block. Ask, and you get
  the caveat rather than a bare "none".
- **A bare unparseable token gets its own line**, not a slot in the comma list
  beside `verify=signature`. A `key=value` pair this parser predates *is*
  provenance and belongs inline; `garbage-no-kv` is not, and listing it inline
  read as though it had been decoded.

The dashboard applies the same rules to the instance card: a `plugins —` line
only when at least one tag is present, and three distinct styles so
`verify=none` (a finding), `verify=signature` (clean) and `verify=unknown` (no
data) can't be read alike. Plugins the browser could never install — `spore-sync`,
`tailscale` — appear there exactly like the rest, which is the whole point of the
second column.

## What still needs the CLI

- `spawn plugin install` on a running instance (SSH tunnel to the on-instance
  controller).
- The local half of `spore-sync`, `rclone`, `tailscale`, `github-actions-runner`,
  and `globus-personal-endpoint`.
- Globus Connect **Personal** as an endpoint — though note the browser *can*
  submit a transfer to a GCP collection; it will simply sit queued until the
  user's machine is on. `TransferCollection.isGlobusConnectPersonal` is surfaced
  so a UI can say that before the user waits an hour.

## Live checks

Both live paths are **manual and opt-in**, never CI:

- Globus Transfer moves real data between real collections. Not something a test
  run should trigger.
- Plugin declaration at launch requires a real instance; the gated smoke test
  (`docs/live-smoke.md`) is the place for it.
