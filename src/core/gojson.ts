// Go encoding/json-compatible serialization, for the bytes spored and the Go
// tool compare or hash.
//
// JSON.stringify is not byte-compatible with Go's encoder in three ways that
// matter here: Go sorts map keys (JSON.stringify keeps insertion order), Go
// escapes <, > and & as \u003c, \u003e, \u0026 unless the encoder turns HTML
// escaping off, and Go always escapes U+2028 and U+2029. Anything spawn-ts
// writes that a Go reader hashes or diffs (plugins.json, the launch config
// object) has to come out of here, or the same input yields different bytes.
//
// Only what spawn-ts serializes is supported: strings, finite numbers, booleans,
// null, arrays, and plain objects whose values are those. Objects are encoded
// with sorted keys, like a Go map; a Go struct's field order is the caller's
// business (pass the fields in declaration order with `goStruct`).

const HEX = "0123456789abcdef";

/**
 * Encode one string exactly as Go's encoding/json does (go1.22+): `\"`, `\\`,
 * `\b`, `\f`, `\n`, `\r`, `\t` short forms; every other control character as
 * `\u00xx` (lowercase hex); `<`, `>`, `&` as `\u003c` etc. when `escapeHTML`;
 * U+2028/U+2029 always escaped; a lone surrogate (invalid UTF-8 in Go terms)
 * as `\ufffd`. DEL (0x7f) is not escaped.
 */
export function goJsonString(s: string, escapeHTML = true): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      if (c === 0x22) out += '\\"';
      else if (c === 0x5c) out += "\\\\";
      else if (c >= 0x20 && !(escapeHTML && (c === 0x3c || c === 0x3e || c === 0x26))) {
        out += s[i];
      } else {
        switch (c) {
          case 0x08:
            out += "\\b";
            break;
          case 0x0c:
            out += "\\f";
            break;
          case 0x0a:
            out += "\\n";
            break;
          case 0x0d:
            out += "\\r";
            break;
          case 0x09:
            out += "\\t";
            break;
          default:
            out += "\\u00" + HEX[c >> 4] + HEX[c & 0xf];
        }
      }
      continue;
    }
    if (c === 0x2028 || c === 0x2029) {
      out += "\\u202" + HEX[c & 0xf];
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else {
        out += "\\ufffd";
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      out += "\\ufffd";
      continue;
    }
    out += s[i];
  }
  return out + '"';
}

/** A value goMarshal can encode. */
export type GoJsonValue =
  | string
  | number
  | boolean
  | null
  | GoJsonValue[]
  | { [k: string]: GoJsonValue }
  | GoStruct;

/** An object whose fields are emitted in the given order, like a Go struct. */
export class GoStruct {
  constructor(readonly fields: ReadonlyArray<readonly [string, GoJsonValue]>) {}
}

/** A Go struct: `goStruct([["schema", 1], ["settings", {...}]])`. */
export function goStruct(fields: ReadonlyArray<readonly [string, GoJsonValue]>): GoStruct {
  return new GoStruct(fields);
}

/**
 * Marshal like Go's `json.Marshal` (escapeHTML true) or an Encoder with
 * `SetEscapeHTML(false)`, without the Encoder's trailing newline. Object keys
 * are sorted by UTF-16 code unit, which equals Go's byte order for the ASCII
 * keys spawn writes.
 */
export function goMarshal(v: GoJsonValue, escapeHTML = true): string {
  if (v === null) return "null";
  if (typeof v === "string") return goJsonString(v, escapeHTML);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`goMarshal: unsupported number ${v}`);
    if (!Number.isInteger(v)) throw new Error(`goMarshal: only integers are supported, got ${v}`);
    return String(v);
  }
  if (Array.isArray(v)) return "[" + v.map((x) => goMarshal(x, escapeHTML)).join(",") + "]";
  if (v instanceof GoStruct) {
    return (
      "{" +
      v.fields.map(([k, x]) => goJsonString(k, escapeHTML) + ":" + goMarshal(x, escapeHTML)).join(",") +
      "}"
    );
  }
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => goJsonString(k, escapeHTML) + ":" + goMarshal(v[k], escapeHTML)).join(",") + "}";
}
