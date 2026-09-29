/**
 * The chunker, which is pure and therefore testable without a model or a
 * database — see `chunking.ts` for why it is its own file.
 *
 * The properties asserted here are the ones the rest of retrieval depends on:
 * determinism (or nothing can be cached by hash), bounds (or a window will not
 * fit a model), and boundaries (or a search result is a fragment starting
 * mid-sentence).
 */

import { describe, expect, it } from "vitest";
import {
  CHUNK_HARD_MAX_CHARS,
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  chunkChapter,
} from "./chunking.js";

/** `count` paragraphs of roughly `size` characters, each distinguishable. */
function prose(count: number, size = 300, separator = "\n\n"): string {
  return Array.from({ length: count }, (_, index) => {
    const sentence = `Paragraph ${index} says something about the lamp. `;
    return sentence.repeat(Math.ceil(size / sentence.length)).slice(0, size);
  }).join(separator);
}

describe("chunkChapter", () => {
  it("is deterministic in text, order and hash", () => {
    const content = prose(12);

    expect(chunkChapter(content)).toEqual(chunkChapter(content));
  });

  it("gives different text different hashes", () => {
    const [first] = chunkChapter("One paragraph.");
    const [second] = chunkChapter("One paragraph!");

    expect(first?.hash).not.toEqual(second?.hash);
  });

  it("numbers chunks contiguously from zero", () => {
    const chunks = chunkChapter(prose(20));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_, index) => index),
    );
  });

  it("keeps every chunk within the hard bound", () => {
    // Ordinary prose, a chapter of one enormous paragraph, and a paragraph
    // with no sentence punctuation to split on — the three shapes that reach
    // three different branches.
    for (const content of [
      prose(40),
      "x".repeat(CHUNK_MAX_CHARS * 3),
      `${prose(3)}\n\n${"No full stops here ".repeat(400)}`,
    ]) {
      for (const chunk of chunkChapter(content)) {
        expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_HARD_MAX_CHARS);
      }
    }
  });

  it("packs several paragraphs into one window rather than one each", () => {
    const chunks = chunkChapter(prose(8, 200));

    // Eight 200-character paragraphs are 1600 characters: too much for one
    // window at a 1200 target, and far too little for eight.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(8);
  });

  it("splits on paragraph boundaries, not mid-sentence", () => {
    for (const chunk of chunkChapter(prose(30))) {
      expect(chunk.text.startsWith("Paragraph ")).toBe(true);
    }
  });

  it("treats a single newline as a paragraph break", () => {
    // The seeded serial separates paragraphs with one newline, not a blank
    // line, and gets chunked at paragraph boundaries all the same. See
    // `paragraphsOf` in `chunking.ts` for why this differs from the renderer.
    const singleNewline = chunkChapter(prose(30, 300, "\n"));

    expect(singleNewline.length).toBeGreaterThan(1);
    for (const chunk of singleNewline) {
      expect(chunk.text.startsWith("Paragraph ")).toBe(true);
    }
  });

  it("repeats the tail of each window at the head of the next", () => {
    const chunks = chunkChapter(prose(30, 200));
    expect(chunks.length).toBeGreaterThan(2);

    for (const [index, chunk] of chunks.entries()) {
      if (index === 0) continue;

      const previous = chunks[index - 1] as { text: string };
      const opening = chunk.text.slice(0, 40);

      expect(previous.text).toContain(opening);
    }
  });

  it("never repeats more than the overlap budget", () => {
    const chunks = chunkChapter(prose(30, 200));

    for (const [index, chunk] of chunks.entries()) {
      if (index === 0) continue;
      const previous = chunks[index - 1] as { text: string };

      // How much of this window the previous one already contained.
      let shared = 0;
      while (
        shared < chunk.text.length &&
        previous.text.includes(chunk.text.slice(0, shared + 1))
      ) {
        shared += 1;
      }

      expect(shared).toBeLessThanOrEqual(CHUNK_OVERLAP_CHARS);
    }
  });

  it("never emits a window that is only carried-over overlap", () => {
    // Paragraphs just under the target: each window is one paragraph plus the
    // overlap before it, which is the case that used to emit a duplicate of
    // the previous window's tail on its own.
    const chunks = chunkChapter(prose(6, CHUNK_TARGET_CHARS - 100));

    const texts = chunks.map((chunk) => chunk.text);
    expect(new Set(texts).size).toBe(texts.length);

    for (const [index, chunk] of chunks.entries()) {
      if (index === 0) continue;
      const previous = chunks[index - 1] as { text: string };
      expect(previous.text).not.toContain(chunk.text);
    }
  });

  it("returns nothing for a chapter with no prose", () => {
    expect(chunkChapter("")).toEqual([]);
    expect(chunkChapter("   \n\n  \n ")).toEqual([]);
  });

  it("returns one window for a chapter shorter than the target", () => {
    const chunks = chunkChapter("A short chapter.\n\nTwo paragraphs only.");

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("A short chapter.");
    expect(chunks[0]?.text).toContain("Two paragraphs only.");
  });
});
