/**
 * The one pure decision in conversations: whether a question needs the
 * conversation before it to be understood -- and so a rewrite before it is
 * searched with.
 */

import { describe, expect, it } from "vitest";
import { needsRewrite, pleasantryReply } from "./conversations.js";

describe("needsRewrite", () => {
  it("rewrites a question that points back into the conversation", () => {
    expect(needsRewrite("What happened after that?")).toBe(true);
    expect(needsRewrite("Does he trust Arjun?")).toBe(true);
    expect(needsRewrite("Why did she go there?")).toBe(true);
  });

  it("rewrites a short question that names nobody: an ellipsis", () => {
    expect(needsRewrite("And the lamp?")).toBe(true);
    expect(needsRewrite("Why?")).toBe(true);
  });

  it("leaves a question that stands on its own", () => {
    expect(needsRewrite("Who is Kabir?")).toBe(false);
    expect(needsRewrite("What happened in the archive at midnight?")).toBe(false);
    expect(needsRewrite("Where did Mira find the lamp?")).toBe(false);
  });

  it("does not count the reader referring to themselves", () => {
    expect(needsRewrite("Remind me where Mira found the lamp")).toBe(false);
  });
});

describe("pleasantryReply", () => {
  it("answers thanks, greetings, goodbyes and acknowledgements", () => {
    expect(pleasantryReply("okay thanks")).toMatch(/^You're welcome/);
    expect(pleasantryReply("Thank you so much!!")).toMatch(/^You're welcome/);
    expect(pleasantryReply("hi")).toMatch(/^Hi/);
    expect(pleasantryReply("ok bye")).toMatch(/^Goodbye/);
    expect(pleasantryReply("Got it, cool.")).toMatch(/^Glad/);
  });

  it("leaves anything that might be about the story alone", () => {
    expect(pleasantryReply("Thanks, and who is Kabir?")).toBeNull();
    expect(pleasantryReply("Is Mira okay?")).toBeNull();
    expect(pleasantryReply("Why?")).toBeNull();
    expect(pleasantryReply("And then?")).toBeNull();
    expect(pleasantryReply("thanks thanks thanks thanks thanks thanks thanks")).toBeNull();
  });
});
