import { describe, it, expect, vi, afterEach } from "vitest";
import { firstAssociatedEip, lookupElasticIp } from "./eip.js";
import { EC2Client, DescribeAddressesCommand } from "@aws-sdk/client-ec2";

describe("firstAssociatedEip — response shape handling (#56)", () => {
  it("returns the first fully-formed address", () => {
    expect(
      firstAssociatedEip([
        { PublicIp: "52.1.2.3", AllocationId: "eipalloc-a" },
        { PublicIp: "52.4.5.6", AllocationId: "eipalloc-b" },
      ]),
    ).toEqual({ publicIp: "52.1.2.3", allocationId: "eipalloc-a" });
  });

  it("skips an address with no AllocationId", () => {
    // Would otherwise produce `release-address --allocation-id undefined`, a
    // copy-pasteable command that cannot work.
    expect(
      firstAssociatedEip([
        { PublicIp: "52.1.2.3" },
        { PublicIp: "52.4.5.6", AllocationId: "eipalloc-b" },
      ]),
    ).toEqual({ publicIp: "52.4.5.6", allocationId: "eipalloc-b" });
  });

  it("returns null for an empty or absent list", () => {
    expect(firstAssociatedEip([])).toBeNull();
    expect(firstAssociatedEip(undefined)).toBeNull();
  });
});

describe("lookupElasticIp (#56)", () => {
  const opts = { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "secret" };
  afterEach(() => vi.restoreAllMocks());

  it("filters DescribeAddresses by instance-id and maps the result", async () => {
    let sent: unknown;
    vi.spyOn(EC2Client.prototype, "send").mockImplementation(async (cmd: unknown) => {
      sent = cmd;
      return { Addresses: [{ PublicIp: "52.1.2.3", AllocationId: "eipalloc-a" }] };
    });
    const out = await lookupElasticIp("i-abc", opts);
    expect(out).toEqual({ eip: { publicIp: "52.1.2.3", allocationId: "eipalloc-a" } });
    expect(sent).toBeInstanceOf(DescribeAddressesCommand);
    expect((sent as DescribeAddressesCommand).input.Filters).toEqual([
      { Name: "instance-id", Values: ["i-abc"] },
    ]);
  });

  it("reports a denied call as an error, NOT as 'no EIP attached'", async () => {
    // The divergence from Go's GetInstanceElasticIP, asserted: a missing
    // ec2:DescribeAddresses permission must not read as a clean bill of health.
    vi.spyOn(EC2Client.prototype, "send").mockRejectedValue(
      new Error("UnauthorizedOperation: not authorized"),
    );
    const out = await lookupElasticIp("i-abc", opts);
    expect(out.eip).toBeNull();
    expect(out.error).toMatch(/UnauthorizedOperation/);
  });

  it("never throws — a failed lookup must not take the status page down with it", async () => {
    vi.spyOn(EC2Client.prototype, "send").mockRejectedValue(new Error("network down"));
    await expect(lookupElasticIp("i-abc", opts)).resolves.toBeTruthy();
  });

  it("reports no EIP with no error when none is attached", async () => {
    vi.spyOn(EC2Client.prototype, "send").mockResolvedValue({ Addresses: [] } as never);
    expect(await lookupElasticIp("i-abc", opts)).toEqual({ eip: null });
  });
});

describe("EC2Provider.lookupElasticIp — the wiring the app actually uses (#56)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("delegates with the provider's own credentials", async () => {
    // The provider already holds the credentials the lookup needs, so the notice
    // works with no extra wiring at the call site (terminal.ts builds a bare
    // ShellCtx). Asserting the delegation, not the SDK call again.
    const { EC2Provider } = await import("./ec2.js");
    vi.spyOn(EC2Client.prototype, "send").mockResolvedValue({
      Addresses: [{ PublicIp: "52.1.2.3", AllocationId: "eipalloc-a" }],
    } as never);
    const p = new EC2Provider({
      region: "us-east-1",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
    });
    expect(await p.lookupElasticIp("i-abc")).toEqual({
      eip: { publicIp: "52.1.2.3", allocationId: "eipalloc-a" },
    });
  });
});
