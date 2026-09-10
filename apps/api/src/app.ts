// Load `.env` before anything else is imported. Several modules read their
// configuration at module scope — `lib/jwt.ts` throws outright if its secrets
// are missing — and until now the only `dotenv` import sat in `prisma/db.ts`,
// which happened to be pulled in first by `routes/auth.ts`. Any import added
// above that one broke startup. Loading it here makes the order irrelevant.
import "dotenv/config";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./lib/logger.js";
import { authenticate } from "./middleware/authenticate.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import accountRouter from "./routes/account.js";
import authRouter from "./routes/auth.js";
import authoringRouter from "./routes/authoring.js";
import booksRouter from "./routes/books.js";
import libraryRouter from "./routes/library.js";
import storiesRouter from "./routes/stories.js";
import uploadsRouter from "./routes/uploads.js";
import { UPLOAD_ROOT, UPLOAD_URL_PREFIX } from "./lib/storage.js";

const app = express();

/**
 * `req.ip` is the socket peer unless Express is told how many proxies sit in
 * front. Left unset behind the Vite dev proxy or an nginx hop, every caller
 * looks like the proxy and the auth rate limits collapse into one shared
 * bucket that a single attacker can exhaust for everybody.
 *
 * `TRUST_PROXY` takes a hop count (`1` for one reverse proxy) or any value
 * Express accepts. It stays unset by default: trusting `X-Forwarded-For`
 * without a real proxy in front lets a client claim any address it likes and
 * mint itself an unlimited number of rate-limit buckets.
 */
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
}

/**
 * `CORS_ORIGIN` takes a comma-separated allowlist. Left unset, every origin is
 * allowed — the same behaviour this app shipped with, and what the Vite dev
 * proxy expects.
 */
const corsOrigins = process.env.CORS_ORIGIN?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors(
    corsOrigins?.length
      ? { origin: corsOrigins, credentials: true }
      : undefined,
  ),
);
app.use(express.json({ limit: "256kb" }));
app.use(pinoHttp({ logger }));

// Ahead of the routers, so identity is established once and no route can
// forget to look for it.
app.use(authenticate);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "scribe-api",
  });
});

/**
 * Uploaded files (avatars today, covers and chapter media later). Served from
 * this app so local development needs no object store, and behind
 * `helmet`'s defaults plus these two headers: a stored file must never be
 * *rendered* by the browser, only downloaded or drawn as an image, because
 * anything served from our own origin runs with our origin's privileges.
 */
app.use(
  UPLOAD_URL_PREFIX,
  express.static(UPLOAD_ROOT, {
    index: false,
    // Uploads are content-addressed by a random name, so a URL's bytes never
    // change and a long cache is safe.
    maxAge: "1y",
    setHeaders: (response) => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'none'");
    },
  }),
);

app.use("/api/account", accountRouter);
app.use("/api/auth", authRouter);
app.use("/api/author", authoringRouter);
app.use("/api/books", booksRouter);
app.use("/api/library", libraryRouter);
app.use("/api/stories", storiesRouter);
app.use("/api/uploads", uploadsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;