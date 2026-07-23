// Portal browser terminal — bundled to public/portal-terminal.js (esbuild).
//
// Exposes a single global the static portal UI (portal.js) calls. It fetches a
// PORTAL-BROKERED SSM session (only {sessionId, streamUrl, tokenValue} — never
// AWS creds) from the portal's own endpoint, then opens the SSM data channel in
// the browser and renders it with xterm. The portal is the sole authorizer; the
// user cannot mint a session themselves.

import { attachTerminal, type AttachedTerminal } from "../lib/terminal.js";

let active: { term: AttachedTerminal; sessionId: string } | null = null;

async function openPortalTerminal(instanceId: string, container: HTMLElement): Promise<void> {
  await closePortalTerminal();
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `session start failed (${res.status})`);

  const term = await attachTerminal(
    container,
    { streamUrl: data.streamUrl, tokenValue: data.tokenValue, sessionId: data.sessionId },
    () => {
      void terminatePortalSession(data.sessionId);
    },
  );
  active = { term, sessionId: data.sessionId };
}

async function terminatePortalSession(sessionId: string): Promise<void> {
  try {
    await fetch("/api/session/terminate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  } catch {
    /* best effort */
  }
}

async function closePortalTerminal(): Promise<void> {
  if (!active) return;
  const { term, sessionId } = active;
  active = null;
  term.dispose();
  await terminatePortalSession(sessionId);
}

// Expose to the static portal UI.
declare global {
  interface Window {
    portalTerminal: {
      open: (instanceId: string, container: HTMLElement) => Promise<void>;
      close: () => Promise<void>;
    };
  }
}
window.portalTerminal = { open: openPortalTerminal, close: closePortalTerminal };
