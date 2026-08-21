import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import CopilotWidget from './CopilotWidget';
import { api } from '../../lib/api';

/** Which conversation the widget should show. */
export type CopilotTarget =
  | { view: 'home' }
  | { view: 'create'; seed?: string; sessionId?: string }
  | { view: 'goal'; goalId: string; goalTitle: string }
  | { view: 'help' };

interface CopilotContextValue {
  isOpen: boolean;
  open(target?: CopilotTarget): void;
  close(): void;
  /** The goal the user is currently looking at, if any. */
  pageGoal: { id: string; title: string } | null;
  setPageGoal(goal: { id: string; title: string } | null): void;
}

const CopilotContext = createContext<CopilotContextValue | null>(null);

/**
 * Routes where a floating Copilot would be redundant or confusing: the full-page
 * interview and the draft review screen are already Copilot surfaces, and running
 * two interviews side by side would let a user answer one question twice.
 */
function isCopilotSurface(pathname: string) {
  return pathname.startsWith('/app/goals/new/ai') || pathname.startsWith('/app/goals/drafts/');
}

/**
 * Mounts the floating Copilot for signed-in screens.
 *
 * This provider lives inside the authenticated shell, which is what keeps the
 * widget off the landing, login and register pages — there is no signed-in user
 * there to coach, and no session cookie to call the API with.
 */
export function CopilotProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [isOpen, setIsOpen] = useState(false);
  const [target, setTarget] = useState<CopilotTarget>({ view: 'home' });
  const [pageGoal, setPageGoal] = useState<{ id: string; title: string } | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  // Asked once per session. A server without an AI provider configured should not
  // show a button that can only ever fail.
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ enabled: boolean }>('/copilot/status')
      .then((status) => {
        if (!cancelled) setEnabled(status.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const open = useCallback((next?: CopilotTarget) => {
    if (next) setTarget(next);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  const value = useMemo(
    () => ({ isOpen, open, close, pageGoal, setPageGoal }),
    [isOpen, open, close, pageGoal],
  );

  const hidden = isCopilotSurface(pathname);

  return (
    <CopilotContext.Provider value={value}>
      {children}
      {enabled && !hidden && (
        <CopilotWidget
          isOpen={isOpen}
          target={target}
          pageGoal={pageGoal}
          onChangeTarget={setTarget}
          onOpen={() => setIsOpen(true)}
          onClose={close}
        />
      )}
    </CopilotContext.Provider>
  );
}

export function useCopilot() {
  const ctx = useContext(CopilotContext);
  if (!ctx) throw new Error('useCopilot must be used inside CopilotProvider');
  return ctx;
}

/**
 * Tells the widget which goal the user is looking at, so its home screen can
 * offer to talk about that goal instead of asking which one.
 */
export function useCopilotGoalContext(goal: { id: string; title: string } | null) {
  const { setPageGoal } = useCopilot();
  const id = goal?.id ?? null;
  const title = goal?.title ?? null;

  useEffect(() => {
    setPageGoal(id && title ? { id, title } : null);
    return () => setPageGoal(null);
  }, [id, title, setPageGoal]);
}
