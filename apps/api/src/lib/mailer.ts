/**
 * Outbound email.
 *
 * One `sendMail` interface with a logging transport as the default, so a
 * clone of this repo can run the whole password-reset and verification flow
 * with no credentials and no account anywhere: the link is printed to the API
 * log and can be pasted into the browser.
 *
 * Deliberately no provider SDK. A transport is a function from a message to a
 * promise, which every provider's HTTP API already fits — see
 * `createTransport` for the one place a real one is dropped in.
 */

import { logger } from "./logger.js";

export interface Mail {
  to: string;
  subject: string;
  /** Plain text only. Nothing here composes HTML, so nothing can inject it. */
  text: string;
}

export type MailTransport = (mail: Mail) => Promise<void>;

/**
 * Where links in emails point. The API and the web app are different origins
 * in every deployment (and behind the Vite proxy locally), so the API cannot
 * derive this from the request without trusting a `Host` header an attacker
 * controls — which is exactly how reset links get redirected to someone
 * else's domain.
 */
const WEB_APP_URL = resolveWebAppUrl();

/**
 * `WEB_APP_URL`, else the first `CORS_ORIGIN` -- which in every deployment is
 * the web app's origin already, and is configured by the operator rather than
 * read from a request -- else the local dev server. Without the middle step a
 * deployment that forgot `WEB_APP_URL` mailed links to `localhost`.
 */
function resolveWebAppUrl(): string {
  const firstCorsOrigin = process.env.CORS_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .find(Boolean);

  return (
    process.env.WEB_APP_URL ??
    firstCorsOrigin ??
    "http://localhost:1302"
  ).replace(/\/$/, "");
}

/** Builds an absolute link into the web app for an email to carry. */
export function webLink(path: string): string {
  return `${WEB_APP_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

const production = process.env.NODE_ENV === "production";

/**
 * Prints the message instead of sending it. The full body is logged on
 * purpose: a reset link is the entire point of the message, and in local
 * development the log *is* the inbox.
 *
 * Never in production. There the body is a live credential -- a reset link
 * is a password for thirty minutes -- and logs are read by more people and
 * kept longer than any inbox. So production logs that a message was dropped,
 * loudly, and nothing it said.
 */
const logTransport: MailTransport = async (mail) => {
  if (production) {
    logger.error(
      { to: mail.to, subject: mail.subject },
      "Email not sent: no mail transport is configured (MAIL_TRANSPORT). " +
        "Password reset and email verification cannot work until one is.",
    );
    return;
  }

  logger.info(
    { to: mail.to, subject: mail.subject },
    `\n----- email (not sent; MAIL_TRANSPORT=log) -----\n` +
      `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n` +
      `------------------------------------------------`,
  );
};

function createTransport(): MailTransport {
  const configured = process.env.MAIL_TRANSPORT ?? "log";

  if (configured === "log") return logTransport;

  if (configured === "resend") return resendTransport();

  /**
   * ---- Another provider ----------------------------------------------
   *
   * Add a branch returning a transport that POSTs to the provider's HTTP
   * API with `fetch`, the way `resendTransport` does -- Postmark, SES and
   * Mailgun all take a small JSON body and an API key header, so none of
   * them needs a dependency. Read the key from an env var; it must never
   * reach the browser.
   */

  logger.warn(
    { transport: configured },
    "Unknown MAIL_TRANSPORT; falling back to the log transport. No mail will be delivered.",
  );

  return logTransport;
}

/**
 * Resend (resend.com): `MAIL_TRANSPORT=resend`, `RESEND_API_KEY`, and
 * `MAIL_FROM` -- an address on a domain verified with Resend, e.g.
 * `Scribe <no-reply@example.com>`. Its free tier covers a small deployment.
 *
 * Missing settings refuse at startup rather than at the first reset request,
 * so a misconfigured deployment shows up in its boot log.
 */
function resendTransport(): MailTransport {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;

  if (!apiKey || !from) {
    throw new Error("MAIL_TRANSPORT=resend needs RESEND_API_KEY and MAIL_FROM.");
  }

  return async (mail) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // The status and Resend's error name only: the response never echoes
      // the message, but there is no reason to log a body we did not need.
      const detail = (await response.json().catch(() => null)) as { name?: string } | null;
      throw new Error(`Resend refused the message: ${response.status} ${detail?.name ?? ""}`.trim());
    }
  };
}

/** Which transport is live, for `/health`: a name, never a key. */
export function describeMail(): { transport: string } {
  return { transport: transport === logTransport ? "log" : (process.env.MAIL_TRANSPORT ?? "log") };
}

const transport = createTransport();

/**
 * Sends a message, and never fails the request that asked for it.
 *
 * Every caller here is a flow whose response must not depend on delivery:
 * forgot-password answers identically whether or not an account exists, and
 * leaking a provider outage as a 500 on one address and a 200 on another
 * would undo that. The failure is logged instead.
 */
export async function sendMail(mail: Mail): Promise<void> {
  try {
    await transport(mail);
  } catch (error) {
    logger.error({ err: error, to: mail.to }, "Could not send email");
  }
}
