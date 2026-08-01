#!/usr/bin/env node
// Asserts every file referenced by package.json "exports" actually exists in dist/.
// A missing .d.ts or .js means a consumer's `import ... from "@spore-host/spawn-ts/x"`
// resolves to nothing — a break that neither typecheck nor the test suite can see,
// because both run against src/.
//
// Derived from "exports" rather than a hardcoded list, which is the point: the list
// in publish.yml had gone stale (it never gained "./transfer" when #59 added that
// subpath), so the guard silently stopped covering a real entry point. A guard that
// enumerates what it checks decays as soon as someone adds a subpath.
//
// Run after `npm run build:lib`.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const missing = [];
let checked = 0;

for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  // A subpath maps either to a string (e.g. the CSS) or to a conditions object.
  const files = typeof target === "string" ? { default: target } : target;
  for (const [condition, rel] of Object.entries(files)) {
    if (typeof rel !== "string") continue;
    checked++;
    if (!existsSync(resolve(root, rel))) missing.push(`${subpath} (${condition}) → ${rel}`);
  }
}

if (!checked) {
  console.error("check-exports: package.json declares no exports — refusing to report success.");
  process.exit(1);
}
if (missing.length) {
  console.error(`check-exports FAILED — ${missing.length} of ${checked} export targets missing from dist/:`);
  for (const m of missing) console.error(`  ✗ ${m}`);
  console.error("\nDid `npm run build:lib` run? See docs/releasing.md.");
  process.exit(1);
}
console.log(`check-exports OK — all ${checked} export targets present across ${Object.keys(pkg.exports).length} subpaths.`);
