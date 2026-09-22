/**
 * The shapes the generation feature passes between its parts.
 *
 * Split out of `generate.ts` for the same reason as `scribble-types.ts`:
 * `prompts/generate.ts` needs the seed and the kind, and importing the service
 * to get them would be a cycle.
 */

import type {
  ChapterOutline,
  CharacterProfile,
  StoryIdea,
} from "./schemas.js";

export const GENERATION_KINDS = ["idea", "character", "outline"] as const;

export type GenerationKind = (typeof GENERATION_KINDS)[number];

/**
 * What the author gave the model to work from. Every field is optional --
 * "surprise me" is a legitimate brief -- and all of it is user-written text
 * that travels as fenced data, never as instructions.
 */
export interface GenerationSeed {
  genre: string | null;
  theme: string | null;
  premise: string | null;
  /**
   * One of the caller's own stories, for material that has to fit work already
   * written. Ownership is asserted when it is resolved, not here.
   */
  storyId: string | null;
}

export type GeneratedValue = StoryIdea | CharacterProfile | ChapterOutline;

export interface GenerationResult {
  /**
   * Names the server-side conversation this came from. Refinement sends this
   * back instead of the object, so the model revises what it actually wrote
   * rather than whatever the client has since edited.
   */
  sessionId: string;
  kind: GenerationKind;
  /** Position in this array is the `index` a refinement addresses. */
  variants: GeneratedValue[];
  /** Seconds until the session expires and refinement stops working. */
  expiresInSeconds: number;
}

export interface RefinementResult {
  sessionId: string;
  kind: GenerationKind;
  index: number;
  value: GeneratedValue;
  expiresInSeconds: number;
}
