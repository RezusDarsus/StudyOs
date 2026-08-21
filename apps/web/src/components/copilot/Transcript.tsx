import { useEffect, useRef } from 'react';
import type { Bubble } from '../../lib/useCopilotInterview';

/**
 * The conversation so far.
 *
 * Shared by the full-page builder and the floating widget so the two surfaces
 * cannot drift apart visually. `maxHeight` is the only thing they disagree on.
 */
export default function Transcript({
  bubbles,
  busy,
  maxHeight,
  thinkingLabel = 'Thinking about the best next question…',
  className = 'card shadow-card flex-1 p-4 sm:p-5 overflow-y-auto',
}: {
  bubbles: Bubble[];
  busy: boolean;
  maxHeight?: string | number;
  thinkingLabel?: string;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [bubbles, busy]);

  return (
    <div
      ref={scrollRef}
      className={className}
      style={maxHeight ? { maxHeight } : undefined}
      // Announced politely: a screen reader hears each new message without
      // having the focus yanked out of the answer input.
      aria-live="polite"
      aria-label="Copilot conversation"
    >
      <div className="flex flex-col gap-3">
        {bubbles.map((bubble, index) => (
          <div
            key={index}
            className={bubble.role === 'user' ? 'self-end' : 'self-start'}
            style={{ maxWidth: '86%' }}
          >
            <div
              className="px-3.5 py-2.5 rounded-2xl animate-slide-up"
              style={{
                background: bubble.role === 'user' ? '#7c3aed' : '#f5f4ff',
                color: bubble.role === 'user' ? '#fff' : '#1a1635',
                border: bubble.role === 'user' ? 'none' : '1px solid #e8e6f5',
                fontSize: '0.88rem',
                lineHeight: 1.55,
                borderBottomRightRadius: bubble.role === 'user' ? 6 : 16,
                borderBottomLeftRadius: bubble.role === 'user' ? 16 : 6,
                whiteSpace: 'pre-wrap',
              }}
            >
              {bubble.text}
            </div>
          </div>
        ))}

        {busy && (
          <div className="self-start">
            <div
              className="px-3.5 py-2.5 rounded-2xl flex items-center gap-1.5"
              style={{ background: '#f5f4ff', border: '1px solid #e8e6f5' }}
            >
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="rounded-full animate-float"
                  style={{
                    width: 6,
                    height: 6,
                    background: '#b8b5d5',
                    animationDelay: `${i * 0.15}s`,
                    animationDuration: '1s',
                  }}
                />
              ))}
              <span style={{ fontSize: '0.78rem', color: '#8b88b0', marginLeft: 4 }}>
                {thinkingLabel}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
