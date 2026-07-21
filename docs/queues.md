# Batch job queues

A **batch job queue** runs a set of jobs with dependencies between them — the
browser port of the Go tool's `spawn queue`. It's how you model a pipeline
(`build → test → deploy`) or a fan-in/fan-out DAG, where some jobs can't start
until others finish. Queues build on the same [fan-out engine](./sweeps.md#the-fan-out-engine)
as [parameter sweeps](./sweeps.md); a queue is a sweep with a dependency graph,
retries, and a failure policy layered on.

## How it maps to the browser

The Go tool launches **one instance** and runs the jobs sequentially on it (an
on-box runner executes each command in dependency order). A web page has no box
to run a shell on, so spawn-ts uses the faithful browser analogue — and what the
issue asks for: **one instance per job**, launched as its dependencies complete
and capacity allows.

- the DAG becomes the fan-out's dependency graph;
- a per-job timeout becomes that instance's TTL (the cost backstop);
- per-job retry becomes **launch** retry;
- `on_failure` maps onto the fan-out's stop/continue policy.

The command and env for each job are recorded as `spawn:param:*` tags (they'd be
what a real on-box runner executes). The Go tool's S3/Lambda result collection is
out of scope — there's no filesystem in the browser.

## The config

A queue config is the same JSON the Go tool reads (an existing
`simple-queue.json` or `ml-pipeline-queue.json` loads unchanged):

```jsonc
{
  "queue_name": "pipeline",
  "jobs": [
    { "job_id": "build",  "command": "make",       "timeout": "20m" },
    { "job_id": "test",   "command": "make test",  "timeout": "20m", "depends_on": ["build"] },
    { "job_id": "deploy", "command": "make deploy", "timeout": "10m", "depends_on": ["test"],
      "retry": { "max_attempts": 3, "backoff": "exponential" } }
  ],
  "global_timeout": "1h",
  "on_failure": "stop"
}
```

Each job needs a `job_id` (unique), a `command`, and a `timeout` (a Go duration).
`depends_on` lists job ids that must **complete** before this job launches.
`retry.max_attempts` bounds launch attempts. `on_failure` is `stop` or
`continue`. The config is validated up front: missing fields, duplicate ids,
dangling or self-dependencies, bad durations, and **dependency cycles** are all
rejected before anything launches.

## Execution semantics

Jobs are ordered by a topological sort (Kahn's algorithm, deterministic across
runs), then launched by the fan-out engine as capacity allows:

- a job is **blocked** until every job it depends on has **completed**;
- when a slot frees (a running job's instance winds down), the next eligible job
  launches — bounded by `--max-concurrent`;
- if a job's launch fails, it retries up to `max_attempts`; once it exhausts
  them it's **failed**;
- a failed (or skipped) job **skips** all of its dependents — the cascade runs
  all the way down the chain;
- `on_failure: "stop"` additionally **skips every not-yet-started job** after any
  failure; `"continue"` (the default) keeps launching independent jobs.

A member ends in one of: `completed`, `failed`, or `skipped`. The queue is done
when every job is in one of those states.

## From the terminal

```
spawn queue '{"jobs":[
  {"job_id":"build","command":"make","timeout":"20m"},
  {"job_id":"test","command":"make test","timeout":"20m","depends_on":["build"]}
]}' --max-concurrent 2
```

The command prints the queue id, the resolved launch order, and the initial
counts. Flags: `--max-concurrent`, `--launch-delay`. Single-quote the JSON so the
shell keeps its double quotes.

## From the dashboard

The **Batch job queue** panel has a JSON config editor (pre-filled with a valid
example) and a live progress card per queue: jobs running / completed / blocked /
failed / skipped, with a progress meter. It shares the card area with sweeps and
is labelled `queue`.

## The tag contract

A queue reuses the sweep tag contract, so every job's instance is discoverable
via `spawn list` and shows its command:

| Tag | Meaning |
|-----|---------|
| `spawn:sweep-id` | the queue id (`queue-<YYYYMMDD>-<HHMMSS>`) |
| `spawn:sweep-name` | the queue name |
| `spawn:sweep-index` | this job's position in the topological order |
| `spawn:sweep-size` | total jobs in the queue |
| `spawn:param:command` | the job's command |
| `spawn:param:env:<KEY>` | one of the job's env vars |

See [parameter sweeps](./sweeps.md) for the shared fan-out engine and the tag
encode/decode in `src/core/tags.ts`.
