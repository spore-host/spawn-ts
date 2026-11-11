// #125: SpawnClient failures reject with typed errors carrying the AWS code, and
// a failed DescribeInstances never looks like an empty account.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  EC2Client,
  DescribeInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { EC2Provider } from "../aws/ec2.js";
import { SpawnClient, type SpawnEvent } from "./client.js";
import { MockProvider } from "./mock.js";
import { SpawnError, awsErrorCode, describeSpawnError, toSpawnError } from "./errors.js";

/** What an AWS SDK v3 client throws: `name` is the code, plus $fault/$metadata. */
function awsError(code: string, message: string, status = 400): Error {
  return Object.assign(new Error(message), {
    name: code,
    $fault: status >= 500 ? "server" : "client",
    $metadata: { httpStatusCode: status, requestId: "req-123" },
  });
}

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const ID = "i-0bbb000000000000b";
const running = {
  InstanceId: ID,
  InstanceType: "c7i.large",
  State: { Name: "running" },
  Tags: [
    { Key: "Name", Value: "test" },
    { Key: "spawn:managed", Value: "true" },
  ],
};

describe("awsErrorCode / toSpawnError", () => {
  it("reads the code off an SDK v3 error", () => {
    expect(awsErrorCode(awsError("UnauthorizedOperation", "no"))).toBe("UnauthorizedOperation");
    expect(awsErrorCode({ Code: "IncorrectInstanceState" })).toBe("IncorrectInstanceState");
    // A plain Error is not an AWS error, whatever its message says.
    expect(awsErrorCode(new Error("AccessDenied"))).toBeUndefined();
  });

  it("keeps the code, status, request id, message and cause", () => {
    const cause = awsError("IncorrectInstanceState", "The instance is not in a state from which it can be stopped.");
    const e = toSpawnError(cause, "stop", ID);
    expect(e).toBeInstanceOf(SpawnError);
    expect(e).toMatchObject({
      name: "SpawnError",
      operation: "stop",
      instanceId: ID,
      code: "IncorrectInstanceState",
      aws: true,
      httpStatus: 400,
      requestId: "req-123",
      message: cause.message,
    });
    expect(e.cause).toBe(cause);
    expect(toSpawnError(e, "terminate")).toBe(e);
  });

  it("codes a network failure and spawn-ts's own refusals", () => {
    expect(toSpawnError(new TypeError("Failed to fetch"), "list").code).toBe("NetworkError");
    expect(toSpawnError(new Error('stop needs an instance id (i-…), got "x"'), "stop").code).toBe("InvalidInstanceId");
    expect(toSpawnError(new Error("something else"), "stop")).toMatchObject({ code: "Unknown", aws: false });
  });

  it("says in words what failed, naming the action", () => {
    const say = (code: string, op: Parameters<typeof toSpawnError>[1]) =>
      describeSpawnError(toSpawnError(awsError(code, "raw"), op, ID));
    expect(say("UnauthorizedOperation", "stop")).toBe("You don't have permission to stop this instance.");
    expect(say("AccessDenied", "terminate")).toBe("You don't have permission to terminate this instance.");
    expect(say("IncorrectInstanceState", "start")).toMatch(/^Couldn't start this instance: it isn't in a state/);
    expect(say("UnsupportedHibernationConfiguration", "hibernate")).toMatch(/wasn't launched with hibernation/);
    expect(say("ExpiredToken", "list")).toMatch(/sign-in has expired/);
    expect(say("SomethingNew", "extend")).toBe("Couldn't extend this instance: raw.");
  });
});

describe("SpawnClient action methods reject with typed errors (#125)", () => {
  let handler: (cmd: unknown) => unknown;
  beforeEach(() => {
    handler = () => ({});
    vi.spyOn(EC2Client.prototype, "send").mockImplementation(function (this: unknown, cmd: unknown) {
      try {
        return Promise.resolve(handler(cmd));
      } catch (err) {
        return Promise.reject(err);
      }
    } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  const client = () =>
    new SpawnClient({
      provider: new EC2Provider({
        region: "us-east-1",
        accessKeyId: "A",
        secretAccessKey: "S",
        identity: { accountId: "123456789012", userArn: "arn:aws:sts::123456789012:assumed-role/r/alice" },
      }),
    });

  for (const [op, Cmd, code] of [
    ["stop", StopInstancesCommand, "UnauthorizedOperation"],
    ["hibernate", StopInstancesCommand, "UnsupportedHibernationConfiguration"],
    ["terminate", TerminateInstancesCommand, "UnauthorizedOperation"],
    ["stop", StopInstancesCommand, "IncorrectInstanceState"],
  ] as const) {
    it(`${op} rejects with ${code} when EC2 refuses`, async () => {
      handler = (cmd) => {
        if (cmd instanceof DescribeInstancesCommand) return { Reservations: [{ Instances: [running] }] };
        if (cmd instanceof Cmd) throw awsError(code, `EC2 said ${code}`);
        return {};
      };
      const c = client();
      const err = await (c[op] as (id: string) => Promise<void>).call(c, ID).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpawnError);
      expect(err).toMatchObject({ operation: op, instanceId: ID, code, aws: true, message: `EC2 said ${code}` });
    });
  }

  it("rejects a Name with code InvalidInstanceId before any AWS call", async () => {
    const c = client();
    const err = await c.stop("test").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "InvalidInstanceId", aws: false, operation: "stop" });
    expect(EC2Client.prototype.send).not.toHaveBeenCalled();
  });

  it("resolves when the stop succeeded even if the refresh after it fails, and reports the refresh", async () => {
    let describes = 0;
    handler = (cmd) => {
      if (cmd instanceof DescribeInstancesCommand) {
        // The first describe is the id lookup; the second is the refresh.
        if (++describes === 2) throw awsError("RequestLimitExceeded", "slow down", 503);
        return { Reservations: [{ Instances: [running] }] };
      }
      return {};
    };
    const c = client();
    const events: SpawnEvent[] = [];
    c.on((e) => events.push(e));
    await expect(c.stop(ID)).resolves.toBeUndefined();
    expect(c.listState).toMatchObject({ status: "error", error: { operation: "list", code: "RequestLimitExceeded" } });
    expect(events.some((e) => e.type === "error" && e.error.code === "RequestLimitExceeded")).toBe(true);
  });
});

describe("a failed DescribeInstances never resolves to an empty list (#125)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function ec2(fail: () => boolean) {
    vi.spyOn(EC2Client.prototype, "send").mockImplementation(function (this: unknown, cmd: unknown) {
      if (cmd instanceof DescribeInstancesCommand && fail()) {
        return Promise.reject(awsError("UnauthorizedOperation", "You are not authorized to perform this operation.", 403));
      }
      return Promise.resolve({ Reservations: [{ Instances: [running] }] });
    } as never);
    return new EC2Provider({ region: "us-east-1", accessKeyId: "A", secretAccessKey: "S" });
  }

  it("EC2Provider.list rejects instead of returning []", async () => {
    await expect(ec2(() => true).list()).rejects.toMatchObject({ name: "UnauthorizedOperation" });
  });

  it("EC2Provider.list follows NextToken, so a long account isn't silently truncated", async () => {
    const pages: (string | undefined)[] = [];
    vi.spyOn(EC2Client.prototype, "send").mockImplementation(function (this: unknown, cmd: unknown) {
      const token = (cmd as DescribeInstancesCommand).input.NextToken;
      pages.push(token);
      const inst = (id: string) => ({ ...running, InstanceId: id });
      return Promise.resolve(
        token === undefined
          ? { Reservations: [{ Instances: [inst("i-0000000000000000a")] }], NextToken: "p2" }
          : { Reservations: [{ Instances: [inst("i-0000000000000000b")] }] },
      );
    } as never);
    const list = await new EC2Provider({ region: "us-east-1", accessKeyId: "A", secretAccessKey: "S" }).list();
    expect(pages).toEqual([undefined, "p2"]);
    expect(list.map((i) => i.instanceId)).toEqual(["i-0000000000000000a", "i-0000000000000000b"]);
  });

  it("refresh rejects with a typed error, keeps the last good list, and says it is stale", async () => {
    let failing = false;
    const c = new SpawnClient({ provider: ec2(() => failing) });
    expect(c.listState.status).toBe("loading");
    await c.refresh();
    expect(c.listState).toMatchObject({ status: "ok", instances: [{ instanceId: ID }] });

    failing = true;
    const err = await c.refresh().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "SpawnError", operation: "list", code: "UnauthorizedOperation", httpStatus: 403 });
    expect(c.list().map((i) => i.instanceId)).toEqual([ID]);
    expect(c.listState.status).toBe("error");
    expect(c.listState.instances.map((i) => i.instanceId)).toEqual([ID]);
  });

  it("a monitor loop over a failing account reports errors and leaves no unhandled rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    try {
      const c = new SpawnClient({ provider: ec2(() => true) });
      const errors: SpawnEvent[] = [];
      c.on((e) => e.type === "error" && errors.push(e));
      c.startMonitor(250);
      await vi.advanceTimersByTimeAsync(250 * 8);
      c.stopMonitor();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 0));
      expect(errors.length).toBeGreaterThanOrEqual(8);
      expect(c.listState).toMatchObject({ status: "error", instances: [] });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("the mock's launch errors are typed too", async () => {
    const c = new SpawnClient({ provider: new MockProvider() });
    const err = await c.launch({ name: "x", ttl: "4 h" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "SpawnError", operation: "launch", code: "LaunchRefused" });
    expect((err as Error).message).toMatch(/refusing to launch with ttl "4 h"/);
  });
});
