import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './components/providers/AuthProvider'
import { ReaderPrefsProvider } from './components/providers/ReaderPrefsProvider'
import { ThemeProvider } from './components/providers/ThemeProvider'
import { ToastProvider } from './components/ui/ToastProvider'
import { RequireAuth } from './components/RequireAuth'

import { LandingPage } from './pages/LandingPage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { OnboardingPage } from './pages/OnboardingPage'
import { ForWritersPage } from './pages/ForWritersPage'
import { HomePage } from './pages/HomePage'
import { DiscoverPage } from './pages/DiscoverPage'
import { StoryDetailPage } from './pages/StoryDetailPage'
import { ReaderPage } from './pages/ReaderPage'
import { LibraryPage } from './pages/LibraryPage'
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

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ReaderPrefsProvider>
          <ToastProvider>
            <BrowserRouter>
              <Routes>
                {/* Public ------------------------------------------- */}
                <Route path="/" element={<LandingPage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/onboarding" element={<OnboardingPage />} />
                <Route path="/for-writers" element={<ForWritersPage />} />

                {/* Browsing is open; reading a chapter is too. -------- */}
                <Route path="/discover" element={<DiscoverPage />} />
                <Route path="/story/:slug" element={<StoryDetailPage />} />
                <Route path="/read/:slug/:chapter" element={<ReaderPage />} />
                <Route path="/clubs" element={<ClubsPage />} />
                <Route path="/clubs/:slug" element={<ClubDetailPage />} />
                <Route path="/challenges" element={<ChallengesPage />} />
                <Route path="/challenges/:slug" element={<ChallengeDetailPage />} />
                <Route path="/channels" element={<ChannelsPage />} />
                <Route path="/channels/:slug" element={<ChannelDetailPage />} />
                <Route path="/profile/:username" element={<ProfilePage />} />

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
                      <LibraryPage />
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

                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </BrowserRouter>
          </ToastProvider>
        </ReaderPrefsProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App
