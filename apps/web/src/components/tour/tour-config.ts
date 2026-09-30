/**
 * The product tour: every step, where it happens and what it points at.
 *
 * **Targets are `data-tour` anchors**, never class names or coordinates, so
 * restyling a page cannot quietly aim the tour at nothing. Several elements
 * may carry the same anchor -- the sidebar and the drawer both render the
 * navigation, and the phone's tab bar repeats four of its links -- and the
 * one actually on screen is used. See `resolveTarget` in `tour-dom.ts`.
 *
 * **Routes are real routes from `App.tsx`.** The story page and the reader
 * need a story that exists, so those two say `{ sample }` and the provider
 * picks one when the tour first needs it: the story the reader is already
 * partway through if there is one, otherwise the most-read story that has a
 * chapter. If the catalogue has none, those steps are skipped.
 *
 * **A target that never appears is skipped, not waited on forever.** Some are
 * conditional by design: "Pick up where you left off" only renders for a
 * reader with something to resume, so a brand-new account passes straight
 * from the streak to Discover.
 *
 * To add a step: put `data-tour="<anchor>"` on the element, and add an entry
 * here in the order it should be shown. Nothing else needs to know.
 */

export type TourPlacement = 'top' | 'bottom' | 'left' | 'right'

/**
 * Where a step happens.
 *
 * - a path: the tour navigates there first, if the reader is elsewhere
 * - `{ sample }`: the sample story's page, or its chapter in the reader
 * - `null`: wherever the previous step left the reader
 */
export type TourRoute = string | { sample: 'story' | 'reader' } | null

export interface TourStep {
  id: string
  route: TourRoute
  /** The `data-tour` anchor to light up, or null for a centred card. */
  target: string | null
  title: string
  description: string
  /** Preferred side for the card; it moves when that side has no room. */
  placement?: TourPlacement
  /**
   * Opens the Scribble panel for this step, because the target is inside it.
   * The tour closes it again on the next step that does not ask for it.
   */
  reveal?: 'scribble'
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    route: '/home',
    target: null,
    title: 'Welcome to Scribe 👋',
    description:
      'Your social reading and story publishing space. Let’s take a quick tour of the features that make Scribe your home for discovering, reading and sharing stories.',
  },
  {
    id: 'home',
    route: '/home',
    target: 'home',
    placement: 'right',
    title: 'Home',
    description:
      'Your personalized reading dashboard. Pick up where you left off, track your reading activity and discover what’s next.',
  },
  {
    id: 'reading-streak',
    route: '/home',
    target: 'reading-streak',
    placement: 'bottom',
    title: 'Reading Streak 🔥',
    description:
      'Keep track of your reading habit and build a consistent streak by reading regularly.',
  },
  {
    id: 'continue-reading',
    route: '/home',
    target: 'continue-reading',
    placement: 'top',
    title: 'Continue Reading',
    description:
      'Jump back into the story you were reading. Your reading progress is saved automatically.',
  },
  {
    id: 'discover',
    route: '/discover',
    target: 'discover',
    placement: 'right',
    title: 'Discover Stories',
    description:
      'Explore stories across different genres, discover trending reads and find your next favorite story.',
  },
  {
    id: 'search',
    route: '/discover',
    target: 'search',
    placement: 'bottom',
    title: 'Search',
    description:
      'Find stories, authors and book clubs quickly using Scribe’s global search.',
  },
  {
    id: 'story-page',
    route: { sample: 'story' },
    target: 'story-page',
    // Beside the story's details is its cover, which the card can cover.
    placement: 'left',
    title: 'Story Details',
    description:
      'Explore a story’s details, discover its author, check engagement and start reading or add it to your library.',
  },
  {
    id: 'reading-controls',
    route: { sample: 'reader' },
    target: 'reading-controls',
    placement: 'bottom',
    title: 'Reading Experience',
    description:
      'Bookmark the chapter, change the text size, width and page colour, or switch to distraction-free reading.',
  },
  {
    id: 'chapter-navigation',
    route: { sample: 'reader' },
    target: 'chapter-navigation',
    placement: 'top',
    title: 'Chapter Navigation',
    description:
      'Move between chapters easily and keep track of where you are in the story. The ← and → keys work too.',
  },
  {
    id: 'library',
    route: '/library',
    target: 'library',
    placement: 'right',
    title: 'My Library',
    description:
      'Keep all your books in one place. Manage what you’re reading, what you want to read and what you’ve finished.',
  },
  {
    id: 'shelves',
    route: '/library',
    target: 'shelves',
    placement: 'bottom',
    title: 'Organize with Shelves',
    description:
      'Move books between Reading, Want to read and Finished, so your reading list is always easy to find.',
  },
  {
    id: 'author-studio',
    route: '/author/stories',
    target: 'author-studio',
    placement: 'bottom',
    title: 'Write & Publish ✍️',
    description:
      'Create, write and publish your own stories. Every story starts as a private draft, and the author tools manage its chapters.',
  },
  {
    id: 'book-clubs',
    route: '/clubs',
    target: 'book-clubs',
    placement: 'right',
    title: 'Book Clubs',
    description:
      'Join communities, discuss stories, share recommendations and connect with fellow readers.',
  },
  {
    id: 'profile',
    route: '/clubs',
    target: 'profile',
    placement: 'bottom',
    title: 'Your Profile',
    description:
      'Manage your profile, stories, followers and settings. You can take this tour again from here any time.',
  },
  {
    id: 'notifications',
    route: '/clubs',
    target: 'notifications',
    placement: 'bottom',
    title: 'Notifications',
    description:
      'Stay updated with replies to your comments, new stories from authors you follow, club discussions and badges you earn.',
  },
  {
    id: 'scribble',
    route: '/clubs',
    target: 'scribble',
    placement: 'top',
    title: 'Meet Scribble 💬',
    description:
      'Your reading companion. Whenever you’re not sure what to read next, Scribble is one tap away, and it follows you from page to page.',
  },
  {
    id: 'scribble-panel',
    route: '/clubs',
    target: 'scribble-panel',
    placement: 'left',
    reveal: 'scribble',
    title: 'Ask in your own words',
    description:
      'Describe a mood or a genre, like “a mystery for the weekend”, or tap an example. Every pick is a real Scribe book; the notes are AI-written.',
  },
  {
    id: 'complete',
    route: null,
    target: null,
    title: 'You’re all set! 🎉',
    description:
      'You’ve completed the Scribe tour. Start exploring, reading and sharing stories.',
  },
]

/** Where "Explore Scribe" on the last card goes. */
export const TOUR_EXPLORE_ROUTE = '/discover'
