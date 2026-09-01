import { z } from 'zod';

/**
 * Stage 3 — the generic runtime-knowledge port.
 *
 * This module is the only thing the Copilot core imports for domain knowledge,
 * and it knows nothing about any domain. It exposes exactly two mechanics —
 * keyed phrase lexicons and keyed question packs — over opaque, open role ids.
 * Domain names live in the DATA packs that feed the port, never here.
 *
 * Two identifier worlds, deliberately separate:
 *
 *   RuntimeRoleId / RuntimeDomainId — OPEN. Any pack may introduce new values.
 *     Nothing in core enumerates them, and none may. Consumers either use them
 *     opaquely or pass them through one of the three generic compatibility
 *     filters (GoalCategory, QuestionTopic, SemanticTaskRole), each a single
 *     membership check written once and domain-blind. A role that fails a
 *     filter is ignored by that consumer — never persisted, never a contract
 *     key, never an error.
 *
 *   The closed unions — persisted/product values and mechanic keys. They are
 *     closed because database rows and contract codes depend on them.
 *
 * Caching: everything compiled lives INSIDE the constructed port object
 * (immutable after build). `setRuntimeKnowledge` swaps the whole object, so a
 * replacement port can never inherit stale compiled data from its predecessor;
 * per-consumer memoization is keyed on the port instance (WeakMap), which
 * makes staleness structurally impossible without versioning machinery.
 */

/** Opaque, open role id — the value side of runtime data. */
export type RuntimeRoleId = string;
/** Opaque, open domain id (a role within the goal-domain lexical family). */
export type RuntimeDomainId = string;

/** One phrase in a keyed lexicon. */
export interface RuntimeLexiconEntry {
  /** A literal word/phrase (`match: 'word'`) or a regex source (`match: 'pattern'`). */
  readonly phrase: string;
  /** Opaque consumer id (a category value, topic id, domain id, label). */
  readonly role?: RuntimeRoleId;
  /** 'word' (default): \b-joined literal. 'pattern': phrase IS regex source. */
  readonly match?: 'word' | 'pattern';
}

/** One runtime-supplied question. Shaped by the generic question mechanics afterwards. */
export interface RuntimeQuestion {
  readonly id: string;
  readonly purpose: string;
  readonly prompt: string;
  readonly type: 'SINGLE_SELECT' | 'MULTI_SELECT' | 'FREE_TEXT';
  readonly options?: readonly string[];
  /** The lexicon role this question settles (matched opaquely). */
  readonly coversRole?: RuntimeRoleId;
}

/** The mechanic-level lexical families the core consumes. Closed on purpose:
 *  these name MECHANICS, never topics. Domains live in the role values. */
export const RUNTIME_KNOWLEDGE_KEYS = [
  'goal-category',
  'goal-domain',
  'question-topic-pattern',
  'stated-topic-pattern',
  'goal-domain-success',
  'create-verb',
  'missed-activity-noun',
  'commitment-activity-verb',
  'training-noun',
  'recommendation-topic',
  'recommendation-material',
  'task-role',
  'explicit-activity',
  'learnable-subject',
  'quantity-unit',
  'non-measurable-quality',
] as const;

export type RuntimeKnowledgeKey = (typeof RUNTIME_KNOWLEDGE_KEYS)[number];

export function isRuntimeKnowledgeKey(value: string): value is RuntimeKnowledgeKey {
  return (RUNTIME_KNOWLEDGE_KEYS as readonly string[]).includes(value);
}

// ----------------------------------------------------------------- pack schemas

export const lexiconPackSchema = z.object({
  key: z.enum(RUNTIME_KNOWLEDGE_KEYS),
  entries: z
    .array(
      z.object({
        phrase: z.string().trim().min(1).max(500),
        role: z.string().trim().min(1).max(40).optional(),
        match: z.enum(['word', 'pattern']).optional(),
      }),
    )
    .min(0),
});
export type LexiconPack = z.infer<typeof lexiconPackSchema>;

export const questionPackSchema = z.object({
  key: z.enum(RUNTIME_KNOWLEDGE_KEYS),
  questions: z
    .array(
      z.object({
        id: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .regex(/^[a-z0-9_]+$/, 'question id must be snake_case'),
        purpose: z.string().trim().min(1).max(40),
        prompt: z.string().trim().min(1).max(300),
        type: z.enum(['SINGLE_SELECT', 'MULTI_SELECT', 'FREE_TEXT']),
        options: z.array(z.string().trim().min(1).max(60)).max(8).optional(),
        coversRole: z.string().trim().min(1).max(40).optional(),
      }),
    )
    .min(0),
});
export type QuestionPack = z.infer<typeof questionPackSchema>;

/** A validated pack (lexicon or question) before composition. */
export type RuntimeContentPack =
  | { kind: 'lexicon'; pack: LexiconPack }
  | { kind: 'questions'; pack: QuestionPack };

export const runtimeContentPackSchema: z.ZodType<RuntimeContentPack> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lexicon'), pack: lexiconPackSchema }),
  z.object({ kind: z.literal('questions'), pack: questionPackSchema }),
]);

// -------------------------------------------------------------------- the port

/** Compiled, immutable lookup structures — built once per port instance. */
export interface CompiledLexicon {
  /** \b(?:...)\b over all word-mode phrases, escaped, case-insensitive. */
  readonly wordRegex: RegExp | null;
  /** Word-mode phrases, escaped and '|' joined — no boundaries, no flags: the
   *  raw material for consumers that embed a fragment in a larger template. */
  readonly alternation: string | null;
  /** Per-entry compiled patterns, in pack order (entry.phrase is the raw source
   *  for consumers that embed it). */
  readonly patterns: ReadonlyArray<{ entry: RuntimeLexiconEntry; regex: RegExp }>;
  /** Word-mode phrases, for literal-substring consumers (the category scorer). */
  readonly phrases: readonly string[];
}

export interface RuntimeKnowledgePort {
  /** Compiled lexicon for a key; empty structures for an unknown key. */
  getLexicon(key: RuntimeKnowledgeKey): CompiledLexicon;
  /** Raw entries (for consumers that need roles/phrases individually). */
  getLexiconEntries(key: RuntimeKnowledgeKey): readonly RuntimeLexiconEntry[];
  /** Questions for a key, in pack order; empty for an unknown key. */
  getQuestionPack(key: RuntimeKnowledgeKey): readonly RuntimeQuestion[];
}

/** Thrown by the composition root when a pack is malformed. Fail fast at boot. */
export class RuntimeContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeContentError';
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compileLexicon(entries: readonly RuntimeLexiconEntry[]): CompiledLexicon {
  const words: string[] = [];
  const patterns: Array<{ entry: RuntimeLexiconEntry; regex: RegExp }> = [];
  for (const entry of entries) {
    if (entry.match === 'pattern') {
      try {
        // Case-insensitivity here is behaviorally identical to the legacy
        // regexes: every case-sensitive legacy pattern was only ever tested
        // against lowercased text, and every raw-input legacy pattern carried
        // its own /i flag.
        patterns.push({ entry, regex: new RegExp(entry.phrase, 'i') });
      } catch (err) {
        throw new RuntimeContentError(
          `invalid pattern entry "${entry.phrase.slice(0, 60)}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      words.push(entry.phrase);
    }
  }
  const wordRegex = words.length
    ? new RegExp(`\\b(?:${words.map(escapeRegExp).join('|')})\\b`, 'i')
    : null;
  const alternation = words.length ? words.map(escapeRegExp).join('|') : null;
  return { wordRegex, alternation, patterns, phrases: words };
}

/**
 * Build an immutable port from validated packs. All compilation happens here,
 * once — consumers never compile, and the port holds the only compiled copy.
 */
export function buildRuntimeKnowledgePort(packs: readonly RuntimeContentPack[]): RuntimeKnowledgePort {
  const lexicons = new Map<RuntimeKnowledgeKey, CompiledLexicon>();
  const lexiconEntries = new Map<RuntimeKnowledgeKey, readonly RuntimeLexiconEntry[]>();
  const questions = new Map<RuntimeKnowledgeKey, readonly RuntimeQuestion[]>();

  const EMPTY: CompiledLexicon = { wordRegex: null, alternation: null, patterns: [], phrases: [] };

  for (const { kind, pack } of packs) {
    if (kind === 'lexicon') {
      if (!isRuntimeKnowledgeKey(pack.key)) {
        throw new RuntimeContentError(`unknown lexicon key: ${pack.key}`);
      }
      lexiconEntries.set(pack.key, pack.entries);
      lexicons.set(pack.key, compileLexicon(pack.entries));
    } else {
      if (!isRuntimeKnowledgeKey(pack.key)) {
        throw new RuntimeContentError(`unknown question pack key: ${pack.key}`);
      }
      questions.set(pack.key, pack.questions);
    }
  }

  return {
    getLexicon(key) {
      return lexicons.get(key) ?? EMPTY;
    },
    getLexiconEntries(key) {
      return lexiconEntries.get(key) ?? [];
    },
    getQuestionPack(key) {
      return questions.get(key) ?? [];
    },
  };
}

// ---------------------------------------------------------------- installation

/** The absence of configuration is a configuration: an empty, safe port. */
const NULL_PORT: RuntimeKnowledgePort = buildRuntimeKnowledgePort([]);

let installed: RuntimeKnowledgePort = NULL_PORT;

/** Install a port. Replaces the previous one wholesale — nothing stale survives. */
export function setRuntimeKnowledge(port: RuntimeKnowledgePort): void {
  installed = port;
}

/** Restore the empty port (test teardown). */
export function resetRuntimeKnowledge(): void {
  installed = NULL_PORT;
}

/** The current port. Never null: an unbootstrapped process reads the NullPort. */
export function getRuntimeKnowledge(): RuntimeKnowledgePort {
  return installed;
}

/** True when something other than the NullPort is installed. */
export function isRuntimeKnowledgeInstalled(): boolean {
  return installed !== NULL_PORT;
}

/** Per-port memoization for consumer-compiled structures, keyed by a stable
 *  string tag. A new port means a new WeakMap entry, so a replacement can
 *  never serve one port the structures compiled for another. */
export function portMemo<T>(port: RuntimeKnowledgePort, key: string, build: () => T): T {
  let cache = portMemoCache.get(port);
  if (!cache) {
    cache = new Map<string, unknown>();
    portMemoCache.set(port, cache);
  }
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const value = build();
  cache.set(key, value);
  return value;
}
const portMemoCache = new WeakMap<RuntimeKnowledgePort, Map<string, unknown>>();
