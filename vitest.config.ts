import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    pool: "forks",
    // Tests must never invoke real provider CLIs.
    env: { DEVRELAY_OFFLINE: "1", DEVRELAY_DISABLE_CLAUDE_CLI: "1" },
  },
});