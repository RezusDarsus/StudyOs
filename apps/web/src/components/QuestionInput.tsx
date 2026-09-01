import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { buildMultiAnswer, describeAnswer, toggleOption } from '../lib/answers';
import { canSubmit } from '../lib/slash';
import { WEEKDAY_LABEL, type CopilotQuestion } from '../lib/types';

export type AnswerHandler = (value: unknown, label: string, skipped?: boolean) => void;

/**
 * Renders whichever input a Copilot question calls for.
 *
 * Shared by the full-page interview and the floating widget: the model returns
 * structured question data and the frontend picks from these known components,
 * so the AI can never hand us arbitrary UI to render. `compact` only tightens
 * spacing — behaviour is identical in both surfaces.
 */
export default function QuestionInput({
  question,
  disabled,
  onAnswer,
  compact = false,
}: {
  question: CopilotQuestion;
  disabled: boolean;
  onAnswer: AnswerHandler;
  compact?: boolean;
}) {
  const [multi, setMulti] = useState<string[]>([]);
  const [text, setText] = useState('');

  // A new question means a fresh input.
  useEffect(() => {
    setMulti([]);
    setText('');
  }, [question.id]);

  const shell = compact ? 'p-3' : 'card shadow-card p-4';

  const chip = (active: boolean) => ({
    background: active ? 'var(--surface-3)' : 'var(--surface)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--hairline)'}`,
    color: active ? 'var(--text)' : 'var(--text-body)',
    fontWeight: 500,
    fontSize: compact ? '0.8rem' : '0.85rem',
    fontFamily: 'var(--font-sans)',
    minHeight: 44,
  });

  const skip = question.optional ? (
    <button
      className="btn-ghost px-4 py-2.5 text-sm"
      onClick={() => onAnswer(null, 'Skipped', true)}
      disabled={disabled}
    >
      Skip
    </button>
  ) : null;

  if (question.type === 'SINGLE_SELECT' || question.type === 'MULTI_SELECT') {
    const isMulti = question.type === 'MULTI_SELECT';
    // For multi-select the custom value joins the checked options rather than
    // replacing them, so this has to consider both.
    const pending = isMulti ? buildMultiAnswer(multi, text) : [];
    const canContinue = pending.length > 0;

    const submitMulti = () => {
      if (pending.length === 0) return;
      onAnswer(pending, describeAnswer(pending));
    };

    return (
      <div className={shell}>
        <div className="flex flex-wrap gap-2">
          {(question.options ?? []).map((option) => {
            const active = multi.includes(option);
            return (
              <button
                key={option}
                aria-pressed={isMulti ? active : undefined}
                disabled={disabled}
                onClick={() => {
                  if (!isMulti) return onAnswer(option, option);
                  // Functional update: two taps landing in one React batch both
                  // read `prev`, so the second cannot drop the first.
                  setMulti((prev) => toggleOption(prev, option));
                }}
                className="px-4 py-2.5 rounded-xl"
                style={chip(isMulti && active)}
              >
                {option}
              </button>
            );
          })}
        </div>

        {question.allowCustomAnswer && (
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // Enter used to submit only the typed word, silently discarding
              // whatever the user had already checked.
              if (isMulti) return submitMulti();
              if (canSubmit(text)) onAnswer(text.trim(), text.trim());
            }}
            placeholder={isMulti ? 'Other — add your own…' : 'Or type your own…'}
            className="w-full px-4 py-2.5 text-sm mt-3"
            disabled={disabled}
            aria-label="Other answer"
          />
        )}

        <div className="flex gap-2 mt-3">
          {skip}
          {isMulti && (
            <button
              className="btn-primary flex-1 py-2.5 text-sm"
              disabled={disabled || !canContinue}
              style={{ opacity: disabled || !canContinue ? 0.5 : 1 }}
              onClick={submitMulti}
            >
              Continue{pending.length > 1 ? ` (${pending.length})` : ''}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (question.type === 'DAYS_OF_WEEK') {
    return (
      <div className={shell}>
        <div className="flex gap-1.5 flex-wrap">
          {WEEKDAY_LABEL.map((label) => {
            const active = multi.includes(label);
            return (
              <button
                key={label}
                aria-pressed={active}
                disabled={disabled}
                onClick={() => setMulti((prev) => toggleOption(prev, label))}
                className="rounded-xl"
                style={{ ...chip(active), width: compact ? 44 : 52 }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="flex gap-2 mt-3">
          {skip}
          <button
            className="btn-primary flex-1 py-2.5 text-sm"
            disabled={disabled || multi.length === 0}
            style={{ opacity: disabled || multi.length === 0 ? 0.5 : 1 }}
            onClick={() => onAnswer(multi, describeAnswer(multi))}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  // NUMBER is deliberately NOT type="number". A number input silently discards any
  // value the browser cannot parse — typing "5/7" leaves the field empty with
  // badInput false, so `canSubmit` never sees the text and Send stays greyed out with
  // nothing to explain why. inputMode still brings up the numeric keypad on a phone.
  const numeric = question.type === 'NUMBER';
  const inputType = numeric
    ? 'text'
    : question.type === 'DATE'
      ? 'date'
      : question.type === 'TIME'
        ? 'time'
        : 'text';

  return (
    <div className={shell}>
      <div className="flex gap-2">
        <input
          type={inputType}
          inputMode={numeric ? 'decimal' : undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder={
            question.type === 'FREE_TEXT'
              ? 'Type your answer…'
              : numeric
                ? 'A number, or say it in your own words…'
                : ''
          }
          className="flex-1 px-4 py-3 text-sm"
          disabled={disabled}
          autoFocus={!compact}
          aria-label={question.prompt}
        />
        <button
          className="btn-primary px-4 flex items-center justify-center"
          onClick={submit}
          disabled={disabled || !canSubmit(text)}
          style={{ opacity: disabled || !canSubmit(text) ? 0.5 : 1 }}
          aria-label="Send answer"
        >
          <Send size={16} />
        </button>
      </div>
      {skip && <div className="mt-3">{skip}</div>}
    </div>
  );

  function submit() {
    // Any non-empty answer goes through verbatim. "5/7", "walking/running" and a
    // lone "/" are all legitimate answers, so nothing is stripped or rejected.
    if (!canSubmit(text)) return;
    const trimmed = text.trim();
    // Send a number only when the whole answer is one. "5/7" and "about 40" are
    // answers to a NUMBER question too, and Number() turns both into NaN, which
    // reaches the backend as null — the answer would vanish rather than be read.
    const asNumber = Number(trimmed);
    const value = numeric && trimmed !== '' && Number.isFinite(asNumber) ? asNumber : trimmed;
    onAnswer(value, trimmed);
  }
}
