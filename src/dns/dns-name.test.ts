import { describe, it, expect } from "vitest";
import { encodeAccountId, sporeHostName, SPORE_DOMAIN } from "./dns-name.js";

describe("encodeAccountId", () => {
  it("renders a 12-digit account id as lowercase base36 (matches Go big.Int.Text(36))", () => {
    // Cross-checked against the Go lambda/dns-updater/main.go doc comment and Python.
    expect(encodeAccountId("123456789012")).toBe("1kpqzg2c");
  });

  it("matches the spore-host dev + infra account encodings", () => {
    expect(encodeAccountId("435415984226")).toBe(BigInt("435415984226").toString(36));
    expect(encodeAccountId("966362334030")).toBe(BigInt("966362334030").toString(36));
  });

  it("is lowercase", () => {
    const enc = encodeAccountId("999999999999");
    expect(enc).toBe(enc.toLowerCase());
  });

  it("rejects non-numeric account ids", () => {
    expect(() => encodeAccountId("not-an-account")).toThrow(/invalid account id/);
    expect(() => encodeAccountId("12ab34")).toThrow(/invalid account id/);
    expect(() => encodeAccountId("")).toThrow(/invalid account id/);
  });
});

describe("sporeHostName", () => {
  it("builds {record}.{base36(account)}.spore.host", () => {
    expect(sporeHostName("demo-direct", "123456789012")).toBe("demo-direct.1kpqzg2c.spore.host");
  });

  it("uses the spore.host domain by default", () => {
    expect(sporeHostName("x", "1").endsWith(`.${SPORE_DOMAIN}`)).toBe(true);
  });

  it("allows a custom domain override", () => {
    expect(sporeHostName("x", "123456789012", "example.test")).toBe("x.1kpqzg2c.example.test");
  });
});
