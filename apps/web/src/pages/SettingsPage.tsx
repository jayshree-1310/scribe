import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { useToast } from '../lib/toast'
import { ApiError } from '../lib/api-client'
import { updateMyAccount } from '../data/account-api'
import { THEME_PREFERENCES, useTheme, type ThemePreference } from '../lib/theme'
import {
  FONT_SIZES,
  FONT_SIZE_LABELS,
  READING_THEMES,
  READING_THEME_LABELS,
  READING_WIDTHS,
  READING_WIDTH_LABELS,
  useReaderPrefs,
} from '../lib/reader-prefs'
import { isValidEmail, isValidUsername } from '../lib/auth'
import { AppShell } from '../components/layout/AppShell'
import { AvatarField } from '../components/settings/AvatarField'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { ConfirmDialog } from '../components/ui/Dialog'
import { Icon, type IconName } from '../components/ui/Icon'
import { Select } from '../components/ui/Select'
import { Switch } from '../components/ui/Checkbox'
import { SegmentedControl } from '../components/ui/Tabs'
import { PasswordField, TextField } from '../components/ui/TextField'
import { EmptyState } from '../components/ui/States'
import './pages.css'

interface Section {
  id: string
  label: string
  icon: IconName
  title: string
  description: string
}

const SECTIONS: Section[] = [
  {
    id: 'account',
    label: 'Profile',
    icon: 'user',
    title: 'Profile',
    description: 'How you appear to other readers.',
  },
  {
    id: 'security',
    label: 'Sign-in & security',
    icon: 'lock',
    title: 'Sign-in & security',
    description: 'Your password, and closing your account.',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'sun',
    title: 'Appearance',
    description: 'Applies across all of Scribe and is remembered on this device.',
  },
  {
    id: 'reading',
    label: 'Reading',
    icon: 'book-open',
    title: 'Reading',
    description: 'Defaults for the reader. You can also change these while reading.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: 'bell',
    title: 'Notifications',
    description: "Choose what's worth interrupting you for.",
  },
  {
    id: 'privacy',
    label: 'Privacy',
    icon: 'shield',
    title: 'Privacy',
    description: 'You decide how much of your reading is public.',
  },
]

const THEME_ICONS = { light: 'sun', dark: 'moon', system: 'monitor' } as const
const THEME_LABELS: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

const VISIBILITY_OPTIONS = [
  { value: 'public', label: 'Everyone' },
  { value: 'followers', label: 'Followers only' },
  { value: 'private', label: 'Only me' },
]

export function SettingsPage() {
  const { session, adoptProfile, signOut } = useAuth()
  const { preference, setPreference } = useTheme()
  const { preferences, update } = useReaderPrefs()
  const { showToast } = useToast()
  const navigate = useNavigate()

  /**
   * The open section lives in the URL, so "Edit profile" can link straight to
   * it, the back button steps between sections, and a reload stays put. One
   * section is shown at a time: the six panels stacked made a page nobody
   * could find anything in without scrolling past everything else.
   */
  const [params, setParams] = useSearchParams()
  const requested = params.get('section')
  const active = SECTIONS.find((section) => section.id === requested) ?? SECTIONS[0]!

  function openSection(id: string) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.set('section', id)
        return next
      },
      // Pushed rather than replaced, so the back button steps back through
      // the sections the reader opened instead of leaving Settings entirely.
      { replace: false },
    )
  }

  const [displayName, setDisplayName] = useState(session?.user.displayName ?? '')
  const [username, setUsername] = useState(session?.user.username ?? '')
  const [email, setEmail] = useState(session?.user.email ?? '')
  const [bio, setBio] = useState(session?.user.bio ?? '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [savingAccount, setSavingAccount] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)

  const [notifications, setNotifications] = useState({
    comments: true,
    ratings: true,
    clubs: true,
    challenges: false,
    authorUpdates: true,
  })

  const [privacy, setPrivacy] = useState({
    profileVisibility: 'public',
    readingActivity: 'followers',
    shareActivity: true,
  })

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  function clearError(field: string) {
    setErrors((current) => ({ ...current, [field]: '' }))
  }

  async function onSaveAccount(event: React.FormEvent) {
    event.preventDefault()
    if (savingAccount || !session) return

    // Checked here as well as server-side so an obviously wrong field is
    // reported without a round trip; the API's own rules are the authority.
    const next: Record<string, string> = {}
    if (!isValidUsername(username)) next.username = '3–24 letters, numbers or underscores.'
    if (!isValidEmail(email)) next.email = 'That email address does not look right.'
    setErrors(next)
    if (Object.keys(next).length > 0) return

    setSavingAccount(true)
    try {
      const profile = await updateMyAccount({
        displayName: displayName.trim(),
        username: username.trim().toLowerCase(),
        email: email.trim().toLowerCase(),
        bio: bio.trim(),
      })

      adoptProfile(profile)

      // The API normalises what it stores — a lower-cased username, a trimmed
      // bio — so the form is refilled from the response rather than from what
      // was typed.
      setDisplayName(profile.displayName ?? '')
      setUsername(profile.username)
      setEmail(profile.email)
      setBio(profile.bio ?? '')

      showToast({ message: 'Profile saved.' })
    } catch (cause) {
      if (cause instanceof ApiError) {
        setErrors(cause.fieldErrors)
        showToast({
          tone: 'error',
          message:
            Object.keys(cause.fieldErrors).length > 0
              ? 'Some of the details need fixing.'
              : cause.message,
        })
      } else {
        showToast({ tone: 'error', message: 'We could not save those changes.' })
      }
    } finally {
      setSavingAccount(false)
    }
  }

  async function onChangePassword(event: React.FormEvent) {
    event.preventDefault()
    const next: Record<string, string> = {}
    if (currentPassword.length === 0) next.currentPassword = 'Enter your current password.'
    if (newPassword.length < 8) next.newPassword = 'Use at least 8 characters.'
    setErrors((current) => ({ ...current, ...next }))
    if (Object.keys(next).length > 0) return

    setSavingPassword(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 600))
      setCurrentPassword('')
      setNewPassword('')
      showToast({ message: 'Password updated.' })
    } finally {
      setSavingPassword(false)
    }
  }

  async function onDeleteAccount() {
    setDeleting(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 700))
      signOut()
      navigate('/', { replace: true })
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  return (
    <AppShell width="narrow">
      <header className="page-head">
        <div>
          <h1 className="page-head__title">Settings</h1>
          <p className="page-head__sub">Your account, how Scribe looks, and who sees what.</p>
        </div>
      </header>

      <div className="settings">
        {/* Section navigation ---------------------------------------- */}
        <nav className="settings__nav" aria-label="Settings sections">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => openSection(section.id)}
              aria-current={section.id === active.id ? 'page' : undefined}
            >
              <Icon name={section.icon} size="1rem" />
              {section.label}
            </button>
          ))}
        </nav>

        <Card as="section" className="settings__card" aria-label={active.title}>
          <h2 className="settings__title">{active.title}</h2>
          <p className="settings__desc">{active.description}</p>

          {/* Profile ------------------------------------------------- */}
          {active.id === 'account' ? (
            session ? (
              <>
                <AvatarField user={session.user} onChange={adoptProfile} />

                <hr className="settings__rule" />

                <form className="settings__form" onSubmit={onSaveAccount} noValidate>
                  <TextField
                    label="Display name"
                    value={displayName}
                    error={errors['displayName']}
                    maxLength={60}
                    hint="Shown on your profile and next to anything you post. Leave it empty to use your username."
                    disabled={savingAccount}
                    onChange={(event) => {
                      setDisplayName(event.target.value)
                      clearError('displayName')
                    }}
                  />
                  <TextField
                    label="Username"
                    value={username}
                    error={errors['username']}
                    maxLength={24}
                    hint="Your profile lives at /profile/your-username."
                    disabled={savingAccount}
                    onChange={(event) => {
                      setUsername(event.target.value)
                      clearError('username')
                    }}
                  />
                  <TextField
                    label="Email"
                    type="email"
                    value={email}
                    error={errors['email']}
                    hint={
                      session.user.email === email
                        ? undefined
                        : "You'll need to verify a new address."
                    }
                    disabled={savingAccount}
                    onChange={(event) => {
                      setEmail(event.target.value)
                      clearError('email')
                    }}
                  />
                  <TextField
                    multiline
                    label="Bio"
                    rows={3}
                    value={bio}
                    error={errors['bio']}
                    maxLength={280}
                    counterMax={280}
                    disabled={savingAccount}
                    onChange={(event) => {
                      setBio(event.target.value)
                      clearError('bio')
                    }}
                  />
                  <div className="settings__actions">
                    <Button variant="primary" type="submit" loading={savingAccount}>
                      Save changes
                    </Button>
                  </div>
                </form>
              </>
            ) : (
              <EmptyState
                icon="user"
                title="Sign in to edit your profile"
                size="sm"
              />
            )
          ) : null}

          {/* Sign-in & security -------------------------------------- */}
          {active.id === 'security' ? (
            <>
              <h3 className="settings__subtitle">Password</h3>
              <form className="settings__form" onSubmit={onChangePassword} noValidate>
                <PasswordField
                  label="Current password"
                  autoComplete="current-password"
                  value={currentPassword}
                  error={errors['currentPassword']}
                  disabled={savingPassword}
                  onChange={(event) => {
                    setCurrentPassword(event.target.value)
                    clearError('currentPassword')
                  }}
                />
                <PasswordField
                  label="New password"
                  autoComplete="new-password"
                  value={newPassword}
                  error={errors['newPassword']}
                  disabled={savingPassword}
                  onChange={(event) => {
                    setNewPassword(event.target.value)
                    clearError('newPassword')
                  }}
                />
                <div className="settings__actions">
                  <Button type="submit" loading={savingPassword}>
                    Update password
                  </Button>
                </div>
              </form>

              <hr className="settings__rule" />

              <h3 className="settings__subtitle settings__subtitle--danger">Delete account</h3>
              <p className="settings__desc">
                This removes your profile, stories, comments and reading history.
                It cannot be undone.
              </p>
              <div className="settings__actions">
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  Delete my account
                </Button>
              </div>
            </>
          ) : null}

          {/* Appearance --------------------------------------------- */}
          {active.id === 'appearance' ? (
            <SegmentedControl
              label="Theme"
              value={preference}
              onChange={setPreference}
              items={THEME_PREFERENCES.map((value) => ({
                value,
                label: THEME_LABELS[value],
                icon: <Icon name={THEME_ICONS[value]} size="1rem" />,
              }))}
            />
          ) : null}

          {/* Reading ------------------------------------------------- */}
          {active.id === 'reading' ? (
            <div className="settings__stack">
              <div>
                <p className="settings__label">Font size</p>
                <SegmentedControl
                  label="Font size"
                  value={preferences.fontSize}
                  onChange={(fontSize) => update({ fontSize })}
                  items={FONT_SIZES.map((size) => ({ value: size, label: FONT_SIZE_LABELS[size] }))}
                />
              </div>

              <div>
                <p className="settings__label">Reading width</p>
                <SegmentedControl
                  label="Reading width"
                  value={preferences.width}
                  onChange={(width) => update({ width })}
                  items={READING_WIDTHS.map((width) => ({
                    value: width,
                    label: READING_WIDTH_LABELS[width],
                  }))}
                />
              </div>

              <div>
                <p className="settings__label">Reading theme</p>
                <SegmentedControl
                  label="Reading theme"
                  value={preferences.theme}
                  onChange={(theme) => update({ theme })}
                  items={READING_THEMES.map((theme) => ({
                    value: theme,
                    label: READING_THEME_LABELS[theme],
                  }))}
                />
              </div>

              <Switch
                checked={preferences.autoplayMultimedia}
                onChange={(autoplayMultimedia) => update({ autoplayMultimedia })}
                label="Autoplay multimedia"
                description="Play chapter audio and video automatically."
              />
            </div>
          ) : null}

          {/* Notifications ------------------------------------------ */}
          {active.id === 'notifications' ? (
            <div className="settings__switches">
              <Switch
                checked={notifications.comments}
                onChange={(value) => setNotifications((c) => ({ ...c, comments: value }))}
                label="Comments"
                description="Replies to your comments and comments on your stories."
              />
              <Switch
                checked={notifications.ratings}
                onChange={(value) => setNotifications((c) => ({ ...c, ratings: value }))}
                label="Ratings and reviews"
                description="When someone rates or reviews your work."
              />
              <Switch
                checked={notifications.clubs}
                onChange={(value) => setNotifications((c) => ({ ...c, clubs: value }))}
                label="Book clubs"
                description="New discussions in clubs you've joined."
              />
              <Switch
                checked={notifications.challenges}
                onChange={(value) => setNotifications((c) => ({ ...c, challenges: value }))}
                label="Writing challenges"
                description="Deadlines, results and new prompts."
              />
              <Switch
                checked={notifications.authorUpdates}
                onChange={(value) => setNotifications((c) => ({ ...c, authorUpdates: value }))}
                label="Author updates"
                description="New chapters and channel posts from authors you follow."
              />
            </div>
          ) : null}

          {/* Privacy ------------------------------------------------- */}
          {active.id === 'privacy' ? (
            <div className="settings__stack">
              <Select
                label="Who can see your profile"
                value={privacy.profileVisibility}
                options={VISIBILITY_OPTIONS}
                onChange={(value) => setPrivacy((c) => ({ ...c, profileVisibility: value }))}
              />
              <Select
                label="Who can see your reading activity"
                value={privacy.readingActivity}
                options={VISIBILITY_OPTIONS}
                onChange={(value) => setPrivacy((c) => ({ ...c, readingActivity: value }))}
              />
              <Switch
                checked={privacy.shareActivity}
                onChange={(value) => setPrivacy((c) => ({ ...c, shareActivity: value }))}
                label="Share activity in club feeds"
                description="Let club members see what you're reading along with them."
              />
            </div>
          ) : null}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete your account?"
        message="Your profile, stories, comments and reading history will be permanently removed. This cannot be undone."
        confirmLabel="Delete account"
        pending={deleting}
        onConfirm={onDeleteAccount}
        onCancel={() => setConfirmDelete(false)}
      />
    </AppShell>
  )
}
