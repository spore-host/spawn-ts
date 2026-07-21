import { describe, it, expect } from "vitest";
import {
  validateQueue,
  topologicalSort,
  buildQueue,
  generateQueueId,
  parseQueueConfig,
  Queue,
  type QueueConfig,
} from "./queue.js";
import { SpawnClient } from "./client.js";
import { MockProvider } from "./mock.js";
import { tag, PARAM_TAG_PREFIX } from "./tags.js";

const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

function client() {
  return new SpawnClient({ provider: new MockProvider(), startMs: T0, clock: 1 });
}

const simple: QueueConfig = {
  queueName: "pipeline",
  jobs: [
    { jobId: "build", command: "make", timeout: "20m" },
    { jobId: "test", command: "make test", timeout: "20m", dependsOn: ["build"] },
    { jobId: "deploy", command: "make deploy", timeout: "10m", dependsOn: ["test"] },
  ],
  onFailure: "stop",
};

describe("validateQueue", () => {
  it("accepts a well-formed config", () => {
    expect(() => validateQueue(simple)).not.toThrow();
  });

  it("requires at least one job", () => {
    expect(() => validateQueue({ jobs: [] })).toThrow(/at least one job/);
  });

  it("rejects a missing job_id, command, or timeout", () => {
    expect(() => validateQueue({ jobs: [{ jobId: "", command: "x", timeout: "1m" }] })).toThrow(/job_id is required/);
    expect(() => validateQueue({ jobs: [{ jobId: "a", command: "", timeout: "1m" }] })).toThrow(/command is required/);
    expect(() => validateQueue({ jobs: [{ jobId: "a", command: "x", timeout: "" }] })).toThrow(/timeout is required/);
  });

  it("rejects a bad timeout format", () => {
    expect(() => validateQueue({ jobs: [{ jobId: "a", command: "x", timeout: "soon" }] })).toThrow(/invalid timeout/);
  });

  it("rejects duplicate job ids", () => {
    expect(() =>
      validateQueue({
        jobs: [
          { jobId: "a", command: "x", timeout: "1m" },
          { jobId: "a", command: "y", timeout: "1m" },
        ],
      }),
    ).toThrow(/duplicate job_id: a/);
  });

  it("rejects a dependency on a non-existent job", () => {
    expect(() =>
      validateQueue({ jobs: [{ jobId: "a", command: "x", timeout: "1m", dependsOn: ["ghost"] }] }),
    ).toThrow(/non-existent job: ghost/);
  });

  it("rejects a self-dependency", () => {
    expect(() =>
      validateQueue({ jobs: [{ jobId: "a", command: "x", timeout: "1m", dependsOn: ["a"] }] }),
    ).toThrow(/cannot depend on itself/);
  });

  it("rejects a circular dependency", () => {
    expect(() =>
      validateQueue({
        jobs: [
          { jobId: "a", command: "x", timeout: "1m", dependsOn: ["b"] },
          { jobId: "b", command: "y", timeout: "1m", dependsOn: ["a"] },
        ],
      }),
    ).toThrow(/circular dependency/);
  });

  it("validates retry config and on_failure", () => {
    expect(() =>
      validateQueue({ jobs: [{ jobId: "a", command: "x", timeout: "1m", retry: { maxAttempts: 0 } }] }),
    ).toThrow(/max_attempts must be >= 1/);
    expect(() =>
      validateQueue({
        jobs: [{ jobId: "a", command: "x", timeout: "1m", retry: { maxAttempts: 2, backoff: "wild" as never } }],
      }),
    ).toThrow(/backoff must be/);
    expect(() =>
      validateQueue({ jobs: [{ jobId: "a", command: "x", timeout: "1m" }], onFailure: "explode" as never }),
    ).toThrow(/on_failure must be/);
  });
});

describe("topologicalSort", () => {
  it("orders jobs so dependencies come first", () => {
    const order = topologicalSort(simple.jobs);
    expect(order.indexOf("build")).toBeLessThan(order.indexOf("test"));
    expect(order.indexOf("test")).toBeLessThan(order.indexOf("deploy"));
  });

  it("is deterministic across runs", () => {
    const a = topologicalSort(simple.jobs);
    for (let i = 0; i < 3; i++) expect(topologicalSort(simple.jobs)).toEqual(a);
  });

  it("throws on a cycle", () => {
    expect(() =>
      topologicalSort([
        { jobId: "a", command: "x", timeout: "1m", dependsOn: ["b"] },
        { jobId: "b", command: "y", timeout: "1m", dependsOn: ["a"] },
      ]),
    ).toThrow(/circular dependency/);
  });
});

describe("generateQueueId", () => {
  it("has the queue-<date>-<time> shape and is deterministic", () => {
    const id = generateQueueId(T0);
    expect(id).toMatch(/^queue-\d{8}-\d{6}$/);
    expect(generateQueueId(T0)).toBe(id);
  });
});

describe("buildQueue", () => {
  it("builds members in topological order with per-job TTL and queue tags", () => {
    const built = buildQueue(simple, { id: "q1" });
    expect(built.order).toEqual(["build", "test", "deploy"]);
    expect(built.members.map((m) => m.key)).toEqual(["build", "test", "deploy"]);

    const test = built.members[1];
    expect(test.input.ttl).toBe("20m");
    expect(test.dependsOn).toEqual(["build"]);
    expect(test.input.sweep).toMatchObject({ id: "q1", name: "pipeline", index: 1, size: 3 });
    // The command rides along as a sweep parameter (spawn:param:command).
    expect(test.input.sweep?.parameters.command).toBe("make test");
  });

  it("falls back to the global timeout when a job omits one is impossible (timeout required); uses maxAttempts from retry", () => {
    const built = buildQueue(
      { jobs: [{ jobId: "a", command: "x", timeout: "5m", retry: { maxAttempts: 3 } }] },
      { id: "q" },
    );
    expect(built.members[0].maxAttempts).toBe(3);
  });

  it("records env vars as spawn:param:env:* parameters", () => {
    const built = buildQueue(
      { jobs: [{ jobId: "a", command: "x", timeout: "5m", env: { FOO: "bar" } }] },
      { id: "q" },
    );
    expect(built.members[0].input.sweep?.parameters["env:FOO"]).toBe("bar");
  });
});

describe("parseQueueConfig", () => {
  it("loads a Go-shape snake_case JSON config", () => {
    const cfg = parseQueueConfig(
      JSON.stringify({
        queue_name: "simple",
        jobs: [
          { job_id: "setup", command: "echo hi", timeout: "1m" },
          { job_id: "run", command: "echo go", timeout: "5m", depends_on: ["setup"], retry: { max_attempts: 2, backoff: "exponential" } },
        ],
        global_timeout: "15m",
        on_failure: "stop",
      }),
    );
    expect(cfg.queueName).toBe("simple");
    expect(cfg.jobs[1].dependsOn).toEqual(["setup"]);
    expect(cfg.jobs[1].retry?.maxAttempts).toBe(2);
    expect(cfg.onFailure).toBe("stop");
  });

  it("throws on malformed JSON and non-object configs", () => {
    expect(() => parseQueueConfig("{bad")).toThrow(/invalid queue config JSON/);
    expect(() => parseQueueConfig("[]")).toThrow(/must be a JSON object/);
  });

  it("propagates validation errors", () => {
    expect(() => parseQueueConfig('{"jobs":[]}')).toThrow(/at least one job/);
  });
});

describe("Queue + SpawnClient integration", () => {
  it("launches jobs in dependency order, one completing before the next starts", async () => {
    const c = client();
    c.startQueue(simple, { id: "q1", maxConcurrent: 5 });
    await c.step(1000);

    // Only "build" (no deps) is running initially.
    let list = await c.refresh();
    expect(list.map((i) => i.sweep?.parameters.command)).toEqual(["make"]);

    // Complete build → test launches; complete test → deploy launches.
    await c.terminate(list[0].instanceId);
    await c.step(1000);
    list = (await c.refresh()).filter((i) => i.state === "running");
    expect(list[0].sweep?.parameters.command).toBe("make test");

    await c.terminate(list[0].instanceId);
    await c.step(1000);
    const running = (await c.refresh()).filter((i) => i.state === "running");
    expect(running[0].sweep?.parameters.command).toBe("make deploy");
  });

  it("stamps queue membership as spawn:sweep-* / spawn:param:* tags", async () => {
    const c = client();
    c.startQueue({ jobs: [{ jobId: "only", command: "run", timeout: "10m" }] }, { id: "q2" });
    await c.step(1000);
    const inst = (await c.refresh())[0];
    expect(inst.tags[tag("sweep-id")]).toBe("q2");
    expect(inst.tags[`${PARAM_TAG_PREFIX}command`]).toBe("run");
  });

  it("emits a terminal 'queue' event with done=true", async () => {
    const c = client();
    let done: unknown;
    c.on((e) => {
      if (e.type === "queue" && e.done) done = e;
    });
    c.startQueue({ jobs: [{ jobId: "a", command: "x", timeout: "5m" }] }, { id: "q3" });
    for (let i = 0; i < 3; i++) await c.step(6 * 60_000);
    expect(done).toBeTruthy();
  });

  it("Queue.create builds a wrapper without registering it", () => {
    const c = client();
    const q = Queue.create(c, simple, { id: "q4" });
    expect(q.size).toBe(3);
    expect(q.order).toEqual(["build", "test", "deploy"]);
    expect(c.activeSweeps()).toHaveLength(0);
  });

  it("a manually-created Queue drives via pump() and reports progress", async () => {
    const c = client();
    const q = Queue.create(c, { jobs: [{ jobId: "a", command: "x", timeout: "5m" }] }, { id: "q5" });
    expect(q.isComplete).toBe(false);
    await q.pump(c.now());
    await c.refresh();
    expect(q.summary.running).toBe(1);
    await c.terminate(q.summary.members[0].instanceId!);
    await q.pump(c.now());
    expect(q.isComplete).toBe(true);
  });

  it("honors on_failure=continue by launching independent jobs after a failure", async () => {
    const c = client();
    const real = c.launch.bind(c);
    (c as unknown as { launch: SpawnClient["launch"] }).launch = ((input: Parameters<SpawnClient["launch"]>[0]) =>
      input.name.endsWith("-a") ? Promise.reject(new Error("x")) : real(input)) as SpawnClient["launch"];
    c.startQueue(
      {
        jobs: [
          { jobId: "a", command: "x", timeout: "5m" },
          { jobId: "b", command: "y", timeout: "5m" },
        ],
        onFailure: "continue",
      },
      { id: "q6", maxConcurrent: 1 },
    );
    await c.step(1000);
    const running = (await c.refresh()).filter((i) => i.state === "running");
    // a failed, but b (independent) still launched under "continue".
    expect(running.map((i) => i.sweep?.parameters.command)).toContain("y");
  });
});
