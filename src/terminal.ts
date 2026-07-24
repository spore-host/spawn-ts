// xterm glue for the demos: given the StartSession tuple, wire an SsmSession to a
// live terminal in a container element. Shared by Demo 1 (direct) — and reusable
// by any consumer that already has a {streamUrl, tokenValue, sessionId}.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { SsmSession, type SsmSessionInit } from "./ssm/index.js";

export interface AttachedTerminal {
  term: Terminal;
  session: SsmSession;
  dispose: () => void;
}

/**
 * Open an SSM shell into `container`, rendering with xterm. Returns handles plus
 * a dispose() that closes the session and terminal. `onClosed` fires when the
 * channel closes (agent exit / socket close).
 */
export async function attachTerminal(
  container: HTMLElement,
  init: SsmSessionInit,
  onClosed?: (reason?: string) => void,
): Promise<AttachedTerminal> {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    theme: { background: "#0d0f14", foreground: "#e6e9ef" },
  });
  // Fit the terminal to its container (otherwise xterm defaults to 24 rows and
  // overflows the fixed-height panel).
  const fit = new FitAddon();
  term.loadAddon(fit);
  // The container was just un-hidden (display:none → block); open/fit/focus must
  // run AFTER layout settles or xterm's helper-textarea won't take focus (keys go
  // nowhere) and fit measures a zero-size box. Wait one frame.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  term.open(container);
  fit.fit();
  term.focus(); // capture keystrokes — without this, input goes nowhere
  // Fallback: clicking anywhere in the panel refocuses the terminal.
  container.addEventListener("mousedown", () => term.focus());
  term.writeln("connecting…");

  // Keep the terminal sized to its container on window resize.
  const onWinResize = () => {
    try {
      fit.fit();
    } catch {
      /* container may be detached */
    }
  };
  window.addEventListener("resize", onWinResize);

  const session = new SsmSession(init, {
    onOutput: (text) => term.write(text),
    onClose: (reason) => {
      term.writeln(`\r\n\x1b[90m[session closed${reason ? `: ${reason}` : ""}]\x1b[0m`);
      onClosed?.(reason);
    },
    onError: (err) => term.writeln(`\r\n\x1b[31m[error: ${err.message}]\x1b[0m`),
  });

  await session.open();
  // Pipe keystrokes to the session; report the initial (fitted) size.
  term.onData((d) => void session.sendInput(d));
  term.onResize(({ cols, rows }) => void session.resize(cols, rows));
  fit.fit();
  term.focus();
  void session.resize(term.cols, term.rows);

  return {
    term,
    session,
    dispose: () => {
      window.removeEventListener("resize", onWinResize);
      session.close();
      term.dispose();
    },
  };
}
