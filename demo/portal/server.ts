// Demo 2 — portal / BYOA (the portal drives, into your account).
//
// A small Node service that models the Arpeggio compute plane in miniature. It
// is its OWN principal (its infra credentials come from the ambient chain — a
// local infra profile here, a Lambda execution role when deployed) and never
// exposes them to the browser. On a launch request it:
//
//   1. assumes a role in the USER's account (RoleArn + ExternalId) via STS,
//   2. builds a spawn-ts EC2Provider from the returned TEMPORARY credentials,
//   3. launches a bounded t4g.nano there via SpawnClient.
//
// The launched instance runs under the PORTAL's assumed role, not the user's —
// so the user cannot touch it directly; they only see the portal-mediated view
// this service exposes. spored still registers DNS with infra + self-terminates.
//
// This mirrors the one place in the Go codebase that assume-roles then launches:
// lambda/autoscale-orchestrator/main.go (+ cloudformation/autoscale-ec2-role.yaml),
// including the ExternalId confused-deputy guard.
//
// Run:  npx tsx demo/portal/server.ts   (with infra creds in the environment)
// Env:  PORTAL_LAUNCH_ROLE_ARN  (required) — the role in the user's/dev account
//       PORTAL_EXTERNAL_ID      (required) — confused-deputy guard
//       PORTAL_REGION           (default us-east-1)
//       PORTAL_INSTANCE_PROFILE (default spored-instance-profile)
//       PORTAL_PORT             (default 8787)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { STSClient } from "@aws-sdk/client-sts";
import {
  clientForUserAccount,
  toPortalView as view,
  portalConfigFromEnv,
  startBrokeredSession,
  terminateBrokeredSession,
  type PortalConfig,
} from "../../src/portal/portal-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const PORT = Number(process.env.PORTAL_PORT ?? 8787);

let CFG: PortalConfig;
try {
  CFG = portalConfigFromEnv(process.env);
} catch (err) {
  console.error(`[portal] ${(err as Error).message}`);
  console.error("[portal] The portal's OWN identity comes from ambient creds; it never sees the browser's.");
  process.exit(1);
}

// The portal's own principal — ambient credential chain (infra profile / Lambda
// role). Used ONLY to assume the user-account role; never sent to the browser.
const sts = new STSClient({ region: CFG.region });

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
};

async function serveStatic(res: ServerResponse, urlPath: string) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  try {
    const buf = await readFile(join(PUBLIC, rel));
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error("[portal]", err);
    sendJson(res, 500, { error: (err as Error).message });
  });
});

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // POST /api/launch { name?, ttl? } → assume role, launch t4g.nano in user acct
  if (req.method === "POST" && path === "/api/launch") {
    const body = await readBody(req);
    const name = typeof body.name === "string" && body.name ? body.name : "portal-demo";
    const ttl = typeof body.ttl === "string" && body.ttl ? body.ttl : "5m";
    const client = await clientForUserAccount(sts, CFG);
    const inst = await client.launch({
      name,
      instanceType: "t4g.nano",
      region: CFG.region,
      ttl,
      pricePerHour: 0.0042,
    });
    return sendJson(res, 200, view(inst));
  }

  // GET /api/instances → list portal-launched instances in the user account
  if (req.method === "GET" && path === "/api/instances") {
    const client = await clientForUserAccount(sts, CFG);
    const list = await client.list();
    return sendJson(res, 200, list.map(view));
  }

  // POST /api/terminate { instanceId } → portal-mediated terminate
  if (req.method === "POST" && path === "/api/terminate") {
    const body = await readBody(req);
    const instanceId = String(body.instanceId ?? "");
    if (!instanceId) return sendJson(res, 400, { error: "instanceId required" });
    const client = await clientForUserAccount(sts, CFG);
    await client.terminate(instanceId, "portal-mediated terminate");
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/session { instanceId } → portal brokers an SSM shell session and
  // returns ONLY the session tuple (no AWS creds ever reach the browser).
  if (req.method === "POST" && path === "/api/session") {
    const body = await readBody(req);
    const instanceId = String(body.instanceId ?? "");
    if (!instanceId) return sendJson(res, 400, { error: "instanceId required" });
    const session = await startBrokeredSession(sts, CFG, instanceId);
    return sendJson(res, 200, session);
  }

  // POST /api/session/terminate { sessionId } → portal ends the brokered session.
  if (req.method === "POST" && path === "/api/session/terminate") {
    const body = await readBody(req);
    const sessionId = String(body.sessionId ?? "");
    if (!sessionId) return sendJson(res, 400, { error: "sessionId required" });
    await terminateBrokeredSession(sts, CFG, sessionId);
    return sendJson(res, 200, { ok: true });
  }

  // Everything else → static portal UI
  return serveStatic(res, path);
}

server.listen(PORT, () => {
  console.log(`[portal] listening on http://localhost:${PORT}`);
  console.log(`[portal] launches into role ${CFG.roleArn} (region ${CFG.region})`);
  console.log(`[portal] the browser never receives AWS credentials.`);
});
