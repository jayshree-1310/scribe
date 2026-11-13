/**
 * The mailer's configuration rules: where links point, what the log transport
 * may print, and what the Resend transport sends. Each case re-imports the
 * module, because the transport and the link origin are read once at load.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const VARS = [
  "NODE_ENV",
  "WEB_APP_URL",
  "CORS_ORIGIN",
  "MAIL_TRANSPORT",
  "RESEND_API_KEY",
  "MAIL_FROM",
] as const;

const saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));

async function load(env: Partial<Record<(typeof VARS)[number], string>>) {
  for (const name of VARS) delete process.env[name];
  Object.assign(process.env, env);
  vi.resetModules();

  const { logger } = await import("./logger.js");
  const info = vi.spyOn(logger, "info").mockImplementation(() => {});
  const error = vi.spyOn(logger, "error").mockImplementation(() => {});

  return { ...(await import("./mailer.js")), info, error };
}

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const MAIL = {
  to: "reader@example.com",
  subject: "Reset your password",
  text: "Open https://scribe.example/reset-password/SECRET-TOKEN",
};

describe("links", () => {
  it("prefers WEB_APP_URL", async () => {
    const { webLink } = await load({
      WEB_APP_URL: "https://web.example/",
      CORS_ORIGIN: "https://other.example",
    });
    expect(webLink("/verify-email/x")).toBe("https://web.example/verify-email/x");
  });

  it("falls back to the first CORS origin rather than localhost", async () => {
    const { webLink } = await load({
      CORS_ORIGIN: "https://web.example, https://preview.example",
    });
    expect(webLink("/reset-password/x")).toBe("https://web.example/reset-password/x");
  });
});

describe("the log transport", () => {
  it("prints the whole message in development, where the log is the inbox", async () => {
    const { sendMail, info } = await load({});
    await sendMail(MAIL);
    expect(JSON.stringify(info.mock.calls)).toContain("SECRET-TOKEN");
  });

  it("never prints the message in production, and says mail is not set up", async () => {
    const { sendMail, info, error, describeMail } = await load({ NODE_ENV: "production" });
    await sendMail(MAIL);

    const logged = JSON.stringify([...info.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain("SECRET-TOKEN");
    expect(error).toHaveBeenCalled();
    expect(describeMail()).toEqual({ transport: "log" });
  });
});

describe("the Resend transport", () => {
  it("refuses to start without its key and sender", async () => {
    await expect(load({ MAIL_TRANSPORT: "resend" })).rejects.toThrow(/RESEND_API_KEY/);
  });

  it("posts the message with the key as a bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { sendMail, describeMail } = await load({
      MAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "re_test",
      MAIL_FROM: "Scribe <no-reply@scribe.example>",
    });
    await sendMail(MAIL);

    expect(describeMail()).toEqual({ transport: "resend" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Scribe <no-reply@scribe.example>",
      to: ["reader@example.com"],
      subject: MAIL.subject,
      text: MAIL.text,
    });
  });

  it("logs a refusal instead of failing the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ name: "validation_error" }), { status: 422 })),
    );

    const { sendMail, error } = await load({
      MAIL_TRANSPORT: "resend",
      RESEND_API_KEY: "re_test",
      MAIL_FROM: "Scribe <no-reply@scribe.example>",
    });

    await expect(sendMail(MAIL)).resolves.toBeUndefined();
    const [fields] = error.mock.calls[0] as unknown as [{ err: Error }];
    expect(fields.err.message).toContain("422");
  });
});
