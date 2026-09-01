import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/AppShell';
import { ToastProvider, UpMarker } from './components/ui';
import { AuthProvider, useAuth } from './lib/auth';
const Landing = lazy(() => import('./pages/Landing'));
const Auth = lazy(() => import('./pages/Auth'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const MyGoals = lazy(() => import('./pages/MyGoals'));
const CreateGoal = lazy(() => import('./pages/CreateGoal'));
const GoalDetail = lazy(() => import('./pages/GoalDetail'));
const Discover = lazy(() => import('./pages/Discover'));
const Friends = lazy(() => import('./pages/Friends'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Profile = lazy(() => import('./pages/Profile'));
const Rewards = lazy(() => import('./pages/Rewards'));
const JoinByCode = lazy(() => import('./pages/JoinByCode'));
const CreateGoalChoice = lazy(() => import('./pages/CreateGoalChoice'));
const CopilotInterview = lazy(() => import('./pages/CopilotInterview'));
const DraftReview = lazy(() => import('./pages/DraftReview'));
const ProductShowcase = lazy(() => import('./pages/ProductShowcase'));

function FullPageSpinner() {
  return (
    <div className="flex items-center justify-center h-screen" style={{ background: 'var(--bg)' }}>
      <div
        className="app-loading-mark"
        role="status"
        aria-label="Loading"
      >
        <UpMarker size={40} />
        <span>Loading your next step…</span>
      </div>
    </div>
  );
}

/** Gate for everything behind sign-in. */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Signed-in users should not sit on the landing or auth screens. */
function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (user) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Suspense fallback={<FullPageSpinner />}><Routes>
            {(window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost') && (
              <Route path="/__showcase/product" element={<ProductShowcase />} />
            )}
            <Route path="/" element={<RedirectIfAuthed><Landing /></RedirectIfAuthed>} />
            <Route path="/login" element={<RedirectIfAuthed><Auth mode="login" /></RedirectIfAuthed>} />
            <Route path="/register" element={<RedirectIfAuthed><Auth mode="register" /></RedirectIfAuthed>} />

            {/* Public: a shared invite link must open for signed-out visitors too. */}
            <Route path="/join/:code" element={<JoinByCode />} />

            <Route path="/app" element={<RequireAuth><AppShell /></RequireAuth>}>
              <Route index element={<Dashboard />} />
              <Route path="goals" element={<MyGoals />} />
              {/* Manual creation stays reachable on its own path — AI is optional. */}
              <Route path="goals/new" element={<CreateGoalChoice />} />
              <Route path="goals/new/manual" element={<CreateGoal />} />
              <Route path="goals/new/ai" element={<CopilotInterview />} />
              <Route path="goals/new/ai/:sessionId" element={<CopilotInterview />} />
              <Route path="goals/drafts/:id" element={<DraftReview />} />
              <Route path="goals/:id" element={<GoalDetail />} />
              <Route path="discover" element={<Discover />} />
              <Route path="friends" element={<Friends />} />
              <Route path="leaderboard" element={<Leaderboard />} />
              <Route path="notifications" element={<Notifications />} />
              <Route path="profile" element={<Profile />} />
              <Route path="profile/:id" element={<Profile />} />
              <Route path="rewards" element={<Rewards />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes></Suspense>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
