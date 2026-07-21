// Parameter-spec parsing + grid expansion for parameter sweeps — a faithful
// port of the Go tool's pkg/params/parser.go (the JSON/grid path). A sweep spec
// is a set of `defaults` merged into each of many `params` sets, optionally
// generated from the cartesian product of a `grid`.
//
// The Go parser reads a file (JSON/YAML/CSV) off disk. The browser has no
// filesystem, so this module works from an already-parsed object (or a JSON
// string), which is the only format a web page can obtain anyway. Grid
// expansion and the defaults/params merge — the actual sweep logic — are ported
// exactly, including the deterministic sorted-key ordering that fixes each
// combination's sweep index across runs.
//
// Pure: no DOM, no clock, no I/O. The dashboard/terminal are consumers.

/** A single parameter value. Mirrors the JSON scalar types Go accepts. */
export type ParamValue = string | number | boolean;

/** One parameter set: named values applied on top of the sweep defaults. */
export type ParamSet = Record<string, ParamValue>;

/**
 * A parameter-sweep specification. `defaults` apply to every member; `params`
 * is an explicit list of per-member overrides; `grid` (when present) is expanded
 * into the cartesian product of its named value lists and appended to `params`.
 * A spec must yield at least one member (a non-empty `params` or `grid`).
 */
export interface ParamSpec {
  defaults?: ParamSet;
  params?: ParamSet[];
  grid?: Record<string, ParamValue[]>;
}

/** A fully-resolved member: defaults merged with one param set, plus its index. */
export interface ResolvedMember {
  /** 0-based position in the sweep — the authoritative sweep index. */
  index: number;
  /** The merged parameter map (defaults ← param set). */
  values: ParamSet;
}

/**
 * Expand a named-value grid into the cartesian product, one param set per
 * combination. Keys are processed in sorted order and each key's values in
 * declaration order, so the resulting sequence — and therefore the sweep index
 * assigned to each combination — is deterministic across runs. A key with an
 * empty value list collapses the product to zero sets, matching the Go original.
 */
export function expandGrid(grid: Record<string, ParamValue[]>): ParamSet[] {
  const keys = Object.keys(grid).sort();
  if (keys.length === 0) return [];

  let combos: ParamSet[] = [{}];
  for (const k of keys) {
    const values = grid[k];
    const next: ParamSet[] = [];
    for (const base of combos) {
      for (const v of values) {
        next.push({ ...base, [k]: v });
      }
    }
    combos = next;
  }
  // An empty value list somewhere collapsed the product; nothing to yield. (If a
  // grid had keys but every combo is empty, that only happens when combos was
  // emptied, so `combos` is already []. Guard the single-empty-combo case too.)
  if (combos.length === 1 && Object.keys(combos[0]).length === 0) return [];
  return combos;
}

/**
 * Normalize a raw spec (or JSON string) into the ordered list of resolved
 * members. Explicit `params` come first, then any `grid` expansion appended —
 * identical to the Go parser's finalize(). Throws if the spec yields no members.
 */
export function resolveMembers(spec: ParamSpec | string): ResolvedMember[] {
  const parsed: ParamSpec = typeof spec === "string" ? parseSpecJson(spec) : spec;

  const defaults = parsed.defaults ?? {};
  const sets: ParamSet[] = [...(parsed.params ?? [])];
  if (parsed.grid && Object.keys(parsed.grid).length > 0) {
    sets.push(...expandGrid(parsed.grid));
  }
  if (sets.length === 0) {
    throw new Error(
      "parameter spec must contain at least one parameter set (a non-empty 'params' array or 'grid')",
    );
  }

  return sets.map((set, index) => ({
    index,
    values: { ...defaults, ...set },
  }));
}

/**
 * Parse the compact grid shorthand "k=v1,v2 k2=v3,v4" into a grid map — a
 * convenience for the CLI/GUI so a user need not hand-write JSON for a quick
 * cartesian sweep. Values are typed like the Go CSV parser (bool → int → float
 * → string) so numeric axes stay numeric. Returns the grid, or an error string.
 */
export function parseGridShorthand(
  raw: string,
): { value: Record<string, ParamValue[]> } | { error: string } {
  const grid: Record<string, ParamValue[]> = {};
  for (const pair of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return { error: `bad grid entry "${pair}" (want key=v1,v2)` };
    const key = pair.slice(0, eq);
    const values = pair
      .slice(eq + 1)
      .split(",")
      .filter((v) => v !== "");
    if (values.length === 0) return { error: `grid key "${key}" has no values` };
    grid[key] = values.map(parseScalar);
  }
  if (Object.keys(grid).length === 0) return { error: "empty grid" };
  return { value: grid };
}

/** Type a bare string like the Go params parser: bool → int → float → string. */
export function parseScalar(v: string): ParamValue {
  const low = v.toLowerCase();
  if (low === "true") return true;
  if (low === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v;
}

/** Parse + validate a JSON sweep spec string. */
function parseSpecJson(json: string): ParamSpec {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new Error(`invalid parameter spec JSON: ${(e as Error).message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("parameter spec must be a JSON object with 'params'/'grid'/'defaults'");
  }
  return obj as ParamSpec;
}
