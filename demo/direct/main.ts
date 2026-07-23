// Demo 1 — "like spawn now": single-account, you drive.
//
// You authenticate spawn-ts with YOUR OWN AWS credentials (pasted here, held in
// memory only); compute launches into YOUR account; the instance's spored
// registers DNS with spore.host infra (the "trust with infra") and
// self-terminates on its TTL. You own the instance.
//
// This is a thin guided view over the exact same library the main app uses
// (SpawnClient + EC2Provider). Its only value-add over the full dashboard is
// making the two demo-defining facts visible: (1) the launch goes into the
// account your creds belong to, and (2) spored will register
// {name}.{base36(accountId)}.spore.host against the real infra DNS Lambda.

import { SpawnClient } from "../../src/core/client.js";
import { EC2Provider } from "../../src/aws/ec2.js";
import type { ManagedInstance } from "../../src/core/types.js";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { SSMClient, StartSessionCommand, TerminateSessionCommand } from "@aws-sdk/client-ssm";
import { sporeHostName } from "../lib/dns-name.js";
import { resolveA } from "../lib/dns-resolve.js";
import { attachTerminal, type AttachedTerminal } from "./terminal.js";

const app = document.getElementById("app")!;

app.innerHTML = `
  <header>
    <div class="brand"><span class="spore">spore</span>.host · spawn-ts demo</div>
    <div class="mode">Demo 1 — direct · <b>your account, you drive</b></div>
  </header>

  <section class="explain">
    <p>You authenticate with <b>your own AWS credentials</b>. Compute launches into
    <b>your account</b>. The instance's <code>spored</code> daemon registers a DNS name with
    spore.host infra and <b>self-terminates on its TTL</b> — even if you close this tab.
    You own and control the instance.</p>
  </section>

  <section class="card creds">
    <h3>1 · Authenticate to your account</h3>
    <label>region</label><input class="f-region" value="us-east-1" />
    <label>access key id</label><input class="f-akid" autocomplete="off" />
    <label>secret access key</label><input class="f-secret" type="password" autocomplete="off" />
    <label>session token (optional, for STS temp creds)</label><input class="f-token" autocomplete="off" />
    <div class="warn">Credentials are held in memory only, never stored. The launch below is a real, billable EC2 instance (a t4g.nano — well under 1¢ for a short TTL).</div>
    <button class="primary connect">Connect</button>
    <div class="whoami"></div>
  </section>

  <section class="card launch" hidden>
    <h3>2 · Launch into your account</h3>
    <label>name</label><input class="f-name" value="demo-direct" />
    <label>TTL</label>
    <select class="f-ttl">
      <option value="5m" selected>5 minutes</option>
      <option value="10m">10 minutes</option>
      <option value="15m">15 minutes</option>
    </select>
    <div class="dns-preview"></div>
    <button class="primary go">Launch t4g.nano</button>
    <button class="reset" hidden>Reset (launch again)</button>
  </section>

  <section class="card status" hidden>
    <h3>3 · Watch it self-terminate</h3>
    <div class="inst"></div>
    <button class="connect-term" hidden>Connect terminal (SSM)</button>
    <div class="term-wrap" hidden>
      <div class="term-note">Live shell over AWS SSM — no SSH, no port 22, no key. Your browser talks to the instance via the SSM data channel.</div>
      <div class="term"></div>
    </div>
    <div class="log"></div>
  </section>
`;

const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
const val = (sel: string) => $<HTMLInputElement>(sel).value.trim();

let client: SpawnClient | null = null;
let accountId = "";
let region = "us-east-1";
// Held in memory only (like the provider's creds) so the terminal can call
// ssm:StartSession for the running instance.
let creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null = null;
let currentInstanceId = "";
let terminal: AttachedTerminal | null = null;
let sessionId = "";

function log(msg: string) {
  const line = document.createElement("div");
  line.className = "logline";
  line.textContent = msg;
  $(".log").prepend(line);
}

// Step 1 — connect: verify creds via STS GetCallerIdentity (which also gives us
// the account id we need to show the DNS name spored will register), then build
// a real EC2Provider-backed client.
$(".connect").addEventListener("click", async () => {
  region = val(".f-region") || "us-east-1";
  const accessKeyId = val(".f-akid");
  const secretAccessKey = val(".f-secret");
  const sessionToken = val(".f-token") || undefined;
  const whoami = $(".whoami");
  if (!accessKeyId || !secretAccessKey) {
    whoami.textContent = "Enter an access key id and secret.";
    whoami.className = "whoami err";
    return;
  }
  whoami.textContent = "Verifying…";
  whoami.className = "whoami";
  try {
    const sts = new STSClient({ region, credentials: { accessKeyId, secretAccessKey, sessionToken } });
    const id = await sts.send(new GetCallerIdentityCommand({}));
    accountId = id.Account ?? "";
    creds = { accessKeyId, secretAccessKey, sessionToken };
    whoami.innerHTML = `Connected to account <b>${accountId}</b> as <code>${escapeHtml(id.Arn ?? "")}</code>`;
    whoami.className = "whoami ok";

    client = new SpawnClient({
      provider: new EC2Provider({
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
        // The spored instance profile in the target account — required for the
        // instance to self-terminate and invoke the infra DNS Lambda.
        iamInstanceProfile: "spored-instance-profile",
      }),
    });
    client.startMonitor();

    $(".launch").hidden = false;
    updateDnsPreview();
  } catch (err) {
    whoami.textContent = `Could not authenticate: ${(err as Error).message}`;
    whoami.className = "whoami err";
  }
});

function updateDnsPreview() {
  if (!accountId) return;
  const name = val(".f-name") || "demo-direct";
  $(".dns-preview").innerHTML =
    `On launch, <code>spored</code> will register <b>${escapeHtml(sporeHostName(name, accountId))}</b> ` +
    `with the spore.host DNS Lambda — that's the instance-side "trust with infra".`;
}
$(".f-name").addEventListener("input", updateDnsPreview);

// Step 2 — launch a real t4g.nano with a bounded TTL into the connected account.
$(".go").addEventListener("click", async () => {
  if (!client) return;
  const name = val(".f-name") || "demo-direct";
  const ttl = ($<HTMLSelectElement>(".f-ttl")).value;
  ($<HTMLButtonElement>(".go")).disabled = true;
  $(".status").hidden = false;
  log(`Launching ${name} (t4g.nano, TTL ${ttl}) into account ${accountId}…`);
  try {
    const inst = await client.launch({
      name,
      instanceType: "t4g.nano",
      region,
      ttl,
      pricePerHour: 0.0042, // t4g.nano on-demand, us-east-1 (display/cost math only)
    });
    log(`Launched ${inst.instanceId} — state ${inst.state}.`);
    currentInstanceId = inst.instanceId;
    render(inst);
    poll(inst.instanceId, name);
  } catch (err) {
    log(`Launch failed: ${(err as Error).message}`);
    showReset();
  }
});

// Step 3b — connect a live shell over SSM once the instance is running. The
// browser calls ssm:StartSession itself (using the in-memory creds), gets a
// session-scoped StreamUrl + token, and opens a data-channel WebSocket. No SSH.
$(".connect-term").addEventListener("click", async () => {
  if (!creds || !currentInstanceId) return;
  const btn = $<HTMLButtonElement>(".connect-term");
  btn.disabled = true;
  btn.textContent = "Starting session…";
  try {
    const ssm = new SSMClient({ region, credentials: creds });
    const started = await ssm.send(new StartSessionCommand({ Target: currentInstanceId }));
    if (!started.StreamUrl || !started.TokenValue || !started.SessionId) {
      throw new Error("StartSession returned an incomplete session");
    }
    sessionId = started.SessionId;
    $(".term-wrap").hidden = false;
    btn.hidden = true;
    log(`SSM session ${sessionId} → opening shell…`);
    terminal = await attachTerminal(
      $(".term"),
      { streamUrl: started.StreamUrl, tokenValue: started.TokenValue, sessionId: started.SessionId },
      () => log(`SSM session ${sessionId} closed.`),
    );
  } catch (err) {
    log(`Terminal failed: ${(err as Error).message}`);
    btn.disabled = false;
    btn.textContent = "Connect terminal (SSM)";
  }
});

// Best-effort SSM session cleanup: close the socket and TerminateSession.
async function cleanupTerminal() {
  terminal?.dispose();
  terminal = null;
  if (creds && sessionId) {
    try {
      await new SSMClient({ region, credentials: creds }).send(new TerminateSessionCommand({ SessionId: sessionId }));
    } catch {
      /* session may already be gone */
    }
    sessionId = "";
  }
  $(".term-wrap").hidden = true;
  ($<HTMLDivElement>(".term")).innerHTML = "";
}

// Reveal the reset control when a run is done (terminated or failed) so the demo
// can be run again without re-entering credentials — the connected client is
// reused as-is.
function showReset() {
  ($<HTMLButtonElement>(".reset")).hidden = false;
}

// Reset for another run: keep the connection/creds, clear the per-run view and
// DNS state, and re-arm the launch button.
$(".reset").addEventListener("click", () => {
  void cleanupTerminal();
  currentInstanceId = "";
  dnsStatus = "pending";
  dnsConfirmed = false;
  $(".inst").innerHTML = "";
  $(".log").innerHTML = "";
  $(".status").hidden = true;
  ($<HTMLButtonElement>(".connect-term")).hidden = true;
  ($<HTMLButtonElement>(".connect-term")).disabled = false;
  ($<HTMLButtonElement>(".connect-term")).textContent = "Connect terminal (SSM)";
  ($<HTMLButtonElement>(".reset")).hidden = true;
  ($<HTMLButtonElement>(".go")).disabled = false;
  updateDnsPreview();
});

// Tracks the outcome of the DNS "trust with infra" check, shown in render().
let dnsStatus = "pending";
let dnsConfirmed = false;

// Poll the instance until it leaves the running set (spored self-terminates on
// TTL). The client's monitor loop is also running, but on a real backend it only
// observes — spored on the instance is what actually terminates. Alongside, once
// the instance has a public IP, resolve its spore.host name over DoH to PROVE
// spored actually registered it with infra (an instance-side action we can't see
// directly, but can confirm by resolution).
function poll(instanceId: string, name: string) {
  let announced = false;
  const timer = setInterval(async () => {
    if (!client) return;
    const inst = await client.get(instanceId);
    if (!inst) {
      log(`${name} no longer visible — terminated and reaped.`);
      clearInterval(timer);
      showReset();
      return;
    }
    void checkDns(inst);
    render(inst);
    // Offer the terminal once the box is running; withdraw + tear down the
    // session as soon as it starts winding down.
    ($<HTMLButtonElement>(".connect-term")).hidden = inst.state !== "running" || !!terminal;
    // Announce the self-terminate the first time we see it wind down, but keep
    // polling so the card reaches its true final state ("terminated") rather
    // than freezing on "shutting-down".
    if (!announced && (inst.state === "shutting-down" || inst.state === "terminated")) {
      announced = true;
      log(`✅ spored self-terminated ${instanceId} on its TTL.`);
      void cleanupTerminal();
      ($<HTMLButtonElement>(".connect-term")).hidden = true;
    }
    if (inst.state === "terminated") {
      clearInterval(timer);
      showReset();
    }
  }, 15_000);
}

// Resolve the computed spore.host name over public DoH and compare to the
// instance's public IP. Confirms the infra DNS registration end-to-end.
async function checkDns(inst: ManagedInstance) {
  if (dnsConfirmed || !accountId || !inst.publicIp) return;
  const fqdn = sporeHostName(inst.name, accountId);
  try {
    const ips = await resolveA(fqdn);
    if (ips.includes(inst.publicIp)) {
      dnsConfirmed = true;
      dnsStatus = `✅ resolves to ${inst.publicIp} — spored registered it with infra`;
      log(`✅ DNS "trust with infra" confirmed: ${fqdn} → ${inst.publicIp}`);
    } else if (ips.length) {
      dnsStatus = `resolves to ${ips.join(", ")} (waiting to match ${inst.publicIp})`;
    } else {
      dnsStatus = "not resolvable yet (spored registers shortly after boot)";
    }
  } catch (err) {
    dnsStatus = `lookup error: ${(err as Error).message}`;
  }
}

function render(inst: ManagedInstance) {
  const deadline = inst.ttlDeadlineMs ? new Date(inst.ttlDeadlineMs).toLocaleTimeString() : "—";
  const dns = accountId ? sporeHostName(inst.name, accountId) : "—";
  $(".inst").innerHTML = `
    <div class="row"><span>instance</span><code>${inst.instanceId}</code></div>
    <div class="row"><span>state</span><b class="state-${inst.state}">${inst.state}</b></div>
    <div class="row"><span>type</span>${inst.instanceType} · ${inst.region}</div>
    <div class="row"><span>public ip</span>${inst.publicIp ?? "—"}</div>
    <div class="row"><span>spore.host DNS</span><b>${escapeHtml(dns)}</b></div>
    <div class="row"><span>DNS trust</span>${escapeHtml(dnsStatus)}</div>
    <div class="row"><span>TTL deadline</span>${deadline}</div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
