// Integration test: drives spawn-ts's EC2Provider against a live substrate
// emulator (github.com/scttfrdmn/substrate) over the wire. This exercises the
// real @aws-sdk/client-ec2 request/response path — tag specifications, filters,
// state mapping — that the mock provider can't cover.
//
// Requires substrate v0.72.0+ running with CORS enabled at $SUBSTRATE_ENDPOINT
// (default http://localhost:4566). Skipped automatically when unreachable, so
// the default `npm test` stays hermetic.

import { describe, it, expect, beforeAll } from "vitest";
import { EC2Provider } from "./ec2.js";
import { SpawnClient } from "../core/client.js";
import { tag } from "../core/tags.js";

const ENDPOINT = process.env.SUBSTRATE_ENDPOINT ?? "http://localhost:4566";
const T0 = Date.UTC(2026, 6, 20, 12, 0, 0);

let reachable = false;
beforeAll(async () => {
  try {
    const res = await fetch(`${ENDPOINT}/health`);
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.warn(`[integration] substrate not reachable at ${ENDPOINT}; skipping`);
    return;
  }
  // Substrate is event-sourced and resettable — start each run from clean state
  // so a prior run's terminated instance can't shadow a get()-by-name lookup.
  await fetch(`${ENDPOINT}/v1/state/reset`, { method: "POST" }).catch(() => {});
});

function provider() {
  return new EC2Provider({
    region: "us-east-1",
    accessKeyId: "test",
    secretAccessKey: "test",
    endpoint: ENDPOINT,
  });
}

describe("EC2Provider against live substrate", () => {
  it("launch → list → get → terminate round-trips through the SDK", async () => {
    if (!reachable) return;
    const p = provider();

    const inst = await p.launch(
      {
        name: "itest-job",
        instanceType: "c6a.xlarge",
        region: "us-east-1",
        ami: "ami-12345678",
        spot: false,
        ttlMs: 4 * 3600_000,
        idleTimeoutMs: 0,
        hibernateOnIdle: false,
        idleCpuPercent: 0,
        costLimit: 0,
        onComplete: "terminate",
        completionFile: "",
        completionDelayMs: 0,
        pricePerHour: 0.153,
        sessionTimeoutMs: 0,
      },
      T0,
    );

    expect(inst.instanceId).toMatch(/^i-/);
    // The spawn:* tag contract must survive the RunInstances TagSpecification.
    // EC2Provider trusts the tags it sent, so these hold regardless of whether
    // the backend echoes them back (substrate#351: <=v0.72.0 omitted the tagSet
    // in the RunInstances response; fixed in v0.73.0).
    expect(inst.tags[tag("managed")]).toBe("true");
    expect(inst.tags[tag("ttl")]).toBe("4h");
    expect(inst.ttlDeadlineMs).toBe(T0 + 4 * 3600_000);

    // But a re-describe must ALSO see the tags — proving substrate persisted
    // them (the omission is only in the RunInstances response body, not storage).
    const described = await p.get(inst.instanceId);
    expect(described?.tags[tag("managed")]).toBe("true");
    expect(described?.tags[tag("ttl")]).toBe("4h");

    // list() filters on tag:spawn:managed=true — our instance must appear.
    const listed = await p.list();
    const found = listed.find((i) => i.instanceId === inst.instanceId);
    expect(found).toBeTruthy();
    expect(found!.name).toBe("itest-job");

    // get() by name resolves via a tag:Name filter.
    const byName = await p.get("itest-job");
    expect(byName?.instanceId).toBe(inst.instanceId);

    // terminate transitions the instance out of the running set.
    await p.terminate(inst.instanceId, "integration cleanup");
    const after = await p.get(inst.instanceId);
    expect(after === null || after.state === "terminated" || after.state === "shutting-down").toBe(true);
  });

  it("SpawnClient monitor self-terminates an expired-TTL instance over the wire", async () => {
    if (!reachable) return;
    await fetch(`${ENDPOINT}/v1/state/reset`, { method: "POST" }).catch(() => {});

    // The substrate endpoint is non-billable, so the client runs on its sim
    // clock. Launch with a short TTL, then advance the clock past the deadline;
    // the resulting monitor tick must fire a real TerminateInstances via the SDK.
    const client = new SpawnClient({ provider: provider() });
    const inst = await client.launch({
      name: "ttl-reaper",
      ami: "ami-12345678",
      ttl: 1, // 1ms TTL
      pricePerHour: 0.1,
    });
    expect(inst.state).toBe("running");

    const actions: string[] = [];
    client.on((e) => {
      if (e.type === "action") actions.push(`${e.rule}:${e.action}`);
    });

    await client.step(1000); // advance 1s past the deadline → one monitor tick

    expect(actions).toContain("ttl:terminate");
    const after = await client.get("ttl-reaper");
    expect(after === null || after.state === "terminated" || after.state === "shutting-down").toBe(true);
  });
});
