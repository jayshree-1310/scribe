# Scribe — New features

Feature ideas queued after scheduled chapters, which has landed. Each entry says
what it is, why it is worth doing, and what it can build on.

| # | Feature                     | Status                    |
| - | --------------------------- | ------------------------- |
| 1 | Highlights and margin notes | **Landed** (2026-11-20)   |
| 2 | Beta readers                | **Landed** (2026-11-23)   |
| 3 | Listen mode                 | **Landed** (2026-11-23)   |
| 4 | Quote cards                 | **Landed** (2026-11-24)   |
| 5 | Public reading lists        | Not started               |
| 6 | Paragraph comments          | **Landed** (2026-11-24)   |

---

## 1. Highlights and margin notes

**What:** A reader selects a passage in the reader and highlights it, with an
optional private note. Highlights are listed per story, so a reader can jump back
to them. The author sees which passages are highlighted most, on an anonymous,
aggregate view in their analytics.

**Why:** It gives readers a reason to come back to a chapter and gives authors a
signal that likes and comments do not: *which lines* landed.

**Builds on:** `lib/chapter-selection.ts` and the selection handling behind
"Explain this passage" (`ExplainSheet`), which already map a selection to a
stable position in the chapter text. Author analytics (`services/analytics.ts`)
for the aggregate view.

**Open questions:** How a highlight survives the author editing the chapter
(anchor on text plus offset, and drop the highlight if the passage is gone).
Whether notes can ever be shared, or stay private only.

**Status: landed (2026-11-20).** How it was built, and how the open questions
were answered:

- **Data:** `engagement.Highlight` (chapter, `start`/`end`, `quote`, optional
  `note`). The client sends offsets from `lib/chapter-selection.ts`, as
  "Explain this passage" does; the server cuts `quote` out of the stored
  chapter, so it is always the author's words. Routes under
  `/api/reading/highlights` (list per story, create, edit note, delete);
  `services/highlights.ts`.
- **Surviving edits:** every read re-finds `quote` — at the stored offsets,
  else the nearest occurrence, else reported as gone (`found: false`). Gone
  highlights are *not deleted*: the note is the reader's writing, so the list
  keeps it, marked "no longer in the chapter", with a Remove. An author who
  restores the passage restores the highlight. Exact-text match only, so a note
  is never painted over a rewritten sentence.
- **Notes are private only.** No route returns another reader's highlight or
  note; sharing is left to quote cards (feature 4), which would share the
  passage, not the note.
- **Reader UI:** selecting text offers *Highlight* beside *Ask about this*; the
  passage is painted with the CSS Custom Highlight API (no DOM is inserted
  into the prose), notes add a dotted underline and a margin marker on wide
  screens, and a tap on a highlight opens its note in a docked sheet (since
  feature 6, the side panel on the right). A top-bar
  button lists the story's highlights by chapter and jumps to one.
  `lib/highlight-ranges.ts`, `components/reader/`.
- **Author view:** the story view of Author analytics shows "Most highlighted
  passages" — paragraphs ranked by distinct readers, shown by the span marked
  most often. Counts only: never who, never notes, never the author's own.
  All-time, not tied to the date range.
- **Limits:** 2,000 characters per passage, 1,000 per note, 200 highlights per
  reader per chapter. Highlights are private reading state, so a suspension
  does not stop them. Deleting a chapter, story or account deletes its
  highlights (foreign keys cascade).

---

## 2. Beta readers

**What:** An author invites chosen readers to a draft story or draft chapter
through a private link. Invited readers can read it and leave feedback that only
the author sees. The author can revoke the link at any time.

**Why:** Drafts are visible only to their author today, so an author who wants
feedback before publishing has to copy text out of Scribe.

**Builds on:** `chaptersVisibleTo` in `services/stories.ts`, which already
decides who may read an unpublished chapter. It would add "an invited reader"
alongside "the author". The comment system can carry the feedback, as a
separate private thread type.

**Open questions:** Invite by username or by a share token (a link anyone can
open). Whether beta feedback carries over once the chapter is published, or is
deleted.

**Status: landed (2026-11-23).** How it was built, and how the open questions
were answered:

- **Invite by private link** (chosen over usernames). A story has at most one
  link (`beta.Link`, a 144-bit token). A signed-in reader who opens
  `/beta/:token` sees the story's card and joins with a button
  (`beta.Reader`), so a link preview or a stray click joins nobody. Signed-out
  visitors sign in first and come back. Making the link again returns the
  same one. **Turning it off** deletes the link and every reader who joined;
  a new link is a new token. The author can also remove one reader, and a
  reader can leave from the story page.
- **What a beta reader sees.** The whole story, drafts included: every
  chapter except one a moderator took down; a take-down of the story shuts
  them out too. The rule is `StoryAccess` (`author` / `beta` / `reader`) in
  `services/stories.ts`, beside every other visibility rule. The shared
  30-second story cache is bypassed for beta readers, as for authors
  (`seesPublicView`).
- **Public engagement stays closed on unpublished work.** Comments, likes,
  ratings, the library, Ask This Book and story summaries keep the old rule
  (`findVisibleStoryId` / `findVisibleChapter` admit beta readers only when a
  caller passes `{ beta: true }`). Highlights and Explain this passage, which
  are private, do. Beta reads of anything unpublished record no view, read or
  reading progress, so they reach neither the author's analytics nor the
  reader's streaks and badges.
- **Feedback** (`beta.Feedback`) is per chapter, optionally on a passage: the
  reader selects text and picks *Feedback*, and the server cuts the quote from
  the chapter by offsets, as for highlights. The top-bar pen button and the
  "Beta read" banner open the same sheet, which lists the reader's own notes
  on the chapter to edit or delete. Only beta readers can write it (not the
  author, not an uninvited reader); writing and editing are refused while
  suspended. The author is notified (`BETA_FEEDBACK`, mutable in Settings);
  the notification names the chapter and does not quote the feedback, so a
  deleted note leaves no copy behind.
- **Kept after publishing**, and after the reader leaves or is removed: it is
  the author's to delete, and the writer's while they are still in the beta.
  It never becomes a public comment. Deleting the story, chapter or either
  account deletes it (foreign keys cascade).
- **Author page:** `/author/stories/:slug/beta` (from the editor's *Beta
  readers* button) has the link with copy and turn-off, the readers with how
  many notes each left, and the feedback grouped by chapter, marked draft or
  published.
- **Limits:** 4,000 characters per note, 2,000 per quoted passage, 100 notes
  per reader per chapter.
- **Not done:** the author cannot reply to feedback, and a reader who signs
  up (rather than signs in) from an invite link lands on Home after
  onboarding, not back on the invite.

---

## 3. Listen mode

**What:** A play button in the reader that reads the chapter aloud. There are
play, pause and speed controls, and the current paragraph is highlighted as it
is read.

**Why:** It helps readers with low vision or dyslexia, and anyone reading on the
go. The first version costs nothing, because it uses the browser's built-in
speech (`speechSynthesis`).

**Builds on:** The reader page (`ReaderPage.tsx`), whose content is already split
into paragraphs, and the reading-progress save, which could follow the narration
so that "continue reading" resumes where listening stopped.

**Open questions:** Browser voices vary in quality. A later version could
generate audio with a hosted text-to-speech model and cache it per chapter, but
that has a per-chapter cost.

**Status: landed (2026-11-23).** Browser speech only, no server change. How it
was built:

- **Engine:** `Narrator` in `lib/narration.ts` reads a list of blocks (the
  chapter title, then the prose's paragraphs, headings, quotes and list
  items; never media captions), and `hooks/useNarration.ts` wraps it for
  React. Each block is spoken as sentence-sized utterances of at most 180
  characters, because Chrome silently stops a long utterance after about
  fifteen seconds with some voices. **Pause cancels** and resume speaks the
  interrupted sentence again, because `speechSynthesis.pause()`/`resume()`
  do not work on Chrome for Linux and Android. Every utterance carries a
  generation number, so the late `end`/`error` of a cancelled one is ignored.
- **Player:** the headphones button in the reader's top bar opens a bar
  docked to the bottom of the window (`components/reader/ListenBar.tsx`):
  play/pause, previous/next paragraph, speed (0.75×–2×) and voice. It starts
  from the first block on screen, not the top of the chapter. Speed and voice
  are reader preferences (`listenRate`, `listenVoice`) saved in this browser;
  only voices for the page language are offered, and a saved voice missing on
  another device falls back to the default. A new speed or voice applies at
  once, to the sentence being read.
- **Following along:** the block being read is marked (`.is-narrating`, the
  same soft mark as a cited passage), and the page scrolls only when the
  narration nears the bottom of the window. A reader who scrolls away is
  left there, with "Back to the narration" in the player. Because the page
  follows the narration, the reading-progress save follows it too.
- **Chapters:** at the end of a chapter it pauses briefly and goes on to the
  next one, from its title; at the end of the story it stops. Moving to
  another chapter yourself stops the narration. Leaving the reader stops it.
- **Other sheets:** the bottom of the window holds one sheet at a time. While
  Ask This Book, the highlights list, a note, feedback or an explanation is
  open, the player steps aside and the narration carries on; the headphones
  button brings it back.
- **When speech fails** the player says so, in one of three ways
  (`NarrationProblem`): the browser reported a speech error; it wants a tap
  first (`not-allowed`); or nothing started within 6 seconds. The last is
  how Chrome on Linux behaves with speech-dispatcher missing or broken, and
  how any browser behaves with no voice installed: it accepts the text and
  then does nothing, and no event reports it. Muted sound, or no output
  device, cannot be detected, since the browser reports success.
- Works signed out, since nothing leaves the browser. Hidden where the
  browser has no `speechSynthesis`.
- **Not done:** no word-by-word highlight (`boundary` events are missing or
  wrong for many voices), no lock-screen or media-key controls (browser
  speech is not a media session), and voices are the device's own; hosted
  text-to-speech remains the later option above.

---

## 4. Quote cards

**What:** From a highlighted passage, a reader makes a shareable image. It shows
the quote, the story title and author, and the cover, in Scribe's violet style.
The share link opens the story at that chapter.

**Why:** Every share is free promotion for the author and brings new readers to
Scribe.

**Builds on:** Highlights (feature 1) for choosing the passage, and the existing
Share buttons on the story and reader pages. The image can be drawn client-side
on a `<canvas>`, so no server rendering is needed.

**Open questions:** Whether authors can opt a story out of quote sharing.

**Status: landed (2026-11-24).** How it was built, and how the open question
was answered:

- **Where:** a highlight's note sheet (tap a highlight, or pick it from the
  highlights list) has a *Quote card* button. It opens a dialog with the card,
  a choice of two styles (*Violet*, dark; *Paper*, light, both in Scribe's
  own colours), and three ways out: *Share* through the system share sheet
  where the browser can share a file, *Download* as a PNG, and *Copy link*.
  Desktop Chrome on Linux and Firefox cannot share files, so there the
  download and the link are what is offered.
- **The card** (`lib/quote-card.ts`) is a 1080×1080 PNG drawn on a
  `<canvas>` in the reader's browser: the passage, the opening quote mark,
  the Scribe lockup, the cover, the story title, "by" the author, the
  chapter, and the chapter's address. The passage is printed as the reader
  saw it (emphasis markers, heading and quote prefixes and attachment tokens
  dropped; each source line its own paragraph) and set as large as the card
  allows, from 64px down to 34px. A passage too long for that is cut after
  the last word that fits, with an ellipsis, and the dialog says so.
- **The cover:** uploaded artwork is drawn cropped to the frame, as
  `StoryCover` crops it. It is fetched with CORS, because an image from
  another origin would taint the canvas and the card could not be exported;
  a store that does not send CORS headers, or a cover that fails to load,
  gets the generated cover instead (same palette per variant, from
  `coverPalette` in `lib/cover.ts`), as `StoryCover` falls back. The R2
  bucket in production needs a CORS rule allowing `GET` from the web app's
  origin for uploaded covers to appear on cards.
- **The link** opens the chapter (`/read/:slug/:number`) from its start, for
  anyone, signed in or not. It does not carry the passage: the card already
  shows it.
- **Only shareable work.** A card is offered on a published chapter of a
  listed story. Not on a draft, a scheduled chapter, or anything a beta
  reader sees before it is published, since the link would not open for
  anyone else and the draft is not the reader's to share.
- **Authors can opt out**, per story: *Allow quote cards* in the story
  editor (on by default), stored as `content.Story.quoteCards` and returned
  on every story. Off hides the button for every reader. The card is drawn
  in the browser from text the reader can already see, so this is a request
  honoured by the app, not a lock: it cannot stop a screenshot.
- **The note never goes on the card.** Notes stay private, as feature 1
  promised; the card shares the author's words and nothing of the reader's.
- **Not done:** no other sizes (a story-shaped 9:16 card, a 1.91:1 link
  preview), no "copy image" to the clipboard, and the link does not scroll to
  the passage.

---

## 5. Public reading lists

**What:** Readers create named, curated lists of stories, such as "Best
slow-burn fantasy", with an optional note per entry. Lists can be public or
private. Other readers can follow a list and be notified when a story is added.

**Why:** Library shelves are private today, so the best curators on the platform
have no way to share their taste. Lists also give Discover a new kind of
content to surface.

**Builds on:** The library (`library.LibraryEntry`, `services/library.ts`) for
the shelf mechanics, follows and notifications for following a list, and the
report menu (`ReportMenu`), so a list's title and notes can be reported like
any other user text.

**Open questions:** Whether lists can include catalogue books as well as Scribe
stories. A cap on list length.

---

## 6. Paragraph comments

**What:** Public comments on one paragraph of a chapter. Hovering a paragraph
shows a comment marker beside it; a paragraph that already has comments always
shows its count. Clicking it opens the paragraph's conversation in a side panel
on the right.

**Why:** Chapter comments are about the whole chapter. Readers react to a
line, a twist or an image, and want to answer each other there. Unlike a
highlight's note, these are public.

**Builds on:** Story comments (`engagement.Comment`), so a paragraph comment
has replies, likes, reports, moderation, notifications and rate limits from the
start; and the anchoring highlights use (feature 1), so comments follow their
paragraph through an author's edits.

**Status: landed (2026-11-24).** How it was built:

- **A paragraph comment is a comment** with `paragraphStart` and
  `paragraphText` set: where the paragraph's line began in the chapter and the
  line itself, cut from the stored chapter by the server. Only threads carry
  them; a reply belongs to its thread.
- **A paragraph is one rendered line of prose**: a paragraph, list item or
  block quote; headings and attachments take no comments. The rules live twice,
  in `services/paragraph-comments.ts` (to check what is posted) and
  `lib/chapter-paragraphs.ts` (to find the blocks on the page), and a test on
  each side pins them to the same fixture, which the web test checks against
  the real renderer. The reader pairs blocks with lines by order, and shows no
  markers on a chapter where the two disagree.
- **Re-anchored on every read**: the stored line at its old place, else the
  identical line nearest it, else the most similar line (60% of words shared,
  five words or more), so a typo fix does not orphan a conversation. A thread
  whose paragraph was rewritten is kept and not shown, and comes back if the
  paragraph does.
- **Kept apart from the chapter's comments.** The comments at the end of a
  chapter and on the story page's Comments tab are about the chapter and the
  story; paragraph threads are left out of both lists and their counts.
- **API:** `GET /api/chapters/:id/paragraph-comments` returns the count per
  paragraph (threads plus replies), and `?comment=<id>` also says which
  paragraph that comment is on. `GET /api/stories/:id/comments?chapterId=&paragraph=`
  lists one paragraph's threads; `POST` the same route with `paragraph` starts
  one. Public reads, like the other comment lists; closed on chapters that are
  not public yet, beta reads included.
- **Links open the paragraph.** The author's and the replied-to reader's
  notifications, and the moderation queue, link to
  `/read/:slug/:n?comment=<thread>`, which opens that paragraph's panel and
  scrolls to it.
- **On screen:** with a mouse, a marker in the left margin on hover, or always
  with a count. On a touch screen every paragraph shows its marker, in a slim
  right gutter. Selecting text also offers *Comment*, which is the keyboard's
  way in.

**All reader panels moved to a side panel** at the same time. Explain,
Ask This Book, the highlights list, a highlight's note and beta feedback were
bottom sheets; they now open in one shell (`components/reader/ReaderPanel.tsx`),
one at a time. On a wide screen it docks on the right, below the top bar, and
the chapter slides left so the passage stays beside it; below 64rem it covers
the page and leads with a Back button. The listen player stays docked at the bottom and
steps aside while a panel is open. The panels now take the reading theme's
tokens, so their fields match a Sepia page when the app is in Night mode.

**Not done:** no paragraph comments on headings, no notification to the other
commenters on a paragraph, and no "most discussed paragraphs" for authors
(their analytics count paragraph comments with the rest).
