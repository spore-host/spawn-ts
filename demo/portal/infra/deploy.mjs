// Deploy the Demo 2 portal to infra: bundle the Lambda with esbuild (+ the
// static public/ assets), deploy the CloudFormation stack, then push the code.
//
// Usage:
//   AWS_PROFILE=spore-host-infra \
//   PORTAL_EXTERNAL_ID=<the dev portal-launch role's external id> \
//   node demo/portal/infra/deploy.mjs
//
// Env:
//   PORTAL_EXTERNAL_ID       (required) — must match the dev role's trust condition
//   PORTAL_LAUNCH_ROLE_ARN   (default arn:aws:iam::435415984226:role/spawn-ts-portal-launch)
//   PORTAL_REGION            (default us-east-1)
//   STACK_NAME               (default spawn-ts-portal)

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTAL = join(HERE, ".."); // demo/portal
const REGION = process.env.PORTAL_REGION ?? "us-east-1";
const STACK = process.env.STACK_NAME ?? "spawn-ts-portal";
const LAUNCH_ROLE = process.env.PORTAL_LAUNCH_ROLE_ARN ?? "arn:aws:iam::435415984226:role/spawn-ts-portal-launch";
const EXTERNAL_ID = process.env.PORTAL_EXTERNAL_ID ?? "";

if (!EXTERNAL_ID) {
  console.error("PORTAL_EXTERNAL_ID is required (must match the dev launch role's ExternalId condition).");
  process.exit(1);
}

const aws = (...args) => execFileSync("aws", [...args, "--region", REGION], { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

// 1) Bundle the Lambda handler (ESM, node20) + copy static assets into a workdir.
const work = mkdtempSync(join(tmpdir(), "portal-deploy-"));
console.log(`[deploy] bundling into ${work}`);

// Bundle the browser terminal (public/portal-terminal.js + .css) so the deployed
// static assets include it.
await build({
  entryPoints: [join(PORTAL, "portal-terminal.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: join(PORTAL, "public", "portal-terminal.js"),
});

await build({
  entryPoints: [join(PORTAL, "lambda.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: join(work, "handler.mjs"),
  // The AWS SDK is available in the Lambda runtime, but bundling it keeps the
  // version pinned to what the demo was tested with.
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
});
cpSync(join(PORTAL, "public"), join(work, "public"), { recursive: true });

// 2) Zip it (use the system zip for a deterministic, Lambda-compatible archive).
const zipPath = join(work, "portal.zip");
execFileSync("zip", ["-qr", zipPath, "handler.mjs", "public"], { cwd: work, stdio: "inherit" });

// 3) Deploy the CloudFormation stack (creates role + function + Function URL).
console.log(`[deploy] deploying stack ${STACK}`);
execFileSync(
  "aws",
  [
    "cloudformation", "deploy",
    "--stack-name", STACK,
    "--template-file", join(HERE, "portal-stack.yaml"),
    "--capabilities", "CAPABILITY_NAMED_IAM",
    "--region", REGION,
    "--parameter-overrides",
    `PortalLaunchRoleArn=${LAUNCH_ROLE}`,
    `PortalExternalId=${EXTERNAL_ID}`,
    `PortalRegion=${REGION}`,
  ],
  { stdio: "inherit" },
);

// 4) Push the real code (the template ships a placeholder).
console.log(`[deploy] updating function code`);
aws("lambda", "update-function-code", "--function-name", "spawn-ts-portal", "--zip-file", `fileb://${zipPath}`);

const url = aws("cloudformation", "describe-stacks", "--stack-name", STACK, "--query", "Stacks[0].Outputs[?OutputKey=='PortalUrl'].OutputValue", "--output", "text");
console.log(`\n[deploy] portal live at: ${url}`);
console.log(`[deploy] launch role: ${LAUNCH_ROLE}`);

rmSync(work, { recursive: true, force: true });
void createRequire; // (kept for parity with the handler banner; no-op here)
