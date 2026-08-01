import { describe, it, expect } from "vitest";
import { parseArgs, flagList, flagStr, flagBool, tokenize } from "./args.js";

describe("parseArgs — repeatable value flags (#53)", () => {
  it("keeps EVERY occurrence of a repeated flag, not just the last", () => {
    // Go's --plugin is a pflag StringArray (cmd/launch_flags.go:351), so this
    // command line means BOTH plugins. A last-wins map installs one and drops the
    // other with nothing to say so — the exact silent-loss shape this exists to
    // prevent.
    const p = parseArgs(["launch", "job", "--plugin", "docker", "--plugin", "jupyterlab"]);
    expect(flagList(p, "plugin")).toEqual(["docker", "jupyterlab"]);
  });

  it("collects --flag=value occurrences too", () => {
    const p = parseArgs(["launch", "job", "--plugin=docker", "--plugin=code-server"]);
    expect(flagList(p, "plugin")).toEqual(["docker", "code-server"]);
  });

  it("collects a mix of both spellings, in command-line order", () => {
    const p = parseArgs(["launch", "job", "--plugin=docker", "--plugin", "rstudio-server"]);
    expect(flagList(p, "plugin")).toEqual(["docker", "rstudio-server"]);
  });

  it("returns an empty list for a flag that never appeared", () => {
    // Not undefined: a caller mapping over the result must not have to guard.
    expect(flagList(parseArgs(["launch", "job"]), "plugin")).toEqual([]);
  });

  it("leaves flags[] last-wins, so every existing single-value reader is unchanged", () => {
    const p = parseArgs(["launch", "job", "--ttl", "1h", "--ttl", "4h"]);
    expect(flagStr(p.flags, "ttl")).toBe("4h");
    expect(flagList(p, "ttl")).toEqual(["1h", "4h"]);
  });

  it("does not record a boolean flag as a list value", () => {
    // A lone flag has no value to collect; recording `true` as a string would make
    // flagList lie about what the user typed.
    const p = parseArgs(["launch", "job", "--spot"], new Set(["spot"]));
    expect(flagBool(p.flags, "spot")).toBe(true);
    expect(flagList(p, "spot")).toEqual([]);
  });

  it("still parses command, positionals and rest alongside the lists", () => {
    const p = parseArgs(["connect", "job", "--plugin", "docker", "--", "echo", "hi"]);
    expect(p.command).toBe("connect");
    expect(p.positionals).toEqual(["job"]);
    expect(p.rest).toEqual(["echo", "hi"]);
    expect(flagList(p, "plugin")).toEqual(["docker"]);
  });

  it("survives a round trip through tokenize", () => {
    const p = parseArgs(tokenize("launch job --plugin docker --plugin mountpoint-s3"));
    expect(flagList(p, "plugin")).toEqual(["docker", "mountpoint-s3"]);
  });
});
