// parseLifetimeDuration / parseTtl, with Go's pkg/ttl/parse_test.go cases
// ported verbatim (v0.149.0) so the two parsers cannot drift (#990).

import { describe, it, expect } from "vitest";
import { parseDuration, parseLifetimeDuration, parseTtl } from "./duration.js";

const H = 3_600_000;
const M = 60_000;
const S = 1000;

describe("parseLifetimeDuration (Go TestParseDurationAccepts)", () => {
  const cases: [string, number][] = [
    ["1d", 24 * H], // the #990 repro
    ["2d", 48 * H],
    ["2d12h", 60 * H],
    ["1d30m", 24 * H + 30 * M],
    ["1.5d", 36 * H],
    ["0.5d", 12 * H],
    ["1d2h30m15s", 26 * H + 30 * M + 15 * S],
    ["12h1d", 36 * H],
    ["8h", 8 * H],
    ["90m", 90 * M],
    ["1h30m", 90 * M],
    ["1.5h", 90 * M],
    ["30s", 30 * S],
    ["500ms", 500],
    ["1us", 1e-3],
    ["1µs", 1e-3],
    ["1ns", 1e-6],
    ["0", 0],
    ["0s", 0],
  ];
  for (const [input, want] of cases) {
    it(`accepts ${input}`, () => {
      expect(parseLifetimeDuration(input)).toBeCloseTo(want, 9);
    });
  }
});

describe("parseLifetimeDuration agrees with Go syntax (TestParseDurationAgreesWithGoOnGoSyntax)", () => {
  const cases: [string, number][] = [
    ["1h", H],
    ["1h30m", 90 * M],
    ["2.5h", 150 * M],
    ["90m", 90 * M],
    ["45s", 45 * S],
    ["100ms", 100],
    ["1m0s", M],
    ["24h0m0s", 24 * H],
    ["0", 0],
    ["3h2m1s500ms", 3 * H + 2 * M + S + 500],
    [".5h", 30 * M],
    ["1.h", H],
  ];
  for (const [input, want] of cases) {
    it(`parses ${input} as time.ParseDuration does`, () => {
      expect(parseLifetimeDuration(input)).toBeCloseTo(want, 9);
    });
  }
});

describe("parseLifetimeDuration rejects (TestParseDurationRejects)", () => {
  for (const s of [
    "", "d", "h", "1", "12", "1w", "1y", "2weeks", "abc", "1D", "1H",
    "-1h", "+1h", "-1d", "1d-2h", " 1h", "1h ", "1 h", "1h,2m",
    "1..5h", "1.2.3d", ".d", "1e3h",
    "999999999999d", "106752d", "106751d24h",
  ]) {
    it(`rejects ${JSON.stringify(s)}`, () => {
      expect(() => parseLifetimeDuration(s)).toThrow();
    });
  }
});

describe("parseTtl (TestParseTTLRejectsZero)", () => {
  for (const s of ["0", "0s", "0d", "0h0m"]) {
    it(`rejects ${s} as not greater than zero`, () => {
      expect(() => parseTtl(s)).toThrow(/greater than zero/);
    });
  }
  it("accepts 1d and rejects 1w", () => {
    expect(parseTtl("1d")).toBe(24 * H);
    expect(() => parseTtl("1w")).toThrow();
  });
});

describe("every unit parses (TestEveryUnitParses)", () => {
  for (const u of ["d", "h", "m", "ms", "ns", "s", "us", "µs", "μs"]) {
    for (const n of ["1", "2", "1.5"]) {
      it(`parses ${n}${u}`, () => {
        expect(() => parseLifetimeDuration(n + u)).not.toThrow();
      });
    }
  }
});

describe("parseDuration stays the tag reader", () => {
  it("does not accept the d unit no Go tag reader understands", () => {
    expect(parseDuration("1d")).toBeNull();
  });
});
