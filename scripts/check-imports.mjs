#!/usr/bin/env node
// Asserts every code subpath in package.json "exports" can actually be IMPORTED
// from the built dist/, under plain Node with no bundler.
//
// This is the check `check-exports.mjs` cannot make. That one proves a file is
// present; presence is weaker than importability, and the gap is not theoretical:
// `./terminal` shipped in 0.6.0 and 0.7.0 carrying `import "@xterm/xterm/css/…"`,
// which plain Node rejects with ERR_UNKNOWN_FILE_EXTENSION. The guard reported
// "all 19 targets present" for a subpath no non-bundler consumer could load (#70).
//
// Bundler-only subpaths are declared in BUNDLER_ONLY below and asserted to fail
// *for that reason*. That turns an undocumented quirk into a stated contract in
// both directions: if a listed subpath starts working, or an unlisted one starts
// importing CSS, this fails and someone has to decide which was intended.
//
// Run after `npm run build:lib`.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

/**
 * Subpaths that are expected NOT to import under plain Node, with the reason.
 * Keep this empty if you can: an entry is a real restriction on consumers.
 */
const BUNDLER_ONLY = {
  // Upstream, and not ours to fix: @xterm/xterm declares no "exports" field, so
  // Node resolves "main" (CJS) and ignores "module" (the ESM build, a
  // bundler-only convention). The two disagree on shape — xterm.mjs has no
  // default export, while Node's CJS view exposes Terminal only under `default`
  // — so no single import form satisfies both.
  //
  // The CSS side-effect import in src/terminal.ts is a second, smaller reason.
  // Dropping it was tried and reverted: it breaks styling for every current
  // (bundled) consumer while this CJS problem keeps the subpath bundler-only
  // regardless, so it costs the demos and buys nothing. See #70.
  "./terminal": "@xterm/xterm is CJS-only to Node (no exports field) and the module imports xterm's CSS",
};

const problems = [];
const results = [];
let ok = 0;
let declared = 0;

for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  // Only conditions objects name JS entry points; a bare string is an asset (CSS).
  if (typeof target === "string") continue;
  const rel = target.import ?? target.default;
  if (typeof rel !== "string" || !rel.endsWith(".js")) continue;

  const expectFailure = subpath in BUNDLER_ONLY;
  let error = null;
  try {
    await import(pathToFileURL(resolve(root, rel)).href);
  } catch (e) {
    error = e;
  }

  if (error && !expectFailure) {
    problems.push(`${subpath} → ${rel} does not import: ${error.code ?? ""} ${error.message.split("\n")[0]}`);
    results.push(`  ✗ ${subpath}`);
  } else if (!error && expectFailure) {
    // Not a nuisance: it means a documented restriction on consumers is now stale.
    problems.push(
      `${subpath} is listed BUNDLER_ONLY ("${BUNDLER_ONLY[subpath]}") but imports fine now — remove it from the list and from the docs that state the restriction.`,
    );
    results.push(`  ✗ ${subpath} (unexpectedly importable)`);
  } else if (error) {
    declared++;
    results.push(`  ~ ${subpath} bundler-only, as declared (${error.code ?? "error"})`);
  } else {
    ok++;
    results.push(`  ✓ ${subpath}`);
  }
}

if (!results.length) {
  console.error("check-imports: found no JS entry points in exports — refusing to report success.");
  process.exit(1);
}
for (const r of results) console.log(r);

if (problems.length) {
  console.error(`\ncheck-imports FAILED:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("\nDid `npm run build:lib` run? See docs/releasing.md.");
  process.exit(1);
}
// State the bundler-only count rather than folding it into a total: "all 9 import"
// would be false while one of them provably does not.
console.log(
  `check-imports OK — ${ok} of ${results.length} code subpaths import under plain Node` +
    (declared ? `, ${declared} bundler-only as declared.` : "."),
);
