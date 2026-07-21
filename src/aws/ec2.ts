// EC2Provider — the real backend. Talks to AWS EC2 (or a substrate emulator at
// a custom endpoint) directly from the browser via @aws-sdk/client-ec2 v3.
//
// Credentials are supplied at runtime and held only in memory (see ui/creds.ts);
// they are never written to storage. When `endpoint` is set (e.g.
// http://localhost:4566), this drives substrate instead of real AWS — the
// intended offline test path once substrate#346 (CORS) is resolved.

import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  DescribeImagesCommand,
  TerminateInstancesCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  CreateTagsCommand,
  type Instance as AwsInstance,
  type Tag as AwsTag,
} from "@aws-sdk/client-ec2";

import type { Provider } from "../core/provider.js";
import type {
  InstanceState,
  LaunchSpec,
  ManagedInstance,
} from "../core/types.js";
import { buildLaunchTags, decodeConfigTags, decodeSweepTags, isManaged, tag } from "../core/tags.js";
import { buildLinuxBootstrap, encodeUserData } from "./userdata.js";

export interface EC2ProviderOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Override endpoint for substrate/localstack. Empty => real AWS. */
  endpoint?: string;
  /** Default SSH public key to bake into launches (optional). */
  publicKey?: string;
  /**
   * IAM instance profile (name or ARN) attached to launched instances. spored
   * needs it to read spawn:* tags (ec2:DescribeTags/DescribeInstances) and to
   * self-terminate (ec2:TerminateInstances/StopInstances on spawn:managed=true).
   * Without it, an instance launches but can never wind itself down.
   */
  iamInstanceProfile?: string;
  /** Login username for bootstrap (default ec2-user). */
  username?: string;
}

export class EC2Provider implements Provider {
  readonly label: string;
  readonly isReal: boolean;
  private client: EC2Client;
  private opts: EC2ProviderOptions;

  constructor(opts: EC2ProviderOptions) {
    this.opts = opts;
    this.isReal = !opts.endpoint; // substrate/localstack endpoints aren't billable
    this.label = opts.endpoint ? `substrate:${opts.region}` : `aws:${opts.region}`;
    this.client = new EC2Client({
      region: opts.region,
      endpoint: opts.endpoint || undefined,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
      },
    });
  }

  async launch(spec: LaunchSpec, launchTimeMs: number): Promise<ManagedInstance> {
    const tags = buildLaunchTags(spec, launchTimeMs);
    const tagList: AwsTag[] = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

    const userData = encodeUserData(
      buildLinuxBootstrap({
        username: this.opts.username ?? "ec2-user",
        publicKey: this.opts.publicKey,
        command: spec.onComplete ? undefined : undefined, // workload wiring is a later feature
      }),
    );

    // Real AWS requires an AMI; resolve the latest AL2023 for the instance's
    // architecture when the caller didn't supply one. (substrate synthesizes an
    // image, so a resolve there is skipped by passing an explicit ami.)
    const imageId = spec.ami || (await this.resolveAmi(spec.instanceType));

    const res = await this.client.send(
      new RunInstancesCommand({
        ImageId: imageId,
        InstanceType: spec.instanceType as any,
        MinCount: 1,
        MaxCount: 1,
        KeyName: spec.keyPair || undefined,
        UserData: userData,
        InstanceMarketOptions: spec.spot ? { MarketType: "spot" } : undefined,
        // spored's self-lifecycle calls require this role. A profile ARN starts
        // with "arn:"; anything else is treated as a profile name.
        IamInstanceProfile: this.opts.iamInstanceProfile
          ? this.opts.iamInstanceProfile.startsWith("arn:")
            ? { Arn: this.opts.iamInstanceProfile }
            : { Name: this.opts.iamInstanceProfile }
          : undefined,
        TagSpecifications: [
          { ResourceType: "instance", Tags: tagList },
        ],
      }),
    );

    const awsInst = res.Instances?.[0];
    if (!awsInst?.InstanceId) throw new Error("RunInstances returned no instance");
    // Trust the tags we just sent rather than the ones echoed back: they're
    // authoritative and drive all lifecycle-config decoding, so this is correct
    // regardless of backend and avoids a re-describe round-trip. (Real EC2 echoes
    // launch-time tags in the RunInstances response; substrate <=v0.72.0 omitted
    // them — fixed in v0.73.0, substrate#351 — but relying on the echo would be
    // fragile either way.)
    return this.toManaged(awsInst, spec.region, tags);
  }

  async list(includeTerminated = false): Promise<ManagedInstance[]> {
    const res = await this.client.send(
      new DescribeInstancesCommand({
        Filters: [{ Name: `tag:${tag("managed")}`, Values: ["true"] }],
      }),
    );
    const out: ManagedInstance[] = [];
    for (const r of res.Reservations ?? []) {
      for (const inst of r.Instances ?? []) {
        const m = this.toManaged(inst, this.opts.region);
        if (!isManaged(m.tags)) continue;
        if (!includeTerminated && m.state === "terminated") continue;
        out.push(m);
      }
    }
    return out;
  }

  async get(nameOrId: string): Promise<ManagedInstance | null> {
    const isId = nameOrId.startsWith("i-");
    const res = await this.client.send(
      new DescribeInstancesCommand(
        isId
          ? { InstanceIds: [nameOrId] }
          : { Filters: [{ Name: "tag:Name", Values: [nameOrId] }] },
      ),
    );
    for (const r of res.Reservations ?? []) {
      for (const inst of r.Instances ?? []) {
        return this.toManaged(inst, this.opts.region);
      }
    }
    return null;
  }

  // `reason` is accepted to satisfy the Provider contract; EC2 has no field for
  // it, so it's ignored here (spored records reasons via tags/notifications).
  async terminate(instanceId: string, _reason?: string): Promise<void> {
    await this.client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  }
  async stop(instanceId: string, _reason?: string): Promise<void> {
    await this.client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
  }
  async start(instanceId: string): Promise<void> {
    await this.client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
  }
  async hibernate(instanceId: string): Promise<void> {
    await this.client.send(new StopInstancesCommand({ InstanceIds: [instanceId], Hibernate: true }));
  }

  async setTags(instanceId: string, tags: Record<string, string>): Promise<void> {
    await this.client.send(
      new CreateTagsCommand({
        Resources: [instanceId],
        Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      }),
    );
  }

  /**
   * Resolve the newest Amazon Linux 2023 AMI for an instance type's architecture
   * via DescribeImages (owner: amazon), so a real launch needs no hardcoded AMI.
   * Graviton (g/most-recent arm families) → arm64, else x86_64.
   */
  private async resolveAmi(instanceType: string): Promise<string> {
    const arch = archForInstanceType(instanceType);
    const res = await this.client.send(
      new DescribeImagesCommand({
        Owners: ["amazon"],
        Filters: [
          { Name: "name", Values: ["al2023-ami-2023.*-kernel-6.1-" + arch] },
          { Name: "state", Values: ["available"] },
          { Name: "architecture", Values: [arch] },
        ],
      }),
    );
    const newest = (res.Images ?? [])
      .filter((i) => i.ImageId && i.CreationDate)
      .sort((a, b) => (a.CreationDate! < b.CreationDate! ? 1 : -1))[0];
    if (!newest?.ImageId) {
      throw new Error(`could not resolve an AL2023 ${arch} AMI in ${this.opts.region}`);
    }
    return newest.ImageId;
  }

  // ---- mapping helpers ----

  private toManaged(
    inst: AwsInstance,
    region: string,
    tagOverride?: Record<string, string>,
  ): ManagedInstance {
    // Prefer authoritative tags supplied by the caller (e.g. the launch tags we
    // just sent), which RunInstances may not echo back; otherwise read the
    // instance's own tagSet from a describe.
    const tags: Record<string, string> = tagOverride ? { ...tagOverride } : {};
    if (!tagOverride) {
      for (const t of inst.Tags ?? []) {
        if (t.Key) tags[t.Key] = t.Value ?? "";
      }
    }
    const cfg = decodeConfigTags(tags);
    return {
      instanceId: inst.InstanceId ?? "",
      name: tags.Name ?? "",
      region,
      instanceType: (inst.InstanceType as string) ?? "",
      state: mapState(inst.State?.Name),
      publicIp: inst.PublicIpAddress,
      privateIp: inst.PrivateIpAddress,
      spot: inst.InstanceLifecycle === "spot",
      tags,
      lastActivityMs: cfg.launchTimeMs, // real activity comes from spored tags; approximate here
      cpuPercent: 0,
      sweep: decodeSweepTags(tags),
      ...cfg,
    };
  }
}

/**
 * Best-effort CPU architecture for an instance type, for AMI selection. AWS
 * Graviton families carry a `g` in the family suffix (m7g, c7gn, r8g, t4g,
 * hpc7g, im4gn, is4gen, x2gd) and the accelerator families trn/inf are arm64
 * hosts too. Everything else is x86_64. Errs toward x86_64 when unsure — a
 * mismatch is caught at launch (AMI arch filter) rather than mis-billed.
 */
export function archForInstanceType(instanceType: string): "arm64" | "x86_64" {
  const family = instanceType.split(".")[0];
  if (/^(trn|inf)\d/.test(family)) return "arm64";
  // The generation-suffix letters after the digit; a "g" marks Graviton.
  const m = family.match(/^[a-z]+\d+([a-z]*)/);
  const suffix = m?.[1] ?? "";
  return suffix.includes("g") ? "arm64" : "x86_64";
}

function mapState(name?: string): InstanceState {
  switch (name) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "shutting-down":
      return "shutting-down";
    case "terminated":
      return "terminated";
    default:
      return "pending";
  }
}
