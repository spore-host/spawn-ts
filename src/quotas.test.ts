import { describe, it, expect, vi } from "vitest";
import { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { fetchEc2Quotas } from "./quotas.js";

describe("fetchEc2Quotas", () => {
  it("returns a vcpu value per quota row", async () => {
    const send = vi.fn().mockResolvedValue({ Quota: { Value: 256 } });
    const rows = await fetchEc2Quotas(
      { accessKeyId: "a", secretAccessKey: "b", sessionToken: "c" },
      "us-east-1",
      { send } as unknown as ServiceQuotasClient,
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows[0]).toMatchObject({ code: "L-1216C47A", vcpus: 256 });
    // it queried the ec2 service with the row's quota code
    expect(send.mock.calls[0][0].input).toMatchObject({ ServiceCode: "ec2", QuotaCode: "L-1216C47A" });
  });

  it("degrades gracefully to null on a per-row failure (e.g. no permission)", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Quota: { Value: 256 } })
      .mockRejectedValue(new Error("AccessDenied"));
    const rows = await fetchEc2Quotas({ accessKeyId: "a", secretAccessKey: "b" }, "us-east-1", { send } as unknown as ServiceQuotasClient);
    expect(rows[0].vcpus).toBe(256);
    expect(rows.slice(1).every((r) => r.vcpus === null)).toBe(true); // failures → null, not a thrown error
  });
});
