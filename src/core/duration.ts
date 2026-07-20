// Go-compatible duration parsing/formatting. spawn writes durations to tags as
// Go duration strings ("4h", "90m", "1h30m", "45s"), so spawn-ts must read and
// write the same format to stay wire-compatible with the real CLI and spored.

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a Go duration string into milliseconds. Supports signed, fractional,
 * multi-unit values ("1h30m", "-5m", "1.5h"). Returns null on malformed input.
 * Mirrors Go's time.ParseDuration closely enough for spawn's tag values.
 */
export function parseDuration(input: string): number | null {
  if (input === "0") return 0;
  const s = input.trim();
  if (s === "") return null;

  let sign = 1;
  let i = 0;
  if (s[0] === "+" || s[0] === "-") {
    if (s[0] === "-") sign = -1;
    i = 1;
  }
  if (i === s.length) return null;

  let total = 0;
  const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/y;
  re.lastIndex = i;
  let consumed = i;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const value = parseFloat(m[1]);
    const unit = UNIT_MS[m[2]];
    if (unit === undefined) return null;
    total += value * unit;
    consumed = re.lastIndex;
  }
  if (consumed !== s.length) return null; // trailing garbage / no units matched
  return sign * total;
}

/**
 * Format milliseconds as a Go-style duration string ("4h0m0s" style collapsed
 * to the largest sensible units). Used for tag values and human display.
 */
export function formatDuration(ms: number): string {
  if (ms === 0) return "0s";
  const neg = ms < 0;
  let rem = Math.abs(ms);

  const h = Math.floor(rem / 3_600_000);
  rem -= h * 3_600_000;
  const m = Math.floor(rem / 60_000);
  rem -= m * 60_000;
  const s = rem / 1000;

  let out = "";
  if (h > 0) out += `${h}h`;
  if (m > 0 || (h > 0 && s > 0)) out += `${m}m`;
  if (s > 0 || out === "") out += `${trimFloat(s)}s`;
  return (neg ? "-" : "") + out;
}

function trimFloat(n: number): string {
  // Integers print without a decimal point; fractions keep up to 3 places.
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** Human "time remaining" formatter for the dashboard: "3h 42m", "58s", "expired". */
export function humanRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
