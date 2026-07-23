// xterm glue for the demos: given the StartSession tuple, wire an SsmSession to a
// live terminal in a container element. Shared by Demo 1 (direct) — and reusable
// by any consumer that already has a {streamUrl, tokenValue, sessionId}.

import { Terminal } from "@xterm/xterm";
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
  term.open(container);
  term.writeln("connecting…");

  const session = new SsmSession(init, {
    onOutput: (text) => term.write(text),
    onClose: (reason) => {
      term.writeln(`\r\n\x1b[90m[session closed${reason ? `: ${reason}` : ""}]\x1b[0m`);
      onClosed?.(reason);
    },
    onError: (err) => term.writeln(`\r\n\x1b[31m[error: ${err.message}]\x1b[0m`),
  });

  await session.open();
  // Pipe keystrokes to the session; report the initial size.
  term.onData((d) => void session.sendInput(d));
  term.onResize(({ cols, rows }) => void session.resize(cols, rows));
  void session.resize(term.cols, term.rows);

  return {
    term,
    session,
    dispose: () => {
      session.close();
      term.dispose();
    },
  };
}
