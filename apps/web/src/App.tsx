import {
  Navigate,
  Outlet,
  Route,
  RouterProvider,
  ScrollRestoration,
  createBrowserRouter,
  createRoutesFromElements,
} from 'react-router-dom'
import { AuthProvider } from './components/providers/AuthProvider'
import { NotificationsProvider } from './components/providers/NotificationsProvider'
import { ReaderPrefsProvider } from './components/providers/ReaderPrefsProvider'
import { ThemeProvider } from './components/providers/ThemeProvider'
import { ToastProvider } from './components/ui/ToastProvider'
import { RequireAuth } from './components/RequireAuth'
import { ShellLayout } from './components/layout/ShellLayout'

import { LandingPage } from './pages/LandingPage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { ResetPasswordPage } from './pages/ResetPasswordPage'
import { VerifyEmailPage } from './pages/VerifyEmailPage'
import { OnboardingPage } from './pages/OnboardingPage'
import { ForWritersPage } from './pages/ForWritersPage'
import { PrivacyPage, TermsPage } from './pages/LegalPage'
import { HomePage } from './pages/HomePage'
import { DiscoverPage } from './pages/DiscoverPage'
import { BookDetailPage } from './pages/BookDetailPage'
import { StoryDetailPage } from './pages/StoryDetailPage'
import { ReaderPage } from './pages/ReaderPage'
import { MyLibraryPage } from './pages/MyLibraryPage'
import { ClubsPage } from './pages/ClubsPage'
import { ClubDetailPage } from './pages/ClubDetailPage'
import { ChallengesPage } from './pages/ChallengesPage'
import { ChallengeDetailPage } from './pages/ChallengeDetailPage'
import { BadgesPage } from './pages/BadgesPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { ModerationQueuePage } from './pages/ModerationQueuePage'
import { ChannelsPage } from './pages/ChannelsPage'
import { ChannelDetailPage } from './pages/ChannelDetailPage'
import { ProfilePage } from './pages/ProfilePage'
import { SettingsPage } from './pages/SettingsPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { AiLabPage } from './pages/AiLabPage'
import { AuthorDashboardPage } from './pages/author/AuthorDashboardPage'
import { AuthorStoriesPage } from './pages/author/AuthorStoriesPage'
import { IdeaStudioPage } from './pages/author/IdeaStudioPage'
import { AuthorAnalyticsPage } from './pages/author/AuthorAnalyticsPage'
import { AuthorChannelsPage } from './pages/author/AuthorChannelsPage'
import { StoryEditorPage } from './pages/author/StoryEditorPage'

/**
 * A data router rather than `<BrowserRouter>`: `useBlocker` — which Settings
 * uses to hold a navigation while unsaved changes are resolved — is only
 * available to one.
 *
 * The signed-in routes are grouped under two layout routes rather than each
 * rendering its own shell, so navigating swaps the page and nothing else. See
 * `components/layout/ShellLayout.tsx` for what that fixed.
 */
/**
 * Everything hangs off this, for one reason: `ScrollRestoration`.
 *
 * Client-side navigation does not move the page the way a document load does,
 * so without this a reader who followed a link from halfway down a long list
 * arrived halfway down the next page. It restores the remembered position on
 * back and forward, and goes to the top on anything new, which is what a
 * browser would have done.
 */
function RootLayout() {
  return (
    <>
      <ScrollRestoration />
      <Outlet />
    </>
  )
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<RootLayout />}>
      {/* Public ------------------------------------------- */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      {/* Reached from a link in an email, so all three must work signed out. */}
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
      <Route path="/verify-email/:token" element={<VerifyEmailPage />} />

      <Route path="/for-writers" element={<ForWritersPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />

      {/* Browsing and reading require an account. --------- */}
      {/*
        Onboarding is gated in both directions: an account that has not
        finished it cannot reach anything else, and one that has cannot come
        back. See `RequireAuth`. It renders outside the shell, deliberately --
        somebody midway through signing up has no sidebar to navigate with.
      */}
      <Route
        path="/onboarding"
        element={
          <RequireAuth>
            <OnboardingPage />
          </RequireAuth>
        }
      />
      {/* The reader page brings its own chrome, so it too sits outside. */}
      <Route
        path="/read/:slug/:chapter"
        element={
          <RequireAuth>
            <ReaderPage />
          </RequireAuth>
        }
      />

      {/*
        Everything below shares one shell, mounted once. `RequireAuth` moved
        onto the layout route with it: the gate is the same for every page in
        the group, and twenty copies of it was twenty chances to forget one.
        `handle` carries the only thing a page still says about its own frame.
      */}
      <Route
        element={
          <RequireAuth>
            <ShellLayout />
          </RequireAuth>
        }
      >
        <Route path="/home" element={<HomePage />} />
        <Route path="/discover" element={<DiscoverPage />} />
        <Route path="/book/:id" element={<BookDetailPage />} />
        <Route path="/story/:slug" element={<StoryDetailPage />} />
        <Route path="/library" element={<MyLibraryPage />} />
        <Route path="/clubs" element={<ClubsPage />} />
        <Route path="/clubs/:slug" element={<ClubDetailPage />} />
        <Route path="/challenges" element={<ChallengesPage />} />
        <Route path="/challenges/:slug" element={<ChallengeDetailPage />} />
        <Route path="/channels" element={<ChannelsPage />} />
        <Route
          path="/channels/:slug"
          handle={{ width: 'narrow' }}
          element={<ChannelDetailPage />}
        />
        <Route path="/badges" element={<BadgesPage />} />
        <Route
          path="/notifications"
          handle={{ width: 'narrow' }}
          element={<NotificationsPage />}
        />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/profile/:username" element={<ProfilePage />} />
        <Route
          path="/settings"
          handle={{ width: 'narrow' }}
          element={<SettingsPage />}
        />
        {/* Offered only to administrators; the page says so for anybody who
            arrives by typing the URL, and every request it makes is checked
            again by `assertAdmin`. */}
        <Route path="/moderation" element={<ModerationQueuePage />} />

        {/*
          A workbench for building AI features, not a feature: mounted in
          development only, and linked from nowhere. `import.meta.env.DEV` is
          a compile-time constant, so a production build drops this branch and
          tree-shakes the page with it — only its stylesheet rides along, which
          is a kilobyte of rules nothing renders. `createRoutesFromElements`
          skips a null child, which is what makes the conditional legal here.

          This is a convenience, not the security boundary. `/api/ai/chat`
          requires a session and is rate-limited whether or not a page exists
          to call it — a route hidden in the client would protect nothing.
        */}
        {import.meta.env.DEV ? (
          <Route path="/ai-lab" element={<AiLabPage />} />
        ) : null}
      </Route>

      {/* Author studio: the same shell, the other navigation. ------------- */}
      <Route
        element={
          <RequireAuth>
            <ShellLayout variant="author" />
          </RequireAuth>
        }
      >
        <Route path="/author" element={<AuthorDashboardPage />} />
        <Route path="/author/stories" element={<AuthorStoriesPage />} />
        <Route path="/author/ideas" element={<IdeaStudioPage />} />
        <Route path="/author/stories/:slug" element={<StoryEditorPage />} />
        <Route path="/author/analytics" element={<AuthorAnalyticsPage />} />
        <Route path="/author/channels" element={<AuthorChannelsPage />} />
      </Route>

      {/* Convenience redirects ---------------------------- */}
      <Route path="/stories" element={<Navigate to="/discover" replace />} />
      <Route path="/books" element={<Navigate to="/discover" replace />} />

      <Route path="*" element={<NotFoundPage />} />
    </Route>,
  ),
)

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <NotificationsProvider>
          <ReaderPrefsProvider>
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </ReaderPrefsProvider>
        </NotificationsProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App
