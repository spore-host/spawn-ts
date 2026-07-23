// Bundle the portal browser terminal (TS + xterm + CSS) into a single
// public/portal-terminal.js the static portal page can load as a module. The
// portal UI is intentionally build-step-free otherwise; this is the one bundled
// asset (xterm can't be hand-vendored sensibly). Run via `npm run build:portal-ui`.

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(HERE, "portal-terminal.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  // Imported xterm.css is emitted as a sibling public/portal-terminal.css, which
  // the portal HTML links.
  outfile: join(HERE, "public", "portal-terminal.js"),
  logLevel: "info",
});
console.log("[build-ui] wrote public/portal-terminal.js (+ .css)");
