// A tiny argv tokenizer + flag parser for the in-browser terminal. Handles
// quoted strings, --flag=value and --flag value, and the `--` command
// separator (spawn connect NAME -- 'cmd'), matching the real CLI's surface.

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Everything after a literal `--` (the one-shot remote command). */
  rest: string[];
}

/** Split a raw command line into argv, honoring single/double quotes. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === " " || c === "\t") {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Parse tokenized argv (excluding the leading program name) into a command,
 * positionals, flags, and post-`--` rest. Boolean flags are those not followed
 * by a value; known value flags are handled by callers reading flags[name].
 */
export function parseArgs(argv: string[], booleanFlags: Set<string> = new Set()): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const rest: string[] = [];
  let command = "";

  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      const raw = a.replace(/^-+/, "");
      const eq = raw.indexOf("=");
      if (eq >= 0) {
        flags[raw.slice(0, eq)] = raw.slice(eq + 1);
      } else if (booleanFlags.has(raw)) {
        flags[raw] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[raw] = next;
          i++;
        } else {
          flags[raw] = true; // lone flag => boolean
        }
      }
    } else if (command === "") {
      command = a;
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags, rest };
}

/** Read a string flag with a default. */
export function flagStr(f: ParsedArgs["flags"], name: string, dflt = ""): string {
  const v = f[name];
  return typeof v === "string" ? v : dflt;
}

/** Read a boolean flag (present or =true). */
export function flagBool(f: ParsedArgs["flags"], name: string): boolean {
  const v = f[name];
  return v === true || v === "true";
}
