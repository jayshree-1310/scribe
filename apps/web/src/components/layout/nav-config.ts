import type { IconName } from '../ui/Icon'

export interface NavItem {
  to: string
  label: string
  icon: IconName
  /** Shown on the mobile bottom bar (max five). */
  primary?: boolean
}

export interface NavSection {
  id: string
  label?: string
  items: NavItem[]
}

/**
 * The administrator's section, appended rather than built into `READER_NAV`.
 *
 * Kept separate because it is the only part of the navigation that depends on
 * who is looking: everything else is the same for everybody signed in, and
 * threading a session through the nav config so one section could read it
 * would make every other section pay for this one. `AppShell` appends it when
 * the session says `isAdmin` -- and the queue checks again on the server, so
 * this is what is *offered* rather than what is allowed.
 */
export const ADMIN_NAV: NavSection = {
  id: 'admin',
  label: 'Administration',
  items: [{ to: '/moderation', label: 'Moderation', icon: 'shield' }],
}

export const READER_NAV: NavSection[] = [
  {
    id: 'read',
    items: [
      { to: '/home', label: 'Home', icon: 'home', primary: true },
      { to: '/discover', label: 'Discover', icon: 'compass', primary: true },
      { to: '/library', label: 'My Library', icon: 'library', primary: true },
    ],
  },
  {
    id: 'community',
    label: 'Community',
    items: [
      { to: '/clubs', label: 'Book Clubs', icon: 'users', primary: true },
      { to: '/challenges', label: 'Writing Challenges', icon: 'trophy' },
      { to: '/channels', label: 'Channels', icon: 'megaphone' },
      { to: '/badges', label: 'Badges', icon: 'medal' },
    ],
  },
]

export const AUTHOR_NAV: NavSection[] = [
  {
    id: 'studio',
    label: 'Studio',
    items: [
      { to: '/author', label: 'Dashboard', icon: 'home', primary: true },
      { to: '/author/stories', label: 'My Stories', icon: 'book', primary: true },
      { to: '/author/ideas', label: 'Idea Studio', icon: 'sparkle' },
      { to: '/author/analytics', label: 'Analytics', icon: 'trend', primary: true },
    ],
  },
  {
    id: 'audience',
    label: 'Audience',
    items: [
      { to: '/author/channels', label: 'Broadcast Channels', icon: 'megaphone', primary: true },
      { to: '/challenges', label: 'Writing Challenges', icon: 'trophy' },
      { to: '/badges', label: 'Badges', icon: 'medal' },
    ],
  },
]

export function primaryItems(sections: NavSection[]): NavItem[] {
  return sections.flatMap((section) => section.items).filter((item) => item.primary)
}
