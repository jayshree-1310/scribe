/**
 * Google Identity Services, wrapped so the rest of the app only ever asks for
 * an ID token.
 *
 * The script is loaded on first use rather than in `index.html`: most visits
 * never reach a sign-in page, and this keeps Google off the critical path (and
 * off the wire entirely) until someone actually clicks the button.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client'

/** Set `VITE_GOOGLE_CLIENT_ID` to the Web client id from Google Cloud. */
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

interface CredentialResponse {
  credential?: string
}

interface PromptNotification {
  isNotDisplayed: () => boolean
  isSkippedMoment: () => boolean
  getNotDisplayedReason: () => string
  getSkippedReason: () => string
}

interface GoogleAccountsId {
  initialize: (config: {
    client_id: string
    callback: (response: CredentialResponse) => void
    use_fedcm_for_prompt?: boolean
    auto_select?: boolean
    cancel_on_tap_outside?: boolean
  }) => void
  prompt: (listener?: (notification: PromptNotification) => void) => void
  renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void
  cancel: () => void
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } }
  }
}

export class GoogleSignInError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GoogleSignInError'
  }
}

export function googleSignInConfigured(): boolean {
  return Boolean(CLIENT_ID)
}

let scriptPromise: Promise<GoogleAccountsId> | null = null

function loadGis(): Promise<GoogleAccountsId> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id)

  scriptPromise ??= new Promise<GoogleAccountsId>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GIS_SRC}"]`,
    )

    const script = existing ?? document.createElement('script')

    const onLoad = () => {
      const api = window.google?.accounts?.id
      if (api) resolve(api)
      else reject(new GoogleSignInError('Google sign-in failed to initialise.'))
    }

    script.addEventListener('load', onLoad, { once: true })
    script.addEventListener(
      'error',
      () => {
        // Let a later attempt retry rather than caching the failure forever.
        scriptPromise = null
        reject(new GoogleSignInError('Could not reach Google. Check your connection and try again.'))
      },
      { once: true },
    )

    if (!existing) {
      script.src = GIS_SRC
      script.async = true
      script.defer = true
      document.head.append(script)
    }
  })

  return scriptPromise
}

/**
 * Asks Google to identify the visitor and resolves with the resulting ID token,
 * which only the API can make sense of — it is verified there against Google's
 * keys before any session is issued.
 *
 * One prompt at a time: a second click while the first is open cancels it, so a
 * stuck dialog cannot wedge the button.
 */
let pending: ((value: string) => void) | null = null

export async function requestGoogleIdToken(): Promise<string> {
  if (!CLIENT_ID) {
    throw new GoogleSignInError('Google sign-in is not configured.')
  }

  const api = await loadGis()

  return new Promise<string>((resolve, reject) => {
    if (pending) api.cancel()

    pending = resolve

    api.initialize({
      client_id: CLIENT_ID,
      callback: (response) => {
        pending = null
        if (response.credential) resolve(response.credential)
        else reject(new GoogleSignInError('Google did not return a credential.'))
      },
      use_fedcm_for_prompt: true,
      cancel_on_tap_outside: true,
    })

    api.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        pending = null
        reject(
          new GoogleSignInError(
            'Google sign-in was dismissed or unavailable. Please try again.',
          ),
        )
      }
    })
  })
}

/**
 * Renders Google's own button into `parent`, resolving once the visitor signs
 * in. The prompt above can be suppressed by the browser — FedCM cooldowns, a
 * previous dismissal, third-party-cookie policy — and this is the path Google
 * supports unconditionally, so it is the fallback when the prompt refuses.
 */
export async function renderGoogleButton(
  parent: HTMLElement,
  onToken: (idToken: string) => void,
): Promise<void> {
  if (!CLIENT_ID) {
    throw new GoogleSignInError('Google sign-in is not configured.')
  }

  const api = await loadGis()

  api.initialize({
    client_id: CLIENT_ID,
    callback: (response) => {
      if (response.credential) onToken(response.credential)
    },
    use_fedcm_for_prompt: true,
  })

  api.renderButton(parent, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    width: parent.clientWidth || 320,
  })
}
