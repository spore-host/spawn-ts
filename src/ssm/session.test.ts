import { describe, it, expect, beforeEach, vi } from "vitest";
import { SsmSession } from "./session.js";
import { serialize, deserialize, MessageType, PayloadType, type AgentMessage } from "./agent-message.js";

// A minimal in-memory WebSocket stub installed on globalThis, capturing what the
// session sends and letting the test push inbound frames.
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  // test helpers
  fireOpen() {
    this.onopen?.();
  }
  push(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}

function agentFrame(over: Partial<AgentMessage>): Promise<Uint8Array> {
  return serialize({
    messageType: MessageType.OutputStreamData,
    schemaVersion: 1,
    createdDate: 1,
    sequenceNumber: 0,
    flags: 0,
    messageId: "11111111-2222-3333-4444-555555555555",
    payloadType: PayloadType.Output,
    payload: new Uint8Array(0),
    ...over,
  });
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Wait until `pred` holds, polling on a 1 ms tick with a generous ceiling.
 *
 * The session's inbound path is async — it awaits WebCrypto digests before
 * sending ACKs and replies, and `markReady` awaits `flushPending` — so the
 * observable effect of pushing a frame lands some indeterminate number of
 * microtask+task turns later. A fixed sleep encodes a guess about that: 5 ms was
 * enough on an idle machine and not enough with 26 other test files in parallel
 * workers, which is how #61 flaked. Polling makes the test's *duration* track the
 * machine while its *verdict* tracks only correctness.
 *
 * `describe` what you're waiting for: the timeout message is the only diagnostic
 * a CI failure will show.
 */
async function waitFor(pred: () => boolean, describe: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${describe}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Wait until the socket has captured at least `n` sent frames. */
function waitForSends(ws: FakeWebSocket, n: number): Promise<void> {
  return waitFor(() => ws.sent.length >= n, `${n} sent frame(s), have ${ws.sent.length}`);
}

/**
 * The client→agent stream frames the session has sent, deserialized. Skips the
 * token JSON, which is the one send that is a string rather than a binary frame.
 */
function sentFrames(ws: FakeWebSocket): AgentMessage[] {
  return ws.sent.filter((b) => typeof b !== "string").map((b) => deserialize(new Uint8Array(b as Uint8Array)));
}

/** Frames carrying an Output payload — i.e. keystrokes reaching the shell. */
function inputFrames(ws: FakeWebSocket): AgentMessage[] {
  return sentFrames(ws).filter((m) => m.payloadType === PayloadType.Output);
}

describe("SsmSession", () => {
  beforeEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    FakeWebSocket.last = null;
  });

  async function opened(handlers = {}) {
    const s = new SsmSession({ streamUrl: "wss://x/data-channel/s?stream=input", tokenValue: "TOK", sessionId: "s-1" }, handlers);
    const p = s.open();
    FakeWebSocket.last!.fireOpen();
    await p;
    return { s, ws: FakeWebSocket.last! };
  }

  it("sends the token JSON as the first message on open", async () => {
    const { ws } = await opened();
    expect(ws.sent).toHaveLength(1);
    const first = JSON.parse(ws.sent[0] as string);
    expect(first).toMatchObject({ MessageSchemaVersion: "1.0", TokenValue: "TOK", ClientVersion: "1.0.0" });
    expect(first.RequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.ClientId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ACKs an inbound output message and surfaces the text", async () => {
    const seen: string[] = [];
    const { ws } = await opened({ onOutput: (t: string) => seen.push(t) });
    ws.sent.length = 0;
    ws.push(await agentFrame({ payloadType: PayloadType.Output, payload: enc.encode("$ ") }));
    await waitForSends(ws, 1);
    // an ACK frame was sent back
    const ack = deserialize(new Uint8Array(ws.sent[0] as ArrayBuffer));
    expect(ack.messageType).toBe(MessageType.Acknowledge);
    const content = JSON.parse(dec.decode(ack.payload));
    expect(content.AcknowledgedMessageType).toBe(MessageType.OutputStreamData);
    // and the output was delivered
    expect(seen).toEqual(["$ "]);
  });

  it("replies to a handshake request and marks ready on complete", async () => {
    const { s, ws } = await opened();
    ws.sent.length = 0;
    ws.push(await agentFrame({ payloadType: PayloadType.HandshakeRequest, payload: enc.encode("{}") }));
    await waitForSends(ws, 2); // ACK + handshake response
    // it ACKs, then sends an input_stream_data handshake response
    const kinds = ws.sent.map((b) => deserialize(new Uint8Array(b as ArrayBuffer)));
    expect(kinds.some((k) => k.messageType === MessageType.Acknowledge)).toBe(true);
    const resp = kinds.find((k) => k.messageType === MessageType.InputStreamData);
    expect(resp?.payloadType).toBe(PayloadType.HandshakeResponse);
    expect(s.ready).toBe(false);

    ws.push(await agentFrame({ payloadType: PayloadType.HandshakeComplete, payload: enc.encode("{}") }));
    // HandshakeComplete sends nothing back, so there is no frame to wait on —
    // `ready` itself is the observable effect, and it's the assertion.
    await waitFor(() => s.ready, "the session to report ready after HandshakeComplete");
    expect(s.ready).toBe(true);
  });

  // Bring the session to the ready (post-handshake) state so input/size flush.
  // Waits for `ready` before clearing: `markReady` is called with `void` inside the
  // inbound handler, so nothing awaits its flush, and a premature clear would drop
  // frames the caller's own assertions are about to read.
  async function makeReady(s: SsmSession, ws: FakeWebSocket) {
    ws.push(await agentFrame({ payloadType: PayloadType.HandshakeComplete, payload: enc.encode("{}") }));
    await waitFor(() => s.ready, "the session to report ready before clearing sent frames");
    ws.sent.length = 0;
  }

  it("normalizes a lone LF to CR on input, with Flags=0 (no SYN)", async () => {
    const { s, ws } = await opened();
    await makeReady(s, ws);
    await s.sendInput("\n");
    const m = deserialize(new Uint8Array(ws.sent[0] as ArrayBuffer));
    expect(m.messageType).toBe(MessageType.InputStreamData);
    expect(m.payloadType).toBe(PayloadType.Output);
    expect(m.flags).toBe(0); // reference client never sets the SYN bit
    expect(dec.decode(m.payload)).toBe("\r");
  });

  it("sends a Size payload on resize", async () => {
    const { s, ws } = await opened();
    await makeReady(s, ws);
    await s.resize(100, 30);
    const m = deserialize(new Uint8Array(ws.sent[0] as ArrayBuffer));
    expect(m.payloadType).toBe(PayloadType.Size);
    expect(JSON.parse(dec.decode(m.payload))).toEqual({ cols: 100, rows: 30 });
  });

  it("queues input sent BEFORE handshake completes, then flushes on ready", async () => {
    const { s, ws } = await opened();
    ws.sent.length = 0;
    // type before HandshakeComplete — must NOT send yet (agent would drop it)
    await s.sendInput("whoami\r");
    expect(ws.sent.length).toBe(0);
    // handshake completes → queued input flushes
    ws.push(await agentFrame({ payloadType: PayloadType.HandshakeComplete, payload: enc.encode("{}") }));
    // Wait for the queued input itself, not for a duration: this assertion is about
    // input being *queued rather than dropped*, so it must fail only when the flush
    // path is broken — never because a loaded machine was slower than a guess.
    await waitFor(() => inputFrames(ws).length > 0, "the queued input to flush on ready");
    const inputs = inputFrames(ws);
    expect(dec.decode(inputs[0].payload)).toBe("whoami\r");
  });

  it("closes and reports channel-closed from the agent", async () => {
    const onClose = vi.fn();
    const { ws } = await opened({ onClose });
    ws.push(await agentFrame({ messageType: MessageType.ChannelClosed, payloadType: PayloadType.Output }));
    await waitFor(() => onClose.mock.calls.length > 0 && ws.closed, "the close to be reported and the socket closed");
    expect(onClose).toHaveBeenCalled();
    expect(ws.closed).toBe(true);
  });
});
