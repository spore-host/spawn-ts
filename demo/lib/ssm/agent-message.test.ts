import { describe, it, expect } from "vitest";
import {
  serialize,
  deserialize,
  uuidToBytes,
  bytesToUuid,
  acknowledgeContent,
  sizePayload,
  MessageType,
  PayloadType,
  type AgentMessage,
} from "./agent-message.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function msg(over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    messageType: MessageType.InputStreamData,
    schemaVersion: 1,
    createdDate: 1_700_000_000_000,
    sequenceNumber: 0,
    flags: 0,
    messageId: "12345678-9abc-def0-1234-56789abcdef0",
    payloadType: PayloadType.Output,
    payload: enc.encode("hello"),
    ...over,
  };
}

describe("uuid <-> bytes", () => {
  it("round-trips a hyphenated UUID", () => {
    const u = "12345678-9abc-def0-1234-56789abcdef0";
    expect(bytesToUuid(uuidToBytes(u))).toBe(u);
  });
  it("rejects a malformed uuid", () => {
    expect(() => uuidToBytes("not-a-uuid")).toThrow(/invalid uuid/);
  });
});

describe("serialize / deserialize", () => {
  it("round-trips every field", async () => {
    const m = msg({ sequenceNumber: 42, flags: 3, createdDate: 1_712_345_678_901 });
    const round = deserialize(await serialize(m));
    expect(round.messageType).toBe(m.messageType);
    expect(round.schemaVersion).toBe(1);
    expect(round.createdDate).toBe(m.createdDate);
    expect(round.sequenceNumber).toBe(42);
    expect(round.flags).toBe(3);
    expect(round.messageId).toBe(m.messageId);
    expect(round.payloadType).toBe(PayloadType.Output);
    expect(dec.decode(round.payload)).toBe("hello");
  });

  it("writes HeaderLength = 116 and payload at offset 120", async () => {
    const bytes = await serialize(msg());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0)).toBe(116); // HeaderLength
    expect(dec.decode(bytes.subarray(120, 125))).toBe("hello"); // payload starts at 120
  });

  it("space-pads the 32-byte MessageType field", async () => {
    const bytes = await serialize(msg({ messageType: MessageType.Acknowledge }));
    const field = bytes.subarray(4, 36);
    expect(dec.decode(field.subarray(0, 11))).toBe("acknowledge");
    // remaining bytes are ASCII spaces (0x20)
    expect(Array.from(field.subarray(11)).every((b) => b === 0x20)).toBe(true);
  });

  it("swaps the two 8-byte halves of the MessageId on the wire", async () => {
    const m = msg({ messageId: "00112233-4455-6677-8899-aabbccddeeff" });
    const bytes = await serialize(m);
    const onWire = bytes.subarray(64, 80);
    // standard order is 00112233445566778899aabbccddeeff; on the wire the
    // low half (8899aabbccddeeff) comes first, then the high half.
    expect(Array.from(onWire.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      "8899aabbccddeeff",
    );
    expect(Array.from(onWire.subarray(8), (b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      "0011223344556677",
    );
    // but it must deserialize back to the canonical order
    expect(deserialize(bytes).messageId).toBe("00112233-4455-6677-8899-aabbccddeeff");
  });

  it("writes the SHA-256 of the payload as the digest", async () => {
    const payload = enc.encode("digest me");
    const bytes = await serialize(msg({ payload }));
    const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
    expect(Array.from(bytes.subarray(80, 112))).toEqual(Array.from(expected));
  });

  it("handles an empty payload", async () => {
    const round = deserialize(await serialize(msg({ payload: new Uint8Array(0) })));
    expect(round.payload.length).toBe(0);
  });

  it("preserves a large sequence number beyond 32 bits", async () => {
    const big = 0x1_0000_0005; // > 2^32
    const round = deserialize(await serialize(msg({ sequenceNumber: big })));
    expect(round.sequenceNumber).toBe(big);
  });
});

describe("payload builders", () => {
  it("acknowledgeContent mirrors the inbound message identity", () => {
    const inbound = msg({ messageType: MessageType.OutputStreamData, sequenceNumber: 7, messageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    const ack = JSON.parse(dec.decode(acknowledgeContent(inbound)));
    expect(ack).toEqual({
      AcknowledgedMessageType: "output_stream_data",
      AcknowledgedMessageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      AcknowledgedMessageSequenceNumber: 7,
      IsSequentialMessage: true,
    });
  });

  it("sizePayload emits {cols,rows}", () => {
    expect(JSON.parse(dec.decode(sizePayload(120, 40)))).toEqual({ cols: 120, rows: 40 });
  });
});
