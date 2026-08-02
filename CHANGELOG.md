# Changelog

All notable changes to **spawn-ts** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**spawn-ts stays on `0.x.y` indefinitely.** There is no planned 1.0.0, so
breaking changes bump the MINOR version — permanently, not as a pre-release
convention. Read a MINOR bump as "may break you" for the life of the project.

Its version line is **its own**, and deliberately not the Go tool's: at time of
writing spawn-ts is 0.6.x against Go `spawn` v0.97.x, and matching those numbers
would assert a feature correspondence that does not exist. Parity with Go is a
**behavioural** claim with documented divergences, tracked in
[#57](https://github.com/spore-host/spawn-ts/issues/57) — never a claim that two
version strings agree.

## [Unreleased]

### Added
- **`npm run check:imports`** (#70) — imports every code subpath from the built
  `dist/` under plain Node, because the existing `check:exports` proves a file
  *exists* and existence is weaker than importability. `./terminal` shipped in both
  0.6.0 and 0.7.0 present-but-unimportable, and the guard reported "all 19 targets
  present" for a subpath no non-bundler consumer could load. Found by installing the
  published 0.7.0 tarball and importing all nine subpaths — not by any check in the
  repo, which is the point.
  - Bundler-only subpaths are **declared with a reason** rather than skipped, and
    the check fails in *both* directions: an undeclared subpath that stops importing,
    and a declared one that starts working (a stale restriction still documented to
    consumers is its own bug). Both were verified to fail.
  - `./terminal` is declared bundler-only. The reason is mostly upstream:
    `@xterm/xterm` publishes no `exports` field, so Node resolves its CJS `main` and
    ignores the ESM `module` build, and the two disagree on shape — `xterm.mjs` has
    no default export while Node's CJS view exposes `Terminal` only under `default`,
    so no single import form satisfies both. Dropping the module's xterm CSS import
    was tried and reverted: it breaks styling for every current (bundled) consumer
    while the CJS problem keeps the subpath bundler-only regardless.
- **A README entry-point table** — all ten subpaths, what each holds, and which work
  under plain Node, with `./ssm` named as the xterm-free alternative to `./terminal`.
  The README also still advertised the pre-library `"spawn-ts"` import name.

### Changed
- **`LIB_VERSION` is exported from the package root** (#70). It is stamped into
  `spawn:version` on every launch, but was readable only from the tag on an
  already-launched instance — so a consumer could not report which library version
  it was running until after it had launched something.
- `repository.url` is `git+https://…`, the form npm was silently normalising it to
  on every publish (so published metadata no longer differs from the repo's).

## [0.7.0] — 2026-08-01

The Go-parity audit ([#57](https://github.com/spore-host/spawn-ts/issues/57)),
plus browser-native data movement. Six per-command gaps were filed and closed;
**two of the six were cost-safety bugs rather than missing features** (#54, #55),
which is what a per-command judgement surfaces and a line-count comparison never
would. MINOR, not PATCH: `launch` now *refuses* a spec it previously accepted
(#51), and the unbounded-launch guard changed which options satisfy it (#55).

### Added
- **`--min-viable` for job arrays** (#52) — a threshold on the *set*, which is a
  different thing from `onFailure`. `onFailure` decides whether to keep
  *launching*; `stop` leaves the members that already came up **running**, so a
  100-member array that reaches 2-of-100 is two instances billing indefinitely for
  a job that cannot be done. `--min-viable N` states the count below which the
  whole array is pointless, and spawn-ts then does what Go's `cohort.Reconciler`
  does for the stated reason *"Drain surviving instances so nothing idles and
  bills"*:
  - **Fast-fail** — the moment the threshold becomes unreachable, the unstarted
    members are skipped rather than launched. Without this, an array with
    `--min-viable 50` that lost 51 members would still launch the other 49.
  - **Drain** — `JobArray.enforceViability()` terminates the survivors, and
    `SpawnClient.pumpFanOuts` calls it on every tick, so the wind-down needs no
    caller action. It emits an `action`/`terminate` event with `rule: "min-viable"`;
    a survivor that could *not* be terminated emits a **warning** instead of being
    swallowed, because that is exactly the case where money keeps being spent.
    Each survivor is reported exactly once, including when two pumps overlap
    (`startJobArray` kicks one without awaiting it) — one instance, one event, not
    two that read as two instances wound down. A *failed* terminate stays
    retryable.
  - The gate is a **monotone latch** (skipping raises the lost count, which keeps
    it non-viable), and `nonViable: false` means "not yet ruled out" — never
    "confirmed viable". `completed` counts toward viability, or a fully successful
    array would turn non-viable as it drained.
  - The value is **clamped** to `[1, size]` as Go clamps it, since `--min-viable
    200` on a 100-member array is an obviously-intended "all of them". A
    *malformed* value is rejected by the CLI rather than clamped: `Number("hlaf")`
    would land on the no-op `1` and silently disable the guard.
  - `FanOutSummary` gains `minViable`/`viableCandidates`/`nonViable`/
    `missingIndexes`. The last is the sparse-index view Go's `missingIndexes`
    provides: "97 of 100 running" hides *which* three slices have no worker, and a
    terminated member's index counts as missing too.
  - The **dashboard card** states the threshold, and when the array goes
    non-viable it says so in red with what follows ("survivors are being
    terminated") and its state chip reads **non-viable** rather than the green
    `done`. Without that a user watches running members disappear with no reason
    given, and an array that was torn down looks like one that succeeded.
    `minviable.harness.html` reaches that state — it needs capacity failures, which
    no control in the UI can produce, so it is the state most likely to be left
    broken.
  - Lives in `FanOut` (report) + `JobArray` (enforce) because `FanOut` owns no
    lifecycle authority — every other state change it makes is a launch, and a
    shared engine that silently terminated instances would surprise the sweep and
    queue callers.
- **MPI declaration tags for arrays** (#52) — `--mpi` and
  `--mpi-processes-per-node N` stamp `spawn:mpi-enabled` /
  `spawn:mpi-processes-per-node` on every member, decoded onto
  `ManagedInstance.mpi` and shown in `spawn status`, so a spawn-ts-launched array
  is *recognisable* as an MPI job by the Go CLI and the portal.
  This is the tag half **only**, and that boundary is deliberate rather than
  unfinished: Go's `pkg/mpicohort` is a self-declared spike whose header states the
  unresolved problem — cohort's `Placement` is per-entity while a placement group
  and an EFA fabric are *collective* constraints. Porting a spike would commit
  spawn-ts to a shape Go is still deciding. EFA validation must run in the launch
  region (blocked on truffle-ts#33) and `--auto-placement-group` creates a real AWS
  resource. Absence stays absence: no `mpi-enabled=false` is ever written and
  `status` never prints "mpi: no".
- **`docs/execution-shapes.md`** — the three shapes (single node / job array /
  MPI), what `--min-viable` guarantees, sparse indexes, and an explicit out-of-reach
  table for `logs`/`collect`/`retry --failed` quoting Go's own reason (a local
  launch record under `~/.config/spore/arrays/` that "must run from the machine
  that launched the array").
- **Browser-native Globus Transfer** (#53, new `./transfer` subpath) — data
  movement in and out of launched instances with no local machine and nothing
  installed. Globus **Transfer** is not Globus Connect **Personal**: it moves data
  between *managed* collections (an HPC DTN, an S3 collection) over REST, and every
  endpoint is CORS-enabled. `transferClient()` covers `endpoint_search`,
  `submit_transfer`, `task`/`task_list`, cancel, and an `awaitTask` polling loop —
  all over an injected `fetch`, so it is unit-tested with no credentials.
  - `submitTransfer` fetches a `submission_id` first: that is Globus's idempotency
    mechanism, and skipping it lets a network retry move the data twice.
  - An empty item list is refused — Globus would accept it and return a task that
    succeeds having moved nothing, which reads as a silent failure.
  - `GlobusTransferError` carries Globus's own `code`, and `needsConsent`
    separates a fixable missing consent from a flat permission denial (both 403).
  - `INACTIVE` is not terminal, and `niceStatus` is surfaced so a stuck task says
    *why*.
- **The Globus Transfer scope, opt-in** — `GlobusConfig.requestTransfer` adds
  `TRANSFER_SCOPE` and `completeLogin` returns `GlobusTokens.transferToken` from
  the *same* sign-in (Globus issues one token per resource server). Deliberately
  **not** in `DEFAULT_SCOPE`: that would show every signing-in user a consent
  screen about managing their transfers and reading their files, including users
  who only want to see their instances. An absent `transferToken` is a normal
  outcome, not an error.
- **Plugin detection and launch-time declaration** (#53). Two columns, not one:
  the browser can **declare 7 of 12** plugins at launch and **detect all 12**.
  - `parsePluginTag` / `detectPlugins` / `instancePlugins` decode the
    `spore:plugin:<name>` provenance tag. An absent or unparseable tag reads as
    "unknown", never "not installed"; `verify=none` stays distinct from a missing
    `verify=`; unknown `key=value` pairs are preserved rather than dropped.
    Go's `"(none)"` digest placeholder is normalised away.
  - `LaunchSpec.plugins` writes `/etc/spawn/plugins.json` in user-data, which
    spored reads at startup — byte-compatible with Go's `plugin.Declaration`.
    Written *before* spored starts, unlike the Go bootstrap, which appends it
    after `systemctl start spored`; spored reads the file once at startup, so that
    ordering is a race.
  - `canDeclareAtLaunch` / `validateDeclarations` refuse the other five **with
    distinct reasons**. Four need a locally-minted secret pushed to the instance
    and would park at `StatusWaitingForPush` — a limitation of Go's own async path
    (`pkg/pluginruntime/runtime.go:62`), not a browser gap. `spore-sync`'s local
    half is mutagen on the developer's machine and stays the CLI's job.
    Rejections are returned, not thrown, so a caller can launch with what works
    and still say what was dropped.
  - See `docs/data-movement.md`.
- **The four tag-derived `status` notices** (#56), as pure `src/core/notices.ts`
  returning structured `{ kind, level, text, detail }` so the CLI, dashboard and
  portal render one source three ways. `spawn status` previously answered "what did
  you configure" and nothing else. The headline gap: spored writes
  `spawn:dns-status` + `spawn:dns-error` when registration fails, specifically so
  the failure isn't buried in the instance's journal (spawn#435) — and nothing read
  them, so a portal user got an FQDN that never resolved and no explanation, while
  the diagnostic sat in a tag `DescribeInstances` had already returned.
  - `lifecycleProtection()` — who enforces the deadline, when it falls, and the
    worst-case *compute* cost to it. The counterpart to `accumulatedCost()`, which
    reports only what's been spent; the ceiling is the number that says whether to
    worry.
  - `dnsNotice()` — the failure, with spored's own recorded reason.
  - `sporedUpgrade()` + `compareSemver()` — a port of `libs/update`'s comparison,
    so the two tools never disagree about whether an upgrade exists.
  - `elasticIpNotice()` — an EIP on a *stopped* instance keeps billing (~$3.60/mo)
    precisely because nothing is using it, which is exactly when the user believes
    they've stopped paying.
  - Absence is never smoothed into reassurance: no `dns-status` tag does not mean
    "registered", and no supplied latest version does not mean "up to date".

### Changed
- **`launch` now refuses a spec whose identity can't be resolved** (#51) —
  `buildLaunchTags` takes an optional `LaunchIdentity` and stamps the base-identity
  block Go writes (root, created-by, version, account-id, account-base36,
  **iam-user**, account-name, plus `os` and `local-username`). This was the audit's
  load-bearing find: a spawn-ts launch was visible in `spawn list` yet invisible
  **and unterminatable** in the portal, which filters its list, lookup and terminate
  on `spawn:iam-user` (the last 403s on a mismatch) while `spawn list` filters on
  `spawn:managed` alone. The divergence therefore surfaced only when someone tried
  to clean up — by which time the instance had been billing the whole time.
  - Identity arrives as **data**, so the tag builder stays pure; `EC2Provider`
    resolves it once via `GetCallerIdentity` and caches it, or takes it from the
    caller (the federated BYOA path already has the ARN and account id back from
    `AssumeRoleWithWebIdentity`).
  - Refusing to launch is deliberate, including for the 200-with-empty-fields case
    a bare try/catch would sail past: omitting the tag and launching anyway produces
    an orphaned billable instance nobody can terminate from the portal — strictly
    worse than a failed launch.
  - `local-username` is resolved once and used for **both** the tag and user-data.
    They must agree or `spawn connect` SSHes to a user that doesn't exist, so a
    custom username with no tag silently sent it to `ec2-user`.
  - Also stamps `spawn:active-ports`.

### Fixed
- **The unbounded-launch guard was inverted** (#55) — it accepted the weakest of
  the three bounds and refused a stronger one:

  | bound | Go accepts | spawn-ts accepted |
  |---|---|---|
  | `--ttl` | yes | yes |
  | `--idle-timeout` | **yes** | **no** |
  | `--cost-limit` | no | **yes** |

  `costLimit` is a **soft** limit — spored polls accumulated compute-seconds
  against `spawn:cost-limit`, so if spored never starts (failed bootstrap, wrong
  instance profile, crash-loop) nothing enforces it. Only the TTL is enforced from
  *outside* the box, by the ttl-reaper Lambda reading `spawn:ttl-deadline` without
  the instance's cooperation. Worse, `findOrphans` skips any instance whose deadline
  is 0, so a cost-limit-only instance was invisible to orphan detection too: the
  guard was waving through exactly the launches nothing downstream can catch, and
  saying nothing while it did. New pure `src/core/bounds.ts` holds one predicate
  carrying the enforcement distinction (external vs on-instance) that was the
  missing type. `idleTimeout` now counts; `costLimit` alone still permits the launch
  — refusing it would be a new, harsher divergence from Go — but warns, naming the
  consequence and the orphan-detection blind spot. Both launch paths share it.
- **`extend` could hand back a deadline in the past** (#54). It added the duration
  to the existing deadline with no floor, so extending an instance already overdue
  produced a deadline still behind `now` — reported as success, then reaped on the
  ttl-reaper's next pass. It failed precisely when it mattered most: the instance
  you are trying to rescue is by definition the overdue one. As with #55 the bug
  existed **twice** — `SpawnClient.extend` and the CLI's `extend` each had their own
  copy of the arithmetic and the same three defects — so the fix is one shared pure
  `computeExtension`, placed next to `ttlDeadline`, the rule it has to agree with.
  - **The floor**: `max(old + by, now + by)`. The two rules compose — a live
    instance still gets `old + by`, so stop/start still buys nothing; only an
    overdue one is pulled forward. Both paths say when the floor engaged, because
    the user asked for one deadline and got another.
  - **Both TTL tags**: `spawn:ttl` is recomputed from the launch anchor alongside
    `spawn:ttl-deadline`. Two TTL tags that disagree are a trap for whichever
    enforcer reads the stale one. With no usable anchor the tag is omitted rather
    than guessed.
  - Nudges spored to reload rather than waiting for its next poll.
- **Expired federated credentials in the direct demo** (#50) — Globus→STS sessions
  are capped at 1 hour, and a tab left open past that failed at the next action with
  a raw `Request has expired`, which says nothing about what to do. The expiration
  was already on `AwsCreds`; nothing read it. The demo now mirrors the portal's
  `SessionController` shape (two surfaces shouldn't invent two models): a session
  clock, an amber warning 5 minutes out so an in-flight launch isn't started against
  lapsing creds, and at expiry a red banner offering re-sign-in with launch/terminal
  disabled, the monitor loop stopped and any SSM terminal torn down. Checked at the
  moment of each click, not only on the timer — a laptop asleep past the deadline
  doesn't fire timeouts on schedule. The loop stops with a note that the instance
  still self-terminates on its TTL, which is the reassuring part: spored owns the
  deadline, not the tab.
- **Two stale claims in `docs/integration.md`** (#58) that changed which features
  read as portable. The "live AWS data needs credentials a browser can't safely hold
  and hits CORS" paragraph was false on both counts — `ec2` / `api.pricing` /
  `servicequotas` each return `access-control-allow-origin: *` when preflighted from
  `Origin: https://spore.host`, and `credsFromIdToken` already puts short-lived STS
  credentials in the tab. `BundledFinder` stays the default for cost and latency,
  which is the real reason. And "wire-compatible" read as complete when Go stamps 55
  launch tags to spawn-ts's 33; the gap is now named in the same tier language as
  the rest of the section.
- **The SSM session tests no longer race a fixed sleep** (#61). Four assertions
  waited `setTimeout(r, 5)` for an async chain — WebCrypto digests, then
  `markReady`'s un-awaited `flushPending` — whose duration is a property of the
  machine, not of the code. 5 ms was enough idle and not enough alongside 29 other
  test files in parallel CI workers. Each now waits on the condition it is actually
  about (`ready`, a flushed `Output` frame, `onClose` having fired) via a shared
  `waitFor(pred, describe)` poll with a 2 s ceiling, so the test's *duration* tracks
  the machine while its *verdict* tracks only correctness. This mattered more than
  an ordinary flake because the flakiest assertion is the one covering **input
  being queued rather than dropped** — the terminal's core correctness property, and
  a test everyone learns to re-run is exactly how a real regression in the flush
  path gets waved through. Verified by slowing the flush path to 25 ms: the old
  sleeps fail, the waits pass; and by four mutations of `session.ts`, each still
  caught.

## [0.6.1] — 2026-07-25

Documented retroactively: 0.6.0 and 0.6.1 were published to npm without CHANGELOG
sections, and 0.6.0 was never tagged. `docs/releasing.md` now makes that
impossible to repeat.

### Fixed
- **The Dashboard CSS is shipped in the package** (#49). `dashboard.css` was not
  emitted into `dist/`, so `@spore-host/spawn-ts/ui/style.css` 404'd for every
  consumer and the portal rendered an unstyled dashboard. Added
  `scripts/copy-css.mjs` to the library build.

## [0.6.0] — 2026-07-25

First release as a **published library**. Documented retroactively (see 0.6.1).

### Changed
- **BREAKING: library-ized as `@spore-host/spawn-ts`** (#48) — scoped package name,
  `private` dropped, and subpath `exports` for `.` `./auth` `./ssm` `./terminal`
  `./quotas` `./dns` `./portal` `./ui`. `demo/lib/*` was promoted to `src/` (via
  `git mv`, so history follows), making the library the primary artifact and the demo
  a consumer of it. Mirrors truffle-ts's layout deliberately.
- **`@spore-host/truffle-ts` is now an npm dependency** (`^0.4.0`) instead of a git
  URL (#28). The three CI/Pages `git@github`→HTTPS rewrite steps are removed —
  `npm ci` resolves it from the registry like any other package.

### Added
- **npm Trusted Publishing** — `publish.yml` publishes on a `v*` tag, authorized by
  GitHub OIDC scoped to this repo + workflow. No `NPM_TOKEN` exists, so there is
  nothing to rotate or leak; provenance is attached automatically. The workflow
  asserts the tag matches `package.json` and that every declared subpath emitted its
  `.d.ts`.
- **Cross-account launch for the live smoke test** (#38) — the real-aws tier can
  now role-chain from the OIDC identity-anchor account into a separate compute
  account, so the ephemeral instance launches there rather than in the anchor
  account. Set `LIVE_SMOKE_LAUNCH_ROLE_ARN` to a launch role in the compute
  account (trusting the anchor role) and the workflow hops into it after OIDC;
  leave it unset for a single-account launch. This is the control-plane/
  compute-plane split — a small-scale rehearsal of the bring-your-own-account
  model. See `docs/live-smoke.md`.
- **No-paste BYOA sign-in via Globus Auth** (#46, #47) — authorization-code + PKCE
  to an OIDC→STS exchange, so a user reaches their own account without pasting an
  access key. Plus a web SSM terminal for both demos (#44) — no SSH, no proxy — and
  a quotas panel and Globus IdP picker.
- **Both BYOA demos** (#42) — `demo/direct` (credentials in the tab) and the portal
  demo (federated session).

### Fixed
- **`spawn:dns-name` is emitted so spored registers DNS** (#45, spawn#435).

## [0.5.0] — 2026-07-22

### Added
- **Live smoke test** (`workflow_dispatch`, #27) — a manual regression guard for
  the self-termination guarantee (which silently regressed once, #19). Two tiers:
  a **substrate** tier (default, zero-credential) that boots the emulator and runs
  the `EC2Provider` integration tests with `SUBSTRATE_REQUIRED=1` so a failed-boot
  can't masquerade as green; and an opt-in **real-aws** tier that launches one
  t4g.nano via GitHub OIDC (no stored keys), observes spored self-terminate on
  its TTL, and leak-checks. Never runs on push/PR. See `docs/live-smoke.md`.
- **Optional spored signature verification** (#26) — an `EC2Provider`
  `sporedSigningPublicKey` (PEM) makes the bootstrap verify the downloaded
  `spored`'s detached signature (`openssl`, fail-closed) against a launcher-held
  key before install, proving authenticity — not just the SHA256 checksum
  (integrity). Ports the Go bootstrap's `SPORED_SIG_VERIFY` path. Default stays
  checksum-only, matching the Go tool when no key is compiled in.
- **Lifecycle-hook tags** (#25) — emit the `spawn:*` tags for daemon-enforced
  hooks so an instance spawn-ts launches is honored by a real spored (spawn-ts,
  a browser launcher, can't run them itself): `pre-stop` (+timeout),
  `spot-webhook-url`/`webhook-correlation`/`webhook-timeout`, `notify-url`/
  `notify-platform`/`notify-command`, and `active-processes`. New `LifecycleHooks`
  on `LaunchSpec`/`LaunchInput`, `buildHookTags`/`decodeHookTags`, decoded onto
  `ManagedInstance.hooks` and shown in `spawn status`. CLI `launch` flags + the
  dashboard exposes pre-stop and notify. Docs state these run **on the instance**.
- **`--on-idle stop|hibernate`** — the modern spelling of `--hibernate-on-idle`
  (rejects `terminate` with a pointer to `--on-complete`); both map to the same
  `spawn:hibernate-on-idle` tag.

### Changed
- `spawn:hibernate-on-idle` is now emitted **only when true** (matches the Go
  tool; an absent tag means the default idle action, stop). Decode is unchanged.

## [0.4.0] — 2026-07-21

### Added
- **Job arrays** (#24) — `spawn array <name> --count N` launches N identical,
  indexed instances from one base config, tagged with the wire-compatible
  `spawn:job-array-*` contract (so `spawn list --job-array-id` sees them and the
  instance's spored surfaces `JOB_ARRAY_INDEX`). A peer of sweeps/queue built on
  the shared `FanOut` engine (`src/core/jobarray.ts`); `SpawnClient.startJobArray`
  emits `jobarray` progress events reusing the dashboard card. Membership decodes
  onto `ManagedInstance.jobArray` and shows in `spawn status`. Scope: launch /
  status (via `list`) / cancel (via `terminate`); `retry --failed` and `logs`/
  `collect` are out (need a persisted record or node access) — follow-ups.
- **Orphan / zombie reaper** (#23) — a lifecycle safety-net for the #19 failure
  mode (spored died/never installed, so an instance never self-terminated).
  `findOrphans` (`src/core/orphans.ts`, reusing the exported `ttlDeadline`) flags
  managed, live instances past their TTL deadline + a 10-min grace;
  `SpawnClient.findOrphans` / `reapOrphans` surface + terminate them. Exposed as
  the CLI `orphans [--reap] [-y]` command and a dashboard warning banner with a
  one-click reap. Pure detection; reaping is always confirmed.
- **Session timeout** (idle-SSH-shell auto-logout, #22) — `--session-timeout` /
  `LaunchInput.sessionTimeout` writes `spawn:session-timeout` and injects an sshd
  `ClientAlive` config + a `readonly TMOUT` in the bootstrap (`src/aws/userdata.ts`),
  mirroring the Go tool. Disconnects idle SSH login sessions; distinct from the
  idle-*instance* lifecycle (which stops/terminates the box). Exposed in the CLI
  `launch` flags and the dashboard launch form.

## [0.3.0] — 2026-07-21

### Fixed
- **spored now self-terminates on TTL** (spawn-ts#19, closes #2). The systemd
  unit invoked `spored run` — an unknown subcommand — so spored exited non-zero
  and the unit crash-looped, never enforcing the TTL. The daemon is the bare
  `spored` invocation; the unit is now byte-for-byte the Go bootstrap's
  (`Type=simple`, `Environment=SPORE_DNS_SIGV4=1`, `ExecStart=/usr/local/bin/spored`,
  `Restart=on-failure`, journal output). Validated on real AWS: a t4g.nano with a
  5-min TTL self-terminated ~35s after its deadline, unattended, leak-checked clean.
- **Real-AWS bootstrap now installs spored** (spawn-ts#17, blocks #2). The
  user-data fetched a GitHub-release URL that 404s and was hardcoded to amd64, so
  spored never installed on a real instance — the self-termination guarantee was
  silently broken on real AWS (invisible because substrate doesn't run
  user-data). `buildLinuxBootstrap` now mirrors the Go tool: detect arch
  (amd64/arm64), read region from IMDS, download `spored-linux-<arch>` from the
  regional S3 bucket (`spawn-binaries-<region>`) with a us-east-1 fallback and
  prefixed/legacy paths, verify the SHA256, and install atomically.
- **EC2Provider attaches an IAM instance profile** (`iamInstanceProfile` option),
  required for spored's self-lifecycle calls (`DescribeTags` + `TerminateInstances`
  on `spawn:managed=true`) — without it a real instance could never self-terminate.
- **EC2Provider resolves an AMI** via `DescribeImages` (latest AL2023 for the
  instance's architecture) when none is supplied, so a real launch needs no
  hardcoded AMI id. Added `archForInstanceType`.

### Added
- **Real-AWS launch validated end-to-end** (#2): a t4g.nano in us-east-1
  (`spored-instance-profile`, resolved arm64 AL2023 AMI) launched, reached
  `running`, and **self-terminated on its TTL via spored** — unattended, ~35s
  past the deadline, leak-checked clean. The full self-termination guarantee is
  proven on real AWS, not just substrate.
- **Truffle instance picker** in the launch form — a natural-language query box
  ("h100 efa", "cheapest graviton 32gb") backed by
  [`@spore-host/truffle-ts`](https://github.com/spore-host/truffle-ts) resolves
  to matching EC2 instance types (offline, no AWS); picking one auto-fills the
  instance-type field and its estimated $/hr. truffle-ts is a git dependency;
  CI/Pages rewrite `git@github`→HTTPS so `npm ci` clones it. spawn-ts owns the
  picker UI — truffle-ts only supplies data + logic.
- Bumped `@spore-host/truffle-ts` to `v0.2.0`, so the picker also accepts
  **glob/regex patterns** (`m7i*`, `c[6-8]i.large`) alongside natural-language
  queries.
- Bumped `@spore-host/truffle-ts` to `v0.3.0`, whose bundled catalog is now
  **real AWS data** ("as of 2026-07") — the picker shows accurate specs and the
  auto-filled $/hr reflects current on-demand pricing (e.g. `p5.48xlarge`
  $55.04/hr).

## [0.2.0] — 2026-07-20

### Added
- **Batch job queues** (`spawn queue`, issue #5) — launch a DAG of jobs, one
  instance per job, as dependencies complete and capacity allows. Built on the
  sweep's fan-out engine, now extended with generic **dependency gating**
  (`dependsOn`), **launch retries** (`maxAttempts` + `retryDelayMs`), and an
  **on-failure policy** (`stop` halts the queue; `continue` keeps launching
  independent jobs; a failed job always skips its dependents). The core
  (`src/core/queue.ts`) ports `pkg/queue` — config validation, Kahn's-algorithm
  topological ordering with cycle detection, and the retry model — and loads an
  existing Go `simple-queue.json` / `ml-pipeline-queue.json` unchanged. Each
  job's instance carries the queue as `spawn:sweep-*` tags with the command +
  env as `spawn:param:*`. Wired into the terminal (`spawn queue '<json>'`) and
  the dashboard (a config editor + progress cards showing blocked/skipped jobs).
  The Go tool's on-box sequential runner and S3/Lambda result collection are out
  of scope for the browser. See [docs/queues.md](docs/queues.md).
- **Parameter sweeps** (`spawn sweep`, issue #4) — fan a parameter grid out into
  many instances. A pure, testable core (`src/core/params.ts`, `sweep.ts`)
  expands a spec (`params` list and/or cartesian `grid`, with `defaults`) into
  members, then launches them over the existing `SpawnClient` via a new reusable
  fan-out engine (`src/core/fanout.ts`) that honors a concurrency cap and an
  inter-launch delay — a port of the Go tool's rolling queue. Each instance is
  tagged with the wire-compatible `spawn:sweep-*` / `spawn:param:*` contract
  (`tags.ts`), so a sweep launched here is visible to the Go `spawn list` and
  vice-versa. Wired into the terminal (`spawn sweep --grid "lr=0.1,0.2 bs=32,64"`
  or an inline JSON spec) and the dashboard (a grid form + live progress cards),
  with sweep membership surfaced in `spawn status`. The fan-out abstraction is
  shared ground for the batch queue (issue #5).
- **Generated TypeDoc API reference** — `npm run docs` (TypeDoc) generates a full
  reference from the `src/index.ts` exports into `dist/api/`, published alongside
  the Pages demo at `/api/`. Wired into `npm run build` so Pages picks it up with
  no workflow change; `docs/api.md` links to it. Exported `TickInput` to complete
  the public surface (issue #6).
- **Concepts guide** (`docs/concepts.md`) — a newcomer-friendly narrative of the
  cost-safety model: TTL vs idle vs cost limit, why TTL always terminates (never
  stops), and the absolute-deadline invariant. Cross-linked with
  `docs/lifecycle.md` (issue #7).
- **Hermetic EC2Provider unit tests** (`src/aws/ec2.test.ts`) — stub the AWS SDK
  `send` so the real command classes still build their request, covering state
  mapping, tag decode, filter/market-option construction, and error paths with
  no substrate emulator required (issue #8).
- **UI test coverage** (`src/ui/*.test.ts`) — happy-dom-based tests for the
  dashboard (launch-form wiring, instance-card actions, meters, log), the
  terminal (command execution, history, refresh-on-mutate), and the modals
  (confirm + backend picker). Added `happy-dom` as a dev dependency (issue #1).
- **user-data bootstrap tests** (`src/aws/userdata.test.ts`) — spored install
  script shape and UTF-8-safe base64 encoding.
- Coverage now ~91% overall (from ~51%), clearing the v0.2.0 ≥75% target.
- Initial public release scaffolding: Apache-2.0 license, contributor guide,
  CI (typecheck + test + build), and documentation.
- **Core lifecycle engine** (`src/core/lifecycle.ts`) — a faithful port of the
  spore.host `spored` monitor loop: completion → TTL (always terminate) → cost
  limit → idle, with 5-minute / 90%-budget warnings. Pure and deterministic.
- **`SpawnClient`** (`src/core/client.ts`) — the public API: a provider-agnostic
  façade with a clock (real or accelerated sim), a monitor loop, and a typed
  event stream.
- **Providers** — `MockProvider` (in-memory, default, non-billable) and
  `EC2Provider` (`@aws-sdk/client-ec2` v3, direct to AWS or a substrate emulator).
- **`spawn:*` tag contract** (`src/core/tags.ts`) — wire-compatible with the Go
  `spawn` tool, including Go-form durations and RFC3339 timestamps.
- **GUI** (primary) — launch form, live instance cards with action buttons,
  TTL/cost meters, lifecycle log, backend/credentials picker, sim-speed control.
- **Terminal** (secondary) — the full `spawn` CLI surface over the same client.
- **Tests** — lifecycle, client end-to-end, CLI, and live integration tests
  against a substrate emulator (auto-skip when unreachable).

[Unreleased]: https://github.com/spore-host/spawn-ts/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/spore-host/spawn-ts/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/spore-host/spawn-ts/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/spore-host/spawn-ts/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/spore-host/spawn-ts/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/spore-host/spawn-ts/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/spore-host/spawn-ts/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/spore-host/spawn-ts/releases/tag/v0.2.0
