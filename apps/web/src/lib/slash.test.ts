import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS, canSubmit, parseInput } from './slash';

// Part 5 of the Phase 2.5 plan. A slash is text unless it opens an allowlisted
// command, and nothing may ever be stripped.

describe('parseInput — a slash is ordinary text', () => {
  const plainText = [
    '/',
    'hello/world',
    '5/7',
    '5/7 days',
    'walking/running',
    '30/08',
    'I work/study at night',
    'https://example.com',
    'text/',
    '/random',
    '/unknown',
    'I can exercise 5/7 days and prefer walking/swimming.',
  ];

  for (const input of plainText) {
    it(`treats ${JSON.stringify(input)} as text and preserves it verbatim`, () => {
      const parsed = parseInput(input);
      expect(parsed.kind).toBe('text');
      // The exact characters survive — no slash stripping, no escaping.
      expect(parsed.kind === 'text' && parsed.text).toBe(input.trim());
    });
  }

  it('keeps every slash in a mixed sentence', () => {
    const parsed = parseInput('  I can exercise 5/7 days and prefer walking/swimming.  ');
    expect(parsed.kind === 'text' && parsed.text).toBe(
      'I can exercise 5/7 days and prefer walking/swimming.',
    );
  });

  it('does not treat an unknown command as a failed command', () => {
    // The old shortcut ("starts with / therefore command") silently swallowed
    // these. They must round-trip as text instead.
    expect(parseInput('/random')).toEqual({ kind: 'text', text: '/random' });
  });
});

describe('parseInput — allowlisted commands', () => {
  for (const command of SLASH_COMMANDS) {
    it(`recognises /${command}`, () => {
      expect(parseInput(`/${command}`)).toEqual({ kind: 'command', command, args: '' });
    });
  }

  it('is case-insensitive on the command token', () => {
    expect(parseInput('/HELP')).toEqual({ kind: 'command', command: 'help', args: '' });
  });

  it('carries the rest of the line as arguments', () => {
    expect(parseInput('/new I want to read more')).toEqual({
      kind: 'command',
      command: 'new',
      args: 'I want to read more',
    });
  });

  it('only considers the first token', () => {
    // A slash later in the line is content, even when it spells a real command.
    expect(parseInput('what about /help')).toEqual({ kind: 'text', text: 'what about /help' });
  });
});

describe('canSubmit', () => {
  it('enables send for any non-empty trimmed text, including a lone slash', () => {
    for (const value of ['/', 'a', '5/7', '  x  ']) {
      expect(canSubmit(value)).toBe(true);
    }
  });

  it('stays disabled for empty and whitespace-only input', () => {
    for (const value of ['', '   ', '\n\t']) {
      expect(canSubmit(value)).toBe(false);
    }
  });
});
