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
const WEB_APP_URL = (process.env.WEB_APP_URL ?? "http://localhost:1302").replace(
  /\/$/,
  "",
);

/** Builds an absolute link into the web app for an email to carry. */
export function webLink(path: string): string {
  return `${WEB_APP_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Prints the message instead of sending it. The full body is logged on
 * purpose: a reset link is the entire point of the message, and in local
 * development the log *is* the inbox.
 */
const logTransport: MailTransport = async (mail) => {
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

  /**
   * ---- Drop a real provider in here ----------------------------------
   *
   * Add a branch returning a transport that POSTs to the provider's HTTP
   * API with `fetch` — Postmark, Resend, SES and Mailgun all take a small
   * JSON body and an API key header, so none of them needs a dependency.
   * Read the key from an env var; it must never reach the browser.
   *
   *   if (configured === "postmark") {
   *     return async (mail) => { await fetch(...) };
   *   }
   */

  logger.warn(
    { transport: configured },
    "Unknown MAIL_TRANSPORT; falling back to the log transport. No mail will be delivered.",
  );

  return logTransport;
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
