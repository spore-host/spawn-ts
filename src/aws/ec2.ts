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
  DescribeInstanceTypesCommand,
  TerminateInstancesCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  CreateTagsCommand,
  type BlockDeviceMapping,
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
import { buildLaunchTags, checkTagLimit, decodeConfigTags, decodeSweepTags, decodeJobArrayTags, decodeMpiTags, decodeHookTags, isManaged, tag, type LaunchIdentity } from "../core/tags.js";
import { checkNestedSpawnTtl, checkSpotStoppable, hibernationRequested } from "../core/bounds.js";
import { LAUNCH_CONFIG_TAG, encodeLaunchConfig, splitLaunchConfigTags } from "../core/launchconfig.js";
import { buildLinuxBootstrap, checkUserDataSize, encodeLinuxUserData } from "./userdata.js";
import { lookupElasticIp } from "./eip.js";
import { resolveByName } from "../core/resolve.js";
import type { ElasticIpLookup } from "../core/notices.js";

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

/**
 * Stand-ins for what resolveIdentity returns, used to count tags before any AWS
 * call (Go's preflight values, pkg/aws/tag_limit.go). An account name is
 * assumed, because the count must cover the most the lookup can add.
 */
const PREFLIGHT_IDENTITY: LaunchIdentity = {
  accountId: "000000000000",
  userArn: "arn:aws:iam::000000000000:user/preflight",
  accountName: "preflight",
};

function withUsername(tags: Record<string, string>, username: string): Record<string, string> {
  tags[tag("local-username")] = username;
  return tags;
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
    // Everything that can refuse a launch runs BEFORE the first AWS call, as in
    // Go's Client.Launch: nothing is created (or even asked) for a launch that
    // RunInstances would reject or that must not happen.

    // A nested-spawn profile can launch more instances; it needs a TTL (#1375).
    const nested = checkNestedSpawnTtl("instance profile", this.opts.iamInstanceProfile, spec.ttlMs);
    if (nested) throw new Error(nested);
    // A one-time Spot instance cannot be stopped (#922/#1330).
    const spotStop = checkSpotStoppable(spec);
    if (spotStop) throw new Error(spotStop);
    // ClientToken (#129, spore-host#673): a retry of the same launch intent,
    // a double-click included, returns the instance the first call made.
    const clientToken = spec.clientToken ?? newClientToken();
    checkClientToken(clientToken);

    // The tag must name the user the bootstrap actually creates, so resolve once
    // and use the same value for both — otherwise `spawn connect` SSHes to a user
    // that doesn't exist.
    const localUsername = spec.localUsername ?? this.opts.username ?? "ec2-user";

    // The launch-fixed spored settings leave the tags for the launch config
    // object, named by spawn:config (#1359). They do not depend on the identity,
    // so the preflight set (Go's ValidateTagCount stand-ins) already has them.
    const preflight = splitLaunchConfigTags(
      withUsername(buildLaunchTags(spec, launchTimeMs, PREFLIGHT_IDENTITY), localUsername),
    );
    const object = await encodeLaunchConfig(preflight.settings);
    const withObject = (t: Record<string, string>): Record<string, string> =>
      object ? { ...t, [LAUNCH_CONFIG_TAG]: object.sha256 } : t;

    // EC2 refuses user data over 16 KiB (decoded) with an HTTP 400 (#1063).
    const userData = await encodeLinuxUserData(
      buildLinuxBootstrap({
        username: localUsername,
        publicKey: this.opts.publicKey,
        // The --command wrapper writes its completion record to the file spored
        // watches, so the two must agree (#1131).
        completionFile: spec.completionFile || undefined,
        sporedSigningPublicKey: this.opts.sporedSigningPublicKey,
        launchConfig: object?.body,
        // Only the accepted declarations reach user-data. Rejections are dropped
        // here rather than thrown, because failing the whole launch over one
        // unsupported plugin is worse than launching without it — but a caller
        // that wants to TELL the user must run validateDeclarations() itself and
        // surface `rejected`. Dropping silently at this layer is a UI bug waiting
        // to happen, so the launch form is where the explanation belongs.
        plugins: spec.plugins ? validateDeclarations(spec.plugins).accepted : undefined,
      }),
    );
    checkUserDataSize(userData);

    // AWS's 50-tag limit (#1336), counted with stand-ins for what the identity
    // lookup adds (Go's ValidateTagCount), so it refuses before that call too.
    checkTagLimit(withObject(preflight.tags));

    const identity = await this.resolveIdentity();
    const split = splitLaunchConfigTags(
      withUsername(buildLaunchTags(spec, launchTimeMs, identity), localUsername),
    );
    const tags = withObject(split.tags);
    checkTagLimit(tags);
    const tagList: AwsTag[] = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

    // The type's architecture, memory and hibernation support, from EC2, as Go
    // resolves them (resolveArchitecture, InstanceMemoryMiB, truffle caps).
    // Best-effort for the architecture, which falls back to the static table;
    // required when the launch will hibernate, as in Go's preflight.
    const hibernate = hibernationRequested(spec);
    const typeInfo = await this.describeType(spec.instanceType);
    if (hibernate) checkHibernatable(spec, typeInfo);
    const arch = ("arch" in typeInfo ? typeInfo.arch : undefined) ?? archForInstanceType(spec.instanceType);

    // Real AWS requires an AMI; resolve Go's for the type when the caller didn't
    // supply one (resolveAmi). substrate synthesizes an image, so a resolve
    // there is skipped by passing an explicit ami.
    const imageId = spec.ami || (await this.resolveAmi(spec.instanceType, arch));
    const hibernation = hibernate
      ? await this.hibernationRequest(imageId, (typeInfo as TypeInfo).memoryMiB!)
      : undefined;

    const res = await this.client.send(
      new RunInstancesCommand({
        ImageId: imageId,
        InstanceType: spec.instanceType as any,
        MinCount: 1,
        MaxCount: 1,
        KeyName: spec.keyPair || undefined,
        UserData: userData,
        InstanceMarketOptions: spec.spot ? { MarketType: "spot" } : undefined,
        ClientToken: clientToken,
        ...hibernation,
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
    if (!awsInst?.InstanceId) {
      // Nothing to terminate: without an id there is no instance this launch
      // can name. Say so, rather than implying nothing was created.
      throw new Error(
        "RunInstances returned no instance id; if an instance was created, it cannot be identified from this response " +
          "(look for spawn:managed=true instances named " + JSON.stringify(spec.name) + ")",
      );
    }
    try {
      // Trust the tags we just sent rather than the ones echoed back: they're
      // authoritative and drive all lifecycle-config decoding, so this is correct
      // regardless of backend and avoids a re-describe round-trip. (Real EC2 echoes
      // launch-time tags in the RunInstances response; substrate <=v0.72.0 omitted
      // them — fixed in v0.73.0, substrate#351 — but relying on the echo would be
      // fragile either way.)
      // The object's settings are no longer tags, so the instance's tags can't
      // say what they are; the launch knows, so the returned view keeps them.
      // A later list()/get() reads tags only and shows them as unset.
      return {
        ...this.toManaged(awsInst, spec.region, tags),
        hooks: spec.hooks,
        idleCpuPercent: spec.idleCpuPercent,
        hibernationConfigured: hibernate,
      };
    } catch (err) {
      throw await this.retireAfterFailedLaunch(awsInst.InstanceId, spec, err as Error);
    }
  }

  /**
   * The launch failed after RunInstances created `instanceId` (Go #1298):
   * terminate it unless the caller asked to keep it, and return the error to
   * throw, which says which happened. The caller sees a failed launch, so an
   * instance kept by default would bill with nobody watching it.
   */
  private async retireAfterFailedLaunch(instanceId: string, spec: Pick<LaunchSpec, "keepOnError">, cause: Error): Promise<Error> {
    if (spec.keepOnError) {
      return new Error(
        `${cause.message}; instance ${instanceId} was KEPT (keepOnError): nothing has confirmed its ` +
          "spored is enforcing its TTL, idle timeout or cost limit, so terminate it yourself when done",
      );
    }
    try {
      await this.client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    } catch (terr) {
      return new Error(
        `${cause.message}; terminating instance ${instanceId} after the failed launch ALSO failed ` +
          `(${(terr as Error).message}): it is still running and billing, terminate it by hand`,
      );
    }
    return new Error(`${cause.message}; instance ${instanceId} was terminated because the launch failed after it was created`);
  }

  /**
   * Every spawn-managed instance, across all DescribeInstances pages. Rejects
   * when a page fails: a partial or empty list must never stand in for the
   * real one, because "nothing is running" is what a user believes when the
   * list is empty (#125).
   */
  async list(includeTerminated = false): Promise<ManagedInstance[]> {
    const out: ManagedInstance[] = [];
    let NextToken: string | undefined;
    do {
      const res = await this.client.send(
        new DescribeInstancesCommand({
          Filters: [{ Name: `tag:${tag("managed")}`, Values: ["true"] }],
          NextToken,
        }),
      );
      for (const r of res.Reservations ?? []) {
        for (const inst of r.Instances ?? []) {
          const m = this.toManaged(inst, this.opts.region);
          if (!isManaged(m.tags)) continue;
          if (!includeTerminated && m.state === "terminated") continue;
          out.push(m);
        }
      }
      NextToken = res.NextToken || undefined;
    } while (NextToken);
    return out;
  }

  /**
   * One spawn-managed instance by id, or by Name as Go's resolveInstance picks
   * one (core/resolve.ts): live instances only, a single running match wins,
   * and an ambiguous Name throws AmbiguousNameError. The old Name lookup
   * returned the first DescribeInstances match, terminated or not (#128).
   *
   * An id lookup returns the instance in any state, terminated included, so a
   * caller acting on it sees the state it is really in. An instance that is not
   * spawn-managed is not found, as in Go ("must be spawn-managed").
   */
  async get(nameOrId: string): Promise<ManagedInstance | null> {
    if (!nameOrId.startsWith("i-")) return resolveByName(await this.list(), nameOrId);
    let res;
    try {
      res = await this.client.send(new DescribeInstancesCommand({ InstanceIds: [nameOrId] }));
    } catch (err) {
      // EC2's answer for an id it doesn't know is an error, not an empty set.
      if ((err as { name?: string }).name === "InvalidInstanceID.NotFound") return null;
      throw err;
    }
    for (const r of res.Reservations ?? []) {
      for (const inst of r.Instances ?? []) {
        if (inst.InstanceId !== nameOrId) continue;
        const m = this.toManaged(inst, this.opts.region);
        return isManaged(m.tags) ? m : null;
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
   * Find the Elastic IP associated with an instance, for `status`'s billing
   * notice (#56). Requires `ec2:DescribeAddresses`.
   *
   * Delegates to `lookupElasticIp` (src/aws/eip.ts) so the SDK call has exactly
   * one implementation; this method exists to hand it the credentials the
   * provider already holds. Never throws — a failure comes back as
   * `{ eip: null, error }` so the caller reports a gap rather than losing the
   * whole status view to one optional lookup.
   */
  async lookupElasticIp(instanceId: string): Promise<ElasticIpLookup> {
    return lookupElasticIp(instanceId, {
      region: this.opts.region,
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      sessionToken: this.opts.sessionToken,
      endpoint: this.opts.endpoint,
    });
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
   * The type's architecture, memory and hibernation support from EC2
   * DescribeInstanceTypes, the call Go's resolveArchitecture makes
   * (pkg/aws/ami.go). Never throws: a failure is returned, so the caller can
   * fall back for the architecture (as Go does) and refuse a hibernating launch.
   */
  private async describeType(instanceType: string): Promise<TypeInfo | { error: string }> {
    try {
      const out = await this.client.send(
        new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType as never] }),
      );
      const t = out.InstanceTypes?.[0];
      if (!t) return { error: `EC2 does not know instance type ${instanceType} in ${this.opts.region}` };
      const archs = t.ProcessorInfo?.SupportedArchitectures ?? [];
      // Go: arm64 wins when a type advertises both; anything else is unknown.
      const arch = archs.includes("arm64") ? "arm64" : archs.includes("x86_64") ? "x86_64" : undefined;
      return { arch, memoryMiB: t.MemoryInfo?.SizeInMiB, hibernationSupported: t.HibernationSupported === true };
    } catch (err) {
      return { error: `ec2:DescribeInstanceTypes failed: ${(err as Error).message}` };
    }
  }

  /**
   * The AMI Go's GetRecommendedAMI picks for an instance type (pkg/aws/ami.go):
   *
   * - an NVIDIA GPU family (isNvidiaGpuInstance, Go's DetectGPUInstance) gets
   *   the "Deep Learning Base OSS Nvidia Driver GPU AMI (Amazon Linux 2023)",
   *   which ships the NVIDIA driver, via Go's SSM public parameter for the
   *   architecture (GPU_AMI_PARAMETERS). A failure here is an error, never a
   *   fall back to the CPU image: that launched GPUs `nvidia-smi` couldn't see.
   * - everything else, Trainium and Inferentia included, gets Amazon Linux 2023
   *   for its architecture. Go deliberately gives Neuron families the CPU image
   *   ("a Neuron workload should pass an explicit --ami"), so spawn-ts does too.
   *
   * The CPU image is found with DescribeImages (owner amazon, newest AL2023
   * kernel-6.1) rather than Go's SSM parameter, as spawn-ts always has, so a
   * CPU launch needs no SSM permission.
   */
  private async resolveAmi(instanceType: string, arch: "arm64" | "x86_64"): Promise<string> {
    if (isNvidiaGpuInstance(instanceType)) return this.resolveGpuAmi(arch);
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

  /** Go's GetAL2023AMI(gpu=true): the DLAMI base GPU image from its SSM public parameter. */
  private async resolveGpuAmi(arch: "arm64" | "x86_64"): Promise<string> {
    const name = GPU_AMI_PARAMETERS[arch];
    // Lazily imported, as for reloadAgent: only a GPU launch needs SSM.
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({
      region: this.opts.region,
      endpoint: this.opts.endpoint || undefined,
      credentials: {
        accessKeyId: this.opts.accessKeyId,
        secretAccessKey: this.opts.secretAccessKey,
        sessionToken: this.opts.sessionToken,
      },
    });
    let value: string | undefined;
    try {
      value = (await ssm.send(new GetParameterCommand({ Name: name }))).Parameter?.Value;
    } catch (err) {
      throw Object.assign(
        new Error(
          `could not resolve the NVIDIA driver GPU AMI in ${this.opts.region} (ssm:GetParameter ${name}: ` +
            `${(err as Error).message}). Refusing to launch a GPU type on an image without the NVIDIA driver; ` +
            "pass an explicit ami to launch anyway",
        ),
        // Keep AWS's code on the error, so a caller can tell AccessDenied apart.
        { name: (err as Error).name, $fault: (err as { $fault?: unknown }).$fault, $metadata: (err as { $metadata?: unknown }).$metadata },
      );
    }
    if (!value) throw new Error(`ssm:GetParameter ${name} returned no AMI id in ${this.opts.region}`);
    return value;
  }

  /**
   * The RunInstances fields that make an instance hibernatable, as Go builds
   * them (pkg/aws/hibernation.go prepareHibernation, ebs.go buildBlockDevices,
   * launch_settings.go): HibernationOptions.Configured, and an ENCRYPTED gp3
   * root on the AMI's own root device, sized RAM + 10 GiB and never below the
   * AMI's root snapshot. EC2 writes RAM to the root volume, and refuses to
   * hibernate one that is unencrypted or too small.
   */
  private async hibernationRequest(
    imageId: string,
    memoryMiB: number,
  ): Promise<{ HibernationOptions: { Configured: true }; BlockDeviceMappings: BlockDeviceMapping[] }> {
    const root = await this.amiRootDevice(imageId);
    const size = Math.max(hibernationRootGiB(memoryMiB), root.minGiB);
    return {
      HibernationOptions: { Configured: true },
      BlockDeviceMappings: [
        {
          DeviceName: root.deviceName,
          Ebs: { VolumeSize: size, VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true },
        },
      ],
    };
  }

  /**
   * The AMI's root device name and root snapshot size (Go launchInfoFromAMI).
   * Best-effort, as in Go: a failed lookup leaves /dev/xvda and no floor. The
   * name matters, because a mapping on a non-root device leaves the AMI's
   * default, unencrypted root in place (Go #284).
   */
  private async amiRootDevice(imageId: string): Promise<{ deviceName: string; minGiB: number }> {
    try {
      const img = (await this.client.send(new DescribeImagesCommand({ ImageIds: [imageId] }))).Images?.[0];
      const deviceName = img?.RootDeviceName || DEFAULT_ROOT_DEVICE;
      const ebs = img?.BlockDeviceMappings?.find((m) => m.DeviceName === deviceName)?.Ebs;
      return { deviceName, minGiB: ebs?.VolumeSize ?? 0 };
    } catch {
      return { deviceName: DEFAULT_ROOT_DEVICE, minGiB: 0 };
    }
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
      hibernationConfigured: inst.HibernationOptions ? inst.HibernationOptions.Configured === true : undefined,
      sweep: decodeSweepTags(tags),
      jobArray: decodeJobArrayTags(tags),
      mpi: decodeMpiTags(tags),
      hooks: decodeHookTags(tags),
      ...cfg,
    };
  }
}

/**
 * Offline CPU architecture for an instance type: the fallback when
 * DescribeInstanceTypes is unavailable, as Go's DetectArchitecture is for its
 * resolveArchitecture (pkg/aws/ami.go).
 *
 * Graviton families carry a `g` in the suffix after the generation digit (m7g,
 * c7gn, r8gd, t4g, hpc7g, im4gn, is4gen, x2gd, g5g), plus the first-generation
 * `a1`. Everything else is x86_64, Trainium and Inferentia included: trn1, trn2,
 * inf1 and inf2 hosts are x86_64, and calling them arm64 picked an image
 * RunInstances refused (#129).
 *
 * It agrees with Go's static list on every family that list names
 * (testdata/launch-parity.go.json) and also knows Graviton families the list
 * doesn't (im4gn, is4gen, i4g, x8g, a1), which Go gets right only through its
 * authoritative lookup. Errs toward x86_64 for anything else.
 */
export function archForInstanceType(instanceType: string): "arm64" | "x86_64" {
  const family = instanceType.split(".")[0];
  if (family === "a1") return "arm64";
  // The generation-suffix letters after the digit; a "g" marks Graviton.
  const m = family.match(/^[a-z]+\d+([a-z]*)/);
  const suffix = m?.[1] ?? "";
  return suffix.includes("g") ? "arm64" : "x86_64";
}

/**
 * Go's DetectGPUInstance (pkg/aws/ami.go): the NVIDIA GPU families, which get
 * the NVIDIA driver image. Exact family match, so g6e must be listed beside g6
 * (Go spawn#384). Neuron (trn/inf) and AMD (g4ad) are deliberately absent.
 */
export const NVIDIA_GPU_FAMILIES: ReadonlySet<string> = new Set([
  "p6", "p5e", "p5", "p4de", "p4d", "p3", "p2",
  "g7e", "g7", "g6e", "g6", "g5", "g5g", "g4dn", "g3",
]);

/** Whether an instance type is an NVIDIA GPU type (Go's DetectGPUInstance). */
export function isNvidiaGpuInstance(instanceType: string): boolean {
  const dot = instanceType.indexOf(".");
  return dot > 0 && NVIDIA_GPU_FAMILIES.has(instanceType.slice(0, dot));
}

/** Go's SSM parameters for the DLAMI base NVIDIA driver image (pkg/aws/ami.go amiParameters). */
export const GPU_AMI_PARAMETERS = {
  x86_64: "/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-amazon-linux-2023/latest/ami-id",
  arm64: "/aws/service/deeplearning/ami/arm64/base-oss-nvidia-driver-gpu-amazon-linux-2023/latest/ami-id",
} as const;

/** Go's defaultRootDeviceName (pkg/aws/ebs.go), used when the AMI can't be read. */
const DEFAULT_ROOT_DEVICE = "/dev/xvda";

/** Go's hibernationRootGiB: RAM rounded up to whole GiB, plus 10 GiB for the OS. */
export function hibernationRootGiB(memoryMiB: number): number {
  return Math.ceil(memoryMiB / 1024) + 10;
}

interface TypeInfo {
  arch?: "arm64" | "x86_64";
  memoryMiB?: number;
  hibernationSupported: boolean;
}

/**
 * Refuse a hibernating launch before RunInstances unless EC2 says the type can
 * hibernate, as Go's preflight does (cmd/launch_preflight.go:233). Without the
 * type's facts the launch is refused too: Go's preflight fails the same way.
 */
function checkHibernatable(spec: LaunchSpec, info: TypeInfo | { error: string }): asserts info is TypeInfo {
  const by = spec.hibernateOnIdle ? "hibernate on idle" : "on-complete hibernate";
  if ("error" in info) {
    throw new Error(
      `cannot check that ${spec.instanceType} supports hibernation (${info.error}), which ${by} needs. ` +
        "Refusing to launch an instance whose hibernate would fail; use stop instead of hibernate",
    );
  }
  if (!info.hibernationSupported || !info.memoryMiB) {
    throw new Error(
      `instance type "${spec.instanceType}" does not support hibernation (required by ${by}). ` +
        "Choose a hibernation-capable type, or use stop instead of hibernate",
    );
  }
}

/** A fresh RunInstances ClientToken, Go's `"spawn-" + rand.Text()` shape. */
export function newClientToken(): string {
  return `spawn-ts-${globalThis.crypto.randomUUID()}`;
}

/** RunInstances' ClientToken limit: at most 64 ASCII characters. */
function checkClientToken(token: string): void {
  if (!/^[\x21-\x7e]{1,64}$/.test(token)) {
    throw new Error(`invalid clientToken ${JSON.stringify(token)}: it must be 1-64 printable ASCII characters`);
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
