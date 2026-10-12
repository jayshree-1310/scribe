/**
 * The story bible's pure half: what makes two facts the same fact, whether a
 * quote is really in a chapter, which names a passage mentions, and which
 * facts are worth a place in a prompt.
 *
 * Split from `story-bible.ts` the way `search-ranking.ts` is split from
 * `search.ts`: everything here is a function of its arguments, so the parts of
 * the feature that decide *what is true* and *what is relevant* are tested
 * without a database, a model or a clock.
 */

import { createHash } from "node:crypto";
import type { FactKind } from "./schemas.js";
import { fuseRankings } from "./search-ranking.js";

export type FactOrigin = "extracted" | "author";

/** A live fact -- not rejected -- as selection and the prompts see it. */
export interface BibleFact {
  id: string;
  kind: FactKind;
  subject: string;
  attribute: string;
  value: string;
  related: string | null;
  /** The chapter's own words. Null only for a fact the author typed in. */
  quote: string | null;
  origin: FactOrigin;
  /** Null for a story-wide fact the author added. */
  chapterId: string | null;
  chapterNumber: number | null;
  factKey: string;
  valueKey: string;
}

/* Identity --------------------------------------------------------------- */

/**
 * Case, punctuation and spacing folded away: "Eye colour", "eye-colour" and
 * "EYE  COLOUR" are one attribute. Deliberately no synonyms -- "eye color" and
 * "eyes" stay different keys. A wrong merge would let an author's correction
 * of one fact silently suppress a different one, which is worse than a
 * duplicate the author can see and remove.
 */
export function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The identity precedence is decided on: kind, subject, and what is being
 * said about it. A relationship is identified by who it is *with* rather than
 * by its label, because "sister of" and "sibling" are the same fact about the
 * same two people and two models will not agree on which to write.
 */
export function factKeyOf(fact: {
  kind: FactKind;
  subject: string;
  attribute: string;
  related: string | null;
}): string {
  const facet =
    fact.kind === "relationship" && fact.related ? fact.related : fact.attribute;
  return `${fact.kind}:${normalise(fact.subject)}:${normalise(facet)}`;
}

export function valueKeyOf(value: string): string {
  return normalise(value);
}

/* Grounding -------------------------------------------------------------- */

/**
 * A quote shorter than this is a name, not evidence. "Mira" occurs in every
 * chapter Mira is in and proves nothing about her eye colour.
 */
export const MIN_QUOTE_CHARS = 8;

/** Emphasis marks the editor writes and a model copying prose leaves out. */
const MARKS = new Set(["*", "_", "~", "`"]);

const FOLDS: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "‟": '"',
  "–": "-",
  "—": "-",
};

/**
 * `text` folded for searching, plus where each folded character came from.
 *
 * The map is the point: a match in the folded text has to be cut out of the
 * *original*, so that what is stored as evidence is the chapter's own words
 * -- its curly quotes, its emphasis -- and not the model's copy of them.
 */
function folded(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let pendingSpace = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (MARKS.has(char)) continue;

    if (/\s/u.test(char)) {
      if (pendingSpace === -1) pendingSpace = index;
      continue;
    }

    if (pendingSpace !== -1) {
      if (out.length > 0) {
        out += " ";
        map.push(pendingSpace);
      }
      pendingSpace = -1;
    }

    for (const piece of (FOLDS[char] ?? char).toLowerCase()) {
      out += piece;
      map.push(index);
    }
  }

  return { text: out, map };
}

const WRAPPING_QUOTES = /^["'“”‘’«»]+|["'“”‘’«»]+$/g;
const ELLIPSIS = /\s*(?:\.\.\.|…)\s*/;

/**
 * The span of `content` a model's quote refers to, or null if it is not
 * there.
 *
 * Loose about what a faithful copy loses -- emphasis marks, curly versus
 * straight quotes, line breaks, case -- and strict about everything else:
 * a paraphrase is not found, and a fact whose evidence is not found is not
 * stored. An elided quote ("she said… and left") is two quotes, and the
 * longer piece is the one that has to be there.
 *
 * Returns the chapter's own text rather than true, so the stored evidence is
 * what the author wrote.
 *
 * Curried because an extraction checks every fact against one chapter, and
 * folding a fifty-thousand-character chapter once per fact is the only
 * expensive thing in here.
 */
export function quoteLocator(content: string): (quote: string) => string | null {
  const haystack = folded(content);

  return (quote) => {
    const trimmed = quote.trim().replace(WRAPPING_QUOTES, "").trim();
    const piece = trimmed
      .split(ELLIPSIS)
      .map((part) => part.trim())
      .sort((a, b) => b.length - a.length)[0];
    if (!piece) return null;

    const needle = folded(piece).text;
    if (needle.length < MIN_QUOTE_CHARS) return null;

    const at = haystack.text.indexOf(needle);
    if (at === -1) return null;

    const start = haystack.map[at] as number;
    const end = (haystack.map[at + needle.length - 1] as number) + 1;
    return content.slice(start, end).trim();
  };
}

export function locateQuote(content: string, quote: string): string | null {
  return quoteLocator(content)(quote);
}

/* Sections --------------------------------------------------------------- */

/**
 * How much of a chapter one extraction call reads, in characters.
 *
 * Smaller than the recap's 24k on purpose. Extraction is the task a small
 * model does worst over a long input -- it reports the first scene in detail
 * and the last one not at all -- and a list of facts, unlike a recap, has no
 * reason to be written in one pass.
 */
export const SECTION_CHARS = 12_000;

/**
 * Beyond this many sections the rest of a chapter is not read, and the
 * extraction says so (`truncated`). Four sections is ~48k characters, a
 * novella-length chapter; the cap exists so one pasted manuscript cannot turn
 * a save into twenty model calls.
 */
export const MAX_SECTIONS = 4;

/**
 * A chapter cut into sections on paragraph boundaries.
 *
 * Paragraphs are split on any newline, as `chunking.ts` does and for its
 * reason: the editor separates paragraphs with one. A single paragraph longer
 * than a section is cut at the last space before the limit.
 */
export function sectionsOf(
  content: string,
  limit = SECTION_CHARS,
  max = MAX_SECTIONS,
): { sections: string[]; truncated: boolean } {
  const units: string[] = [];

  for (const paragraph of content.split(/\n+/)) {
    let rest = paragraph.trim();
    while (rest.length > limit) {
      const cut = rest.lastIndexOf(" ", limit);
      const at = cut > limit / 2 ? cut : limit;
      units.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest.length > 0) units.push(rest);
  }

  const sections: string[] = [];
  let current = "";

  for (const unit of units) {
    const joined = current.length === 0 ? unit : `${current}\n${unit}`;
    if (joined.length > limit && current.length > 0) {
      sections.push(current);
      current = unit;
    } else {
      current = joined;
    }
  }
  if (current.length > 0) sections.push(current);

  return {
    sections: sections.slice(0, max),
    truncated: sections.length > max,
  };
}

/* Names ------------------------------------------------------------------ */

/**
 * Words that start a name without identifying anybody. "Old Tom" is matched
 * by "Tom", never by "Old"; "The Lighthouse" by its whole name only.
 */
const TITLE_WORDS = new Set(
  (
    "the a an old young little big mr mrs ms miss dr doctor sir lady lord " +
    "captain king queen prince princess aunt uncle father mother brother " +
    "sister saint st mount lake river"
  ).split(" "),
);

/** Letters only, so a name can never put a metacharacter into a pattern. */
function lettersOf(name: string): string[] {
  return name.match(/[\p{L}\p{M}]+/gu) ?? [];
}

function boundaryPattern(words: string[], flags: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])${words.join("\\s+")}(?![\\p{L}\\p{M}\\p{N}])`,
    flags,
  );
}

/**
 * The patterns that count as a mention of `name`: the whole name, and each
 * distinctive word of it.
 *
 * **Case-sensitive for a capitalised name.** "Will", "Hope" and "Rose" are
 * also ordinary words, and a story about Will is full of the word "will"; a
 * character's name is capitalised in prose and its homonym usually is not.
 * A lower-case subject -- "the old mill" -- is matched without regard to case,
 * because it has no capitalisation to rely on.
 */
export function namePatterns(name: string): RegExp[] {
  const words = lettersOf(name);
  if (words.length === 0) return [];

  const sensitive = /^\p{Lu}/u.test(words[0] as string);
  const flags = sensitive ? "u" : "iu";
  const patterns = [boundaryPattern(words, flags)];

  if (words.length > 1) {
    for (const word of words) {
      if (word.length < 3 || TITLE_WORDS.has(word.toLowerCase())) continue;
      if (sensitive && !/^\p{Lu}/u.test(word)) continue;
      patterns.push(boundaryPattern([word], flags));
    }
  }

  return patterns;
}

export function mentions(text: string, name: string): boolean {
  return namePatterns(name).some((pattern) => pattern.test(text));
}

/** The words that identify a name, for comparing two names with each other. */
function distinctiveWords(name: string): Set<string> {
  return new Set(
    lettersOf(name)
      .map((word) => word.toLowerCase())
      .filter((word) => word.length >= 3 && !TITLE_WORDS.has(word)),
  );
}

function sameEntity(a: string, b: string): boolean {
  if (normalise(a) === normalise(b)) return true;

  const left = distinctiveWords(a);
  for (const word of distinctiveWords(b)) if (left.has(word)) return true;
  return false;
}

/**
 * Whether two facts are about the same person, place or event.
 *
 * The deterministic guard under the continuity checker: a contradiction is
 * between two claims about one thing, so a reported pair about Mira and about
 * Arjun is a model pairing the wrong lines, whatever confidence it gave.
 * Relationships count by either party.
 */
export function shareSubject(
  a: { subject: string; related: string | null },
  b: { subject: string; related: string | null },
): boolean {
  const left = [a.subject, a.related].filter((name): name is string => !!name);
  const right = [b.subject, b.related].filter((name): name is string => !!name);
  return left.some((x) => right.some((y) => sameEntity(x, y)));
}

/* Prompt lines ----------------------------------------------------------- */

function whoOf(fact: Pick<BibleFact, "subject" | "related">): string {
  return fact.related ? `${fact.subject} and ${fact.related}` : fact.subject;
}

/**
 * One fact as a prompt shows it. Also what the budget measures, so the budget
 * is in the same units as what is actually sent.
 */
export function factLine(fact: BibleFact): string {
  const where =
    fact.chapterNumber === null ? "Whole story" : `Chapter ${fact.chapterNumber}`;
  const confirmed = fact.origin === "author" ? ", confirmed by the author" : "";
  return `[${where}${confirmed}] ${whoOf(fact)} (${fact.kind}) — ${fact.attribute}: ${fact.value}`;
}

/** What a fact is embedded as: the claim, without the bookkeeping. */
export function embeddingTextOf(
  fact: Pick<BibleFact, "subject" | "related" | "attribute" | "value">,
): string {
  return `${whoOf(fact)}: ${fact.attribute} — ${fact.value}`;
}

/* Selection -------------------------------------------------------------- */

/**
 * The budget for bible context in an assistant prompt.
 *
 * Sixteen facts or 2400 characters (~600 tokens), whichever comes first. The
 * assistant's own window is ~2000 tokens of prose (`assist.ts`), and context
 * that outweighs the passage gets summarised instead of respected -- the same
 * failure the assistant's window exists to prevent. A forty-chapter bible
 * runs to hundreds of facts; this is what fits beside one paragraph.
 */
export const BIBLE_FACT_LIMIT = 16;
export const BIBLE_CHAR_LIMIT = 2400;

/**
 * No one subject takes more than this many places. A protagonist named in the
 * passage has forty facts; without a cap they fill the budget and push out the
 * place the scene is set and the event it follows.
 */
export const PER_SUBJECT_LIMIT = 5;

/** "Recent events" means events from this many chapters up to the current one. */
export const RECENT_CHAPTERS = 2;

const KIND_ORDER: Record<FactKind, number> = {
  character: 0,
  relationship: 1,
  location: 2,
  event: 3,
};

/** Story-wide facts sit before chapter 1: true throughout, so never "after". */
const at = (fact: BibleFact): number => fact.chapterNumber ?? 0;

/**
 * At most two facts per key: the one to believe and, if it says something
 * different, the latest the text itself says.
 *
 * "The one to believe" is an author's own fact first, then the most recent
 * fact at or before the current chapter, then the earliest after it. The
 * second slot exists because whereabouts change: an author who confirmed in
 * chapter two that Mira lives at the harbour has not said where she is in
 * chapter nine, and the model should see both.
 */
export function collapseByKey(
  facts: BibleFact[],
  position: number,
): BibleFact[] {
  const groups = new Map<string, BibleFact[]>();
  for (const fact of facts) {
    const group = groups.get(fact.factKey) ?? [];
    group.push(fact);
    groups.set(fact.factKey, group);
  }

  const before = (fact: BibleFact) => at(fact) <= position;
  const recency = (a: BibleFact, b: BibleFact) =>
    before(a) !== before(b)
      ? before(a)
        ? -1
        : 1
      : before(a)
        ? at(b) - at(a)
        : at(a) - at(b);

  const kept: BibleFact[] = [];

  for (const group of groups.values()) {
    const believed = [...group].sort(
      (a, b) =>
        (a.origin === "author" ? 0 : 1) - (b.origin === "author" ? 0 : 1) ||
        recency(a, b) ||
        a.id.localeCompare(b.id),
    )[0] as BibleFact;
    kept.push(believed);

    const latest = [...group]
      .filter(before)
      .sort((a, b) => recency(a, b) || a.id.localeCompare(b.id))[0];
    if (latest && latest.valueKey !== believed.valueKey) kept.push(latest);
  }

  return kept;
}

export interface SelectionInput {
  /** Every live fact of the story. */
  facts: BibleFact[];
  /** The prose the assistant is about to work on, with its window. */
  text: string;
  /** The chapter that prose sits in; null for one not saved yet (after the last). */
  chapterNumber: number | null;
  /** Fact ids by embedding similarity to `text`, nearest first, already floored. */
  similar: string[];
}

/**
 * The facts worth a place in the prompt, within the budget, in reading order.
 *
 * Three rankings, fused by rank exactly as hybrid search fuses its two
 * (`fuseRankings`), because none of them is sufficient alone:
 *
 * - **Named.** Facts about anybody or anywhere the passage names. Counted
 *   twice in the fusion: the commonest continuity mistake a continuation can
 *   make is to get a character it is writing about wrong.
 * - **Recent.** Events from the last `RECENT_CHAPTERS` chapters up to this
 *   one -- what the scene follows on from, whether or not it is named.
 * - **Similar.** Facts whose embedding is near the passage's: the storm the
 *   paragraph is about, though it never says "the storm".
 *
 * Then the per-subject cap and the budget, in fused order, so what is cut is
 * always the least relevant. The result is re-sorted into chapter order for
 * display, because a prompt reads better as a timeline than as a ranking.
 */
export function selectFacts(input: SelectionInput): BibleFact[] {
  const lastChapter = Math.max(0, ...input.facts.map(at));
  const position = input.chapterNumber ?? lastChapter + 1;
  const pool = collapseByKey(input.facts, position);
  const ids = new Set(pool.map((fact) => fact.id));

  const distance = (fact: BibleFact) =>
    at(fact) <= position ? position - at(fact) : 1000 + at(fact) - position;
  const byProximity = (a: BibleFact, b: BibleFact) =>
    distance(a) - distance(b) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.id.localeCompare(b.id);

  const named = pool
    .filter(
      (fact) =>
        mentions(input.text, fact.subject) ||
        (fact.related !== null && mentions(input.text, fact.related)),
    )
    .sort(byProximity)
    .map((fact) => fact.id);

  const recentChapters = [
    ...new Set(
      pool
        .filter((fact) => fact.chapterNumber !== null && fact.chapterNumber <= position)
        .map((fact) => fact.chapterNumber as number),
    ),
  ]
    .sort((a, b) => b - a)
    .slice(0, RECENT_CHAPTERS);

  const recent = pool
    .filter(
      (fact) =>
        fact.kind === "event" &&
        fact.chapterNumber !== null &&
        recentChapters.includes(fact.chapterNumber),
    )
    .sort(byProximity)
    .map((fact) => fact.id);

  const similar = input.similar.filter((id) => ids.has(id));

  const byId = new Map(pool.map((fact) => [fact.id, fact]));
  const perSubject = new Map<string, number>();
  const chosen: BibleFact[] = [];
  let chars = 0;

  for (const hit of fuseRankings([named, named, recent, similar])) {
    if (chosen.length === BIBLE_FACT_LIMIT) break;

    const fact = byId.get(hit.id) as BibleFact;
    const subject = normalise(fact.subject);
    if ((perSubject.get(subject) ?? 0) >= PER_SUBJECT_LIMIT) continue;

    const cost = factLine(fact).length + 1;
    if (chars + cost > BIBLE_CHAR_LIMIT) continue;

    chosen.push(fact);
    chars += cost;
    perSubject.set(subject, (perSubject.get(subject) ?? 0) + 1);
  }

  return chosen.sort(
    (a, b) =>
      at(a) - at(b) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.subject.localeCompare(b.subject) ||
      a.id.localeCompare(b.id),
  );
}

/* Continuity fingerprints ------------------------------------------------ */

/**
 * The identity of a contradiction: which two claims, wherever they are
 * stored.
 *
 * Built from each side's chapter, key and value -- never from row ids, which
 * change every time a chapter is re-extracted -- and sorted, so the pair is
 * the same pair whichever side was checked. That is what lets a dismissal
 * outlive the finding it was made from: an author who dismisses "green eyes
 * in chapter two, blue in chapter five" and then edits chapter five elsewhere
 * is not asked again.
 */
export function fingerprintOf(
  a: Pick<BibleFact, "chapterId" | "factKey" | "valueKey">,
  b: Pick<BibleFact, "chapterId" | "factKey" | "valueKey">,
): string {
  const side = (fact: typeof a) =>
    `${fact.chapterId ?? "story"}|${fact.factKey}|${fact.valueKey}`;
  return createHash("sha256")
    .update([side(a), side(b)].sort().join("\u0000"))
    .digest("hex");
}
