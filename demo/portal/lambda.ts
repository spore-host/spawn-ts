// Portal as a real infra-hosted Lambda behind a Function URL — the faithful
// "served from infra" shape of Demo 2 (the local Node server in server.ts is the
// dev-loop equivalent). Same portal-core logic; the Lambda execution role is the
// portal's infra identity that assumes the dev portal-launch role.
//
// Bundled with esbuild (see deploy.mjs) into a single handler.mjs. The static UI
// (public/) is served from the same handler so the whole portal is one Function
// URL.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { STSClient } from "@aws-sdk/client-sts";
import { clientForUserAccount, toPortalView, portalConfigFromEnv } from "./portal-core.js";

// Lambda Function URL event/response shapes (subset we use). Kept local so the
// demo needs no @types/aws-lambda dependency.
interface FunctionUrlEvent {
  requestContext: { http: { method: string; path: string } };
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
}
interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

const CFG = portalConfigFromEnv(process.env);
const sts = new STSClient({ region: CFG.region });

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const MIME: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

function json(statusCode: number, body: unknown): FunctionUrlResult {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function staticFile(urlPath: string): FunctionUrlResult {
  const rel = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");
  try {
    const buf = readFileSync(join(PUBLIC, rel));
    return {
      statusCode: 200,
      headers: { "content-type": MIME[extname(rel)] ?? "application/octet-stream" },
      body: buf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch {
    return { statusCode: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  }
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.requestContext?.http?.path ?? event.rawPath ?? "/";
  const bodyRaw = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body
    : "";
  const body = bodyRaw ? (JSON.parse(bodyRaw) as Record<string, unknown>) : {};

  try {
    if (method === "POST" && path === "/api/launch") {
      const name = typeof body.name === "string" && body.name ? body.name : "portal-demo";
      const ttl = typeof body.ttl === "string" && body.ttl ? body.ttl : "5m";
      const client = await clientForUserAccount(sts, CFG);
      const inst = await client.launch({ name, instanceType: "t4g.nano", region: CFG.region, ttl, pricePerHour: 0.0042 });
      return json(200, toPortalView(inst));
    }
    if (method === "GET" && path === "/api/instances") {
      const client = await clientForUserAccount(sts, CFG);
      const list = await client.list();
      return json(200, list.map(toPortalView));
    }
    if (method === "POST" && path === "/api/terminate") {
      const instanceId = String(body.instanceId ?? "");
      if (!instanceId) return json(400, { error: "instanceId required" });
      const client = await clientForUserAccount(sts, CFG);
      await client.terminate(instanceId, "portal-mediated terminate");
      return json(200, { ok: true });
    }
    return staticFile(path);
  } catch (err) {
    return json(500, { error: (err as Error).message });
  }
}
