/**
 * Unit tests for the narration scanner. No database, no provider: this is a
 * pure function over strings, and the cases that matter are the ones where a
 * delta boundary lands somewhere awkward.
 */

import { describe, expect, it } from "vitest";
import { createNarrationScanner, type NarrationEvent } from "./json-stream.js";

/** Feeds `text` in chunks of `size` and collects everything emitted. */
function scan(text: string, size: number): NarrationEvent[] {
  const scanner = createNarrationScanner();
  const events: NarrationEvent[] = [];
  for (let at = 0; at < text.length; at += size) {
    events.push(...scanner.push(text.slice(at, at + size)));
  }
  return events;
}

const REPLY = JSON.stringify({
  intro: "Here are a few to try.",
  picks: [
    { id: "aaa", reason: "Gentle and short." },
    { id: "bbb", reason: "Longer, but worth it." },
  ],
});

describe("createNarrationScanner", () => {
  it("emits the intro once its string closes, then one event per pick", () => {
    expect(scan(REPLY, REPLY.length)).toEqual([
      { type: "intro", text: "Here are a few to try." },
      { type: "pick", id: "aaa", reason: "Gentle and short." },
      { type: "pick", id: "bbb", reason: "Longer, but worth it." },
    ]);
  });

  /**
   * The real reason this is a byte-wise scanner. A delta is whatever one
   * NDJSON line carried, so every boundary below is one a model can produce.
   */
  it("gives the same events at every chunk size", () => {
    const whole = scan(REPLY, REPLY.length);
    for (const size of [1, 2, 3, 5, 7, 11, 23, 64]) {
      expect(scan(REPLY, size)).toEqual(whole);
    }
  });

  it("emits a pick as soon as it closes, not at the end", () => {
    const scanner = createNarrationScanner();
    const upToFirst = REPLY.slice(0, REPLY.indexOf("}", REPLY.indexOf("aaa")) + 1);

    const events = scanner.push(upToFirst);

    expect(events).toContainEqual({
      type: "pick",
      id: "aaa",
      reason: "Gentle and short.",
    });
    expect(events.filter((event) => event.type === "pick")).toHaveLength(1);
  });

  it("is not fooled by a brace inside a reason", () => {
    const reply = JSON.stringify({
      intro: "ok",
      picks: [{ id: "aaa", reason: "Uses { and } as motifs." }],
    });

    expect(scan(reply, 3)).toEqual([
      { type: "intro", text: "ok" },
      { type: "pick", id: "aaa", reason: "Uses { and } as motifs." },
    ]);
  });

  it("is not fooled by an escaped quote inside a reason", () => {
    const reply = JSON.stringify({
      intro: 'She said "read it"',
      picks: [{ id: "aaa", reason: 'A "quiet" book.' }],
    });

    expect(scan(reply, 2)).toEqual([
      { type: "intro", text: 'She said "read it"' },
      { type: "pick", id: "aaa", reason: 'A "quiet" book.' },
    ]);
  });

  it("waits rather than guessing when a unicode escape is split", () => {
    const reply = JSON.stringify({ intro: "café", picks: [] });
    // Split inside the é escape sequence.
    const cut = reply.indexOf("\\u") + 3;

    const scanner = createNarrationScanner();
    expect(scanner.push(reply.slice(0, cut))).toEqual([]);
    expect(scanner.push(reply.slice(cut))).toEqual([
      { type: "intro", text: "café" },
    ]);
  });

  it("emits nothing for an empty intro", () => {
    const reply = JSON.stringify({ intro: "", picks: [{ id: "aaa", reason: "x" }] });

    expect(scan(reply, 4)).toEqual([{ type: "pick", id: "aaa", reason: "x" }]);
  });

  it("keeps the raw text for the terminal whole-object validation", () => {
    const scanner = createNarrationScanner();
    scanner.push(REPLY);
    expect(scanner.text()).toBe(REPLY);
  });

  it("emits nothing at all for prose that is not JSON", () => {
    expect(scan("I'm afraid I can't help with that.", 5)).toEqual([]);
  });
});
