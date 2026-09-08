import type { ReactElement } from 'react'

/**
 * In-repo icon set — no icon dependency ships with the app.
 * All glyphs share a 24×24 box, inherit `currentColor` and are stroked.
 */

export type IconName =
  | 'home' | 'compass' | 'library' | 'users' | 'trophy' | 'medal' | 'megaphone'
  | 'book' | 'book-open' | 'bookmark' | 'bookmark-filled' | 'pencil' | 'pen'
  | 'search' | 'filter' | 'sliders' | 'grid' | 'list' | 'more'
  | 'star' | 'star-filled' | 'star-half' | 'heart' | 'heart-filled' | 'comment'
  | 'eye' | 'flame' | 'clock' | 'calendar' | 'trend' | 'crown' | 'sparkle'
  | 'target' | 'quote' | 'lock' | 'globe' | 'shield'
  | 'bell' | 'settings' | 'logout' | 'user' | 'user-plus' | 'check' | 'check-circle'
  | 'close' | 'plus' | 'minus' | 'alert' | 'info' | 'retry' | 'trash'
  | 'chevron-left' | 'chevron-right' | 'chevron-down' | 'chevron-up'
  | 'arrow-right' | 'arrow-left' | 'arrow-up-right'
  | 'sun' | 'moon' | 'monitor' | 'menu' | 'share' | 'link'
  | 'image' | 'audio' | 'video' | 'play' | 'upload' | 'type'
  | 'google' | 'eye-off' | 'send' | 'text-size' | 'columns' | 'maximize'

const PATHS: Record<IconName, ReactElement> = {
  home: <path d="M4 11.5 12 4l8 7.5M6.5 10v10h11V10" />,
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m14.8 9.2-1.6 4.6-4.6 1.6 1.6-4.6z" />
    </>
  ),
  library: <path d="M4 4v16M8 4v16M12.5 5l6 15M20 20H3.5" />,
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 20c0-3 2.5-5.2 5.5-5.2s5.5 2.2 5.5 5.2" />
      <path d="M16 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.9c2 .7 3.5 2.6 3.5 5.1" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 4h8v4.5a4 4 0 0 1-8 0z" />
      <path d="M8 5.5H5.5v1.2A3.3 3.3 0 0 0 8.8 10M16 5.5h2.5v1.2a3.3 3.3 0 0 1-3.3 3.3" />
      <path d="M12 12.5V16M9 20h6M10 16h4l.6 4h-5.2z" />
    </>
  ),
  medal: (
    <>
      <circle cx="12" cy="14.5" r="5" />
      <path d="M8.5 3.5 12 9.5 15.5 3.5M12 12.6l.9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2L9.1 14.7l2-.3z" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 10.5 17 5.5v11L4 13.5z" />
      <path d="M4 10.5A1.8 1.8 0 0 0 4 13.5M8 12.6V19l3 1v-6" />
      <path d="M19.5 9.5a3.5 3.5 0 0 1 0 5" />
    </>
  ),
  book: (
    <>
      <path d="M5 4.5h9.5a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z" />
      <path d="M5 17a3 3 0 0 1 3-3h9.5" />
    </>
  ),
  'book-open': <path d="M12 6.5C10 5 7.5 4.5 4 4.5v13c3.5 0 6 .5 8 2 2-1.5 4.5-2 8-2v-13c-3.5 0-6 .5-8 2zM12 6.5v13" />,
  bookmark: <path d="M7 4.5h10V21l-5-3.4L7 21z" />,
  'bookmark-filled': <path d="M7 4.5h10V21l-5-3.4L7 21z" fill="currentColor" />,
  pencil: (
    <>
      <path d="M4 20h4L20 8l-4-4L4 16z" />
      <path d="m14.5 5.5 4 4" />
    </>
  ),
  pen: <path d="M4 20c1-5 3-9 7-12 2-1.5 4-2 6-2 0 2-.5 4-2 6-3 4-7 6-11 8zM8.5 15.5l2 2" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  sliders: <path d="M4 8h10M18 8h2M4 16h4M12 16h8M15 5.5v5M9 13.5v5" />,
  grid: <path d="M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z" />,
  list: <path d="M4 7h1M4 12h1M4 17h1M8 7h12M8 12h12M8 17h12" />,
  more: <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={2.4} />,
  star: <path d="m12 4.5 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z" />,
  'star-filled': <path d="m12 4.5 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z" fill="currentColor" />,
  'star-half': (
    <>
      <path d="m12 4.5 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z" />
      <path d="M12 4.5v12.9l-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z" fill="currentColor" />
    </>
  ),
  heart: <path d="M12 20s-7.5-4.4-7.5-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.7C19.5 15.6 12 20 12 20z" />,
  'heart-filled': <path d="M12 20s-7.5-4.4-7.5-9.3A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 7.5 2.7C19.5 15.6 12 20 12 20z" fill="currentColor" />,
  comment: <path d="M4.5 5.5h15v10h-9L5 19.5v-4h-.5z" />,
  eye: (
    <>
      <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.5 6.9A9.6 9.6 0 0 1 12 6.5c6 0 9.5 5.5 9.5 5.5a17 17 0 0 1-2.7 3.2M6.2 8.6A16.6 16.6 0 0 0 2.5 12S6 17.5 12 17.5c1 0 1.9-.15 2.7-.4" />
      <path d="M10 10.1a2.8 2.8 0 0 0 3.9 3.9" />
    </>
  ),
  flame: <path d="M12 21c3.6 0 6-2.3 6-5.4 0-4.3-4.5-5.6-3.6-11.6-3 1-6.4 4.3-6.4 8.3 0 1.4.5 2.4 1.2 3-.9-.2-1.7-1-2-2-.8 1-1.2 2.2-1.2 3.4C6 18.7 8.4 21 12 21z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3.2 2" />
    </>
  ),
  calendar: <path d="M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 4v3.5M15.5 4v3.5" />,
  trend: <path d="M4 16.5 9.5 11l3.5 3.5 6.5-7M20 7.5h-4.5M20 7.5V12" />,
  crown: <path d="M4 8.5l3 3.5 5-6.5 5 6.5 3-3.5V18H4zM4 18h16" />,
  sparkle: <path d="M12 4v5M12 15v5M4.5 12h5M14.5 12h5M7 7l2.5 2.5M14.5 14.5 17 17M17 7l-2.5 2.5M9.5 14.5 7 17" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </>
  ),
  quote: <path d="M9 6.5C6.5 8 5.5 10 5.5 13v4.5h5V12H8c0-1.8.5-3.2 2-4.2zM20 6.5c-2.5 1.5-3.5 3.5-3.5 6.5v4.5h5V12H19c0-1.8.5-3.2 2-4.2z" />,
  lock: (
    <>
      <path d="M6.5 11h11v9h-11z" />
      <path d="M9 11V8a3 3 0 0 1 6 0v3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.3 3.8 8.5S14.5 18.6 12 20.5c-2.5-1.9-3.8-4.8-3.8-8.5S9.5 5.9 12 3.5z" />
    </>
  ),
  shield: <path d="M12 3.5 19 6v5.5c0 4-2.8 7.3-7 9-4.2-1.7-7-5-7-9V6z" />,
  bell: <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10zM10 18.5a2.2 2.2 0 0 0 4 0" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M4.9 7.8l1.7 1M17.4 15.2l1.7 1M4.9 16.2l1.7-1M17.4 8.8l1.7-1" />
    </>
  ),
  logout: <path d="M14 7V5.5h-9v13h9V17M10 12h10M17 9l3 3-3 3" />,
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.4 3-6 7-6s7 2.6 7 6" />
    </>
  ),
  'user-plus': (
    <>
      <circle cx="10" cy="8.5" r="3.5" />
      <path d="M3.5 20c0-3.4 2.9-6 6.5-6 1 0 2 .2 2.8.6M17 14v6M14 17h6" />
    </>
  ),
  check: <path d="m5 13 4.5 4.5L19 7" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.2 12.3 2.6 2.6 5-5.4" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v5M12 16.2v.3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 7.8v.3" />
    </>
  ),
  retry: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 4h4M6 7l1 13h10l1-13" />
      <path d="M10.5 11v5.5M13.5 11v5.5" />
    </>
  ),
  'chevron-left': <path d="M14.5 5.5 8 12l6.5 6.5" />,
  'chevron-right': <path d="M9.5 5.5 16 12l-6.5 6.5" />,
  'chevron-down': <path d="M5.5 9.5 12 16l6.5-6.5" />,
  'chevron-up': <path d="M5.5 14.5 12 8l6.5 6.5" />,
  'arrow-right': <path d="M4 12h15M13.5 6.5 20 12l-6.5 5.5" />,
  'arrow-left': <path d="M20 12H5M10.5 6.5 4 12l6.5 5.5" />,
  'arrow-up-right': <path d="M7 17 17 7M8.5 7H17v8.5" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />,
  monitor: <path d="M3.5 5.5h17v10h-17zM9 19.5h6M12 15.5v4" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  share: (
    <>
      <path d="M12 15V4M8.5 7.5 12 4l3.5 3.5" />
      <path d="M6 12H4.5v8h15v-8H18" />
    </>
  ),
  link: <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" />,
  image: (
    <>
      <path d="M4.5 5.5h15v13h-15z" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m5 17 4.5-4.5 3.5 3.5 3-2.5 3 3" />
    </>
  ),
  audio: <path d="M4 14v-4h3l4-3.5v11L7 14zM15 9.5a3.5 3.5 0 0 1 0 5M17.5 7a7 7 0 0 1 0 10" />,
  video: <path d="M3.5 6.5h11v11h-11zM14.5 10.5l6-3v9l-6-3z" />,
  play: <path d="M8 5.5 19 12 8 18.5z" />,
  upload: <path d="M12 16V4M8.5 7.5 12 4l3.5 3.5M4.5 14v6h15v-6" />,
  type: <path d="M4 6.5h16M12 6.5V20M8.5 20h7" />,
  'text-size': <path d="M3 8h8M7 8v11M13 12h8M17 12v7" />,
  columns: <path d="M4.5 5.5h15v13h-15zM12 5.5v13" />,
  maximize: <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />,
  send: <path d="M20 4 4 10.5l6 2.5 2.5 6z" />,
  google: (
    <path
      d="M21 12.2c0-.7-.06-1.2-.18-1.8H12v3.4h5.1c-.1.9-.66 2.2-1.9 3.1l-.02.1 2.8 2.1.2.02c1.8-1.6 2.8-4 2.8-6.9zM12 21c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9a5.4 5.4 0 0 1-5.1-3.7H4l-.1.1v2.2A9 9 0 0 0 12 21zM6.9 13.8a5.5 5.5 0 0 1 0-3.6V7.9H4a9 9 0 0 0 0 8.1zM12 6.6c1.7 0 2.8.7 3.5 1.3l2.5-2.5A8.7 8.7 0 0 0 12 3a9 9 0 0 0-8 4.9l2.9 2.3A5.4 5.4 0 0 1 12 6.6z"
      fill="currentColor"
      stroke="none"
    />
  ),
}

interface IconProps {
  name: IconName
  /** Any CSS length; defaults to the current font size. */
  size?: string
  strokeWidth?: number
  className?: string
}

export function Icon({ name, size = '1.15em', strokeWidth = 1.7, className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none' }}
    >
      {PATHS[name]}
    </svg>
  )
}
