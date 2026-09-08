import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Single logger instance shared by the app and by `pino-http`, so request logs
 * and application logs land in the same stream with the same configuration.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
  // Never let credentials reach the log stream.
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
});
