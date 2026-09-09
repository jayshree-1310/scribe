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

export const READER_NAV: NavSection[] = [
  {
    id: 'read',
    items: [
      { to: '/home', label: 'Home', icon: 'home', primary: true },
      { to: '/discover', label: 'Discover', icon: 'compass', primary: true },
      { to: '/books', label: 'Books', icon: 'book' },
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
