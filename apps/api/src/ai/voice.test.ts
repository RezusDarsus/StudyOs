import { describe, expect, it } from 'vitest';
import { isThirdPerson, toPluralVerb, toSecondPerson } from './voice.js';

// From a real generated plan the user rejected. Its rationale read: "User wants to
// read more fiction. They prefer 40-minute sessions, 6 days a week, e-books, and
// evening reading." That is a case note about somebody, shown to the somebody.

describe('spotting a plan written about the user', () => {
  it('recognises the rationale that prompted this', () => {
    expect(isThirdPerson('User wants to read more fiction.')).toBe(true);
    expect(isThirdPerson('The user prefers evenings.')).toBe(true);
    expect(isThirdPerson('This person is new to running.')).toBe(true);
  });

  it('leaves a plan that already speaks to the user alone', () => {
    const text = 'You said 40 minutes suits you, so that is where this starts.';
    expect(isThirdPerson(text)).toBe(false);
    expect(toSecondPerson(text)).toEqual({ text, changed: false });
  });
});

describe('rewriting it to speak to them', () => {
  it('fixes the exact rationale from the rejected plan', () => {
    const { text, changed } = toSecondPerson(
      'User wants to read more fiction. They prefer 40-minute sessions, 6 days a week.',
    );
    expect(changed).toBe(true);
    expect(text).toBe(
      'You want to read more fiction. You prefer 40-minute sessions, 6 days a week.',
    );
  });

  it('agrees the verb with "you"', () => {
    expect(toSecondPerson('The user enjoys fiction.').text).toBe('You enjoy fiction.');
    expect(toSecondPerson('The user is new to this.').text).toBe('You are new to this.');
    expect(toSecondPerson('The user has 40 minutes free.').text).toBe('You have 40 minutes free.');
    expect(toSecondPerson('The user tries most evenings.').text).toBe('You try most evenings.');
    expect(toSecondPerson('The user watches TV instead.').text).toBe('You watch TV instead.');
  });

  it('lower-cases "you" mid-sentence and capitalises it at the start', () => {
    expect(toSecondPerson('Evenings work because the user finishes late.').text).toBe(
      'Evenings work because you finish late.',
    );
  });

  it('turns a possessive into "your"', () => {
    expect(toSecondPerson("The user's evenings are free.").text).toBe('Your evenings are free.');
  });

  it('needs no conjugation for a past tense or a modal', () => {
    expect(toSecondPerson('The user said 40 minutes.').text).toBe('You said 40 minutes.');
    expect(toSecondPerson('The user can read in the evening.').text).toBe(
      'You can read in the evening.',
    );
  });

  it('would rather read as distant than as broken English', () => {
    // "always" ends in -s and is not a verb. Conjugating it would produce "You alway
    // reads", so this occurrence is left exactly as the model wrote it.
    const { text } = toSecondPerson('The user always reads at night.');
    expect(text).toBe('The user always reads at night.');
  });
});

describe('what it refuses to touch', () => {
  it('leaves third-person pronouns alone when nobody claimed they were the reader', () => {
    // "they" here is the kids. Rewriting it would corrupt a correct sentence, so the
    // whole rewrite only runs when the text says outright it is about the user.
    const text = 'Evenings suit you because the kids are asleep and they will not interrupt.';
    expect(toSecondPerson(text)).toEqual({ text, changed: false });
  });

  it('does nothing to an empty string', () => {
    expect(toSecondPerson('')).toEqual({ text: '', changed: false });
  });
});

describe('conjugating on its own', () => {
  it('drops the third-person -s', () => {
    expect(toPluralVerb('wants')).toBe('want');
    expect(toPluralVerb('reads')).toBe('read');
  });

  it('handles -ies, -es and the irregulars', () => {
    expect(toPluralVerb('studies')).toBe('study');
    expect(toPluralVerb('finishes')).toBe('finish');
    expect(toPluralVerb('does')).toBe('do');
    expect(toPluralVerb('was')).toBe('were');
  });

  it('passes through anything that is not a third-person form', () => {
    expect(toPluralVerb('must')).toBe('must');
    expect(toPluralVerb('walked')).toBe('walked');
  });

  it('declines rather than guess', () => {
    expect(toPluralVerb('always')).toBeNull();
    expect(toPluralVerb('progress')).toBeNull();
  });
});
