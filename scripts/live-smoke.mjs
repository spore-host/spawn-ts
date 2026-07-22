// Real-AWS smoke test for the live-smoke workflow's `real-aws` tier. Launches ONE
// t4g.nano with a short TTL + the spored instance profile, polls unattended, and
// asserts spored self-terminates on its TTL — then hard-backstops + leak-checks.
// This is the automated form of the manual #2/#19 validation, so the
// self-termination guarantee can't silently regress.
//
// Credentials come from the ambient chain (the workflow assumes an OIDC role
// first — no stored keys). Region + instance profile come from env.
//
// It compiles src/aws/ec2.ts on the fly (the repo ships no built dist) and drives
// EC2Provider directly. ALWAYS terminates in a finally block.

import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REGION = process.env.LIVE_SMOKE_REGION || "us-east-1";
const PROFILE = process.env.LIVE_SMOKE_INSTANCE_PROFILE || "spored-instance-profile";
const TTL_MIN = 5;
const BACKSTOP_MIN = 9;

const repo = fileURLToPath(new URL("..", import.meta.url));

// Compile EC2Provider (+ its core deps) to a temp dir, then symlink node_modules
// so the AWS SDK resolves. Mirrors the manual validation harness.
const out = mkdtempSync(join(tmpdir(), "spawn-live-"));
execFileSync(
  "npx",
  ["tsc", "--outDir", out, "--module", "esnext", "--moduleResolution", "bundler",
    "--target", "es2022", "--skipLibCheck", "--resolveJsonModule", "src/aws/ec2.ts"],
  { cwd: repo, stdio: "inherit" },
);
if (!existsSync(join(out, "node_modules"))) symlinkSync(join(repo, "node_modules"), join(out, "node_modules"));

const { EC2Provider } = await import(join(out, "aws", "ec2.js"));

const provider = new EC2Provider({
  region: REGION,
  // No explicit creds → the AWS SDK's default provider chain (the OIDC session).
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  iamInstanceProfile: PROFILE,
});

const t = () => new Date().toISOString().slice(11, 19);
const spec = {
  name: "spawn-ts-ci-smoke",
  instanceType: "t4g.nano",
  region: REGION,
  spot: false,
  ttlMs: TTL_MIN * 60_000,
  idleTimeoutMs: 0, hibernateOnIdle: false, idleCpuPercent: 0,
  costLimit: 0, onComplete: "", completionFile: "", completionDelayMs: 0,
  pricePerHour: 0.0042, sessionTimeoutMs: 0,
};

let id = null;
let selfTerminated = false;
let failure = null;
try {
  const launchMs = Date.now();
  const inst = await provider.launch(spec, launchMs);
  id = inst.instanceId;
  console.log(`${t()} LAUNCHED ${id} ttl=${TTL_MIN}m`);
  const deadlineMs = launchMs + TTL_MIN * 60_000;
  const backstopMs = launchMs + BACKSTOP_MIN * 60_000;
  while (Date.now() < backstopMs) {
    await new Promise((r) => setTimeout(r, 30_000));
    const seen = await provider.get(id).catch(() => null);
    const state = seen?.state ?? "gone";
    console.log(`${t()} state=${state}`);
    if (state === "shutting-down" || state === "terminated") {
      selfTerminated = true;
      console.log(`${t()} ✅ spored self-terminated on TTL`);
      break;
    }
  }
  if (!selfTerminated) failure = `instance ${id} did NOT self-terminate within ${BACKSTOP_MIN}m`;
} catch (e) {
  failure = `launch/observe error: ${e.message}`;
} finally {
  if (id) {
    console.log(`${t()} cleanup: terminating ${id}`);
    await provider.terminate(id, "ci smoke cleanup").catch((e) => {
      failure = (failure ? failure + "; " : "") + `TERMINATE FAILED for ${id}: ${e.message} — MANUAL CLEANUP`;
    });
    // Leak-check: confirm nothing named spawn-ts-ci-smoke is left running.
    const leaks = (await provider.list(false).catch(() => [])).filter(
      (i) => i.name === "spawn-ts-ci-smoke" && i.state !== "terminated" && i.state !== "shutting-down",
    );
    if (leaks.length) failure = (failure ? failure + "; " : "") + `LEAK: ${leaks.map((i) => i.instanceId).join(",")}`;
  }
}

if (failure) {
  console.error(`${t()} SMOKE TEST FAILED: ${failure}`);
  process.exit(1);
}
console.log(`${t()} smoke test passed`);
