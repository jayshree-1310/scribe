/**
 * Terms of Service and Privacy Policy copy.
 *
 * ⚠️  DRAFT — NOT LEGAL ADVICE. This is plain-English placeholder copy written
 * to give the pages real structure and a real reading experience. It has not
 * been reviewed by a lawyer and does not describe Scribe's actual data
 * processing, jurisdiction or liability position. Have counsel review and
 * replace it before launch, and update `updatedAt` when you do.
 *
 * Content lives here rather than in JSX so the pages stay presentational and
 * the text can be swapped — or later fetched from a CMS — on its own.
 */

export interface LegalSection {
  /** Anchor id, also used by the contents list. */
  id: string
  heading: string
  body: string[]
  list?: string[]
}

export interface LegalDocument {
  title: string
  /** One-line description under the title. */
  summary: string
  /** ISO date the document last changed. */
  updatedAt: string
  sections: LegalSection[]
}

const CONTACT = 'legal@scribe.example'

export const TERMS: LegalDocument = {
  title: 'Terms of Service',
  summary:
    'The agreement between you and Scribe: what you can expect from us, and what we ask of you.',
  updatedAt: '2026-09-01',
  sections: [
    {
      id: 'agreement',
      heading: 'The short version',
      body: [
        'Scribe is a place to read and write serialised fiction. These terms apply whenever you use it — reading, writing, commenting, or simply browsing.',
        'By creating an account you accept these terms. If you do not agree with them, please do not use Scribe.',
      ],
    },
    {
      id: 'account',
      heading: 'Your account',
      body: [
        'You need an account to write, comment, or keep a library. You are responsible for what happens under your account, so choose a password you do not use anywhere else and tell us promptly if you think someone else has access to it.',
        'You must be at least 13 years old to hold an account. Some material on Scribe is written for adults, and we mark it accordingly.',
      ],
    },
    {
      id: 'your-work',
      heading: 'Your writing stays yours',
      body: [
        'You keep every right you have in what you write. Publishing on Scribe does not transfer ownership to us.',
        'You do give us the permission we need in order to run the service: to store your work, show it to the readers you publish it to, display excerpts and covers in listings and recommendations, and make the copies a website technically requires. That permission lasts as long as your work is on Scribe and ends when you remove it, apart from backups we have not yet cycled out.',
      ],
    },
    {
      id: 'what-you-post',
      heading: 'What you publish',
      body: [
        'You are responsible for what you post, and you confirm that you have the right to post it. Please do not publish work that is not yours to publish.',
        'Some things are not welcome on Scribe at all:',
      ],
      list: [
        'Material that sexualises children, in any form, including fiction.',
        'Content that encourages violence against real people, or targets them with harassment.',
        'Someone else’s writing passed off as your own.',
        'Private information about another person shared without their consent.',
        'Spam, scams, malware, or attempts to manipulate ratings and rankings.',
      ],
    },
    {
      id: 'moderation',
      heading: 'Moderation',
      body: [
        'We may remove work that breaks these terms, and we may suspend or close accounts that do so repeatedly or seriously.',
        'Where we can, we will tell you what was removed and why, and give you a way to reply. Where the law requires immediate action, we may act first and explain afterwards.',
      ],
    },
    {
      id: 'reading-data',
      heading: 'Your library and reading activity',
      body: [
        'Your library, your shelves, and your reading progress belong to you. We use them to run features you have asked for — picking up where you left off, and suggesting books you might like.',
        'You can remove anything from your library at any time. How we handle this data is described in the Privacy Policy.',
      ],
    },
    {
      id: 'availability',
      heading: 'Availability',
      body: [
        'We work to keep Scribe running, but we do not promise it will be uninterrupted or error-free. We may change or retire features, and we will give reasonable notice before removing something you rely on.',
        'To the extent the law allows, Scribe is provided as it is, and we are not liable for indirect or consequential loss. Nothing here limits liability that cannot be limited by law.',
      ],
    },
    {
      id: 'ending',
      heading: 'Ending the agreement',
      body: [
        'You can close your account whenever you like from your settings. We can end this agreement if you break these terms, or if we stop offering the service.',
        'When your account closes, your published work is removed from public view. The sections on your writing, availability and liability survive.',
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to these terms',
      body: [
        'We will update this page when these terms change, and change the date at the top. If a change materially affects your rights, we will tell you before it takes effect.',
        `Questions about any of this are welcome at ${CONTACT}.`,
      ],
    },
  ],
}

export const PRIVACY: LegalDocument = {
  title: 'Privacy Policy',
  summary:
    'What Scribe collects, why we collect it, and the control you have over it.',
  updatedAt: '2026-09-01',
  sections: [
    {
      id: 'principles',
      heading: 'The short version',
      body: [
        'We collect what we need to run a reading and writing service, and not more. We do not sell your personal information, and we do not sell your reading history.',
      ],
    },
    {
      id: 'collected',
      heading: 'What we collect',
      body: ['Three kinds of information:'],
      list: [
        'What you give us — your username, email address, password (stored only as a hash, never in readable form), and anything you choose to write in your profile.',
        'What you create — your stories, chapters, comments, ratings, library and reading progress.',
        'What your device sends — IP address, browser type, and pages requested, kept in server logs so we can keep the service secure and working.',
      ],
    },
    {
      id: 'use',
      heading: 'How we use it',
      body: ['We use your information to:'],
      list: [
        'Run your account and keep you signed in.',
        'Show your work to the readers you publish it to.',
        'Keep your library and remember where you stopped reading.',
        'Recommend books, based on what you read and shelve.',
        'Detect abuse, spam and security problems.',
        'Answer you when you contact us.',
      ],
    },
    {
      id: 'sharing',
      heading: 'Who else sees it',
      body: [
        'Anything you publish — stories, comments, public profile details — is visible to other people by design. Your library and reading progress are private to you.',
        'We share personal information outside Scribe only with the service providers who host and operate the platform on our behalf, and only as far as they need it; or where the law requires it. We do not sell it.',
      ],
    },
    {
      id: 'storage',
      heading: 'Cookies and browser storage',
      body: [
        'We use cookies and browser storage for things the site needs to work: keeping you signed in, remembering your theme, your reading preferences, and where you were in a chapter.',
        'We do not use advertising trackers.',
      ],
    },
    {
      id: 'retention',
      heading: 'How long we keep it',
      body: [
        'We keep your account information for as long as your account is open. When you close it, we delete or anonymise your personal information, apart from what we must keep for legal or security reasons, and backups still in rotation.',
        'Server logs are kept for a short period and then discarded.',
      ],
    },
    {
      id: 'rights',
      heading: 'Your choices',
      body: ['Depending on where you live, you may have the right to:'],
      list: [
        'Get a copy of the personal information we hold about you.',
        'Correct anything that is wrong.',
        'Delete your account and the information attached to it.',
        'Object to certain processing, or ask us to restrict it.',
      ],
    },
    {
      id: 'children',
      heading: 'Children',
      body: [
        'Scribe is not intended for children under 13, and we do not knowingly collect their information. If you believe a child has given us personal information, contact us and we will remove it.',
      ],
    },
    {
      id: 'privacy-changes',
      heading: 'Changes to this policy',
      body: [
        'We will update this page when our practices change, and change the date at the top. Significant changes will be announced before they take effect.',
        `You can reach us about anything on this page at ${CONTACT}.`,
      ],
    },
  ],
}
