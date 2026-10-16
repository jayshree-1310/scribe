/**
 * The corpus an evaluation runs against: `SEED_STORIES`, loaded into rows
 * that exist only for the length of the run.
 *
 * Not the seeded rows themselves, for two reasons. A development database may
 * not have run `seed:stories` -- or may have edited what it seeded -- and an
 * eval whose expected sources depend on the state of somebody's database is
 * not reproducible. And the eval must not leave anything behind: a run creates
 * one author and one reader with run-unique names, the stories under unique
 * slugs, embeds them with the configured embedder, and `unload` deletes all of
 * it. Chunks and anything else hung off a chapter cascade with it.
 *
 * The embedder is whichever is configured -- the real one in a real run, the
 * fake in the CI test -- because retrieval quality is half of what is measured.
 */

import { randomUUID } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { SEED_STORIES, type RawStory } from "../data/seed-stories.js";
import { slugify } from "../lib/slug.js";
import { db } from "../prisma/db.js";
import { deleteAll } from "../prisma/delete-all.js";
import { embedChapter } from "../services/ai/embeddings.js";

const UNUSABLE_PASSWORD_HASH = "!ai-eval-fixture-no-login";

export interface CorpusChapter {
  id: string;
  number: number;
  title: string;
  content: string;
  published: boolean;
}

export interface CorpusStory {
  id: string;
  slug: string;
  title: string;
  listed: boolean;
  chapters: CorpusChapter[];
}

export interface Corpus {
  runId: string;
  authorId: string;
  /** Somebody who did not write any of it: the identity Ask This Book runs as. */
  readerId: string;
  /** By title, which is how the dataset names a story. */
  stories: Map<string, CorpusStory>;
}

export async function loadCorpus(
  stories: RawStory[] = SEED_STORIES,
  options: { embed?: boolean } = {},
): Promise<Corpus> {
  const runId = `eval-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const user = async (label: string) =>
    (
      await db.orm.auth.User.select("id").create({
        username: `${runId}-${label}`.slice(0, 30),
        email: `${runId}-${label}@ai-eval.invalid`,
        passwordHash: UNUSABLE_PASSWORD_HASH,
        displayName: null,
        bio: null,
        isAuthor: label === "author",
      })
    ).id;

  const corpus: Corpus = {
    runId,
    authorId: await user("author"),
    readerId: await user("reader"),
    stories: new Map(),
  };

  try {
    for (const raw of stories) {
      const listed = raw.listed !== false;
      const slug = `${runId}-${slugify(raw.title)}`.slice(0, 80);

      const story = await db.orm.content.Story.select("id").create({
        authorId: corpus.authorId,
        title: raw.title,
        description: raw.description,
        slug,
        source: "SCRIBE",
        listedAt: listed ? Temporal.Now.instant() : null,
        isCompleted: raw.isCompleted,
        kidsAppropriate: raw.kidsAppropriate,
        viewCount: 0,
        likeCount: 0,
      });

      const chapters: CorpusChapter[] = [];
      for (const [index, chapter] of raw.chapters.entries()) {
        const content = chapter.paragraphs.join("\n\n");
        const published = chapter.published !== false;

        const row = await db.orm.content.Chapter.select("id").create({
          storyId: story.id,
          chapterNumber: index + 1,
          title: chapter.title,
          content,
          wordCount: content.trim().split(/\s+/).length,
          publishedAt: published ? Temporal.Now.instant() : null,
        });

        chapters.push({ id: row.id, number: index + 1, title: chapter.title, content, published });
      }

      corpus.stories.set(raw.title, { id: story.id, slug, title: raw.title, listed, chapters });
    }

    if (options.embed !== false) {
      // Every chapter, drafts included, exactly as the backfill does: the
      // visibility rule at query time is part of what is under test.
      for (const story of corpus.stories.values()) {
        for (const chapter of story.chapters) {
          await embedChapter({ id: chapter.id, storyId: story.id, content: chapter.content });
        }
      }
    }
  } catch (error) {
    await unloadCorpus(corpus);
    throw error;
  }

  return corpus;
}

/** Deletes everything `loadCorpus` created. Safe to call twice. */
export async function unloadCorpus(corpus: Corpus): Promise<void> {
  const storyIds = [
    ...(
      await db.orm.content.Story.select("id")
        .where((story) => story.authorId.eq(corpus.authorId))
        .all()
    ).map((story) => story.id),
  ];

  for (const storyId of storyIds) {
    await deleteAll(() => db.orm.content.Chapter.where((chapter) => chapter.storyId.eq(storyId)));
    await deleteAll(() => db.orm.content.Story.where((story) => story.id.eq(storyId)));
  }

  for (const userId of [corpus.authorId, corpus.readerId]) {
    await deleteAll(() => db.orm.auth.User.where((user) => user.id.eq(userId)));
  }
}

/** A story by the title the dataset uses, or a loud failure naming it. */
export function storyOf(corpus: Corpus, title: string): CorpusStory {
  const story = corpus.stories.get(title);
  if (!story) throw new Error(`The eval corpus has no story called "${title}".`);
  return story;
}
