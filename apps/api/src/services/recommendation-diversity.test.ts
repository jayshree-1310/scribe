import { describe, expect, it } from "vitest";
import {
  MAX_PER_AUTHOR,
  diversify,
  maxPerGenre,
  type DiversityKey,
} from "./recommendation-diversity.js";

interface Item extends DiversityKey {
  id: string;
}

/** `a1:x` is story `a1` by author `a`, tagged `x`. Ranked in the order given. */
function ranking(...specs: string[]): Item[] {
  return specs.map((spec) => {
    const [id = "", genres = ""] = spec.split(":");
    return {
      id,
      authorId: id.replace(/\d+$/, ""),
      genreIds: genres === "" ? [] : genres.split("+"),
    };
  });
}

function pick(items: Item[], limit: number): string[] {
  return diversify(items, limit, (item) => item).map((item) => item.id);
}

describe("diversify", () => {
  it("leaves a ranking alone when nothing is over a cap", () => {
    const items = ranking("a1:x", "b1:y", "c1:z", "d1:w");

    expect(pick(items, 3)).toEqual(["a1", "b1", "c1"]);
  });

  it("holds an author to their best two", () => {
    expect(MAX_PER_AUTHOR).toBe(2);

    // Distinct genres, so only the author cap can be what holds a3 and a4.
    const items = ranking("a1:p", "a2:q", "a3:r", "a4:s", "b1:t", "c1:u");

    expect(pick(items, 4)).toEqual(["a1", "a2", "b1", "c1"]);
  });

  it("holds a genre to half the page", () => {
    expect(maxPerGenre(4)).toBe(2);

    const items = ranking("a1:x", "b1:x", "c1:x", "d1:x", "e1:y", "f1:z");

    expect(pick(items, 4)).toEqual(["a1", "b1", "e1", "f1"]);
  });

  it("counts a story against every genre it carries", () => {
    // c1 is over on `x` though it also carries `y`, which has room.
    const items = ranking("a1:x", "b1:x", "c1:x+y", "d1:y", "e1:z");

    expect(pick(items, 4)).toEqual(["a1", "b1", "d1", "e1"]);
  });

  it("never holds an untagged story for its genres", () => {
    const items = ranking("a1", "b1", "c1", "d1");

    expect(pick(items, 4)).toEqual(["a1", "b1", "c1", "d1"]);
  });

  it("fills the page from what it held back rather than leaving it short", () => {
    // One author and nobody else: the caps cannot be met, so the page is the
    // ranking, with the stories that fit ahead of the ones that did not.
    const items = ranking("a1:p", "a2:q", "a3:r", "a4:s");

    expect(pick(items, 3)).toEqual(["a1", "a2", "a3"]);
  });

  it("tops up in ranked order, after everything that fit", () => {
    const items = ranking("a1:p", "a2:q", "a3:r", "b1:s");

    expect(pick(items, 4)).toEqual(["a1", "a2", "b1", "a3"]);
  });

  it("does not let a small page turn the genre cap into a ban", () => {
    expect(maxPerGenre(1)).toBe(2);
    expect(maxPerGenre(12)).toBe(6);
    expect(maxPerGenre(5)).toBe(3);
  });

  it("returns the same page for the same ranking", () => {
    const items = ranking("a1:x", "a2:x", "a3:y", "b1:x", "c1:y", "d1:z");

    expect(pick(items, 4)).toEqual(pick(items, 4));
  });
});
