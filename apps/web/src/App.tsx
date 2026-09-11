import {
  Navigate,
  Route,
  RouterProvider,
  createBrowserRouter,
  createRoutesFromElements,
} from 'react-router-dom'
import { AuthProvider } from './components/providers/AuthProvider'
import { ReaderPrefsProvider } from './components/providers/ReaderPrefsProvider'
import { ThemeProvider } from './components/providers/ThemeProvider'
import { ToastProvider } from './components/ui/ToastProvider'
import { RequireAuth } from './components/RequireAuth'

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
import { ChannelsPage } from './pages/ChannelsPage'
import { ChannelDetailPage } from './pages/ChannelDetailPage'
import { ProfilePage } from './pages/ProfilePage'
import { SettingsPage } from './pages/SettingsPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { AuthorDashboardPage } from './pages/author/AuthorDashboardPage'
import { AuthorStoriesPage } from './pages/author/AuthorStoriesPage'
import { AuthorAnalyticsPage } from './pages/author/AuthorAnalyticsPage'
import { AuthorChannelsPage } from './pages/author/AuthorChannelsPage'
import { StoryEditorPage } from './pages/author/StoryEditorPage'

/**
 * A data router rather than `<BrowserRouter>`: `useBlocker` — which Settings
 * uses to hold a navigation while unsaved changes are resolved — is only
 * available to one. The route tree itself is unchanged.
 */
const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      {/* Public ------------------------------------------- */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      {/* Reached from a link in an email, so all three must work signed out. */}
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
      <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/for-writers" element={<ForWritersPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/privacy" element={<PrivacyPage />} />

      {/* Browsing and reading require an account. --------- */}
      <Route
        path="/discover"
        element={
          <RequireAuth>
            <DiscoverPage />
          </RequireAuth>
        }
      />
      <Route
        path="/book/:id"
        element={
          <RequireAuth>
            <BookDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/story/:slug"
        element={
          <RequireAuth>
            <StoryDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/read/:slug/:chapter"
        element={
          <RequireAuth>
            <ReaderPage />
          </RequireAuth>
        }
      />
      <Route
        path="/clubs"
        element={
          <RequireAuth>
            <ClubsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/clubs/:slug"
        element={
          <RequireAuth>
            <ClubDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/challenges"
        element={
          <RequireAuth>
            <ChallengesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/challenges/:slug"
        element={
          <RequireAuth>
            <ChallengeDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/channels"
        element={
          <RequireAuth>
            <ChannelsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/channels/:slug"
        element={
          <RequireAuth>
            <ChannelDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/profile/:username"
        element={
          <RequireAuth>
            <ProfilePage />
          </RequireAuth>
        }
      />

      {/* Signed in ---------------------------------------- */}
      <Route
        path="/home"
        element={
          <RequireAuth>
            <HomePage />
          </RequireAuth>
        }
      />
      <Route
        path="/library"
        element={
          <RequireAuth>
            <MyLibraryPage />
          </RequireAuth>
        }
      />
      <Route
        path="/badges"
        element={
          <RequireAuth>
            <BadgesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/profile"
        element={
          <RequireAuth>
            <ProfilePage />
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <SettingsPage />
          </RequireAuth>
        }
      />

      {/* Author studio ------------------------------------ */}
      <Route
        path="/author"
        element={
          <RequireAuth>
            <AuthorDashboardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/author/stories"
        element={
          <RequireAuth>
            <AuthorStoriesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/author/stories/:slug"
        element={
          <RequireAuth>
            <StoryEditorPage />
          </RequireAuth>
        }
      />
      <Route
        path="/author/analytics"
        element={
          <RequireAuth>
            <AuthorAnalyticsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/author/channels"
        element={
          <RequireAuth>
            <AuthorChannelsPage />
          </RequireAuth>
        }
      />

      {/* Convenience redirects ---------------------------- */}
      <Route path="/stories" element={<Navigate to="/discover" replace />} />
      <Route path="/books" element={<Navigate to="/discover" replace />} />

      <Route path="*" element={<NotFoundPage />} />
    </>,
  ),
)

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ReaderPrefsProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </ReaderPrefsProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App
