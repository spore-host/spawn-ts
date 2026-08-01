#!/usr/bin/env node
// Release preflight — run before tagging (`npm run release:check`).
//
// Pushing a `v*` tag publishes to npm, and npm forbids republishing a version even
// after unpublish. So every check here corresponds to a drift that has actually
// happened in this repo rather than to a hypothetical: 0.6.0 and 0.6.1 were both
// published with no CHANGELOG section, 0.6.0 was never tagged, and [Unreleased]
// consequently still compared from v0.5.0 while holding items that had shipped.
//
// Exits non-zero with every failure listed, not just the first — a preflight that
// makes you re-run it once per problem trains people to skip it. See
// docs/releasing.md.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const problems = [];
const notes = [];
const fail = (m) => problems.push(m);

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const version = pkg.version;

// `git` and `npm` may both legitimately be unavailable (a sandbox, an offline box).
// A check that cannot run is reported as unknown, never as passing — the same
// absence-is-not-reassurance rule src/core/notices.ts follows.
function tryRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// ── 1. the version has a dated CHANGELOG section ────────────────────────────────
const sectionRe = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\](.*)$`, "m");
const section = changelog.match(sectionRe);
if (!section) {
  fail(`CHANGELOG.md has no "## [${version}]" section. Promote [Unreleased] before tagging.`);
} else if (!/—\s*\d{4}-\d{2}-\d{2}\s*$/.test(section[1])) {
  fail(`the "## [${version}]" section is undated — it should read "## [${version}] — YYYY-MM-DD".`);
}

// ── 2. the compare link exists ──────────────────────────────────────────────────
if (!changelog.includes(`\n[${version}]: `)) {
  fail(`CHANGELOG.md has no "[${version}]:" compare link in the reference list at the bottom.`);
}

// ── 3. [Unreleased] compares from the newest released version ───────────────────
// Ordered by position in the file, which is newest-first by convention.
const released = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
const newest = released[0];
if (newest && newest !== version) {
  fail(`the newest CHANGELOG section is [${newest}] but package.json says ${version} — they must agree.`);
}
const unreleasedLink = changelog.match(/^\[Unreleased\]: .*compare\/v([\d.]+)\.\.\.HEAD/m);
if (!unreleasedLink) {
  fail("CHANGELOG.md has no [Unreleased] compare link.");
} else if (newest && unreleasedLink[1] !== newest) {
  fail(`[Unreleased] compares from v${unreleasedLink[1]} but the newest section is [${newest}].`);
}

// ── 4. every released section is tagged, and this version is not yet ─────────────
const tags = tryRun("git", ["tag", "--list", "v*"]);
if (tags === null) {
  notes.push("git tags unreadable — tag checks skipped (unknown, not passed).");
} else {
  const have = new Set(tags.split("\n").filter(Boolean));
  if (have.has(`v${version}`)) {
    fail(`v${version} is already tagged. Never move a released tag — cut the next patch instead (docs/releasing.md).`);
  }
  const untagged = released.filter((v) => v !== version && !have.has(`v${v}`));
  if (untagged.length) {
    notes.push(`documented but untagged: ${untagged.map((v) => `v${v}`).join(", ")} — historical drift, not a blocker.`);
  }
}

// ── 5. not already on npm ───────────────────────────────────────────────────────
const publishedRaw = tryRun("npm", ["view", pkg.name, "versions", "--json"]);
if (publishedRaw === null) {
  notes.push(`could not reach npm to check whether ${version} is published — verify manually.`);
} else {
  try {
    const list = JSON.parse(publishedRaw);
    if ((Array.isArray(list) ? list : [list]).includes(version)) {
      fail(`${pkg.name}@${version} is ALREADY PUBLISHED. npm will not accept it again; bump the version.`);
    }
  } catch {
    notes.push("npm returned unparseable version data — verify manually.");
  }
}

// ── 6. clean tree, on main ──────────────────────────────────────────────────────
const status = tryRun("git", ["status", "--porcelain"]);
if (status === null) {
  notes.push("git status unreadable — working-tree check skipped.");
} else if (status) {
  notes.push("working tree is dirty — commit the release bump before tagging.");
}
const branch = tryRun("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch && branch !== "main") {
  notes.push(`on branch "${branch}" — release tags belong on main.`);
}

// ── report ──────────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  note: ${n}`);
if (problems.length) {
  console.error(`\nrelease:check FAILED for ${pkg.name}@${version}:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("\nSee docs/releasing.md.");
  process.exit(1);
}
console.log(`\nrelease:check OK — ${pkg.name}@${version} is consistent and unpublished.`);
