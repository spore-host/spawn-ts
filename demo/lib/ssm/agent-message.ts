// A minimal reimplementation of the AWS SSM Session Manager "agent message"
// binary protocol — the framing that carries shell I/O over the data-channel
// WebSocket. The AWS SDK does not implement this layer; the reference is the
// Apache-2.0 `aws/session-manager-plugin` (src/message/clientmessage.go +
// messageparser.go). We port only what a browser shell client needs.
//
// Wire frame (all big-endian):
//   off  0  u32   HeaderLength (= 116, the offset of PayloadLength)
//   off  4  [32]  MessageType, space-padded ASCII
//   off 36  u32   SchemaVersion (= 1)
//   off 40  u64   CreatedDate (epoch ms)
//   off 48  i64   SequenceNumber
//   off 56  u64   Flags
//   off 64  [16]  MessageId (UUID; the two 8-byte halves are SWAPPED on the wire)
//   off 80  [32]  PayloadDigest (SHA-256 of Payload)
//   off 112 u32   PayloadType
//   off 116 u32   PayloadLength
//   off 120 ...   Payload

export const MessageType = {
  InputStreamData: "input_stream_data",
  OutputStreamData: "output_stream_data",
  Acknowledge: "acknowledge",
  ChannelClosed: "channel_closed",
  StartPublication: "start_publication",
  PausePublication: "pause_publication",
} as const;

export const PayloadType = {
  Output: 1,
  Error: 2,
  Size: 3,
  Parameter: 4,
  HandshakeRequest: 5,
  HandshakeResponse: 6,
  HandshakeComplete: 7,
  EncChallengeRequest: 8,
  EncChallengeResponse: 9,
  Flag: 10,
  StdErr: 11,
  ExitCode: 12,
} as const;

// Field offsets/lengths (bytes) — mirror the plugin's ClientMessage_* constants.
const O_HL = 0;
const O_MSGTYPE = 4;
const L_MSGTYPE = 32;
const O_SCHEMA = 36;
const O_CREATED = 40;
const O_SEQ = 48;
const O_FLAGS = 56;
const O_MSGID = 64;
const O_DIGEST = 80;
const O_PTYPE = 112;
const O_PLEN = 116;
const O_PAYLOAD = 120;
const HEADER_LENGTH = O_PLEN; // serialized HeaderLength value = 116

export interface AgentMessage {
  messageType: string;
  schemaVersion: number;
  createdDate: number;
  sequenceNumber: number;
  flags: number;
  messageId: string; // canonical UUID string (hyphenated)
  payloadType: number;
  payload: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** SHA-256 of the payload via WebCrypto. */
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(buf);
}

/** Parse a hyphenated UUID string into its 16 raw bytes (standard order). */
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`invalid uuid: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Render 16 raw bytes (standard order) as a hyphenated UUID string. */
export function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The plugin writes the least-significant 8 bytes first, then the most-significant
// 8 bytes — i.e. the two halves are swapped relative to standard UUID byte order.
function writeUuidSwapped(view: DataView, offset: number, uuid: string) {
  const b = uuidToBytes(uuid);
  for (let i = 0; i < 8; i++) view.setUint8(offset + i, b[i + 8]); // LSB half first
  for (let i = 0; i < 8; i++) view.setUint8(offset + 8 + i, b[i]); // MSB half second
}
function readUuidSwapped(view: DataView, offset: number): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 8; i++) b[i + 8] = view.getUint8(offset + i);
  for (let i = 0; i < 8; i++) b[i] = view.getUint8(offset + 8 + i);
  return bytesToUuid(b);
}

/** Serialize an AgentMessage to the binary wire frame (async: computes the digest). */
export async function serialize(msg: AgentMessage): Promise<Uint8Array> {
  const digest = await sha256(msg.payload);
  const buf = new ArrayBuffer(O_PAYLOAD + msg.payload.length);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint32(O_HL, HEADER_LENGTH);

  // MessageType, space-padded to 32 bytes.
  bytes.fill(0x20, O_MSGTYPE, O_MSGTYPE + L_MSGTYPE);
  bytes.set(enc.encode(msg.messageType), O_MSGTYPE);

  view.setUint32(O_SCHEMA, msg.schemaVersion);
  setU64(view, O_CREATED, msg.createdDate);
  setU64(view, O_SEQ, msg.sequenceNumber);
  setU64(view, O_FLAGS, msg.flags);
  writeUuidSwapped(view, O_MSGID, msg.messageId);
  bytes.set(digest, O_DIGEST);
  view.setUint32(O_PTYPE, msg.payloadType);
  view.setUint32(O_PLEN, msg.payload.length);
  bytes.set(msg.payload, O_PAYLOAD);

  return bytes;
}

/** Deserialize a binary wire frame into an AgentMessage. */
export function deserialize(input: Uint8Array): AgentMessage {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const messageType = dec.decode(input.subarray(O_MSGTYPE, O_MSGTYPE + L_MSGTYPE)).replace(/\0/g, "").trim();
  const payloadType = view.getUint32(O_PTYPE);
  const payloadLength = view.getUint32(O_PLEN);
  const payload = input.subarray(O_PAYLOAD, O_PAYLOAD + payloadLength);
  return {
    messageType,
    schemaVersion: view.getUint32(O_SCHEMA),
    createdDate: getU64(view, O_CREATED),
    sequenceNumber: getU64(view, O_SEQ),
    flags: getU64(view, O_FLAGS),
    messageId: readUuidSwapped(view, O_MSGID),
    payloadType,
    payload,
  };
}

// 64-bit helpers. Sequence numbers/dates here stay well under 2^53, so Number is
// safe; we write via two 32-bit halves to avoid BigInt churn.
function setU64(view: DataView, offset: number, value: number) {
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value >>> 0;
  view.setUint32(offset, high);
  view.setUint32(offset + 4, low);
}
function getU64(view: DataView, offset: number): number {
  const high = view.getUint32(offset);
  const low = view.getUint32(offset + 4);
  return high * 0x1_0000_0000 + low;
}

// --- Payload JSON shapes -------------------------------------------------------

export interface AcknowledgeContent {
  AcknowledgedMessageType: string;
  AcknowledgedMessageId: string;
  AcknowledgedMessageSequenceNumber: number;
  IsSequentialMessage: boolean;
}

/** Build the acknowledge payload JSON for an inbound message. */
export function acknowledgeContent(msg: AgentMessage): Uint8Array {
  const content: AcknowledgeContent = {
    AcknowledgedMessageType: msg.messageType,
    AcknowledgedMessageId: msg.messageId,
    AcknowledgedMessageSequenceNumber: msg.sequenceNumber,
    IsSequentialMessage: true,
  };
  return enc.encode(JSON.stringify(content));
}

/** Build the terminal-size payload JSON. */
export function sizePayload(cols: number, rows: number): Uint8Array {
  return enc.encode(JSON.stringify({ cols, rows }));
}
