import { defineConfig } from "vitest/config";

// spawn-ts is a fully static single-page app. No server, no backend.
// The AWS SDK talks to EC2 endpoints directly from the browser using
// credentials the user pastes in at runtime (kept in memory only).
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
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
        "src/index.ts",
        "src/main.ts",
      ],
      reporter: ["text", "html", "lcov"],
    },
  },
});
