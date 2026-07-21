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

    const res = await this.client.send(
      new RunInstancesCommand({
        ImageId: spec.ami, // required for real AWS; substrate may synthesize one
        InstanceType: spec.instanceType as any,
        MinCount: 1,
        MaxCount: 1,
        KeyName: spec.keyPair || undefined,
        UserData: userData,
        InstanceMarketOptions: spec.spot ? { MarketType: "spot" } : undefined,
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
