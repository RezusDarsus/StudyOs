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
  Zap,
} from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { CopilotProvider } from './copilot/CopilotProvider';
import { useAuth } from '../lib/auth';
import { NotificationsProvider, useNotifications } from '../lib/notifications';
import { ProgressBar } from './ui';

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
      className="hidden lg:flex flex-col h-full overflow-hidden"
      style={{ width: 256, minWidth: 256, background: '#ffffff', borderRight: '1px solid #e8e6f5' }}
    >
      <div className="p-5">
        <NavLink to="/app" className="flex items-center gap-2.5 mb-8">
          <div
            className="flex items-center justify-center rounded-xl"
            style={{
              width: 36,
              height: 36,
              background: 'linear-gradient(135deg, #7c3aed, #6d28d9)',
              boxShadow: '0 4px 12px rgba(124,58,237,0.4)',
            }}
          >
            <Zap size={18} fill="white" color="white" />
          </div>
          <span
            style={{
              fontFamily: 'Plus Jakarta Sans',
              fontWeight: 800,
              fontSize: '1.1rem',
              color: '#1a1635',
            }}
          >
            Goalify
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

      <div className="mt-auto p-5" style={{ borderTop: '1px solid #e8e6f5' }}>
        <div className="flex flex-col gap-0.5 mb-4">
          <NavLink
            to="/app/notifications"
            className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
          >
            <div className="relative">
              <Bell size={17} />
              {unread > 0 && (
                <span
                  className="absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full text-white"
                  style={{ width: 14, height: 14, fontSize: 9, fontWeight: 700, background: '#7c3aed' }}
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
                  background: '#f0ebff',
                  color: '#7c3aed',
                  fontSize: 11,
                  fontWeight: 700,
                  fontFamily: 'Plus Jakarta Sans',
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
          style={{ background: '#f5f4ff', border: '1px solid #e8e6f5' }}
        >
          <div
            className="relative flex-shrink-0 rounded-full flex items-center justify-center"
            style={{
              width: 38,
              height: 38,
              background: 'linear-gradient(135deg, #7c3aed, #a855f7)',
              fontSize: 17,
            }}
          >
            {user?.avatarEmoji ?? '🐱'}
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="truncate"
              style={{
                fontFamily: 'Plus Jakarta Sans',
                fontWeight: 700,
                fontSize: '0.85rem',
                color: '#1a1635',
              }}
            >
              {user?.name ?? 'You'}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className="flex-1">
                <ProgressBar value={user?.percent ?? 0} height={4} />
              </div>
              <span style={{ fontSize: 10, color: '#8b88b0', fontWeight: 700 }}>
                Lv.{user?.level ?? 1}
              </span>
            </div>
          </div>
          <ChevronRight size={14} style={{ color: '#b8b5d5' }} />
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
        background: 'rgba(255,255,255,0.95)',
        backdropFilter: 'blur(20px)',
        borderTop: '1px solid #e8e6f5',
        boxShadow: '0 -4px 20px rgba(124,58,237,0.08)',
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
                  background: isActive ? '#f0ebff' : 'transparent',
                  transition: 'background 0.18s',
                }}
              >
                <Icon size={19} style={{ color: isActive ? '#7c3aed' : '#8b88b0' }} />
              </div>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? '#7c3aed' : '#8b88b0',
                  fontFamily: 'Plus Jakarta Sans',
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
        background: 'rgba(255,255,255,0.95)',
        backdropFilter: 'blur(20px)',
        borderBottom: '1px solid #e8e6f5',
      }}
    >
      <NavLink to="/app" className="flex items-center gap-2">
        <div
          className="flex items-center justify-center rounded-lg"
          style={{ width: 30, height: 30, background: 'linear-gradient(135deg, #7c3aed, #6d28d9)' }}
        >
          <Zap size={15} fill="white" color="white" />
        </div>
        <span style={{ fontFamily: 'Plus Jakarta Sans', fontWeight: 800, color: '#1a1635' }}>
          Goalify
        </span>
      </NavLink>
      <div className="flex items-center gap-2">
      <NavLink
        to="/app/notifications"
        className="relative flex items-center justify-center rounded-xl"
        style={{ width: 38, height: 38, background: '#f5f4ff', border: '1px solid #e8e6f5' }}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        <Bell size={18} style={{ color: '#6b688f' }} />
        {unread > 0 && (
          <span
            className="absolute top-1 right-1 flex items-center justify-center rounded-full text-white"
            style={{ width: 15, height: 15, fontSize: 9, fontWeight: 700, background: '#7c3aed' }}
          >
            {unread}
          </span>
        )}
      </NavLink>
      <button
        className="flex items-center justify-center rounded-xl"
        style={{ width: 38, height: 38, background: '#f5f4ff', border: '1px solid #e8e6f5' }}
        aria-label="Log out"
        onClick={async () => {
          await logout();
          navigate('/');
        }}
      >
        <LogOut size={18} style={{ color: '#6b688f' }} />
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
        <div className="flex h-screen overflow-hidden" style={{ background: '#f5f4ff' }}>
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
