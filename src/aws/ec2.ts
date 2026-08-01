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
import { validateDeclarations } from "../core/plugins.js";
import { buildLaunchTags, decodeConfigTags, decodeSweepTags, decodeJobArrayTags, decodeHookTags, isManaged, tag, type LaunchIdentity } from "../core/tags.js";
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
  /**
   * PEM spore.host signing public key. When set, launched instances verify the
   * spored binary's signature before running it (fail-closed). Absent = the
   * bootstrap relies on the SHA256 checksum only. See userdata.ts.
   */
  sporedSigningPublicKey?: string;
  /**
   * Who is launching, for the spawn:* base-identity tags. Supply it when the
   * caller already knows (the federated BYOA path gets
   * `AssumedRoleUser.Arn` + the account id straight back from
   * AssumeRoleWithWebIdentity, so no extra call is needed); otherwise the
   * provider resolves it once via GetCallerIdentity on first launch.
   */
  identity?: LaunchIdentity;
}

export class EC2Provider implements Provider {
  readonly label: string;
  readonly isReal: boolean;
  private client: EC2Client;
  private opts: EC2ProviderOptions;
  private cachedIdentity?: LaunchIdentity;

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

  /**
   * Resolve (and cache) the launching identity. Cached for the provider's
   * lifetime because credentials don't change under it.
   *
   * Throws rather than degrading. A launch that can't stamp spawn:iam-user
   * produces an instance the portal can neither list nor terminate (it 403s on
   * the owner mismatch — lambda/dashboard-api/instances.go:285), and it still
   * accrues cost. Failing at launch is recoverable; an orphaned billable
   * instance is the #63 invariant in its most expensive form, so the error must
   * not look like an absence of identity.
   */
  private async resolveIdentity(): Promise<LaunchIdentity> {
    if (this.opts.identity) return this.opts.identity;
    if (this.cachedIdentity) return this.cachedIdentity;
    // Imported lazily: only the real launch path needs STS, so the pure/offline
    // consumers of this module don't pay for the client.
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const sts = new STSClient({
      region: this.opts.region,
      endpoint: this.opts.endpoint || undefined,
      credentials: {
        accessKeyId: this.opts.accessKeyId,
        secretAccessKey: this.opts.secretAccessKey,
        sessionToken: this.opts.sessionToken,
      },
    });
    let out;
    try {
      out = await sts.send(new GetCallerIdentityCommand({}));
    } catch (err) {
      throw new Error(
        `cannot determine the launching identity (sts:GetCallerIdentity failed: ${
          (err as Error).message
        }). Refusing to launch: without spawn:iam-user the instance would be ` +
          `invisible to the portal and impossible to terminate there, while still costing money.`,
      );
    }
    if (!out.Account || !out.Arn) {
      throw new Error(
        "sts:GetCallerIdentity returned no Account/Arn. Refusing to launch: " +
          "without spawn:iam-user the instance would be unterminatable from the portal.",
      );
    }
    this.cachedIdentity = { accountId: out.Account, userArn: out.Arn };
    return this.cachedIdentity;
  }

  async launch(spec: LaunchSpec, launchTimeMs: number): Promise<ManagedInstance> {
    const identity = await this.resolveIdentity();
    const tags = buildLaunchTags(spec, launchTimeMs, identity);

    // The tag must name the user userdata actually creates, so resolve once and
    // use the same value for both — otherwise `spawn connect` SSHes to a user
    // that doesn't exist. Set before tagList is snapshotted below.
    const localUsername = spec.localUsername ?? this.opts.username ?? "ec2-user";
    tags[tag("local-username")] = localUsername;

    const tagList: AwsTag[] = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

    const userData = encodeUserData(
      buildLinuxBootstrap({
        username: localUsername,
        publicKey: this.opts.publicKey,
        command: spec.onComplete ? undefined : undefined, // workload wiring is a later feature
        sessionTimeoutMs: spec.sessionTimeoutMs,
        sporedSigningPublicKey: this.opts.sporedSigningPublicKey,
        // Only the accepted declarations reach user-data. Rejections are dropped
        // here rather than thrown, because failing the whole launch over one
        // unsupported plugin is worse than launching without it — but a caller
        // that wants to TELL the user must run validateDeclarations() itself and
        // surface `rejected`. Dropping silently at this layer is a UI bug waiting
        // to happen, so the launch form is where the explanation belongs.
        plugins: spec.plugins ? validateDeclarations(spec.plugins).accepted : undefined,
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
   * Nudge spored to re-read its config from tags now, via SSM RunShellScript.
   *
   * This is the browser's stand-in for Go's SSH `triggerReload`
   * (cmd/extend.go:303): SSH needs a private key the browser doesn't have, but
   * `ssm:SendCommand` is a plain signed POST and the endpoint is CORS-open
   * (`access-control-allow-origin: *`, verified against ssm.us-east-1), so the
   * same nudge works with no local half.
   *
   * Fire-and-report: it does NOT poll the command to completion. What the caller
   * needs to know is whether the request was accepted, and an accepted
   * SendCommand still fails on the box if SSM Agent isn't running or the instance
   * profile lacks the managed-instance policy. So a true `ok` means "the reload
   * was requested", not "spored reloaded" — the detail string says so, because
   * the difference is exactly the kind that must not be smoothed over.
   *
   * Never throws: a failed reload must not fail the extend it follows. The tag
   * write already succeeded, and that is the authoritative, durable part — the
   * reload only shortens the window in which spored acts on a stale deadline.
   */
  async reloadAgent(instanceId: string): Promise<{ ok: boolean; detail: string }> {
    // Lazily imported for the same reason as STS: nothing offline should pay for
    // an SSM client, and @aws-sdk/client-ssm is an optional peer here.
    let SSMClient, SendCommandCommand;
    try {
      ({ SSMClient, SendCommandCommand } = await import("@aws-sdk/client-ssm"));
    } catch (err) {
      return { ok: false, detail: `@aws-sdk/client-ssm is unavailable: ${(err as Error).message}` };
    }
    const ssm = new SSMClient({
      region: this.opts.region,
      endpoint: this.opts.endpoint || undefined,
      credentials: {
        accessKeyId: this.opts.accessKeyId,
        secretAccessKey: this.opts.secretAccessKey,
        sessionToken: this.opts.sessionToken,
      },
    });
    try {
      const out = await ssm.send(
        new SendCommandCommand({
          InstanceIds: [instanceId],
          DocumentName: "AWS-RunShellScript",
          // The same command Go's triggerReload runs over SSH.
          Parameters: { commands: ["sudo /usr/local/bin/spored reload"] },
          Comment: "spawn-ts extend: reload spored config from tags",
        }),
      );
      const id = out.Command?.CommandId;
      if (!id) {
        // A 200 with no CommandId means we cannot check on it later, so it is
        // reported as a non-success rather than assumed fine.
        return { ok: false, detail: "ssm:SendCommand returned no CommandId" };
      }
      return { ok: true, detail: `reload requested via SSM (command ${id})` };
    } catch (err) {
      return { ok: false, detail: `ssm:SendCommand failed: ${(err as Error).message}` };
    }
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
      jobArray: decodeJobArrayTags(tags),
      hooks: decodeHookTags(tags),
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
