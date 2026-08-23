import { defineConfig } from "vitest/config";

// Real end-to-end tests. These create REAL AutoDL instances and cost REAL money.
// Guarded behind AUTODL_E2E=1 plus a valid AUTODL_TOKEN.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 15 * 60 * 1000,
    fileParallelism: false,
  },
});
