import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@exocortex/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@exocortex/server": path.resolve(__dirname, "packages/server/src/index.ts"),
    },
  },
  test: {
    globals: true,
    testTimeout: 30_000,
    pool: "forks",
    exclude: ["**/dist/**", "**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/server/src/**/*.ts", "packages/mcp/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/benchmark/**", "**/dist/**"],
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
