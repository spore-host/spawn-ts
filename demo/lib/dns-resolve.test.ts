import { describe, it, expect, vi } from "vitest";
import { resolveA } from "./dns-resolve.js";

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe("resolveA", () => {
  it("returns the A-record IPs from a DoH JSON answer", async () => {
    const f = fakeFetch({
      Answer: [
        { name: "x.spore.host", type: 1, data: "203.0.113.7" },
        { name: "x.spore.host", type: 1, data: "203.0.113.8" },
      ],
    });
    expect(await resolveA("x.spore.host", f)).toEqual(["203.0.113.7", "203.0.113.8"]);
  });

  it("filters out non-A records (e.g. CNAME type 5)", async () => {
    const f = fakeFetch({
      Answer: [
        { name: "x", type: 5, data: "alias.spore.host" },
        { name: "x", type: 1, data: "203.0.113.9" },
      ],
    });
    expect(await resolveA("x", f)).toEqual(["203.0.113.9"]);
  });

  it("returns [] when the name does not resolve (no Answer section)", async () => {
    expect(await resolveA("missing", fakeFetch({}))).toEqual([]);
  });

  it("passes the DoH query params and json accept header", async () => {
    const f = fakeFetch({ Answer: [] });
    await resolveA("host.example", f, "https://doh.test/q");
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://doh.test/q?name=host.example&type=A");
    expect((init as RequestInit).headers).toMatchObject({ accept: "application/dns-json" });
  });

  it("throws only when the HTTP call itself fails", async () => {
    await expect(resolveA("x", fakeFetch({}, false, 500))).rejects.toThrow(/DoH query failed: 500/);
  });
});
