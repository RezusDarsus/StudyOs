// Answer assembly for Copilot questions.
//
// Kept out of the component so the rules are testable on their own, and so the
// MULTI_SELECT contract is written down in one place rather than implied by JSX.

/**
 * Toggle one option in a multi-select list.
 *
 * Always called through a functional state update. Two taps landing in the same
 * React batch both read `prev`, so the second cannot overwrite the first — the
 * bug where rapidly picking Walking then Swimming submitted only one of them.
 * Selection order is preserved: people read their answer back and expect the
 * order they clicked.
 */
export function toggleOption(previous: readonly string[], option: string): string[] {
  return previous.includes(option)
    ? previous.filter((value) => value !== option)
    : [...previous, option];
}

/**
 * The final payload for a MULTI_SELECT question: every checked option, plus a
 * custom "Other" value if one was typed.
 *
 * The custom value is appended, never substituted — typing "Boxing" alongside
 * checked Walking and Swimming must send all three. Duplicates are dropped so
 * typing an option that is already checked cannot send it twice.
 */
export function buildMultiAnswer(selected: readonly string[], custom = ''): string[] {
  const extra = custom.trim();
  const values = extra ? [...selected, extra] : [...selected];
  return [...new Set(values)];
}

/** How an answer is echoed into the transcript. */
export function describeAnswer(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined) return '';
  return String(value);
}
