import {
  Bell,
  ChevronRight,
  Compass,
  Gift,
  Home,
  LogOut,
  Target,
  Trophy,
  User,
  Users,
} from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { CopilotProvider } from './copilot/CopilotProvider';
import { useAuth } from '../lib/auth';
import { NotificationsProvider, useNotifications } from '../lib/notifications';
import { ProgressBar, UpMarker } from './ui';

const navItems = [
  { icon: Home, label: 'Home', to: '/app' },
  { icon: Target, label: 'My Goals', to: '/app/goals' },
  { icon: Compass, label: 'Discover', to: '/app/discover' },
  { icon: Users, label: 'Friends', to: '/app/friends' },
  { icon: Trophy, label: 'Leaderboard', to: '/app/leaderboard' },
  { icon: Gift, label: 'Rewards', to: '/app/rewards' },
];

const mobileTabs = [
  { icon: Home, label: 'Home', to: '/app' },
  { icon: Target, label: 'Goals', to: '/app/goals' },
  { icon: Compass, label: 'Discover', to: '/app/discover' },
  { icon: Users, label: 'Friends', to: '/app/friends' },
  { icon: User, label: 'Profile', to: '/app/profile' },
];

function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  // Both this and the mobile header read the one shared count, so the two badges can never
  // disagree, and both update the moment a notification arrives rather than on next load.
  const { unread } = useNotifications();

  return (
    <aside
      className="app-sidebar hidden lg:flex flex-col h-full overflow-hidden"
    >
      <div className="p-5">
        <NavLink to="/app" className="flex items-center gap-2.5 mb-8 brand-link">
          <UpMarker size={36} />
          <span
            style={{
              fontFamily: 'var(--font-sans)',
              fontWeight: 600,
              fontSize: '1.1rem',
              color: 'var(--text)',
            }}
          >
            One Up
          </span>
        </NavLink>

        <nav className="flex flex-col gap-0.5">
          {navItems.map(({ icon: Icon, label, to }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/app'}
              className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon size={17} />
              {label}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="mt-auto p-5" style={{ borderTop: '1px solid var(--hairline)' }}>
        <div className="flex flex-col gap-0.5 mb-4">
          <NavLink
            to="/app/notifications"
            className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
          >
            <div className="relative">
              <Bell size={17} />
              {unread > 0 && (
                <span
                  className="absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full"
                  style={{ width: 14, height: 14, fontSize: 9, fontWeight: 500, background: 'var(--accent)', color: 'var(--accent-ink)' }}
                >
                  {unread}
                </span>
              )}
            </div>
            Notifications
            {unread > 0 && (
              <span
                className="ml-auto rounded-full px-1.5 py-0.5"
                style={{
                  background: 'var(--surface-3)',
                  color: 'var(--text)',
                  fontSize: 11,
                  fontWeight: 500,
                  fontFamily: 'var(--font-sans)',
                }}
              >
                {unread}
              </span>
            )}
          </NavLink>

          <NavLink
            to="/app/profile"
            className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
          >
            <User size={17} />
            Profile
          </NavLink>

          <button
            className="sidebar-nav-item"
            onClick={async () => {
              await logout();
              navigate('/');
            }}
          >
            <LogOut size={17} />
            Log out
          </button>
        </div>

        <NavLink
          to="/app/profile"
          className="w-full flex items-center gap-3 p-3 rounded-xl transition-all"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
        >
          <div
            className="relative flex-shrink-0 rounded-full flex items-center justify-center"
            style={{
              width: 38,
              height: 38,
              background: 'var(--surface-3)',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {(user?.name ?? 'You').slice(0, 2).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="truncate"
              style={{
                fontFamily: 'var(--font-sans)',
                fontWeight: 500,
                fontSize: '0.85rem',
                color: 'var(--text)',
              }}
            >
              {user?.name ?? 'You'}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className="flex-1">
                <ProgressBar value={user?.percent ?? 0} height={4} />
              </div>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 500 }}>
                Lv.{user?.level ?? 1}
              </span>
            </div>
          </div>
          <ChevronRight size={14} style={{ color: 'var(--text-faint)' }} />
        </NavLink>
      </div>
    </aside>
  );
}

function MobileNav() {
  return (
    <nav
      className="lg:hidden fixed bottom-0 left-0 right-0 flex items-center z-50"
      style={{
        background: 'rgba(246,245,238,0.88)',
        backdropFilter: 'blur(20px)',
        borderTop: '1px solid var(--hairline)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      aria-label="Main"
    >
      {mobileTabs.map(({ icon: Icon, label, to }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/app'}
          // 44px+ touch target, single tap to switch section.
          className="flex-1 flex flex-col items-center gap-1 py-3"
        >
          {({ isActive }) => (
            <>
              <div
                className="flex items-center justify-center rounded-xl"
                style={{
                  width: 32,
                  height: 32,
                  background: isActive ? 'var(--surface-3)' : 'transparent',
                  transition: 'background 0.18s',
                }}
              >
                <Icon size={19} style={{ color: isActive ? 'var(--text)' : 'var(--text-muted)' }} />
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: isActive ? 500 : 400,
                  color: isActive ? 'var(--text)' : 'var(--text-muted)',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                {label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

/** Mobile-only top bar, so the logo and notifications stay reachable. */
function MobileHeader() {
  const { unread } = useNotifications();
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <header
      className="lg:hidden sticky top-0 z-40 flex items-center justify-between px-4 py-3"
      style={{
        background: 'rgba(246,245,238,0.88)',
        backdropFilter: 'blur(20px)',
        borderBottom: '1px solid var(--hairline)',
      }}
    >
      <NavLink to="/app" className="flex items-center gap-2">
        <UpMarker size={30} />
        <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, color: 'var(--text)' }}>
          One Up
        </span>
      </NavLink>
      <div className="flex items-center gap-2">
      <NavLink
        to="/app/notifications"
        className="relative flex items-center justify-center rounded-xl"
        style={{ width: 38, height: 38, background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        <Bell size={18} style={{ color: 'var(--text-body)' }} />
        {unread > 0 && (
          <span
            className="absolute top-1 right-1 flex items-center justify-center rounded-full"
            style={{ width: 15, height: 15, fontSize: 9, fontWeight: 500, background: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            {unread}
          </span>
        )}
      </NavLink>
      <button
        className="flex items-center justify-center rounded-xl"
        style={{ width: 38, height: 38, background: 'var(--surface-2)', border: '1px solid var(--hairline)' }}
        aria-label="Log out"
        onClick={async () => {
          await logout();
          navigate('/');
        }}
      >
        <LogOut size={18} style={{ color: 'var(--text-body)' }} />
      </button>
      </div>
    </header>
  );
}

export default function AppShell() {
  return (
    // Inside the authenticated shell, which is what keeps the socket off the landing, login
    // and register pages: there is no session cookie to authenticate a connection there.
    <NotificationsProvider>
      <CopilotProvider>
        <div className="app-frame flex h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0">
            <MobileHeader />
            <main className="flex-1 overflow-y-auto min-w-0 pb-24 lg:pb-0" id="main">
              <Outlet />
            </main>
          </div>
          <MobileNav />
        </div>
      </CopilotProvider>
    </NotificationsProvider>
  );
}
