# Content model: books vs stories

Status: **decided and in place** — option (c), a single `content.Story` with an
explicit source discriminator.

The contract additions this document called for landed with the stories read
API: `Story.slug` (unique), `Story.source` (`SCRIBE` | `CATALOGUE`),
`Story.listedAt` for Scribe publication state, and `Chapter.wordCount`, in
`migrations/app/20260910T0557_add_story_slug_source_and_chapter_word_count`.
That migration also backfilled existing rows — every seeded edition is
`CATALOGUE` and listed. `services/books.ts` now filters to `CATALOGUE` and
`services/stories.ts` to `SCRIBE`.

## What is actually in the repo today

The premise that the app has two *storage* models turns out to be wrong. There
is one table, and both features already sit on it.

- `content.Story` is the only work entity. There is no `Book` model, and the
  "seeded catalogue tables" do not exist — `scripts/seed-books.ts` writes
  `content.Story` rows (`seed-books.ts:79-102`), filling in the publication
  block that `contract.prisma` already carries for exactly this purpose:
  `isbn` (unique), `publisher`, `publishedAt`, `pageCount`.
- `services/books.ts` says so in its own header comment: *"A 'book' is
  `content.Story` — the catalogue entity Scribe already has."*
- **Both** reader-side relations point at the same table:
  `library.LibraryEntry.storyId → content.Story` and
  `engagement.ReadingHistory.storyId → content.Story`. The backlog's claim that
  these point at different entities does not hold, which removes the migration
  risk that made this a blocker.

So the split is not in the schema. It is in three narrower places:

1. **Two API vocabularies.** `/api/books` + `/api/library` exist and speak
   `Book`; `/api/stories` does not exist at all. Chapters, genres-with-counts
   and story discovery have zero routes.
2. **Two frontend type files.** `types/books.ts` mirrors the real API;
   `types/domain.ts` mirrors `mock-db.ts`. They disagree about the same
   concept: `Book.description` vs `Story.synopsis`, `ratingAverage: number |
   null` vs `number`, and `domain.Story` carries `slug`, `status`,
   `chapterCount`, `wordCount`, `ratingCount`, `tagline` — none of which exist
   in the contract.
3. **Two page trees over one concept.** `/book/:id` (`BookDetailPage`, 286
   lines, real API) and `/story/:slug` (`StoryDetailPage`, 559 lines, mock) plus
   `/read/:slug/:chapter`. `DiscoverPage` already renders `components/books/*`
   off the real endpoint while `components/story/Cards.tsx` renders the mock.

Three gaps in the contract are common to every option below and have to be
closed regardless:

- **No `slug`.** The whole authored surface routes by slug.
- **No publish state.** `Story.publishedAt` is documented as the *edition*
  publication date and the seed sets it to the book's real publication date
  (1937, and so on). It cannot double as "visible on Scribe" — a draft would be
  indistinguishable from a catalogue import with an unknown date.
- **No word/chapter counts.** The FE renders both; they are either denormalised
  columns or computed aggregates.

## Option (a) — keep them fully separate

Add a real `Book` model (or catalogue namespace), leave `content.Story` for
authored work, and keep `/book/:id` and `/story/:slug` distinct with separate
shelves.

- **Schema:** new `Book`, `BookGenre` join, and a second copy of every
  reader-side relation — `LibraryEntry` splits into book-shelf and story-shelf
  variants, or grows a nullable `bookId`/`storyId` pair with a check
  constraint. `Rating`, `Comment`, `ReadingHistory` face the same fork.
- **Blast radius:** largest of the three. `services/books.ts` and
  `services/library.ts` get rewritten against the new table rather than
  extended; `library.test.ts` and `books.test.ts` follow. Every future feature
  in Tasks 3, 12, 13, 16 doubles: two rating paths, two histogram queries, two
  recommendation sources, two analytics unions.
- **Migration cost:** this is the only option that requires moving data. The
  seeded rows must be copied out of `content.Story` into `Book` and the
  existing `LibraryEntry` rows repointed, with `Story.isbn`/`publisher`/
  `pageCount` then dropped as dead columns.
- **What it buys:** honest field-level modelling (a book has an ISBN and no
  chapters; a story has chapters and no ISBN) and no risk of a reader landing
  in the chapter reader on a catalogue import.

## Option (b) — one polymorphic `Work` with a source discriminator

Introduce `content.Work` as the shared parent, with `Story` and `Book` as
detail tables keyed on it, and repoint every engagement relation at `Work`.

- **Schema:** new `Work` table plus two satellites; `LibraryEntry`,
  `ReadingHistory`, `Rating`, `Comment`, `StoryGenre`, `ChallengeEntry` all
  move from `storyId` to `workId`.
- **Blast radius:** every query in `services/books.ts` grows a join, and every
  write path in Tasks 2, 3, 6 has to decide which table it is writing. The FE
  gains a discriminated union it must narrow at each render site.
- **Migration cost:** high — six foreign keys renamed and backfilled in one
  migration, and `LibraryEntry`'s unique constraint and both its indexes
  (`[userId, status, addedAt]`, `[storyId]`) rebuilt.
- **What it buys:** the correct shape *if* books and stories were about to
  diverge structurally. They are not: the only real divergence is "has
  chapters" and "has an ISBN", both of which a single table already expresses
  with nullable columns.

## Option (c) — catalogue books are read-only imported stories

Keep `content.Story` as the one entity — which is what the code already does —
and make the distinction explicit rather than implicit in whether `isbn` is
null.

- **Schema:** additive only, no data movement.
  - `source ContentSource @default(SCRIBE)` — enum `SCRIBE | CATALOGUE`, a new
    top-level enum beside `ReadingStatus`. Backfilled to `CATALOGUE` where
    `isbn IS NOT NULL`, which is exactly the seeded set.
  - `slug String @unique`, backfilled from titles (slugify + numeric suffix on
    collision, per Task 1).
  - `status` (or `listedAt`) for Scribe publication state, kept distinct from
    the existing edition `publishedAt`, whose comment gets amended to say so.
  - `chapterCount` / `wordCount` denormalised, or left as aggregates until
    Task 8 shows they are hot.
- **Blast radius:** smallest. `services/books.ts` gains
  `.where(source.eq(CATALOGUE))` and keeps its `Book` response shape verbatim,
  so `types/books.ts`, `books-api.ts`, `components/books/*`, `DiscoverPage`,
  `MyLibraryPage` and `BookDetailPage` are untouched — the working, tested
  surface does not move. `services/stories.ts` is new and filters
  `source = SCRIBE` for lists while allowing either by slug for detail.
  `library.ts` needs no change at all: a shelf is a shelf.
- **Migration cost:** one additive migration, no repointed foreign keys, no
  rebuilt indexes, and `LibraryEntry`'s production-shaped rows are never
  touched.
- **Cost it does carry:** `content.Story` becomes a wide table where roughly
  four columns are meaningful for one source and roughly four for the other.
  Authoring writes (Task 6) must refuse `source = CATALOGUE` rows on every
  endpoint — a per-route ownership check that is easy to forget, so it belongs
  in one guard in `services/authoring.ts`, not repeated per handler.

## Recommendation

**Option (c).** Two reasons, in order of weight.

First, it is already true. The unification the other options describe as future
work has happened: one table, one set of engagement relations, one shelf model.
(a) and (b) are both *de-unifications* dressed as clean-ups, and both would
migrate live `LibraryEntry` rows to reach a model the code does not currently
want. Option (c) is the only one that treats the existing schema as correct and
spends its migration budget on the three things genuinely missing — slug,
publish state, counts — all of which Task 1 needs anyway.

Second, the divergence that would justify (a) or (b) is not there. A catalogue
book and an authored story differ in two nullable columns and in whether
chapters exist. Everything the rest of the backlog wants to build over them —
shelves, ratings, comments, reading progress, recommendations, follows, badges —
is identical for both and gets written once. Under (a) each of Tasks 3, 12, 13
and 16 pays a second implementation; under (b) each pays a join and a union
narrow. Under (c) they pay a `source` filter where they care and nothing where
they do not.

### Consequences for the tasks that follow

- **Routing.** Keep `/book/:id` as-is for now and treat `/story/:slug` as the
  canonical detail route. Once Task 1 lands, `BookDetailPage` is a thin variant
  of `StoryDetailPage` with the chapter list and reader entry point suppressed
  for `source = CATALOGUE`; folding the two pages together belongs in Task 17,
  not earlier, so the real surface stays working throughout.
- **Reader.** Catalogue titles now carry two seeded sample chapters each
  (`data/catalogue-chapters.ts`), so `/book/:id` offers a read action and
  `/read/:slug/:chapter` works for them. A title with no chapters still 404s in
  the reader rather than empty-rendering, and the read action hides itself —
  `Book.chapterCount` counts published chapters only.
- **Task 1's contract change** is the one described above — `slug`, `source`,
  Scribe publish state — and its slug backfill must cover the seeded catalogue
  rows too, or `/story/:slug` will 404 on half the corpus.
- **Types.** `types/books.ts` stays the source of truth for the shared fields;
  Task 1's story types extend it rather than re-declaring them, and
  `types/domain.ts` shrinks as the mock retires. Do not reconcile them wholesale
  now — that is Task 17.
