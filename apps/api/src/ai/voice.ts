// How a plan speaks to the person reading it.
//
// A generated plan is shown to the user, not to an operator. "The user wants to read
// more fiction. They prefer 40-minute sessions" is a case note about someone, and
// reading a case note about yourself is a small but real breach of the thing this
// feature is for.
//
// The prompt asks for second person. This runs afterwards because the prompt is not
// a guarantee, and the alternative — putting the rule in the Zod schema — costs the
// user their plan: ai/client.ts allows exactly one corrective retry and then throws,
// so a pronoun would be enough to lose a plan somebody waited half a minute for.
// Rewriting is cheap and reversible; rejecting is not.

/**
 * Words ending in -s that are not third-person verbs.
 *
 * "The user always reads" would otherwise be conjugated at "always" and come back as
 * "You alway reads". The list only needs to cover words that can directly follow a
 * subject, which is a small closed set of adverbs — every English modal and every
 * base-form verb is already safe.
 */
const NOT_A_VERB = new Set([
  'always',
  'sometimes',
  'perhaps',
  'thus',
  'nevertheless',
  'besides',
  'regardless',
  'unless',
  'afterwards',
  'towards',
  'upwards',
  'downwards',
  'sideways',
  'anyways',
  'nowadays',
  'often',
  'less',
  'plus',
  'this',
  'his',
  'hers',
  'its',
  'yes',
]);

/** Third-person singular verbs that do not follow the -s rules. */
const IRREGULAR: Record<string, string> = {
  is: 'are',
  was: 'were',
  has: 'have',
  does: 'do',
  goes: 'go',
  says: 'say',
};

/**
 * Turn a third-person singular verb into the form that follows "you".
 *
 * Returns null when the word cannot be conjugated with confidence — the caller then
 * leaves the whole phrase alone rather than emitting "You wants". A sentence in the
 * wrong person is a flaw; a sentence in broken English is worse, so the ambiguous
 * case declines to act.
 */
export function toPluralVerb(word: string): string | null {
  const lower = word.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower];
  // Not a third-person form at all: past tense, a modal, a base form after "to".
  // Already correct after "you", so nothing to do.
  if (!lower.endsWith('s')) return word;
  if (NOT_A_VERB.has(lower)) return null;
  // "his", "focus", "progress" — a trailing -ss or -us is not an inflection.
  if (lower.endsWith('ss') || lower.endsWith('us')) return null;
  if (lower.endsWith('ies') && lower.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ss|sh|ch|x|z|o)es$/.test(lower)) return word.slice(0, -2);
  return word.slice(0, -1);
}

/**
 * A reference to the reader written as though they were not reading.
 *
 * "user" on its own counts: in a goal-planning app the word has no other referent,
 * and the run that prompted this opened its rationale with "User wants to read more".
 */
const SUBJECT_REFERENCE = /\b(the users?|users?|this person|the person)\b([ \t]+)([A-Za-z']+)?/gi;
// The apostrophe-s alternative is tried first on purpose: matching a bare "user'"
// inside "the user's" leaves the s behind, which reads as "Yours evenings are free".
const POSSESSIVE_REFERENCE = /\b(?:the |this )?(?:users?|person)(?:'s|s'|')/gi;

/** Does this text talk about the reader in the third person at all? */
export function isThirdPerson(text: string): boolean {
  return /\b(?:the users?|users?|this person|the person)\b/i.test(text);
}

function startsSentence(text: string, offset: number): boolean {
  const before = text.slice(0, offset).trimEnd();
  if (before.length === 0) return true;
  return /[.!?:\n]$/.test(before);
}

/**
 * Rewrite a plan's prose to address the user directly.
 *
 * Only runs at all when the text refers to the user in the third person. That guard
 * is what makes rewriting "they" safe: a rationale can legitimately say "your kids
 * are asleep, so they will not interrupt", and nothing in that sentence claims to be
 * about the reader, so nothing in it is touched.
 */
export function toSecondPerson(text: string): { text: string; changed: boolean } {
  if (!isThirdPerson(text)) return { text, changed: false };

  let changed = false;

  let out = text.replace(POSSESSIVE_REFERENCE, (match, offset: number) => {
    changed = true;
    return startsSentence(text, offset) ? 'Your' : 'your';
  });

  out = out.replace(SUBJECT_REFERENCE, (match, _ref, gap: string, next: string | undefined, offset: number, whole: string) => {
    const verb = next === undefined ? null : toPluralVerb(next);
    // Could not conjugate what follows, so leave the phrase as it stands. Third
    // person reads as distant; "You wants" reads as broken.
    if (next !== undefined && verb === null) return match;
    changed = true;
    const you = startsSentence(whole, offset) ? 'You' : 'you';
    return next === undefined ? `${you}${gap}` : `${you}${gap}${verb}`;
  });

  // Safe only because of the third-person guard above: something in this text was
  // already talking about the reader, so its pronouns are about the reader too.
  if (changed) {
    out = out
      .replace(/\bthemselves\b/g, 'yourself')
      .replace(/\bTheir\b/g, 'Your')
      .replace(/\btheir\b/g, 'your')
      .replace(/\bThey\b/g, 'You')
      .replace(/\bthey\b/g, 'you')
      .replace(/\bThem\b/g, 'You')
      .replace(/\bthem\b/g, 'you');
  }

  return { text: out, changed };
}
