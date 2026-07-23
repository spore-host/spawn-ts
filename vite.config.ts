import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// spawn-ts is a fully static single-page app. No server, no backend.
// The AWS SDK talks to EC2 endpoints directly from the browser using
// credentials the user pastes in at runtime (kept in memory only).
//
// Multi-page build: the main app plus the "direct" BYOA demo (demo/direct),
// which ships to /demo/direct/ alongside it. (The portal demo, demo/portal, is a
// Node service — not a static page — so it is not part of this build.)
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "demo-direct": resolve(__dirname, "demo/direct/index.html"),
      },
    },
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Exclude tests, pure type decls, the barrel, and DOM entry wiring that
      // can't be meaningfully unit-covered.
      exclude: [
        "src/**/*.test.ts",
        "src/core/types.ts",
        "src/core/provider.ts", // pure interface — no executable code
        "src/index.ts",
        "src/main.ts",
      ],
      reporter: ["text", "html", "lcov"],
    },
  },
});
