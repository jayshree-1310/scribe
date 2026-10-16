import { describe, expect, it } from "vitest";
import {
  BIBLE_CHAR_LIMIT,
  BIBLE_FACT_LIMIT,
  PER_SUBJECT_LIMIT,
  collapseByKey,
  factKeyOf,
  factLine,
  fingerprintOf,
  locateQuote,
  mentions,
  normalise,
  sectionsOf,
  selectFacts,
  shareSubject,
  valueKeyOf,
  type BibleFact,
} from "./bible-facts.js";
import type { FactKind } from "./schemas.js";

let seq = 0;

/** A fact with keys derived the way the service derives them. */
function fact(patch: Partial<BibleFact> & { subject: string }): BibleFact {
  const base = {
    kind: "character" as FactKind,
    attribute: "eye colour",
    value: "green",
    related: null,
    ...patch,
  };

  seq += 1;
  return {
    id: patch.id ?? `f${String(seq).padStart(4, "0")}`,
    quote: "the chapter's own words",
    origin: "extracted",
    chapterId: `c${patch.chapterNumber ?? 1}`,
    chapterNumber: 1,
    factKey: factKeyOf(base),
    valueKey: valueKeyOf(base.value),
    ...base,
    ...patch,
  };
}

describe("identity", () => {
  it("folds case, punctuation and spacing, and nothing else", () => {
    expect(normalise("  Eye-COLOUR  ")).toBe("eye colour");
    expect(normalise("eye color")).not.toBe(normalise("eye colour"));
  });

  it("keys a fact by kind, subject and attribute", () => {
    expect(
      factKeyOf({ kind: "character", subject: "Mira", attribute: "Eye colour", related: null }),
    ).toBe(
      factKeyOf({ kind: "character", subject: "mira", attribute: "eye-colour", related: null }),
    );
  });

  it("keys a relationship by who it is with, not what it is called", () => {
    const sister = factKeyOf({
      kind: "relationship",
      subject: "Mira",
      attribute: "sister of",
      related: "Arjun",
    });
    const sibling = factKeyOf({
      kind: "relationship",
      subject: "Mira",
      attribute: "sibling",
      related: "Arjun",
    });

    expect(sister).toBe(sibling);
  });
});

describe("locateQuote", () => {
  const chapter =
    "Mira kept the light.\nHer eyes were *green* as “sea glass” — everyone said so.\nShe was thirty.";

  it("finds a faithful copy and returns the chapter's own text", () => {
    expect(locateQuote(chapter, 'Her eyes were green as "sea glass" - everyone')).toBe(
      "Her eyes were *green* as “sea glass” — everyone",
    );
  });

  it("is loose about case and line breaks", () => {
    expect(locateQuote(chapter, "mira kept the light. her eyes were green")).toBe(
      "Mira kept the light.\nHer eyes were *green*",
    );
  });

  it("keeps the emphasis marks around a word the match ends on", () => {
    expect(locateQuote(chapter, "Her eyes were green")).toBe("Her eyes were *green*");
    expect(locateQuote("It was **never** hers.", "never hers")).toBe("**never** hers");
  });

  it("does not find a paraphrase", () => {
    expect(locateQuote(chapter, "Her eyes were the green of sea glass")).toBeNull();
  });

  it("refuses a quote too short to be evidence", () => {
    expect(locateQuote(chapter, "Mira")).toBeNull();
  });

  it("checks the longer half of an elided quote", () => {
    expect(locateQuote(chapter, "Mira kept… everyone said so")).toBe(
      "everyone said so",
    );
  });
});

describe("sectionsOf", () => {
  it("keeps a short chapter whole", () => {
    expect(sectionsOf("One.\nTwo.")).toEqual({
      sections: ["One.\nTwo."],
      truncated: false,
    });
  });

  it("cuts on paragraph boundaries and never exceeds the limit", () => {
    const paragraph = "word ".repeat(30).trim();
    const { sections } = sectionsOf(
      Array.from({ length: 10 }, () => paragraph).join("\n"),
      400,
      99,
    );

    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.length).toBeLessThanOrEqual(400);
      expect(section.startsWith("word")).toBe(true);
      expect(section.endsWith("word")).toBe(true);
    }
  });

  it("says so when it stopped reading", () => {
    const { sections, truncated } = sectionsOf(
      Array.from({ length: 10 }, () => "x".repeat(90)).join("\n"),
      100,
      3,
    );

    expect(sections).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it("is deterministic", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}.`).join("\n");

    expect(sectionsOf(text, 120)).toEqual(sectionsOf(text, 120));
  });
});

describe("mentions", () => {
  it("matches a whole name and its distinctive words", () => {
    expect(mentions("Desai closed the shutters.", "Mira Desai")).toBe(true);
    expect(mentions("Mira closed the shutters.", "Mira Desai")).toBe(true);
  });

  it("does not match a title word on its own", () => {
    expect(mentions("An old boat on the shingle.", "Old Tom")).toBe(false);
    expect(mentions("Tom was on the shingle.", "Old Tom")).toBe(true);
  });

  it("does not take the ordinary word for the name", () => {
    expect(mentions("She will go tomorrow.", "Will")).toBe(false);
    expect(mentions("She told Will tomorrow.", "Will")).toBe(true);
  });

  it("does not match inside a longer word", () => {
    expect(mentions("Miranda arrived.", "Mira")).toBe(false);
  });

  it("ignores case for a name that has none", () => {
    expect(mentions("Past The Old Mill and on.", "the old mill")).toBe(true);
  });
});

describe("shareSubject", () => {
  it("joins a short name to its full one", () => {
    expect(
      shareSubject(
        { subject: "Mira", related: null },
        { subject: "Mira Desai", related: null },
      ),
    ).toBe(true);
  });

  it("counts either party of a relationship", () => {
    expect(
      shareSubject(
        { subject: "Arjun", related: null },
        { subject: "Mira", related: "Arjun" },
      ),
    ).toBe(true);
  });

  it("keeps different people apart", () => {
    expect(
      shareSubject(
        { subject: "Mira", related: null },
        { subject: "Arjun", related: null },
      ),
    ).toBe(false);
  });

  it("does not join two people on a title", () => {
    expect(
      shareSubject(
        { subject: "Captain Rao", related: null },
        { subject: "Captain Okafor", related: null },
      ),
    ).toBe(false);
  });
});

describe("collapseByKey", () => {
  it("believes the author over a later extraction", () => {
    const authored = fact({ subject: "Mira", value: "grey", origin: "author", chapterNumber: 2 });
    const later = fact({ subject: "Mira", value: "green", chapterNumber: 5 });

    const kept = collapseByKey([later, authored], 9);

    expect(kept[0]).toBe(authored);
    // And still shows what the text most recently says, because it differs.
    expect(kept).toContain(later);
  });

  it("keeps one row when the two agree", () => {
    const first = fact({ subject: "Mira", chapterNumber: 2 });
    const second = fact({ subject: "Mira", chapterNumber: 5 });

    expect(collapseByKey([first, second], 9)).toEqual([second]);
  });

  it("prefers what has already happened to what has not", () => {
    const past = fact({ subject: "Mira", attribute: "whereabouts", value: "harbour", chapterNumber: 2 });
    const future = fact({ subject: "Mira", attribute: "whereabouts", value: "city", chapterNumber: 8 });

    expect(collapseByKey([future, past], 4)).toEqual([past]);
  });
});

/** Distinct capitalised names made of letters only: Naa, Nab, Nac... */
function nameAt(index: number): string {
  return `N${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
}

describe("selectFacts", () => {
  it("returns nothing for a passage the bible has nothing on", () => {
    const facts = [fact({ subject: "Mira" })];

    expect(
      selectFacts({ facts, text: "A gull landed.", chapterNumber: 1, similar: [] }),
    ).toEqual([]);
  });

  it("picks facts about whoever the passage names", () => {
    const mira = fact({ subject: "Mira Desai" });
    const arjun = fact({ subject: "Arjun" });

    const chosen = selectFacts({
      facts: [mira, arjun],
      text: "Mira looked up.",
      chapterNumber: 3,
      similar: [],
    });

    expect(chosen).toEqual([mira]);
  });

  it("includes recent events nobody named", () => {
    const storm = fact({
      kind: "event",
      subject: "The storm",
      attribute: "what happened",
      value: "the pier was lost",
      chapterNumber: 4,
    });
    const old = fact({
      kind: "event",
      subject: "The wedding",
      attribute: "what happened",
      value: "they married",
      chapterNumber: 1,
    });
    const filler = fact({ kind: "event", subject: "The fair", attribute: "when", value: "spring", chapterNumber: 3 });

    const chosen = selectFacts({
      facts: [old, filler, storm],
      text: "Nothing in particular.",
      chapterNumber: 4,
      similar: [],
    });

    expect(chosen).toContain(storm);
    expect(chosen).toContain(filler);
    expect(chosen).not.toContain(old);
  });

  it("includes what is near in meaning, though never named", () => {
    const pier = fact({ kind: "location", subject: "Saltmarsh Pier", attribute: "condition", value: "wrecked" });

    const chosen = selectFacts({
      facts: [pier],
      text: "The tempest had not let up.",
      chapterNumber: 2,
      similar: [pier.id],
    });

    expect(chosen).toEqual([pier]);
  });

  it("ignores a similar id that is not a live fact", () => {
    expect(
      selectFacts({ facts: [], text: "x", chapterNumber: 1, similar: ["gone"] }),
    ).toEqual([]);
  });

  it("holds the fact budget however much is relevant", () => {
    const facts = Array.from({ length: 60 }, (_, index) =>
      fact({ subject: nameAt(index), attribute: "age", value: String(index) }),
    );
    const text = facts.map((item) => item.subject).join(", ");

    const chosen = selectFacts({ facts, text, chapterNumber: 2, similar: [] });

    expect(chosen).toHaveLength(BIBLE_FACT_LIMIT);
  });

  it("holds the character budget when facts are long", () => {
    const facts = Array.from({ length: 30 }, (_, index) =>
      fact({ subject: nameAt(index), attribute: "history", value: "x".repeat(280) }),
    );
    const text = facts.map((item) => item.subject).join(", ");

    const chosen = selectFacts({ facts, text, chapterNumber: 2, similar: [] });
    const size = chosen.reduce((total, item) => total + factLine(item).length + 1, 0);

    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.length).toBeLessThan(BIBLE_FACT_LIMIT);
    expect(size).toBeLessThanOrEqual(BIBLE_CHAR_LIMIT);
  });

  it("does not let one subject take every place", () => {
    const mira = Array.from({ length: 12 }, (_, index) =>
      fact({ subject: "Mira", attribute: `trait ${index}`, value: "yes" }),
    );
    const arjun = fact({ subject: "Arjun" });

    const chosen = selectFacts({
      facts: [...mira, arjun],
      text: "Mira and Arjun.",
      chapterNumber: 2,
      similar: [],
    });

    expect(chosen.filter((item) => item.subject === "Mira")).toHaveLength(
      PER_SUBJECT_LIMIT,
    );
    expect(chosen).toContain(arjun);
  });

  it("reads as a timeline", () => {
    const late = fact({ subject: "Mira", attribute: "job", value: "keeper", chapterNumber: 6 });
    const early = fact({ subject: "Mira", attribute: "age", value: "thirty", chapterNumber: 1 });

    const chosen = selectFacts({
      facts: [late, early],
      text: "Mira.",
      chapterNumber: 9,
      similar: [],
    });

    expect(chosen.map((item) => item.chapterNumber)).toEqual([1, 6]);
  });
});

describe("factLine", () => {
  it("says where a fact is from and whether the author confirmed it", () => {
    expect(factLine(fact({ subject: "Mira", chapterNumber: 3 }))).toBe(
      "[Chapter 3] Mira (character) — eye colour: green",
    );
    expect(
      factLine(fact({ subject: "Mira", chapterNumber: null, chapterId: null, origin: "author" })),
    ).toBe("[Whole story, confirmed by the author] Mira (character) — eye colour: green");
  });
});

describe("fingerprintOf", () => {
  const green = fact({ subject: "Mira", value: "green", chapterId: "c2" });
  const blue = fact({ subject: "Mira", value: "blue", chapterId: "c5" });

  it("is the same pair whichever side was checked", () => {
    expect(fingerprintOf(green, blue)).toBe(fingerprintOf(blue, green));
  });

  it("does not depend on row ids", () => {
    const reExtracted: BibleFact = { ...green, id: "other" };

    expect(fingerprintOf(reExtracted, blue)).toBe(
      fingerprintOf(green, blue),
    );
  });

  it("changes when either claim does", () => {
    const grey = fact({ subject: "Mira", value: "grey", chapterId: "c5" });

    expect(fingerprintOf(green, grey)).not.toBe(fingerprintOf(green, blue));
  });
});
