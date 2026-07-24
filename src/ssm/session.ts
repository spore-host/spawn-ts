// SsmSession — a browser-native SSM Session Manager shell client. Given the
// StreamUrl + TokenValue from an ssm:StartSession response, it opens the
// data-channel WebSocket, authenticates with the token first-message, drives the
// agent handshake, ACKs inbound data, and exposes a simple shell I/O surface.
//
// No AWS credentials are used here — only the session-scoped StreamUrl/TokenValue.
// (StartSession itself is called elsewhere: by the browser with the user's creds
// in Demo 1, or by the portal Lambda in Demo 2.)

import {
  serialize,
  deserialize,
  acknowledgeContent,
  sizePayload,
  MessageType,
  PayloadType,
  type AgentMessage,
} from "./agent-message.js";

export interface SsmSessionInit {
  streamUrl: string;
  tokenValue: string;
  sessionId: string;
}

export interface SsmSessionHandlers {
  onOutput?: (text: string) => void;
  onClose?: (reason?: string) => void;
  onError?: (err: Error) => void;
}

const CLIENT_VERSION = "1.0.0";
const SCHEMA_VERSION = "1.0";

// A v4 UUID from WebCrypto (available in browsers and Node ≥ 16).
function uuidv4(): string {
  return crypto.randomUUID();
}

export class SsmSession {
  private ws: WebSocket | null = null;
  private seq = 0;
  private handshakeDone = false;
  private readonly clientId = uuidv4();
  private readonly dec = new TextDecoder();
  private readonly enc = new TextEncoder();

  constructor(
    private readonly init: SsmSessionInit,
    private readonly handlers: SsmSessionHandlers = {},
  ) {}

  /** Open the data channel and authenticate. Resolves once the socket is open. */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.init.streamUrl);
      } catch (err) {
        reject(err as Error);
        return;
      }
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      ws.onopen = () => {
        // The token first-message (JSON TEXT) authenticates the channel.
        ws.send(
          JSON.stringify({
            MessageSchemaVersion: SCHEMA_VERSION,
            RequestId: uuidv4(),
            TokenValue: this.init.tokenValue,
            ClientId: this.clientId,
            ClientVersion: CLIENT_VERSION,
          }),
        );
        resolve();
      };
      ws.onmessage = (ev) => void this.onMessage(ev);
      ws.onerror = () => this.handlers.onError?.(new Error("websocket error"));
      ws.onclose = (ev) => this.handlers.onClose?.(ev.reason || `closed (${ev.code})`);
    });
  }

  private async onMessage(ev: MessageEvent) {
    // The token handshake reply and any control frames may arrive as text; shell
    // traffic is binary agent-messages.
    if (typeof ev.data === "string") return;
    const bytes = new Uint8Array(ev.data as ArrayBuffer);
    let m: AgentMessage;
    try {
      m = deserialize(bytes);
    } catch (err) {
      this.handlers.onError?.(err as Error);
      return;
    }

    // Every inbound data/handshake message must be acknowledged.
    if (m.messageType === MessageType.OutputStreamData) {
      await this.sendAck(m);
      await this.handleOutput(m);
    } else if (m.messageType === MessageType.ChannelClosed) {
      this.handlers.onClose?.("channel closed by agent");
      this.ws?.close();
    }
    // acknowledge / publication-control messages need no response.
  }

  private async handleOutput(m: AgentMessage) {
    switch (m.payloadType) {
      case PayloadType.Output:
      case PayloadType.StdErr:
      case PayloadType.Error:
        // Shell output flowing means the session is live — some agents don't send
        // a distinct HandshakeComplete for a default shell, so treat first output
        // as "ready" too (flushes any queued input).
        void this.markReady();
        this.handlers.onOutput?.(this.dec.decode(m.payload));
        break;
      case PayloadType.HandshakeRequest:
        // Reply with a handshake response echoing the requested actions. A
        // minimal response (empty ProcessedClientActions) is accepted for a
        // default Standard_Stream shell. Sent directly (not gated) — this is what
        // drives the handshake toward completion.
        await this.sendData(PayloadType.HandshakeResponse, this.enc.encode(JSON.stringify({
          ClientVersion: CLIENT_VERSION,
          ProcessedClientActions: [],
          Errors: [],
        })));
        break;
      case PayloadType.HandshakeComplete:
        void this.markReady();
        break;
      // ExitCode / others: ignore for a shell demo.
    }
  }

  // Mark the shell live and flush any input queued before the handshake finished.
  private async markReady(): Promise<void> {
    if (this.handshakeDone) return;
    this.handshakeDone = true;
    await this.flushPending();
  }

  private async sendAck(m: AgentMessage) {
    const ack: AgentMessage = {
      messageType: MessageType.Acknowledge,
      schemaVersion: 1,
      createdDate: nowMs(),
      sequenceNumber: 0,
      flags: 3,
      messageId: uuidv4(),
      payloadType: 0,
      payload: acknowledgeContent(m),
    };
    this.ws?.send(await serialize(ack));
  }

  // One monotonic sequence counter shared by ALL client→agent stream messages
  // (handshake response, size, keystrokes), starting at 0. Flags is ALWAYS 0 —
  // the AWS reference client never sets the SYN bit (verified against
  // session-manager-plugin). Setting it here caused the agent to drop input.
  private async sendData(payloadType: number, payload: Uint8Array) {
    const m: AgentMessage = {
      messageType: MessageType.InputStreamData,
      schemaVersion: 1,
      createdDate: nowMs(),
      sequenceNumber: this.seq++,
      flags: 0,
      messageId: uuidv4(),
      payloadType,
      payload,
    };
    this.ws?.send(await serialize(m));
  }

  // Input/size sent before the handshake completes never reaches the shell (the
  // agent hasn't started the shell plugin yet). Queue until ready, then flush.
  private pending: Array<{ payloadType: number; payload: Uint8Array }> = [];

  private async enqueueOrSend(payloadType: number, payload: Uint8Array): Promise<void> {
    if (this.handshakeDone) {
      await this.sendData(payloadType, payload);
    } else {
      this.pending.push({ payloadType, payload });
    }
  }

  private async flushPending(): Promise<void> {
    const q = this.pending;
    this.pending = [];
    for (const { payloadType, payload } of q) await this.sendData(payloadType, payload);
  }

  /** Send terminal keystrokes. A lone LF is normalized to CR (as the plugin does). */
  async sendInput(text: string): Promise<void> {
    const normalized = text === "\n" ? "\r" : text;
    await this.enqueueOrSend(PayloadType.Output, this.enc.encode(normalized));
  }

  /** Send a terminal resize. */
  async resize(cols: number, rows: number): Promise<void> {
    await this.enqueueOrSend(PayloadType.Size, sizePayload(cols, rows));
  }

  /** True once the agent handshake has completed and the shell is live. */
  get ready(): boolean {
    return this.handshakeDone;
  }

  /** Close the WebSocket (does not call ssm:TerminateSession — the caller does). */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

// Timestamp helper isolated so the session module has one obvious clock touchpoint.
function nowMs(): number {
  return Date.now();
}
