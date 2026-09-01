import { useState } from 'react';
import { Copy, Link2, RefreshCw, Share2, Trash2 } from 'lucide-react';
import { Modal, useToast } from './ui';
import { ApiError, api } from '../lib/api';

/**
 * Share a goal with anyone via a link — not just friends.
 *
 * The code is the grant: whoever holds it can join, even a stranger, even for a
 * private goal. So the modal says that plainly, and gives the owner a way to
 * rotate (kill the old link) or revoke it entirely.
 */
export default function ShareGoalModal({
  goalId,
  goalTitle,
  initialCode,
  open,
  onClose,
  onChanged,
}: {
  goalId: string;
  goalTitle: string;
  initialCode: string | null;
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { push } = useToast();
  const [code, setCode] = useState<string | null>(initialCode);
  const [busy, setBusy] = useState(false);

  const link = code ? `${window.location.origin}/join/${code}` : '';

  async function generate(rotating = false) {
    setBusy(true);
    try {
      const result = await api.post<{ code: string }>(`/goals/${goalId}/invite-code`);
      setCode(result.code);
      push(rotating ? 'New link created — the old one no longer works' : 'Invite link ready');
      onChanged?.();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not create a link', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm('Turn off this link? Anyone still holding it will not be able to join.'))
      return;
    setBusy(true);
    try {
      await api.del(`/goals/${goalId}/invite-code`);
      setCode(null);
      push('Invite link turned off');
      onChanged?.();
    } catch (err) {
      push(err instanceof ApiError ? err.message : 'Could not revoke', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      push(`${label} copied`);
    } catch {
      push('Could not copy — select and copy manually', 'error');
    }
  }

  async function nativeShare() {
    // Uses the OS share sheet where available (phones), so the link can go
    // straight into Messenger/WhatsApp without a manual copy-paste.
    if (navigator.share) {
      try {
        await navigator.share({ title: goalTitle, text: `Join me on "${goalTitle}"`, url: link });
        return;
      } catch {
        /* user dismissed the sheet — fall through to copy */
      }
    }
    copy(link, 'Link');
  }

  return (
    <Modal open={open} onClose={onClose} title={`Share "${goalTitle}"`}>
      {!code ? (
        <>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-body)', lineHeight: 1.6 }}>
            Create a link you can send to anyone — on Messenger, WhatsApp, anywhere. They
            don't need to be your friend on One Up to join.
          </p>
          <button
            className="btn-primary w-full mt-5 py-3 text-sm flex items-center justify-center gap-2"
            onClick={() => generate(false)}
            disabled={busy}
          >
            <Link2 size={15} /> {busy ? 'Creating…' : 'Create invite link'}
          </button>
        </>
      ) : (
        <>
          <label
            style={{
              fontSize: '0.8rem',
              fontWeight: 500,
              color: 'var(--text-body)',
              display: 'block',
              marginBottom: 6,
              fontFamily: 'var(--font-sans)',
            }}
          >
            Invite code
          </label>
          <button
            onClick={() => copy(code, 'Code')}
            className="w-full rounded-xl py-4 mb-3"
            style={{
              background: 'var(--surface-3)',
              border: '1px dashed var(--hairline-strong)',
              fontFamily: 'var(--font-mono)',
              fontWeight: 500,
              fontSize: '1.6rem',
              letterSpacing: '0.18em',
              color: 'var(--text)',
            }}
            title="Tap to copy the code"
          >
            {code}
          </button>

          <div className="flex gap-2 mb-4">
            <input
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 px-3.5 py-2.5 text-sm"
              aria-label="Invite link"
              style={{ fontSize: '0.78rem' }}
            />
            <button
              className="btn-secondary px-3.5 py-2.5 flex items-center gap-1.5 text-sm flex-shrink-0"
              onClick={() => copy(link, 'Link')}
            >
              <Copy size={14} /> Copy
            </button>
          </div>

          <button
            className="btn-primary w-full py-3 text-sm flex items-center justify-center gap-2 mb-4"
            onClick={nativeShare}
          >
            <Share2 size={15} /> Share link
          </button>

          <p
            className="px-3.5 py-3 rounded-xl mb-4"
            style={{
              background: 'var(--note-tint)',
              border: '1px solid var(--note-line)',
              fontSize: '0.78rem',
              color: 'var(--note-ink)',
              lineHeight: 1.5,
            }}
          >
            ⚠️ Anyone with this link can join and see this goal's tasks, participants and
            leaderboard. Turn it off or make a new one whenever you like.
          </p>

          <div className="flex gap-2">
            <button
              className="btn-ghost flex-1 py-2.5 text-sm flex items-center justify-center gap-1.5"
              onClick={() => generate(true)}
              disabled={busy}
            >
              <RefreshCw size={14} /> New link
            </button>
            <button
              className="btn-ghost flex-1 py-2.5 text-sm flex items-center justify-center gap-1.5"
              onClick={revoke}
              disabled={busy}
              style={{ color: 'var(--red)' }}
            >
              <Trash2 size={14} /> Turn off
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
