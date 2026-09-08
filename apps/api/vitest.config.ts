import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Keep request logs out of the test output.
    env: { LOG_LEVEL: "silent" },
  },
});
