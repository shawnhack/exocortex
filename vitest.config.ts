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
  },
});
