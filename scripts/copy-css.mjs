// tsc only emits .js/.d.ts — it ignores .css. The library ships a CSS file
// (src/ui/dashboard.css, the Dashboard component styles) that consumers import
// via @spore-host/spawn-ts/ui/style.css, so copy every src .css into dist/ after
// the TypeScript build, preserving its path.
import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src");
const distDir = join(root, "dist");

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".css")) yield p;
  }
}

let n = 0;
for await (const src of walk(srcDir)) {
  const dest = join(distDir, relative(srcDir, src));
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest);
  n++;
}
console.log(`copied ${n} css file(s) → dist/`);
