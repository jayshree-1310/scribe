import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { HttpError } from "../lib/http-error.js";
import { errorHandler } from "./error-handler.js";

/**
 * The model provider's own answer -- status and body -- rides on an error as
 * a non-enumerable `upstreamDetail` so it can never reach a client. It is
 * there for the log, and the log never printed it, so a production 502 said
 * only "the model could not complete that request" (E2E-FINDINGS E-3).
 */
describe("errorHandler", () => {
  it("logs the provider's status and code, never its body or a response", () => {
    const error = HttpError.upstream("The model could not complete that request.");
    Object.defineProperty(error, "upstreamDetail", {
      // What Groq answers for an oversize request; the body can quote the prompt.
      value: { status: 413, code: "request_too_large", body: "Request too large: Tell me about chapter 3..." },
      enumerable: false,
    });

    const logError = vi.fn();
    const req = { log: { error: logError, warn: vi.fn() } } as unknown as Request;
    const json = vi.fn();
    const res = {
      headersSent: false,
      setHeader: vi.fn(),
      status: vi.fn(() => ({ json })),
    } as unknown as Response;

    errorHandler(error, req, res, vi.fn());

    // The status and the provider's code, which say what went wrong; not the
    // body, which can quote a member's unpublished prose.
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ upstream: { status: 413, code: "request_too_large" } }),
      "Request failed",
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain("chapter 3");
    expect(JSON.stringify(json.mock.calls)).not.toContain("Request too large");
  });
});
