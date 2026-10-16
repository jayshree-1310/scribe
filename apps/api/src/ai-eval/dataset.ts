/**
 * What the evaluation asks, and what a right answer looks like.
 *
 * Written against `SEED_STORIES` (`data/seed-stories.ts`), which the runner
 * loads into temporary rows, so every expected source is a chapter whose text
 * is in this repo. Stories are named by title and chapters by number -- the
 * corpus loader resolves both to the run's own ids.
 *
 * Three kinds of case, matching the three kinds of AI output Scribe has:
 *
 * - `ask`: Ask This Book. `sources` are the chapters that answer it; an empty
 *   list means the story does not, and the right behaviour is to decline.
 *   `mentions` is a set of alternatives, any one of which an on-topic answer
 *   contains -- a cheap, code-graded "does it address the question".
 * - `assist`: the writing assistant, graded on properties a correct reply has
 *   whatever its wording: non-empty, no preamble, names kept, shorter when
 *   asked to shorten.
 * - `extract`: the story bible's extraction, which is structured output --
 *   graded on whether it parsed first time, whether its quotes are really in
 *   the chapter, and whether it found the people a reader would list.
 *
 * Bump `DATASET_VERSION` whenever a case is added, removed or changed:
 * `compare.ts` only compares like with like.
 */

import type { AssistAction } from "../services/ai/assist-types.js";

/**
 * 2: `sisters-diner` also accepts "laughed" -- mentions match whole words, so
 * "laugh" alone failed a right answer in the second real run.
 */
export const DATASET_VERSION = 2;

export interface AskCase {
  kind: "ask";
  id: string;
  story: string;
  question: string;
  /** Chapters that answer it. Empty: the right answer is to decline. */
  sources: number[];
  /** Any one of these in the answer counts as addressing the question. */
  mentions?: string[];
  /** The reader's bound. Omitted: the whole story they can read. */
  upToChapter?: number;
  /** For a story the reader cannot see: the request must be refused. */
  refused?: boolean;
}

export interface AssistCase {
  kind: "assist";
  id: string;
  action: AssistAction;
  text: string;
  tone?: string;
  /** Words that must survive the edit -- names, mostly. */
  keeps: string[];
}

export interface ExtractCase {
  kind: "extract";
  id: string;
  story: string;
  chapter: number;
  /** Subjects a careful reader would list; matched loosely. */
  subjects: string[];
}

export type EvalCase = AskCase | AssistCase | ExtractCase;

export interface Dataset {
  version: number;
  cases: EvalCase[];
}

const LANTERN = "The Lantern Keepers";
const OBSERVATORY = "Small Hours at the Observatory";
const INVENTORY = "The Inventory of Small Losses";
const SISTERS = "Nine Hundred Miles of Nothing to Say";
const SOMMELIER = "The Sommelier of Brackish Water";
const EXIT_ROW = "Emergency Exit Row";
const HOLLOWMERE = "Hollowmere";
const GHOSTS = "A Field Guide to Local Ghosts";
const WINTER = "Notes Toward a Longer Winter";

const ask = (input: Omit<AskCase, "kind">): AskCase => ({ kind: "ask", ...input });

export const DATASET: Dataset = {
  version: DATASET_VERSION,
  cases: [
    /* Answerable, one chapter each ---------------------------------------- */
    ask({ id: "lantern-steps", story: LANTERN, question: "How many steps did Mira climb to the lamp room?", sources: [1], mentions: ["ninety-two", "92"] }),
    ask({ id: "lantern-first-notice", story: LANTERN, question: "What did Mira notice first when the light went out?", sources: [1], mentions: ["silence", "hum"] }),
    ask({ id: "lantern-keepers-count", story: LANTERN, question: "How many keepers gathered on the harbour wall?", sources: [2], mentions: ["fourteen", "14"] }),
    ask({ id: "lantern-when", story: LANTERN, question: "At what time of night did the lights fail?", sources: [2], mentions: ["two and three", "2", "two"] }),
    ask({ id: "lantern-where", story: LANTERN, question: "Which stretch of coast lost its lights?", sources: [2], mentions: ["Cape Dolan", "Narrows"] }),
    ask({ id: "observatory-time", story: OBSERVATORY, question: "What time did the first reply arrive?", sources: [1], mentions: ["3:14", "three", "fourteen minutes"] }),
    ask({ id: "observatory-style", story: OBSERVATORY, question: "How could Ada tell the message was written in her own style?", sources: [1], mentions: ["formatting", "spacing", "units"] }),
    ask({ id: "observatory-supervisor", story: OBSERVATORY, question: "What did Ada's supervisor ask her?", sources: [2], mentions: ["sleeping"] }),
    ask({ id: "observatory-final", story: OBSERVATORY, question: "What did the final reply say?", sources: [3], mentions: ["now we can begin"] }),
    ask({ id: "inventory-name", story: INVENTORY, question: "What was written under 'who was asking' on the eleven hundred and first form?", sources: [1], mentions: ["own name", "her name", "Hanne"] }),
    ask({ id: "inventory-columns", story: INVENTORY, question: "How many columns did the form have?", sources: [1], mentions: ["four", "4"] }),
    ask({ id: "inventory-after-hours", story: INVENTORY, question: "What did Hanne do after hours?", sources: [2], mentions: ["forms", "levee", "pulled"] }),
    ask({ id: "sisters-urn", story: SISTERS, question: "Where did the urn ride in the car?", sources: [1], mentions: ["back seat", "seatbelt"] }),
    ask({ id: "sisters-diner", story: SISTERS, question: "What happened between the sisters at the diner?", sources: [2], mentions: ["laugh", "laughed", "laughing"] }),
    ask({ id: "sisters-ashes", story: SISTERS, question: "Where had their mother asked to be scattered?", sources: [3], mentions: ["sea"] }),
    ask({ id: "sommelier-taste", story: SOMMELIER, question: "What could Sabeen taste in the water?", sources: [1], mentions: ["rust", "lime", "loom"] }),
    ask({ id: "sommelier-years", story: SOMMELIER, question: "How long has Sabeen made her living reading water?", sources: [2], mentions: ["nineteen", "19"] }),
    ask({ id: "exit-row-manifest", story: EXIT_ROW, question: "What stayed the same on the manifests while the passenger's name changed?", sources: [2], mentions: ["frequent-flyer", "frequent flyer", "number"] }),
    ask({ id: "exit-row-words", story: EXIT_ROW, question: "What did the passenger in 14C finally say to Nadia?", sources: [3], mentions: ["looks at the water", "water"] }),
    ask({ id: "hollowmere-cass", story: HOLLOWMERE, question: "How old is Cass?", sources: [2], mentions: ["fifteen", "15"] }),
    ask({ id: "hollowmere-vicar", story: HOLLOWMERE, question: "What did the vicar report after climbing the tower?", sources: [2], mentions: ["mechanism", "rope", "sound"] }),
    ask({ id: "ghosts-bus-stop", story: GHOSTS, question: "Where does specimen one wait every evening?", sources: [1], mentions: ["bus stop", "Tanner"] }),
    ask({ id: "ghosts-science-fair", story: GHOSTS, question: "Did the narrator win the science fair?", sources: [3], mentions: ["did not win", "didn't win", "not win", "no"] }),

    /* Should decline ------------------------------------------------------- */
    // Chapter 3 is a draft chapter: a reader cannot see it, so nobody named
    // Ansel exists for them.
    ask({ id: "lantern-unpublished", story: LANTERN, question: "Who is Ansel, and what did he see?", sources: [] }),
    // The answer is in chapter 2, past the reader's bound.
    ask({ id: "lantern-spoiler-bound", story: LANTERN, question: "What did the harbourmaster tell the keepers?", sources: [], upToChapter: 1 }),
    ask({ id: "observatory-unnamed", story: OBSERVATORY, question: "What is the name of Ada's supervisor?", sources: [] }),
    ask({ id: "ghosts-off-topic", story: GHOSTS, question: "What is the capital of France?", sources: [] }),
    ask({ id: "winter-draft", story: WINTER, question: "What happens in November?", sources: [], refused: true }),

    /* Writing assistant ---------------------------------------------------- */
    {
      kind: "assist",
      id: "assist-grammar",
      action: "grammar",
      text: "Mira climb the ninety-two step in the dark, counting them the way her mother have taught her.",
      keeps: ["Mira", "ninety-two"],
    },
    {
      kind: "assist",
      id: "assist-shorten",
      action: "shorten",
      text: "The man who had brought the bottle paid her without arguing, which told her more than the water had, because in her long experience people who argue about a price are people who intend to keep living in the city for a good while yet, and he plainly did not.",
      keeps: ["bottle"],
    },
    {
      kind: "assist",
      id: "assist-tone",
      action: "tone",
      tone: "warmer",
      text: "Nadia noticed him the way you notice a word you have read four times on the same page: not as a shock, but as a slow accumulation of wrongness.",
      keeps: ["Nadia"],
    },
    {
      kind: "assist",
      id: "assist-continue",
      action: "continue",
      text: "On Monday the bell rang at dawn and did not stop, and by noon everyone in Hollowmere had stopped meeting each other's eyes. Cass went to the tower.",
      keeps: [],
    },

    /* Extraction ------------------------------------------------------------ */
    { kind: "extract", id: "extract-lantern-1", story: LANTERN, chapter: 1, subjects: ["Mira"] },
    { kind: "extract", id: "extract-observatory-1", story: OBSERVATORY, chapter: 1, subjects: ["Ada"] },
    { kind: "extract", id: "extract-sisters-1", story: SISTERS, chapter: 1, subjects: ["Tolu", "Bisi"] },
  ],
};
