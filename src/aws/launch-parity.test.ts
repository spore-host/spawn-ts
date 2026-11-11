// #129: launch parity with Go spawn. The vectors in testdata/launch-parity.go.json
// are rendered from the published spawn v0.150.0 by scripts/gen-go-fixtures.sh,
// so these tests fail when spawn-ts and Go disagree, not when a hand copy does.
//
// The launch tests drive EC2Provider against a fake EC2 and SSM
// (EC2Client/SSMClient.prototype.send stubbed): no AWS call is made.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  EC2Client,
  RunInstancesCommand,
  DescribeImagesCommand,
  DescribeInstanceTypesCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  EC2Provider,
  archForInstanceType,
  isNvidiaGpuInstance,
  GPU_AMI_PARAMETERS,
  hibernationRootGiB,
} from "./ec2.js";
import { hibernationRequested, isOneTimeSpot, needsStoppable } from "../core/bounds.js";
import { parseLifetimeDuration } from "../core/duration.js";
import type { LaunchSpec } from "../core/types.js";

interface Vectors {
  types: { instanceType: string; staticArch: "arm64" | "x86_64"; gpu: boolean; amiParameter: string }[];
  hibernationRootGiB: { memoryMiB: number; rootGiB: number; ok: boolean }[];
  hibernationRequested: { hibernateOnIdle: boolean; onComplete: string; requested: boolean }[];
  needsStoppable: { idleTimeout: string; onComplete: string; hibernate: boolean; needsStoppable: boolean }[];
  isOneTime: { tags: Record<string, string>; oneTime: boolean }[];
  spotRequestTypeTag: string;
  defaultRootDeviceName: string;
}

const GO: Vectors = JSON.parse(readFileSync(new URL("./testdata/launch-parity.go.json", import.meta.url), "utf8"));

describe("Go parity vectors (spawn v0.150.0, #129)", () => {
  it("covers the families the issue is about", () => {
    const types = GO.types.map((t) => t.instanceType);
    for (const t of ["trn1.2xlarge", "inf2.xlarge", "g6.xlarge", "p5.48xlarge", "g5g.xlarge"]) expect(types).toContain(t);
  });

  it("architecture: agrees with Go's DetectArchitecture for every vector, trn/inf included", () => {
    for (const v of GO.types) expect(archForInstanceType(v.instanceType), v.instanceType).toBe(v.staticArch);
  });

  it("architecture: also knows Graviton families Go's static list lacks (Go gets them from EC2)", () => {
    for (const t of ["im4gn.large", "is4gen.large", "i4g.large", "x8g.large", "a1.large"]) {
      expect(archForInstanceType(t), t).toBe("arm64");
    }
  });

  it("GPU: agrees with Go's DetectGPUInstance for every vector", () => {
    for (const v of GO.types) expect(isNvidiaGpuInstance(v.instanceType), v.instanceType).toBe(v.gpu);
  });

  it("GPU: uses Go's SSM parameter for the NVIDIA driver image, per architecture", () => {
    for (const v of GO.types.filter((t) => t.gpu)) {
      expect(GPU_AMI_PARAMETERS[v.staticArch], v.instanceType).toBe(v.amiParameter);
    }
  });

  it("hibernation root size: RAM rounded up to GiB, plus 10, as Go's hibernationRootGiB", () => {
    for (const v of GO.hibernationRootGiB.filter((r) => r.ok)) {
      expect(hibernationRootGiB(v.memoryMiB), String(v.memoryMiB)).toBe(v.rootGiB);
    }
  });

  it("hibernation requested: as Go's HibernationRequested", () => {
    for (const v of GO.hibernationRequested) {
      const spec = { hibernateOnIdle: v.hibernateOnIdle, onComplete: v.onComplete as LaunchSpec["onComplete"] };
      expect(hibernationRequested(spec), JSON.stringify(v)).toBe(v.requested);
    }
  });

  it("needs a stoppable Spot request: as Go's NeedsStoppable (hibernate = hibernate-on-idle here)", () => {
    for (const v of GO.needsStoppable) {
      const spec = {
        idleTimeoutMs: v.idleTimeout && v.idleTimeout !== "0" ? parseLifetimeDuration(v.idleTimeout) : 0,
        onComplete: v.onComplete as LaunchSpec["onComplete"],
        hibernateOnIdle: v.hibernate,
      };
      expect(needsStoppable(spec), JSON.stringify(v)).toBe(v.needsStoppable);
    }
  });

  it("one-time Spot: as Go's spotrequest.IsOneTime, on the same tag", () => {
    expect(GO.spotRequestTypeTag).toBe("spawn:spot-request-type");
    for (const v of GO.isOneTime) expect(isOneTimeSpot({ spot: true, tags: v.tags }), JSON.stringify(v)).toBe(v.oneTime);
    expect(isOneTimeSpot({ spot: false, tags: {} })).toBe(false);
  });
});

// ---- launch, against a fake EC2 + SSM ----

let sent: unknown[];
let ec2: (cmd: unknown) => unknown;
let ssm: (cmd: GetParameterCommand) => unknown;

beforeEach(() => {
  sent = [];
  ec2 = () => ({});
  ssm = () => ({ Parameter: { Value: "ami-0gpu" } });
  const run = (fn: () => unknown) => {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  };
  vi.spyOn(EC2Client.prototype, "send").mockImplementation(function (this: unknown, cmd: unknown) {
    sent.push(cmd);
    return run(() => ec2(cmd));
  } as never);
  vi.spyOn(SSMClient.prototype, "send").mockImplementation(function (this: unknown, cmd: unknown) {
    sent.push(cmd);
    return run(() => ssm(cmd as GetParameterCommand));
  } as never);
});
afterEach(() => vi.restoreAllMocks());

function provider() {
  return new EC2Provider({
    region: "us-east-1",
    accessKeyId: "A",
    secretAccessKey: "S",
    identity: { accountId: "123456789012", userArn: "arn:aws:sts::123456789012:assumed-role/r/alice" },
  });
}

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  name: "job",
  instanceType: "c7i.large",
  region: "us-east-1",
  spot: false,
  ttlMs: 4 * 3600_000,
  idleTimeoutMs: 0,
  hibernateOnIdle: false,
  idleCpuPercent: 0,
  costLimit: 0,
  onComplete: "",
  completionFile: "",
  completionDelayMs: 0,
  pricePerHour: 0,
  sessionTimeoutMs: 0,
  ...over,
});

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);

function sentOf<T>(type: new (...a: never[]) => T): T[] {
  return sent.filter((c): c is T => c instanceof type);
}

/** A fake EC2 with the type facts, images and launch response a test needs. */
function fakeEc2(opts: {
  arch?: "arm64" | "x86_64";
  memoryMiB?: number;
  hibernation?: boolean;
  describeTypesFails?: boolean;
  root?: { device: string; sizeGiB: number };
}) {
  ec2 = (cmd) => {
    if (cmd instanceof DescribeInstanceTypesCommand) {
      if (opts.describeTypesFails) {
        throw Object.assign(new Error("not authorized: ec2:DescribeInstanceTypes"), {
          name: "UnauthorizedOperation",
          $fault: "client",
          $metadata: { httpStatusCode: 403 },
        });
      }
      return {
        InstanceTypes: [
          {
            InstanceType: cmd.input.InstanceTypes?.[0],
            ProcessorInfo: { SupportedArchitectures: [opts.arch ?? "x86_64"] },
            MemoryInfo: { SizeInMiB: opts.memoryMiB ?? 8192 },
            HibernationSupported: opts.hibernation ?? false,
          },
        ],
      };
    }
    if (cmd instanceof DescribeImagesCommand) {
      if (cmd.input.ImageIds) {
        const r = opts.root ?? { device: "/dev/xvda", sizeGiB: 8 };
        return {
          Images: [{ ImageId: cmd.input.ImageIds[0], RootDeviceName: r.device, BlockDeviceMappings: [{ DeviceName: r.device, Ebs: { VolumeSize: r.sizeGiB } }] }],
        };
      }
      return { Images: [{ ImageId: "ami-0al2023", CreationDate: "2026-11-01T00:00:00Z" }] };
    }
    if (cmd instanceof RunInstancesCommand) {
      return { Instances: [{ InstanceId: "i-0123456789abcdef0", State: { Name: "pending" } }] };
    }
    return {};
  };
}

const run = () => sentOf(RunInstancesCommand)[0]?.input;
const al2023Arch = () =>
  sentOf(DescribeImagesCommand)
    .find((c) => c.input.Filters)
    ?.input.Filters?.find((f) => f.Name === "architecture")?.Values?.[0];

describe("EC2Provider.launch picks Go's AMI (#129)", () => {
  it("Trainium and Inferentia get an x86_64 AL2023 image, from EC2's architecture", async () => {
    for (const t of ["trn1.2xlarge", "inf2.xlarge"]) {
      sent = [];
      fakeEc2({ arch: "x86_64" });
      await provider().launch(spec({ instanceType: t }), T0);
      expect(al2023Arch(), t).toBe("x86_64");
      expect(run()!.ImageId).toBe("ami-0al2023");
      expect(sentOf(GetParameterCommand)).toEqual([]); // not a GPU image
    }
  });

  it("falls back to the static architecture when DescribeInstanceTypes is denied, as Go does", async () => {
    fakeEc2({ describeTypesFails: true });
    await provider().launch(spec({ instanceType: "trn1.2xlarge" }), T0);
    expect(al2023Arch()).toBe("x86_64");
    fakeEc2({ describeTypesFails: true });
    sent = [];
    await provider().launch(spec({ instanceType: "m8g.large" }), T0);
    expect(al2023Arch()).toBe("arm64");
  });

  it("takes EC2's architecture over the static table (Go resolveArchitecture)", async () => {
    fakeEc2({ arch: "arm64" });
    await provider().launch(spec({ instanceType: "m99g.large" }), T0);
    expect(al2023Arch()).toBe("arm64");
  });

  it("an NVIDIA GPU type gets the DLAMI NVIDIA-driver image from Go's SSM parameter", async () => {
    fakeEc2({ arch: "x86_64" });
    await provider().launch(spec({ instanceType: "g6.xlarge" }), T0);
    expect(sentOf(GetParameterCommand).map((c) => c.input.Name)).toEqual([GPU_AMI_PARAMETERS.x86_64]);
    expect(run()!.ImageId).toBe("ami-0gpu");
    expect(sentOf(DescribeImagesCommand)).toEqual([]); // no AL2023 lookup
  });

  it("the arm64 GPU type (g5g) gets the arm64 NVIDIA-driver image", async () => {
    fakeEc2({ arch: "arm64" });
    await provider().launch(spec({ instanceType: "g5g.xlarge" }), T0);
    expect(sentOf(GetParameterCommand)[0].input.Name).toBe(GPU_AMI_PARAMETERS.arm64);
  });

  it("refuses a GPU launch it can't give a driver image, keeping AWS's code, and launches nothing", async () => {
    fakeEc2({ arch: "x86_64" });
    ssm = () => {
      throw Object.assign(new Error("User is not authorized to perform: ssm:GetParameter"), {
        name: "AccessDeniedException",
        $fault: "client",
        $metadata: { httpStatusCode: 400 },
      });
    };
    const err = await provider().launch(spec({ instanceType: "p5.48xlarge" }), T0).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/could not resolve the NVIDIA driver GPU AMI .*without the NVIDIA driver/);
    expect((err as Error).name).toBe("AccessDeniedException");
    expect(sentOf(RunInstancesCommand)).toEqual([]);
  });

  it("an explicit ami is used as given, GPU or not", async () => {
    fakeEc2({});
    await provider().launch(spec({ instanceType: "g6.xlarge", ami: "ami-0mine" }), T0);
    expect(run()!.ImageId).toBe("ami-0mine");
    expect(sentOf(GetParameterCommand)).toEqual([]);
  });
});

describe("EC2Provider.launch configures hibernation where it can succeed (#129)", () => {
  it("sets HibernationOptions and an encrypted gp3 root on the AMI's root device, sized RAM + 10 GiB", async () => {
    fakeEc2({ hibernation: true, memoryMiB: 16384, root: { device: "/dev/xvda", sizeGiB: 8 } });
    const inst = await provider().launch(spec({ idleTimeoutMs: 30 * 60_000, hibernateOnIdle: true }), T0);
    expect(run()!.HibernationOptions).toEqual({ Configured: true });
    expect(run()!.BlockDeviceMappings).toEqual([
      { DeviceName: "/dev/xvda", Ebs: { VolumeSize: 26, VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true } },
    ]);
    expect(inst.hibernationConfigured).toBe(true);
  });

  it("does the same for on-complete hibernate, and never sizes the root below the AMI's snapshot", async () => {
    fakeEc2({ hibernation: true, memoryMiB: 4096, root: { device: "/dev/sda1", sizeGiB: 60 } });
    await provider().launch(spec({ onComplete: "hibernate" }), T0);
    expect(run()!.BlockDeviceMappings![0]).toMatchObject({ DeviceName: "/dev/sda1", Ebs: { VolumeSize: 60, Encrypted: true } });
  });

  it("refuses before RunInstances on a type EC2 says can't hibernate", async () => {
    fakeEc2({ hibernation: false });
    await expect(provider().launch(spec({ hibernateOnIdle: true }), T0)).rejects.toThrow(
      /does not support hibernation \(required by hibernate on idle\)/,
    );
    expect(sentOf(RunInstancesCommand)).toEqual([]);
  });

  it("refuses when it can't check (DescribeInstanceTypes denied), as Go's preflight does", async () => {
    fakeEc2({ describeTypesFails: true });
    await expect(provider().launch(spec({ onComplete: "hibernate" }), T0)).rejects.toThrow(
      /cannot check that c7i.large supports hibernation .*DescribeInstanceTypes failed/,
    );
    expect(sentOf(RunInstancesCommand)).toEqual([]);
  });

  it("sends neither when nothing will hibernate", async () => {
    fakeEc2({ hibernation: true });
    const inst = await provider().launch(spec({ idleTimeoutMs: 30 * 60_000 }), T0);
    expect(run()!.HibernationOptions).toBeUndefined();
    expect(run()!.BlockDeviceMappings).toBeUndefined();
    expect(inst.hibernationConfigured).toBe(false);
  });

  it("refuses Spot with hibernate on idle: one-time Spot can't hibernate (Go makes it persistent)", async () => {
    fakeEc2({ hibernation: true });
    await expect(provider().launch(spec({ spot: true, hibernateOnIdle: true }), T0)).rejects.toThrow(
      /refusing a Spot launch whose lifecycle stops the instance/,
    );
    expect(sent).toEqual([]);
  });

  it("reads HibernationOptions.Configured back from DescribeInstances", async () => {
    ec2 = () => ({
      Reservations: [
        {
          Instances: [
            { InstanceId: "i-0aaa000000000000a", State: { Name: "running" }, HibernationOptions: { Configured: true }, Tags: [{ Key: "spawn:managed", Value: "true" }] },
            { InstanceId: "i-0bbb000000000000b", State: { Name: "running" }, HibernationOptions: { Configured: false }, Tags: [{ Key: "spawn:managed", Value: "true" }] },
            { InstanceId: "i-0ccc000000000000c", State: { Name: "running" }, Tags: [{ Key: "spawn:managed", Value: "true" }] },
          ],
        },
      ],
    });
    void DescribeInstancesCommand;
    const list = await provider().list();
    expect(list.map((i) => i.hibernationConfigured)).toEqual([true, false, undefined]);
  });
});

describe("EC2Provider.launch sends a ClientToken (#129, spore-host#673)", () => {
  it("passes the caller's token through", async () => {
    fakeEc2({});
    await provider().launch(spec({ clientToken: "intent-42" }), T0);
    expect(run()!.ClientToken).toBe("intent-42");
  });

  it("mints a fresh one per launch when none is given (Go: spawn- + random)", async () => {
    fakeEc2({});
    const p = provider();
    await p.launch(spec(), T0);
    await p.launch(spec(), T0);
    const [a, b] = sentOf(RunInstancesCommand).map((c) => c.input.ClientToken!);
    expect(a).toMatch(/^spawn-ts-[0-9a-f-]{36}$/);
    expect(b).not.toBe(a);
  });

  it("refuses a token RunInstances would reject, before any AWS call", async () => {
    for (const bad of ["", "x".repeat(65), "has space", "naïve"]) {
      sent = [];
      await expect(provider().launch(spec({ clientToken: bad }), T0), bad).rejects.toThrow(/invalid clientToken/);
      expect(sent).toEqual([]);
    }
  });
});
