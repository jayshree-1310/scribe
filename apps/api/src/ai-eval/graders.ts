/**
 * Grading with code, wherever code can.
 *
 * Every function here is pure and deterministic, so a change in a score is a
 * change in what the model did -- never in how it was marked. The one fuzzy
 * question, faithfulness, goes to the judge (`judge.ts`) and to nothing here.
 */

import { locateQuote, normalise } from "../services/ai/bible-facts.js";

/* Retrieval -------------------------------------------------------------- */

export interface RetrievalScore {
  /** 1-based position of the first right chapter among the top `k`, or null. */
  rank: number | null;
  hitAt1: boolean;
  hitAt3: boolean;
  hitAtK: boolean;
  /** 1 / rank, or 0 when no right chapter made the top `k`. */
  reciprocalRank: number;
}

/**
 * Where the right chapter came in what retrieval returned.
 *
 * Scored per *chapter*, not per passage: several windows of one chapter are
 * one source to a reader, and a list of six passages from the wrong chapter
 * followed by the right one is a rank-seven miss, not a rank-two one.
 */
export function scoreRetrieval(
  rankedChapters: number[],
  sources: number[],
  k: number,
): RetrievalScore {
  const chapters = [...new Set(rankedChapters)].slice(0, k);
  const index = chapters.findIndex((chapter) => sources.includes(chapter));
  const rank = index === -1 ? null : index + 1;

  return {
    rank,
    hitAt1: rank === 1,
    hitAt3: rank !== null && rank <= 3,
    hitAtK: rank !== null,
    reciprocalRank: rank === null ? 0 : 1 / rank,
  };
}

/* Answers ---------------------------------------------------------------- */

/**
 * The ways a model says "the story does not say".
 *
 * A regex rather than a judge because a refusal is a short, conventional
 * sentence and the cost of a judge call per case would buy nothing. When it
 * misfires the case's `detail.answer` shows exactly what was said, so the
 * pattern can be widened in review.
 */
const DECLINE =
  /\b(do(?:es)?(?:n['’]t| not)|did(?:n['’]t| not)|is(?:n['’]t| not)|are(?:n['’]t| not))\s+(?:\w+\s+){0,3}?(say|mention|cover|tell|state|specify|name|reveal|include|appear|give|given|stated|mentioned|named|covered)\b|\bno (?:mention|information|indication|record)\b|\bnot (?:mentioned|stated|named|covered|given|specified|revealed)\b|\b(?:can(?:no|['’])t|unable to) (?:find|tell|answer|say)\b|\bnothing (?:in|about)\b/i;

export function isDecline(answer: string): boolean {
  return DECLINE.test(plainText(answer));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Typography models use and datasets do not: curly quotes, the Unicode
 * hyphens and dashes (gpt-oss writes "ninety‑two" with U+2011), and the
 * no-break spaces it puts before "am". Folded before any comparison.
 */
export function plainText(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00a0\u202f\u2007]/g, " ");
}

/**
 * Whether the answer contains any of the alternatives, as whole words.
 *
 * Whole words because the alternatives include "no" and "2", which as
 * substrings match "know" and "2019". Case and typography are ignored.
 */
export function mentionsAny(answer: string, alternatives: string[]): boolean {
  const text = plainText(answer);
  return alternatives.some((alternative) => {
    const escaped = escapeRegex(plainText(alternative));
    const start = /^\w/.test(alternative) ? "\\b" : "";
    const end = /\w$/.test(alternative) ? "\\b" : "";
    return new RegExp(`${start}${escaped}${end}`, "i").test(text);
  });
}

/** At least one citation names a chapter that answers the question. */
export function citesSource(citedChapters: number[], sources: number[]): boolean {
  return citedChapters.some((chapter) => sources.includes(chapter));
}

/* Writing assistant ------------------------------------------------------ */

/** The openers the assistant's prompt forbids and small models still write. */
const PREAMBLE =
  /^\s*(?:here(?:'s| is| are)\b|sure\b|certainly\b|of course\b|okay\b|ok\b|absolutely\b|i(?:'ve| have) (?:rewritten|revised|edited|made)|revised(?: version)?:|rewritten(?: version)?:)/i;

export function hasPreamble(text: string): boolean {
  return PREAMBLE.test(plainText(text));
}

export function keepsAll(text: string, words: string[]): boolean {
  const lower = plainText(text).toLowerCase();
  return words.every((word) => lower.includes(plainText(word).toLowerCase()));
}

/** Meaningfully different: not the input back with a changed full stop. */
export function changed(text: string, original: string): boolean {
  const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return squash(text) !== squash(original);
}

/** A continuation that does not restart by repeating where it was handed off. */
export function continuesWithoutRepeating(text: string, original: string): boolean {
  const tail = normalise(original).slice(-40);
  return text.trim().length > 0 && !normalise(text).includes(tail);
}

/* Extraction ------------------------------------------------------------- */

/** The share of quotes that are really in the chapter -- what the bible keeps. */
export function groundedShare(quotes: string[], chapterContent: string): number {
  if (quotes.length === 0) return 0;
  const found = quotes.filter((quote) => locateQuote(chapterContent, quote) !== null);
  return found.length / quotes.length;
}

/** The share of expected subjects the extraction named, matched loosely. */
export function subjectRecall(found: string[], expected: string[]): number {
  if (expected.length === 0) return 1;
  const names = found.map(normalise);
  const hits = expected.filter((subject) => {
    const wanted = normalise(subject);
    return names.some((name) => name.includes(wanted) || wanted.includes(name));
  });
  return hits.length / expected.length;
}

/* Aggregates ------------------------------------------------------------- */

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Nearest-rank percentile; null for an empty list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** The share of `true`s among the applicable (non-null) entries. */
export function rate(values: (boolean | null | undefined)[]): number | null {
  const applicable = values.filter((value): value is boolean => typeof value === "boolean");
  if (applicable.length === 0) return null;
  return applicable.filter(Boolean).length / applicable.length;
}
