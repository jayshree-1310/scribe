import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // Keep request logs out of the test output.
      LOG_LEVEL: "silent",
      // Force the local-filesystem backend, whatever `apps/api/.env` holds.
      // These tests write real files and read them back; a developer with
      // object-store credentials in that file would otherwise have the suite
      // upload to a live bucket. `dotenv` does not overwrite a variable that
      // is already set, so an empty value here wins.
      S3_BUCKET: "",
    },
  },
});
