// Slash handling for every Copilot text input.
//
// A slash is ordinary text. People write "5/7 days", "walking/running", "30/08"
// and "I work/study at night", and every one of those must survive untouched all
// the way to the backend.
//
// So the rule is deliberately narrow: a message is a command ONLY if it starts
// with "/" AND its first token is in the allowlist below. Anything else — an
// unknown command, a slash in the middle, a bare "/" — is plain text. That is
// the opposite of the usual "starts with / therefore command" shortcut, which is
// what silently swallowed real answers.

/** The only tokens that mean anything. Everything else is text. */
export const SLASH_COMMANDS = ['help', 'new', 'clear'] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number];

export type ParsedInput =
  | { kind: 'command'; command: SlashCommand; args: string }
  | { kind: 'text'; text: string };

/**
 * Decide whether some typed input is a command or ordinary text.
 *
 * Never mutates the text it returns beyond trimming the outer whitespace — in
 * particular it never strips a slash.
 */
export function parseInput(raw: string): ParsedInput {
  const text = raw.trim();

  if (text.startsWith('/')) {
    // Only the FIRST token is eligible, and only if the allowlist knows it.
    // "/help me plan my week" is the /help command; "/random" is just text.
    const [head, ...rest] = text.slice(1).split(/\s+/);
    const candidate = head.toLowerCase();
    if ((SLASH_COMMANDS as readonly string[]).includes(candidate)) {
      return { kind: 'command', command: candidate as SlashCommand, args: rest.join(' ') };
    }
  }

  return { kind: 'text', text };
}

/**
 * Whether the Send button should be live.
 *
 * Any non-empty trimmed string qualifies, including a lone "/". The backend
 * accepts single characters too, so the button and the API agree — a disabled
 * button that gives no reason is worse than a short message that gets a reply.
 */
export function canSubmit(raw: string): boolean {
  return raw.trim().length > 0;
}

/** Shown when someone sends /help. */
export const SLASH_HELP = [
  'You can just talk to me normally — slashes in your text are fine ("5/7 days" works).',
  'A few shortcuts: /new starts a fresh goal, /clear empties this conversation, /help shows this.',
].join('\n');
