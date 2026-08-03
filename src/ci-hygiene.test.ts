/**
 * Tests that assert on repo wiring rather than on code.
 *
 * Wiring is what rots: a pin reverted to `@v4` or a deleted Dependabot entry is a
 * one-line change whose absence is completely silent — nothing fails, the supply
 * chain just quietly goes back to being mutable. These make that fail a test.
 *
 * The stakes here are specific. `publish.yml` uses npm Trusted Publishing:
 * `id-token: write` + GitHub OIDC authorizes publishing `@spore-host/spawn-ts`, so
 * whatever executes in that job can publish as us — and unlike a leaked NPM_TOKEN
 * there is nothing to rotate afterward. `pages.yml` and `live-smoke.yml` also hold
 * `id-token: write`, and live-smoke assumes an AWS role (#72).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowDir = `${repoRoot}.github/workflows`;

/**
 * owner/action@<40-hex> followed by a `# vX.Y.Z` comment. The comment is required:
 * a bare SHA is unreadable, and the version is what makes a bump reviewable —
 * without it nobody can tell whether a pin is current or two years stale.
 */
// The comment must be an EXACT vX.Y.Z, not a bare `# v7`. A bare major cannot be
// checked against the SHA and can silently misstate what CI runs: Dependabot bumped
// nf-spawn's checkout pin to a v7.0.1 SHA while leaving the comment reading `# v6`,
// and the older `v?\d` form of this pattern passed it. A wrong label is worse than a
// missing one — it makes a major-version jump read as a routine same-line bump.
// scripts/verify-pins.sh checks comment-against-tag for real; that needs the network,
// so it stays out of the test suite.
const PINNED = /^[^@\s]+@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\s*$/;

interface UsesRef {
  file: string;
  line: number;
  ref: string;
}

/** Every registry action ref across the workflows. */
function usesRefs(): UsesRef[] {
  const refs: UsesRef[] = [];
  for (const name of readdirSync(workflowDir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const text = readFileSync(`${workflowDir}/${name}`, "utf8");
    text.split("\n").forEach((raw, i) => {
      const stripped = raw.trim().replace(/^-\s+/, "");
      if (!stripped.startsWith("uses:")) return;
      const ref = stripped.slice("uses:".length).trim();
      if (ref.startsWith("./")) return; // a local path, not a registry ref
      refs.push({ file: name, line: i + 1, ref });
    });
  }
  return refs;
}

/** Dependabot's only wildcard is `*`, matching any run of characters. */
function globMatch(pattern: string, value: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === value;
  if (!value.startsWith(parts[0])) return false;
  let rest = value.slice(parts[0].length);
  for (const middle of parts.slice(1, -1)) {
    const idx = rest.indexOf(middle);
    if (idx < 0) return false;
    rest = rest.slice(idx + middle.length);
  }
  return rest.endsWith(parts[parts.length - 1]);
}

interface DependabotUpdate {
  "package-ecosystem"?: string;
  directory?: string;
  directories?: string[];
  groups?: Record<string, { patterns?: string[] }>;
}

function dependabotConfig(): { version?: number; updates?: DependabotUpdate[] } {
  return parse(readFileSync(`${repoRoot}.github/dependabot.yml`, "utf8"));
}

describe("CI hygiene", () => {
  it("pins every action to a commit SHA", () => {
    const refs = usesRefs();
    // Anti-vacuous: a parser that silently stopped matching would pass forever.
    expect(refs.length, `no \`uses:\` lines found under ${workflowDir}`).toBeGreaterThan(0);

    const unpinned = refs
      .filter((r) => !PINNED.test(r.ref))
      .map((r) => `${r.file}:${r.line}: ${r.ref}`);

    expect(
      unpinned,
      "These actions are not pinned to a full commit SHA with a version comment.\n" +
        "A tag or branch is mutable, so the code CI runs can change with no commit here —\n" +
        "and publish.yml can publish this package to npm via OIDC. Use:\n" +
        "    uses: owner/action@<40-hex-sha> # vX.Y.Z",
    ).toEqual([]);
  });

  it("has a Dependabot entry covering every action", () => {
    // The other half of pinning: a SHA never moves, including past a security fix,
    // so pinning without Dependabot just trades a mutable-tag hole for a stale one.
    // The check that matters is coverage — an ecosystem entry whose group patterns
    // don't match an action leaves it outside the grouped PR, silently.
    const cfg = dependabotConfig();
    expect(cfg.version).toBe(2);

    const patterns: string[] = [];
    let found = false;
    for (const update of cfg.updates ?? []) {
      if (update["package-ecosystem"] !== "github-actions") continue;
      found = true;
      const dirs = update.directories ?? (update.directory ? [update.directory] : []);
      expect(
        dirs,
        'workflows live in .github/workflows, which Dependabot finds via directory "/"',
      ).toEqual(["/"]);
      for (const group of Object.values(update.groups ?? {})) {
        patterns.push(...(group.patterns ?? []));
      }
    }
    expect(found, "dependabot.yml has no `github-actions` entry, so the SHA pins never move").toBe(
      true,
    );

    for (const { file, ref } of usesRefs()) {
      const action = ref.split("@")[0];
      expect(
        patterns.some((p) => globMatch(p, action)),
        `${action} (in ${file}) matches no Dependabot group pattern ${JSON.stringify(patterns)}, ` +
          "so it falls outside the grouped PR and its bumps get missed. Widen the pattern.",
      ).toBe(true);
    }
  });

  it("has a Dependabot entry for npm dependencies", () => {
    const ecosystems = (dependabotConfig().updates ?? []).map((u) => u["package-ecosystem"]);
    expect(
      ecosystems,
      "no `npm` entry, so package.json dependencies are never updated",
    ).toContain("npm");
  });
});
