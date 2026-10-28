import { describe, expect, it } from "vitest";
import { literalSearch, stem, termsOf } from "./literal-search.js";

const chapters = [
  {
    chapterNumber: 1,
    chapterTitle: "The Lamp Room",
    content:
      "Mira climbed the ninety steps at dusk.\n\nHer eyes, grey as the sea fog, were always on the lamp.\n\nOdile had left when they were girls.",
  },
  {
    chapterNumber: 2,
    chapterTitle: "The Stranger",
    content: "Someone knocked three times on the door below.\n\nMira's eye caught the stranger's colour of coat.",
  },
];

describe("terms", () => {
  it("keeps the words that carry the question", () => {
    expect(termsOf("What colour are Mira's eyes?")).toEqual(["colour", "mira", "eye"]);
  });

  it("stems plurals and verb endings, but never below three letters", () => {
    expect(stem("knocked")).toBe("knock");
    expect(stem("eyes")).toBe("eye");
    expect(stem("climbing")).toBe("climb");
    expect(stem("bus")).toBe("bus");
  });

  it("has nothing to search with for a question of stop words", () => {
    expect(termsOf("What did she say about it?")).toEqual([]);
    expect(literalSearch(chapters, "What did she say?", 5)).toEqual([]);
  });
});

describe("literalSearch", () => {
  it("finds a paragraph by a word's other forms", () => {
    const [hit] = literalSearch(chapters, "eye colour", 5);

    expect(hit).toMatchObject({ chapterNumber: 2, score: 2 });
    expect(hit?.text).toContain("eye caught");
  });

  it("ranks by distinct terms, then reading order", () => {
    const hits = literalSearch(chapters, "Mira eyes", 5);

    // Chapter 2's paragraph names both; chapter 1's two each name one, and
    // keep the order they are read in.
    expect(hits.map((hit) => [hit.chapterNumber, hit.score, hit.text.slice(0, 8)])).toEqual([
      [2, 2, "Mira's e"],
      [1, 1, "Mira cli"],
      [1, 1, "Her eyes"],
    ]);
  });

  it("returns whole paragraphs, at most the limit", () => {
    const hits = literalSearch(chapters, "Mira", 1);

    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe("Mira climbed the ninety steps at dusk.");
  });
});
