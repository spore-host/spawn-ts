// Read EC2 vCPU service quotas for the connected account — the read-only account
// inspection Coiled's setup shows (proving that whole class of "what can this
// account do" detail is fully browser-native: no backend, just the STS creds we
// already federated). @aws-sdk/client-service-quotas is browser-safe.

import { ServiceQuotasClient, GetServiceQuotaCommand } from "@aws-sdk/client-service-quotas";

export interface QuotaCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface QuotaRow {
  label: string;
  code: string;
  vcpus: number | null; // null = lookup failed (e.g. no permission)
}

// EC2 On-Demand / Spot vCPU quotas (service "ec2"), the same families Coiled shows.
const EC2_QUOTAS: Array<{ label: string; code: string }> = [
  { label: "Standard (A,C,D,H,I,M,R,T,Z) On-Demand", code: "L-1216C47A" },
  { label: "Standard Spot", code: "L-34B43A08" },
  { label: "G/VT (NVIDIA T4/A10G) On-Demand", code: "L-DB2E81BA" },
  { label: "G/VT Spot", code: "L-3819A6DF" },
  { label: "P (NVIDIA V100/A100) On-Demand", code: "L-417A185B" },
];

/**
 * Fetch the EC2 vCPU quotas for a region. Each row resolves independently so a
 * single permission/lookup failure doesn't sink the whole panel (row.vcpus=null).
 */
export async function fetchEc2Quotas(
  creds: QuotaCreds,
  region = "us-east-1",
  client?: ServiceQuotasClient,
): Promise<QuotaRow[]> {
  const sq =
    client ??
    new ServiceQuotasClient({
      region,
      credentials: { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken },
    });

  return Promise.all(
    EC2_QUOTAS.map(async ({ label, code }) => {
      try {
        const out = await sq.send(new GetServiceQuotaCommand({ ServiceCode: "ec2", QuotaCode: code }));
        return { label, code, vcpus: out.Quota?.Value ?? null };
      } catch {
        return { label, code, vcpus: null };
      }
    }),
  );
}
