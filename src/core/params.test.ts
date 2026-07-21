import { describe, it, expect } from "vitest";
import {
  expandGrid,
  resolveMembers,
  parseGridShorthand,
  parseScalar,
} from "./params.js";

describe("expandGrid", () => {
  it("produces the full cartesian product", () => {
    const combos = expandGrid({
      learning_rate: [0.001, 0.01, 0.1],
      batch_size: [32, 64, 128],
    });
    expect(combos).toHaveLength(9);
  });

  it("is deterministic with sorted keys (batch_size before learning_rate)", () => {
    const combos = expandGrid({
      learning_rate: [0.001, 0.01, 0.1],
      batch_size: [32, 64, 128],
    });
    // batch_size sorts first → outer loop → changes slowest.
    expect(combos[0]).toEqual({ batch_size: 32, learning_rate: 0.001 });
    expect(combos[2].batch_size).toBe(32);
    expect(combos[3].batch_size).toBe(64);
  });

  it("repeated calls yield identical ordering", () => {
    const grid = { a: [1, 2], b: ["x", "y"] };
    const first = expandGrid(grid);
    for (let i = 0; i < 3; i++) expect(expandGrid(grid)).toEqual(first);
  });

  it("an empty value list collapses the product to nothing", () => {
    expect(expandGrid({ a: [1, 2], b: [] })).toEqual([]);
  });

  it("an empty grid yields nothing", () => {
    expect(expandGrid({})).toEqual([]);
  });
});

describe("resolveMembers", () => {
  it("merges defaults under each param set and indexes them", () => {
    const members = resolveMembers({
      defaults: { region: "us-east-1", ttl: "4h" },
      params: [{ instance_type: "t3.micro", alpha: 0.1 }, { instance_type: "t3.small", ttl: "8h" }],
    });
    expect(members).toHaveLength(2);
    expect(members[0]).toEqual({
      index: 0,
      values: { region: "us-east-1", ttl: "4h", instance_type: "t3.micro", alpha: 0.1 },
    });
    // A param-set value overrides the default of the same key.
    expect(members[1].values.ttl).toBe("8h");
    expect(members[1].index).toBe(1);
  });

  it("appends grid expansion after explicit params", () => {
    const members = resolveMembers({
      params: [{ tag: "explicit" }],
      grid: { n: [1, 2] },
    });
    expect(members.map((m) => m.values)).toEqual([
      { tag: "explicit" },
      { n: 1 },
      { n: 2 },
    ]);
  });

  it("parses a JSON string spec", () => {
    const members = resolveMembers('{"params":[{"a":1},{"a":2}]}');
    expect(members).toHaveLength(2);
    expect(members[1].values.a).toBe(2);
  });

  it("throws when the spec yields no members", () => {
    expect(() => resolveMembers({ defaults: { region: "us-east-1" } })).toThrow(/at least one/);
    expect(() => resolveMembers({ grid: {} })).toThrow(/at least one/);
  });

  it("throws on malformed JSON", () => {
    expect(() => resolveMembers("{not json")).toThrow(/invalid parameter spec JSON/);
  });

  it("throws on a non-object JSON spec", () => {
    expect(() => resolveMembers("[1,2,3]")).toThrow(/must be a JSON object/);
  });
});

describe("parseGridShorthand", () => {
  it("parses key=v1,v2 pairs with type inference", () => {
    const r = parseGridShorthand("lr=0.01,0.1 bs=32,64 spot=true,false");
    expect("value" in r && r.value).toEqual({
      lr: [0.01, 0.1],
      bs: [32, 64],
      spot: [true, false],
    });
  });

  it("rejects an entry without =", () => {
    const r = parseGridShorthand("lronly");
    expect("error" in r && r.error).toMatch(/want key=v1,v2/);
  });

  it("rejects a key with no values", () => {
    const r = parseGridShorthand("lr=");
    expect("error" in r && r.error).toMatch(/no values/);
  });

  it("rejects an empty grid", () => {
    const r = parseGridShorthand("   ");
    expect("error" in r && r.error).toMatch(/empty grid/);
  });
});

describe("parseScalar", () => {
  it("infers booleans, ints, floats, and strings", () => {
    expect(parseScalar("true")).toBe(true);
    expect(parseScalar("FALSE")).toBe(false);
    expect(parseScalar("42")).toBe(42);
    expect(parseScalar("-7")).toBe(-7);
    expect(parseScalar("3.14")).toBe(3.14);
    expect(parseScalar("t3.micro")).toBe("t3.micro");
    expect(parseScalar("4h")).toBe("4h");
  });
});
