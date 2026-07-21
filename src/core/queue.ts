// Batch job queues — `spawn queue` for the browser. A queue is a DAG of jobs;
// each job becomes one instance that launches when its dependencies have
// completed and capacity allows, built on the shared FanOut engine. This is the
// port of pkg/queue (queue.go / dependency.go / retry.go) + the local launch
// path of cmd/launch_batchqueue.go.
//
// The Go tool runs the jobs sequentially on a single on-box runner (spored
// executes each command in dependency order). The browser has no box to run a
// shell on, so the faithful browser analogue — and what issue #5 asks for — is
// one instance per job, launched as turn/capacity allows: the DAG becomes the
// fan-out's dependency graph, per-job retry becomes launch retry, and
// on_failure maps onto the fan-out's stop/continue policy. Config parsing,
// validation, and the topological ordering are ported exactly; the S3/Lambda
// result-collection path is out of scope (no filesystem in a web page).
//
// Building a queue (config → members) is pure and testable; running it is
// delegated to FanOut via SpawnClient.

import type { SpawnClient, LaunchInput } from "./client.js";
import { FanOut, type FanOutMember, type OnFailure } from "./fanout.js";
import { parseDuration } from "./duration.js";

/** Retry policy for one job's launch. Mirrors pkg/queue.RetryConfig (subset). */
export interface RetryConfig {
  maxAttempts: number;
  /** "fixed" | "exponential" — validated but backoff shaping is coarse here. */
  backoff?: "fixed" | "exponential";
  baseDelay?: string;
  maxDelay?: string;
}

/** One job in a queue. Mirrors pkg/queue.JobConfig (the fields we model). */
export interface JobConfig {
  jobId: string;
  /** The command the job would run on-box. Recorded as a spawn:command tag. */
  command: string;
  /** Per-job timeout (Go duration) — becomes the instance's TTL backstop. */
  timeout: string;
  env?: Record<string, string>;
  dependsOn?: string[];
  retry?: RetryConfig;
  /** Launch overrides for this job's instance (type/region/spot/…). */
  launch?: Partial<LaunchInput>;
}

/** A batch job queue configuration. Mirrors pkg/queue.QueueConfig. */
export interface QueueConfig {
  queueId?: string;
  queueName?: string;
  jobs: JobConfig[];
  /** Whole-queue timeout (Go duration); a per-job TTL fallback. */
  globalTimeout?: string;
  /** "stop" halts launching after any job's terminal failure; "continue" default. */
  onFailure?: OnFailure;
  /** Default launch config applied to every job unless the job overrides it. */
  defaults?: Partial<LaunchInput>;
}

/** A built queue: identity, the topological order, and the fan-out members. */
export interface BuiltQueue {
  id: string;
  name: string;
  size: number;
  /** Job ids in a valid execution order (topological sort). */
  order: string[];
  members: FanOutMember[];
}

export interface QueueOptions {
  /** Explicit queue id; else generated from `nowMs`. */
  id?: string;
  /** Time (ms epoch) used to stamp a generated queue id. */
  nowMs?: number;
  /** Max instances running at once (0 = all eligible at once). */
  maxConcurrent?: number;
  /** Min ms between launches. */
  launchDelayMs?: number;
}

/**
 * Validate a queue config: non-empty jobs, unique non-empty job ids, a command
 * and a parseable timeout per job, dependencies that reference real jobs, no
 * self-dependency, sane retry config, a valid global timeout + on-failure, and
 * an acyclic dependency graph. Ported from ValidateQueue + validateDAG. Throws
 * on the first problem (message matches the Go phrasing where practical).
 */
export function validateQueue(cfg: QueueConfig): void {
  if (!cfg.jobs || cfg.jobs.length === 0) throw new Error("at least one job is required");

  const ids = new Set<string>();
  for (const job of cfg.jobs) {
    if (!job.jobId) throw new Error("job_id is required for all jobs");
    if (ids.has(job.jobId)) throw new Error(`duplicate job_id: ${job.jobId}`);
    ids.add(job.jobId);
    if (!job.command) throw new Error(`command is required for job ${job.jobId}`);
    if (!job.timeout) throw new Error(`timeout is required for job ${job.jobId}`);
    if (parseDuration(job.timeout) === null) {
      throw new Error(`invalid timeout format for job ${job.jobId}: ${job.timeout}`);
    }
  }

  for (const job of cfg.jobs) {
    for (const dep of job.dependsOn ?? []) {
      if (dep === job.jobId) throw new Error(`job ${job.jobId} cannot depend on itself`);
      if (!ids.has(dep)) throw new Error(`job ${job.jobId} depends on non-existent job: ${dep}`);
    }
    if (job.retry) {
      if (job.retry.maxAttempts < 1) {
        throw new Error(`retry max_attempts must be >= 1 for job ${job.jobId}`);
      }
      if (job.retry.backoff && job.retry.backoff !== "fixed" && job.retry.backoff !== "exponential") {
        throw new Error(`retry backoff must be 'fixed' or 'exponential' for job ${job.jobId}`);
      }
    }
  }

  if (cfg.globalTimeout && parseDuration(cfg.globalTimeout) === null) {
    throw new Error(`invalid global_timeout format: ${cfg.globalTimeout}`);
  }
  if (cfg.onFailure && cfg.onFailure !== "stop" && cfg.onFailure !== "continue") {
    throw new Error("on_failure must be 'stop' or 'continue'");
  }

  topologicalSort(cfg.jobs); // throws on a cycle
}

/**
 * Resolve job dependencies into an execution order (Kahn's algorithm). Throws if
 * the graph has a cycle. Ports pkg/queue.TopologicalSort — including its stable
 * seeding of the ready set in job-declaration order, so the order is
 * deterministic across runs.
 */
export function topologicalSort(jobs: JobConfig[]): string[] {
  const dependents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const job of jobs) {
    inDegree.set(job.jobId, 0);
    dependents.set(job.jobId, []);
  }
  for (const job of jobs) {
    inDegree.set(job.jobId, (job.dependsOn ?? []).length);
    for (const dep of job.dependsOn ?? []) {
      dependents.get(dep)?.push(job.jobId);
    }
  }

  // Seed in declaration order for a deterministic result (Go iterates a map, but
  // its tests assert declaration order for the ready set; we make that explicit).
  const ready = jobs.filter((j) => inDegree.get(j.jobId) === 0).map((j) => j.jobId);
  const order: string[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    order.push(current);
    for (const dep of dependents.get(current) ?? []) {
      const d = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, d);
      if (d === 0) ready.push(dep);
    }
  }

  if (order.length !== jobs.length) {
    throw new Error(
      `circular dependency detected: ${order.length} jobs processed out of ${jobs.length}`,
    );
  }
  return order;
}

/** Generate a queue id in the Go shape: queue-<YYYYMMDD>-<HHMMSS>, from nowMs. */
export function generateQueueId(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `queue-${date}-${time}`;
}

/**
 * Build (but do not launch) a queue from a config: validate it, order the jobs,
 * and turn each into a FanOut member whose LaunchInput carries the queue tags,
 * the job's TTL (per-job timeout, else the global timeout), retry count, and the
 * command/env recorded as spawn:param:* so the whole queue is discoverable and
 * tagged like the Go tool. Pure and testable.
 */
export function buildQueue(cfg: QueueConfig, opts: QueueOptions = {}): BuiltQueue {
  validateQueue(cfg);
  const id = cfg.queueId || opts.id || generateQueueId(opts.nowMs ?? 0);
  const name = cfg.queueName || "queue";
  const order = topologicalSort(cfg.jobs);
  const size = cfg.jobs.length;

  // Emit members in topological order so a bounded pump still respects the DAG
  // even before dependency gating (a natural, human-readable launch sequence).
  const byId = new Map(cfg.jobs.map((j) => [j.jobId, j]));
  const members: FanOutMember[] = order.map((jobId, idx) => {
    const job = byId.get(jobId)!;
    const ttl = job.timeout || cfg.globalTimeout || "";
    const parameters: Record<string, string> = { command: job.command };
    for (const [k, v] of Object.entries(job.env ?? {})) parameters[`env:${k}`] = v;

    const input: LaunchInput = {
      name: `${name}-${jobId}`,
      ...cfg.defaults,
      ...job.launch,
      ttl,
      // The queue is one big sweep: reuse the spawn:sweep-* / spawn:param:*
      // contract so `spawn list` shows queue membership + the job command.
      sweep: { id, name, index: idx, size, parameters },
    };

    return {
      key: jobId,
      input,
      dependsOn: job.dependsOn,
      maxAttempts: job.retry?.maxAttempts ?? 1,
    };
  });

  return { id, name, size, order, members };
}

/**
 * A running batch queue: binds queue identity to a FanOut. Driving it (pump each
 * tick) is the consumer's job unless it was started via SpawnClient.startQueue,
 * which registers it on the monitor loop.
 */
export class Queue {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly order: string[];

  constructor(built: BuiltQueue, readonly fanOut: FanOut) {
    this.id = built.id;
    this.name = built.name;
    this.size = built.size;
    this.order = built.order;
  }

  /** Build from a config and wire up a fresh FanOut over the given client. */
  static create(client: SpawnClient, cfg: QueueConfig, opts: QueueOptions = {}): Queue {
    const built = buildQueue(cfg, opts);
    const fanOut = new FanOut(client, built.members, {
      maxConcurrent: opts.maxConcurrent,
      launchDelayMs: opts.launchDelayMs,
      onFailure: cfg.onFailure ?? "continue",
    });
    return new Queue(built, fanOut);
  }

  pump(nowMs: number): Promise<boolean> {
    return this.fanOut.pump(nowMs);
  }

  get summary() {
    return this.fanOut.summary;
  }
  get isComplete(): boolean {
    return this.fanOut.isComplete;
  }
}

/** Parse + validate a JSON queue config string (snake_case wire keys → camelCase). */
export function parseQueueConfig(json: string): QueueConfig {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new Error(`invalid queue config JSON: ${(e as Error).message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("queue config must be a JSON object with a 'jobs' array");
  }
  const cfg = normalizeQueueConfig(obj as Record<string, unknown>);
  validateQueue(cfg);
  return cfg;
}

/**
 * Map the Go tool's snake_case JSON schema onto our camelCase QueueConfig so an
 * existing simple-queue.json / ml-pipeline-queue.json loads unchanged.
 */
function normalizeQueueConfig(o: Record<string, unknown>): QueueConfig {
  const jobsRaw = Array.isArray(o.jobs) ? (o.jobs as Record<string, unknown>[]) : [];
  const jobs: JobConfig[] = jobsRaw.map((j) => {
    const retryRaw = j.retry as Record<string, unknown> | undefined;
    const retry: RetryConfig | undefined = retryRaw
      ? {
          maxAttempts: Number(retryRaw.max_attempts ?? retryRaw.maxAttempts ?? 1),
          backoff: (retryRaw.backoff as RetryConfig["backoff"]) ?? undefined,
          baseDelay: (retryRaw.base_delay ?? retryRaw.baseDelay) as string | undefined,
          maxDelay: (retryRaw.max_delay ?? retryRaw.maxDelay) as string | undefined,
        }
      : undefined;
    return {
      jobId: String(j.job_id ?? j.jobId ?? ""),
      command: String(j.command ?? ""),
      timeout: String(j.timeout ?? ""),
      env: (j.env as Record<string, string>) ?? undefined,
      dependsOn: (j.depends_on ?? j.dependsOn) as string[] | undefined,
      retry,
      launch: (j.launch as Partial<LaunchInput>) ?? undefined,
    };
  });
  return {
    queueId: (o.queue_id ?? o.queueId) as string | undefined,
    queueName: (o.queue_name ?? o.queueName) as string | undefined,
    jobs,
    globalTimeout: (o.global_timeout ?? o.globalTimeout) as string | undefined,
    onFailure: (o.on_failure ?? o.onFailure) as OnFailure | undefined,
    defaults: (o.defaults as Partial<LaunchInput>) ?? undefined,
  };
}
