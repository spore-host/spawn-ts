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

// The session's inbound handler is async (it awaits WebCrypto digests before
// sending ACKs/replies), so wait until the socket has captured `n` sent frames
// rather than counting microtasks.
async function waitForSends(ws: FakeWebSocket, n: number, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (ws.sent.length < n) {
    if (Date.now() - start > timeoutMs) throw new Error(`only ${ws.sent.length}/${n} frames sent`);
    await new Promise((r) => setTimeout(r, 1));
  }
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
    await waitForSends(ws, 3).catch(() => {}); // complete triggers no send; just let the tick run
    await new Promise((r) => setTimeout(r, 5));
    expect(s.ready).toBe(true);
  });

  // Bring the session to the ready (post-handshake) state so input/size flush.
  async function makeReady(s: SsmSession, ws: FakeWebSocket) {
    ws.push(await agentFrame({ payloadType: PayloadType.HandshakeComplete, payload: enc.encode("{}") }));
    await new Promise((r) => setTimeout(r, 5));
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
    await new Promise((r) => setTimeout(r, 5));
    const inputs = ws.sent.map((b) => deserialize(new Uint8Array(b as ArrayBuffer))).filter((m) => m.payloadType === PayloadType.Output);
    expect(inputs.length).toBeGreaterThan(0);
    expect(dec.decode(inputs[0].payload)).toBe("whoami\r");
  });

  it("closes and reports channel-closed from the agent", async () => {
    const onClose = vi.fn();
    const { ws } = await opened({ onClose });
    ws.push(await agentFrame({ messageType: MessageType.ChannelClosed, payloadType: PayloadType.Output }));
    await new Promise((r) => setTimeout(r, 5));
    expect(onClose).toHaveBeenCalled();
    expect(ws.closed).toBe(true);
  });
});
