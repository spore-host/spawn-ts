// goMarshal / goJsonString against Go's own encoding/json output.
// testdata/gojson-vectors.go.json was produced by json.NewEncoder with
// SetEscapeHTML(true) ("html") and (false) ("raw") on Go 1.27, trailing
// newline trimmed (scripts/gen-go-fixtures.sh).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { goJsonString, goMarshal, goStruct } from "./gojson.js";

const vectors: {
  strings: { in: string; html: string; raw: string }[];
  mapHTML: string;
  mapRaw: string;
} = JSON.parse(readFileSync(new URL("./testdata/gojson-vectors.go.json", import.meta.url), "utf8"));

describe("goJsonString matches Go encoding/json", () => {
  for (const v of vectors.strings) {
    it(`escapes ${JSON.stringify(v.in)} like Go (HTML escaping on)`, () => {
      expect(goJsonString(v.in, true)).toBe(v.html);
    });
    it(`escapes ${JSON.stringify(v.in)} like Go (HTML escaping off)`, () => {
      expect(goJsonString(v.in, false)).toBe(v.raw);
    });
  }

  it("turns a lone surrogate into \\ufffd, as Go does invalid UTF-8", () => {
    expect(goJsonString("a\ud800b")).toBe('"a\\ufffdb"');
    expect(goJsonString("\udc00")).toBe('"\\ufffd"');
  });
});

describe("goMarshal", () => {
  it("sorts map keys like a Go map", () => {
    const m = { z: "1", a: "<&>", M: "x", _: "y", aa: "2" };
    expect(goMarshal(m, true)).toBe(vectors.mapHTML);
    expect(goMarshal(m, false)).toBe(vectors.mapRaw);
  });

  it("keeps struct field order", () => {
    expect(goMarshal(goStruct([["schema", 1], ["settings", { b: "2", a: "1" }]]), false)).toBe(
      '{"schema":1,"settings":{"a":"1","b":"2"}}',
    );
  });

  it("refuses non-integer numbers rather than guessing Go's float format", () => {
    expect(() => goMarshal(1.5)).toThrow();
    expect(() => goMarshal(Number.NaN)).toThrow();
  });
});
