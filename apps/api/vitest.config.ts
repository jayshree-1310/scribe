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
      // Posting a comment schedules an automated content check. Off for the
      // whole suite, so the dozens of tests that post one do not each call
      // whatever model `apps/api/.env` points at; the moderation suite turns
      // it back on for itself, behind the fake provider.
      AI_MODERATION: "off",
      // Likewise for the continuity check a chapter save schedules: the
      // authoring suites save chapters constantly. Its own suite turns it on.
      AI_CONTINUITY: "off",
      // Usage rows for every wrapped call would pile up in the dev database
      // with no fixture user to sweep them; the usage suite turns it on.
      AI_USAGE_PERSIST: "off",
      // Suites explain the same passage over and over, and each expects a
      // model call; the cost suite turns the result cache on for itself.
      AI_RESULT_CACHE_SECONDS: "0",
      // Publishing a fixture chapter queues its embedding; with no worker in
      // the suite those jobs would only pile up. The jobs suite turns it on.
      AI_JOBS: "off",
    },
  },
});
