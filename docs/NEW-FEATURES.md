# Scribe — New features

Feature ideas queued after scheduled chapters, which is being built first.
Nothing here exists in the codebase yet (checked 2026-11-20). Each entry says
what it is, why it is worth doing, and what it can build on.

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
