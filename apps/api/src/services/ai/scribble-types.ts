/**
 * The shapes Scribble passes between its stages.
 *
 * Separate from `scribble.ts` only so `prompts/scribble.ts` can render a
 * candidate without importing the service that imports it back.
 */

export interface ScribbleAuthor {
  username: string;
  displayName: string | null;
}

export interface ScribbleGenre {
  id: string;
  name: string;
  hue: number;
}

/**
 * A row retrieval returned, normalised across the two services. `Book` and
 * `Story` already agree on every field here; the union exists so narration and
 * the response do not care which list a title came from.
 */
export interface Candidate {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  coverUrl: string | null;
  source: "SCRIBE" | "CATALOGUE";
  kidsAppropriate: boolean;
  ratingAverage: number | null;
  author: ScribbleAuthor;
  genres: ScribbleGenre[];
}

/** A candidate the model kept, plus the one sentence it contributed. */
export interface Recommendation extends Candidate {
  /**
   * Generated text, and labelled as such everywhere it is rendered. The only
   * field on this object that did not come out of Postgres.
   */
  reason: string;
  /**
   * Where the reader lands. Built here rather than on the client because the
   * route shape differs by source and a client that guesses gets it wrong.
   */
  url: string;
}

/**
 * What the previous turn settled on, sent back by the client so a follow-up
 * can narrow it.
 *
 * Deliberately the *interpreted filters* rather than the previous prose or the
 * previous result ids:
 *
 * - Filters are structured, so merging them is ordinary code and the result is
 *   inspectable. Rewriting "thriller ones" into a standalone sentence needs a
 *   second model call and fails invisibly when it guesses wrong.
 * - Re-querying with merged filters finds every book matching both, whereas
 *   filtering the previous *ids* could only ever return a subset of one capped
 *   page -- so "thrillers by A" would miss A's thrillers that did not fit in
 *   the first five results.
 *
 * Client-supplied, and safe to be: the genre is re-resolved against the real
 * genre list, every field is validated, and retrieval still applies the same
 * visibility rules. Forging this is no more powerful than typing a query.
 */
export interface ScribbleContext {
  genre: string | null;
  kidsAppropriate: boolean;
  completed: boolean | null;
  search: string | null;
}

export interface ScribbleReply {
  /** Generated. Empty when nothing matched and the fallback text is used. */
  intro: string;
  recommendations: Recommendation[];
  /** What stage 1 understood, echoed back so the UI can show its working. */
  interpreted: {
    genre: string | null;
    kidsAppropriate: boolean;
    completed: boolean | null;
    search: string | null;
    /**
     * Set when a title or author the reader named matched nothing and was
     * dropped to find anything at all. The UI says so; these are substitutes,
     * not the thing that was asked for.
     */
    droppedSearch: string | null;
  };
}
