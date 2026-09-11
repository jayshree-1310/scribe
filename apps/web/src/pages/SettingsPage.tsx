import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useBlocker, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { cn } from '../lib/cn'
import { useToast } from '../lib/toast'
import { ApiError } from '../lib/api-client'
import {
  deleteMyAccount,
  getMyAccount,
  removeAvatar,
  updateMyAccount,
  uploadAvatar,
} from '../data/account-api'
import {
  changePassword,
  sendVerificationEmail,
  setPassword as setAccountPassword,
  signOutEverywhere,
} from '../data/auth-api'
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
import { PASSWORD_MIN, isValidEmail, isValidUsername, passwordStrength } from '../lib/auth'
import { AppShell } from '../components/layout/AppShell'
import { AvatarField, type PendingAvatar } from '../components/settings/AvatarField'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Dialog } from '../components/ui/Dialog'
import { Icon, type IconName } from '../components/ui/Icon'
import { Select } from '../components/ui/Select'
import { Switch } from '../components/ui/Checkbox'
import { SegmentedControl } from '../components/ui/Tabs'
import { PasswordField, TextField } from '../components/ui/TextField'
import { PasswordStrength } from '../components/ui/PasswordStrength'
import { EmptyState } from '../components/ui/States'
import './pages.css'

interface Section {
  id: string
  label: string
  /** Sits under the label in the navigation, so a section is findable. */
  blurb: string
  icon: IconName
  title: string
  description: string
}

const SECTIONS: Section[] = [
  {
    id: 'account',
    label: 'Profile',
    blurb: 'Name, picture, bio',
    icon: 'user',
    title: 'Profile',
    description: 'How you appear to other readers.',
  },
  {
    id: 'security',
    label: 'Sign-in & security',
    blurb: 'Password, email, devices',
    icon: 'lock',
    title: 'Sign-in & security',
    description: 'How you get into Scribe, and how you leave for good.',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    blurb: 'Light and dark',
    icon: 'sun',
    title: 'Appearance',
    description: 'Applies across all of Scribe and is remembered on this device.',
  },
  {
    id: 'reading',
    label: 'Reading',
    blurb: 'Type, width, media',
    icon: 'book-open',
    title: 'Reading',
    description: 'Defaults for the reader. You can also change these while reading.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    blurb: "What's worth a ping",
    icon: 'bell',
    title: 'Notifications',
    description: "Choose what's worth interrupting you for.",
  },
  {
    id: 'privacy',
    label: 'Privacy',
    blurb: 'Who sees what',
    icon: 'shield',
    title: 'Privacy',
    description: 'You decide how much of your reading is public.',
  },
]

/**
 * Six flat items read as a list to work through. Two groups say what the
 * split actually is: the first two write to the server and matter, the rest
 * are preferences you can flip without consequence.
 */
const NAV_GROUPS: { label: string; ids: string[] }[] = [
  { label: 'Account', ids: ['account', 'security'] },
  { label: 'Preferences', ids: ['appearance', 'reading', 'notifications', 'privacy'] },
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

/**
 * One card per thing a person might come here to change.
 *
 * The page used to be a single card per section with rules drawn between
 * unrelated forms, which made "change my password" and "delete my account"
 * look like two halves of the same task. Separate cards make the danger one
 * visibly separate, which is the whole point of putting it last.
 */
function Panel({
  title,
  description,
  tone,
  children,
}: {
  title: string
  description?: ReactNode
  tone?: 'danger'
  children: ReactNode
}) {
  return (
    <Card as="section" className={cn('settings-card', tone && `settings-card--${tone}`)}>
      <div className="settings-card__head">
        <h3 className="settings-card__title">{title}</h3>
        {description ? <p className="settings-card__desc">{description}</p> : null}
      </div>
      {children}
    </Card>
  )
}

/** A labelled control laid out beside its explanation. */
function Row({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <p className="settings-row__label">{label}</p>
        {description ? <p className="settings-row__desc">{description}</p> : null}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  )
}

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
  const [pendingAvatar, setPendingAvatar] = useState<PendingAvatar>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [savingAccount, setSavingAccount] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)

  const [sendingVerification, setSendingVerification] = useState(false)
  const [verificationSent, setVerificationSent] = useState(false)
  const [signingOutAll, setSigningOutAll] = useState(false)

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
  const [deleteUsername, setDeleteUsername] = useState('')
  const [deletePassword, setDeletePassword] = useState('')
  const [deleting, setDeleting] = useState(false)

  /**
   * Google accounts start with no password at all, so this panel offers to
   * *set* one rather than to change one — asking for a current password an
   * account has never had is the confusing half of this flow.
   *
   * Defaults to true for a session restored from an older stored shape: the
   * bootstrap refreshes the profile a moment later, and offering the more
   * common form in the meantime is the cheaper mistake.
   */
  const hasPassword = session?.user.hasPassword ?? true
  const emailVerified = session?.user.emailVerified !== false

  function clearError(field: string) {
    setErrors((current) => ({ ...current, [field]: '' }))
  }

  /** Folds a freshly written profile back into the session. */
  async function refreshProfile() {
    try {
      adoptProfile(await getMyAccount())
    } catch {
      // Cosmetic: the change landed, only this page's copy is stale.
    }
  }

  /**
   * True when the profile panel holds anything the API has not been told
   * about. Only this panel is tracked: the other sections either write to the
   * server as they are switched or are device-local preferences.
   */
  const dirty =
    pendingAvatar !== null ||
    (session != null &&
      (displayName !== (session.user.displayName ?? '') ||
        username !== session.user.username ||
        email !== session.user.email ||
        bio !== (session.user.bio ?? '')))

  /** Puts every field back to what the session holds, dropping the edits. */
  function resetAccountForm() {
    setDisplayName(session?.user.displayName ?? '')
    setUsername(session?.user.username ?? '')
    setEmail(session?.user.email ?? '')
    setBio(session?.user.bio ?? '')
    setPendingAvatar(null)
    setErrors({})
  }

  /**
   * Saves the whole profile panel: the picture and the text fields in one
   * action. The picture goes first, since it has its own endpoint and its own
   * ways to fail — a rejected upload should not leave the name saved and the
   * picture silently dropped.
   *
   * Returns whether everything saved, so a navigation held for unsaved changes
   * knows whether it may continue.
   */
  async function saveAccount(): Promise<boolean> {
    if (savingAccount || !session) return false

    // Checked here as well as server-side so an obviously wrong field is
    // reported without a round trip; the API's own rules are the authority.
    const next: Record<string, string> = {}
    if (!isValidUsername(username)) next.username = '3–24 letters, numbers or underscores.'
    if (!isValidEmail(email)) next.email = 'That email address does not look right.'
    setErrors(next)
    if (Object.keys(next).length > 0) {
      showToast({ tone: 'error', message: 'Some of the details need fixing.' })
      return false
    }

    setSavingAccount(true)
    try {
      if (pendingAvatar?.kind === 'file') {
        adoptProfile(await uploadAvatar(pendingAvatar.file))
      } else if (pendingAvatar?.kind === 'remove') {
        adoptProfile(await removeAvatar())
      }
      setPendingAvatar(null)

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
      return true
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
      return false
    } finally {
      setSavingAccount(false)
    }
  }

  async function onSaveAccount(event: React.FormEvent) {
    event.preventDefault()
    await saveAccount()
  }

  /**
   * Holds a navigation away from Settings while there are unsaved changes.
   * Switching sections is a search-param change on the same route, so the
   * blocker compares pathnames rather than whole locations — otherwise the
   * prompt would appear on every click in the section nav.
   */
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  )

  // The blocker covers navigation inside the app; a reload or a closed tab is
  // the browser's own prompt, which is all a page is allowed to ask for.
  useEffect(() => {
    if (!dirty) return

    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  async function onSaveAndLeave() {
    if (await saveAccount()) blocker.proceed?.()
  }

  function onDiscardAndLeave() {
    resetAccountForm()
    blocker.proceed?.()
  }

  /* Password ------------------------------------------------------------ */

  /**
   * One handler for both shapes of the form. The API is two endpoints, since
   * setting a first password and replacing a known one are different acts
   * with different proof behind them, but from here it is one decision the
   * account's own state already made.
   */
  async function onSubmitPassword(event: React.FormEvent) {
    event.preventDefault()
    if (savingPassword) return

    const next: Record<string, string> = {}
    if (hasPassword && currentPassword.length === 0) {
      next.currentPassword = 'Enter your current password.'
    }
    if (newPassword.length < PASSWORD_MIN) {
      next.newPassword = `Use at least ${PASSWORD_MIN} characters.`
    } else if (passwordStrength(newPassword).score < 2) {
      next.newPassword = 'Please choose a stronger password.'
    }
    if (confirmPassword !== newPassword) {
      next.confirmPassword = 'These passwords do not match.'
    }

    setErrors((current) => ({ ...current, ...next }))
    if (Object.keys(next).length > 0) return

    setSavingPassword(true)
    try {
      if (hasPassword) await changePassword({ currentPassword, newPassword })
      else await setAccountPassword(newPassword)

      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      await refreshProfile()

      showToast({
        message: hasPassword
          ? 'Password updated. Other devices have been signed out.'
          : 'Password set. You can now sign in without Google.',
      })
    } catch (cause) {
      if (cause instanceof ApiError) {
        setErrors((current) => ({
          ...current,
          ...cause.fieldErrors,
          // `/set-password` names its one field `password`; this form calls
          // the same box `newPassword`.
          ...(cause.fieldErrors['password']
            ? { newPassword: cause.fieldErrors['password'] }
            : {}),
        }))

        // 409 means this account is not the shape the form assumed — it has
        // gained or lost a password elsewhere. Re-reading the profile swaps
        // the form over rather than leaving it failing on every submit.
        if (cause.status === 409) await refreshProfile()

        showToast({ tone: 'error', message: cause.message })
      } else {
        showToast({ tone: 'error', message: 'We could not change your password.' })
      }
    } finally {
      setSavingPassword(false)
    }
  }

  async function onSendVerification() {
    setSendingVerification(true)
    try {
      await sendVerificationEmail()
      setVerificationSent(true)
      showToast({ message: 'Confirmation link sent. Check your inbox.' })
    } catch (cause) {
      showToast({
        tone: 'error',
        message:
          cause instanceof ApiError
            ? cause.message
            : 'We could not send that link. Please try again.',
      })
    } finally {
      setSendingVerification(false)
    }
  }

  /**
   * Ends every session, this one included — there is no "all the others"
   * endpoint, and pretending otherwise would leave this tab holding a token
   * the server has already forgotten.
   */
  async function onSignOutEverywhere() {
    setSigningOutAll(true)
    try {
      await signOutEverywhere()
      signOut()
      navigate('/login', { replace: true })
    } catch {
      showToast({ tone: 'error', message: 'We could not sign out those sessions.' })
      setSigningOutAll(false)
    }
  }

  /* Deletion ------------------------------------------------------------ */

  const deleteConfirmed =
    deleteUsername.trim().toLowerCase() === (session?.user.username ?? '') &&
    (!hasPassword || deletePassword.length > 0)

  function closeDeleteDialog() {
    setConfirmDelete(false)
    setDeleteUsername('')
    setDeletePassword('')
    clearError('confirmUsername')
    clearError('password')
  }

  async function onDeleteAccount() {
    if (deleting || !deleteConfirmed) return

    setDeleting(true)
    try {
      await deleteMyAccount({
        confirmUsername: deleteUsername.trim(),
        ...(hasPassword ? { password: deletePassword } : {}),
      })

      // Nothing left to save once the account is gone; clearing the form first
      // keeps the unsaved-changes prompt out of the way of the redirect.
      resetAccountForm()
      signOut()
      navigate('/', { replace: true })
    } catch (cause) {
      if (cause instanceof ApiError) {
        setErrors((current) => ({ ...current, ...cause.fieldErrors }))
        showToast({ tone: 'error', message: cause.message })
      } else {
        showToast({ tone: 'error', message: 'We could not delete your account.' })
      }
      setDeleting(false)
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
          {NAV_GROUPS.map((group) => (
            <div className="settings__nav-group" key={group.label}>
              <p className="settings__nav-heading">{group.label}</p>
              {group.ids.map((id) => {
                const section = SECTIONS.find((item) => item.id === id)!
                return (
                  <button
                    key={section.id}
                    type="button"
                    className="settings__nav-item"
                    onClick={() => openSection(section.id)}
                    aria-current={section.id === active.id ? 'page' : undefined}
                  >
                    <span className="settings__nav-icon">
                      <Icon name={section.icon} size="1rem" />
                    </span>
                    <span className="settings__nav-text">
                      {section.label}
                      <span>{section.blurb}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="settings__panel">
          <header className="settings__panel-head">
            <h2 className="settings__panel-title">{active.title}</h2>
            <p className="settings__panel-desc">{active.description}</p>
          </header>

          {/* Profile ------------------------------------------------- */}
          {active.id === 'account' ? (
            session ? (
              <form onSubmit={onSaveAccount} noValidate>
                <Panel
                  title="Picture"
                  description="A square image, at least 200 × 200. PNG, JPEG, WebP or GIF, up to 2 MB."
                >
                  <AvatarField
                    user={session.user}
                    pending={pendingAvatar}
                    onPendingChange={setPendingAvatar}
                    disabled={savingAccount}
                  />
                </Panel>

                <Panel title="Details" description="Everything here is public.">
                  <div className="settings__form">
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
                  </div>
                </Panel>

                {/* Sticky, so a long form never hides the button that saves
                    it, and absent entirely until there is something to save. */}
                {dirty ? (
                  <div className="settings__savebar">
                    <p>You have unsaved changes.</p>
                    <div className="settings__savebar-actions">
                      <Button
                        variant="ghost"
                        onClick={() => resetAccountForm()}
                        disabled={savingAccount}
                      >
                        Discard
                      </Button>
                      <Button variant="primary" type="submit" loading={savingAccount}>
                        Save changes
                      </Button>
                    </div>
                  </div>
                ) : null}
              </form>
            ) : (
              <EmptyState icon="user" title="Sign in to edit your profile" size="sm" />
            )
          ) : null}

          {/* Sign-in & security -------------------------------------- */}
          {active.id === 'security' ? (
            session ? (
              <>
                <Panel
                  title={hasPassword ? 'Password' : 'Add a password'}
                  description={
                    hasPassword
                      ? 'Changing it signs you out on every other device.'
                      : "You signed in with Google, so this account has no password yet. Adding one gives you a second way in — Google keeps working either way."
                  }
                >
                  <form className="settings__form" onSubmit={onSubmitPassword} noValidate>
                    {hasPassword ? (
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
                    ) : null}

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
                      footer={<PasswordStrength value={newPassword} />}
                    />

                    <PasswordField
                      label="Confirm new password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      error={errors['confirmPassword']}
                      disabled={savingPassword}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value)
                        clearError('confirmPassword')
                      }}
                    />

                    <div className="settings__actions">
                      <Button variant="primary" type="submit" loading={savingPassword}>
                        {hasPassword ? 'Update password' : 'Set password'}
                      </Button>
                      {hasPassword ? (
                        <Button variant="ghost" onClick={() => navigate('/forgot-password')}>
                          I've forgotten it
                        </Button>
                      ) : null}
                    </div>
                  </form>
                </Panel>

                <Panel
                  title="Email address"
                  description="Where password resets and account notices are sent."
                >
                  <Row
                    label={session.user.email}
                    description={
                      emailVerified
                        ? 'Confirmed — this address can recover your account.'
                        : 'Not confirmed yet. Until it is, you cannot reset your password with it.'
                    }
                  >
                    {emailVerified ? (
                      <span className="settings__badge is-verified">
                        <Icon name="check-circle" size="0.9em" />
                        Verified
                      </span>
                    ) : (
                      <Button
                        loading={sendingVerification}
                        disabled={verificationSent}
                        onClick={() => void onSendVerification()}
                      >
                        {verificationSent ? 'Link sent' : 'Send confirmation link'}
                      </Button>
                    )}
                  </Row>
                </Panel>

                <Panel
                  title="Devices"
                  description="Signed in somewhere you no longer trust?"
                >
                  <Row
                    label="Sign out everywhere"
                    description="Ends every session, including this one. You'll sign in again here."
                  >
                    <Button
                      loading={signingOutAll}
                      onClick={() => void onSignOutEverywhere()}
                      startIcon={<Icon name="logout" size="1rem" />}
                    >
                      Sign out all devices
                    </Button>
                  </Row>
                </Panel>

                <Panel
                  tone="danger"
                  title="Delete account"
                  description="Your profile, your stories and their chapters, your comments, ratings and reading history are removed permanently. Anything you published stops being readable for everyone. This cannot be undone."
                >
                  <div className="settings__actions">
                    <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                      Delete my account
                    </Button>
                  </div>
                </Panel>
              </>
            ) : (
              <EmptyState icon="lock" title="Sign in to manage your account" size="sm" />
            )
          ) : null}

          {/* Appearance --------------------------------------------- */}
          {active.id === 'appearance' ? (
            <Panel
              title="Theme"
              description="System follows whatever your device is set to, including its own schedule."
            >
              <div className="theme-picker">
                {THEME_PREFERENCES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={cn('theme-option', preference === value && 'is-active')}
                    onClick={() => setPreference(value)}
                    aria-pressed={preference === value}
                  >
                    <span className={`theme-option__preview theme-option__preview--${value}`} aria-hidden="true">
                      <span className="theme-option__bar" />
                      <span className="theme-option__line" />
                      <span className="theme-option__line theme-option__line--short" />
                    </span>
                    <span className="theme-option__label">
                      <Icon name={THEME_ICONS[value]} size="0.95rem" />
                      {THEME_LABELS[value]}
                    </span>
                  </button>
                ))}
              </div>
            </Panel>
          ) : null}

          {/* Reading ------------------------------------------------- */}
          {active.id === 'reading' ? (
            <>
              <Panel title="Type" description="Applies the next time you open a chapter.">
                <div className="settings__stack">
                  <Row label="Font size">
                    <SegmentedControl
                      label="Font size"
                      value={preferences.fontSize}
                      onChange={(fontSize) => update({ fontSize })}
                      items={FONT_SIZES.map((size) => ({
                        value: size,
                        label: FONT_SIZE_LABELS[size],
                      }))}
                    />
                  </Row>
                  <Row label="Reading width">
                    <SegmentedControl
                      label="Reading width"
                      value={preferences.width}
                      onChange={(width) => update({ width })}
                      items={READING_WIDTHS.map((width) => ({
                        value: width,
                        label: READING_WIDTH_LABELS[width],
                      }))}
                    />
                  </Row>
                  <Row label="Page colour">
                    <SegmentedControl
                      label="Reading theme"
                      value={preferences.theme}
                      onChange={(theme) => update({ theme })}
                      items={READING_THEMES.map((theme) => ({
                        value: theme,
                        label: READING_THEME_LABELS[theme],
                      }))}
                    />
                  </Row>
                </div>
              </Panel>

              <Panel title="Media">
                <Switch
                  checked={preferences.autoplayMultimedia}
                  onChange={(autoplayMultimedia) => update({ autoplayMultimedia })}
                  label="Autoplay multimedia"
                  description="Play chapter audio and video automatically."
                />
              </Panel>
            </>
          ) : null}

          {/* Notifications ------------------------------------------ */}
          {active.id === 'notifications' ? (
            <Panel title="Email and in-app">
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
                  onChange={(value) =>
                    setNotifications((c) => ({ ...c, authorUpdates: value }))
                  }
                  label="Author updates"
                  description="New chapters and channel posts from authors you follow."
                />
              </div>
            </Panel>
          ) : null}

          {/* Privacy ------------------------------------------------- */}
          {active.id === 'privacy' ? (
            <Panel title="Visibility">
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
            </Panel>
          ) : null}
        </div>
      </div>

      <Dialog
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="Save your changes?"
        description="You have unsaved changes to your profile."
        size="sm"
        dismissible={!savingAccount}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => onDiscardAndLeave()}
              disabled={savingAccount}
            >
              Discard changes
            </Button>
            <Button
              variant="primary"
              onClick={() => void onSaveAndLeave()}
              loading={savingAccount}
            >
              Save and leave
            </Button>
          </>
        }
      >
        <p className="settings-card__desc">
          {pendingAvatar
            ? 'Your profile details and picture will be lost if you leave without saving.'
            : 'Your profile details will be lost if you leave without saving.'}
        </p>
      </Dialog>

      {/*
        A typed confirmation rather than a plain "are you sure": the button
        behind this dialog is one click away from destroying work, and the
        password — for accounts that have one — is what stops a borrowed,
        still-signed-in laptop from being enough.
      */}
      <Dialog
        open={confirmDelete}
        onClose={closeDeleteDialog}
        title="Delete your account?"
        size="sm"
        dismissible={!deleting}
        footer={
          <>
            <Button variant="ghost" onClick={closeDeleteDialog} disabled={deleting}>
              Keep my account
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              disabled={!deleteConfirmed}
              onClick={() => void onDeleteAccount()}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <div className="settings__form">
          <p className="settings-card__desc">
            This removes your profile, your stories and their chapters, your
            comments, ratings and reading history. Readers lose access to
            anything you published. It cannot be undone.
          </p>

          <TextField
            label={`Type ${session?.user.username ?? 'your username'} to confirm`}
            value={deleteUsername}
            error={errors['confirmUsername']}
            autoComplete="off"
            disabled={deleting}
            onChange={(event) => {
              setDeleteUsername(event.target.value)
              clearError('confirmUsername')
            }}
          />

          {hasPassword ? (
            <PasswordField
              label="Your password"
              autoComplete="current-password"
              value={deletePassword}
              error={errors['password']}
              disabled={deleting}
              onChange={(event) => {
                setDeletePassword(event.target.value)
                clearError('password')
              }}
            />
          ) : null}
        </div>
      </Dialog>
    </AppShell>
  )
}
