import { chatJson } from '../ai/client.js';
import { PROMPT_VERSIONS, preferenceSystemPrompt } from '../ai/prompts.js';
import { preferenceExtractionSchema } from '../ai/schemas.js';
import { prisma } from '../lib/prisma.js';

/**
 * Long-term user preferences.
 *
 * Deliberately separate from a session's context: "I have an exam on Tuesday" is
 * true for one goal, while "I hate running" is worth remembering next time. Only
 * confident, durable statements are stored, and the backend — not the model —
 * decides what actually persists.
 */
const MIN_CONFIDENCE_TO_STORE = 0.75;

/** Keep memory small enough to stay useful and cheap to inject. */
const MAX_PER_CATEGORY = 8;

/**
 * The model invents a new key for the same idea every time — session_duration,
 * session_duration_minutes, session_length, ideal_session_length and
 * preferred_session_length all showed up for one concept. Left alone, memory grows
 * without bound and starts contradicting itself (one account held both
 * `preferred_time: evenings` and `preferred_time_of_day: morning`).
 *
 * Collapsing synonyms onto a canonical key means a newer statement UPDATES the
 * old one through the unique constraint, instead of sitting beside it.
 */
const CANONICAL_KEYS: Array<{ canonical: string; matches: RegExp }> = [
  { canonical: 'session_length_minutes', matches: /(session|ideal).*(duration|length)|duration_minutes/ },
  { canonical: 'sessions_per_week', matches: /frequen|per_week|days_of_week$|preferred_days$|study_days|free_days/ },
  { canonical: 'preferred_time_of_day', matches: /preferred_time|time_of_day|energy_time|focus_time/ },
  { canonical: 'preferred_activity', matches: /preferred_activity(_\d)?$|preferred_evening_activity/ },
  { canonical: 'disliked_activity', matches: /disliked/ },
];

export function canonicalPreferenceKey(key: string): string {
  const normalized = key.trim().toLowerCase();
  for (const rule of CANONICAL_KEYS) {
    if (rule.matches.test(normalized)) return rule.canonical;
  }
  return normalized;
}

export async function getPreferencesForPrompt(userId: string, category?: string | null) {
  const preferences = await prisma.userPreference.findMany({
    where: {
      userId,
      OR: [{ scope: 'GLOBAL' }, ...(category ? [{ scope: 'CATEGORY', category }] : [])],
    },
    orderBy: { confidence: 'desc' },
    take: 12,
  });
  return preferences.map((p) => ({ key: p.key, value: p.value, category: p.category }));
}

/** Keep only the strongest few per category, so memory cannot grow without bound. */
export async function pruneMemory(userId: string) {
  const all = await prisma.userPreference.findMany({
    where: { userId },
    orderBy: [{ confidence: 'desc' }, { updatedAt: 'desc' }],
  });

  const kept = new Map<string, number>();
  const doomed: string[] = [];
  for (const pref of all) {
    const bucket = `${pref.scope}:${pref.category}`;
    const count = kept.get(bucket) ?? 0;
    if (count >= MAX_PER_CATEGORY) doomed.push(pref.id);
    else kept.set(bucket, count + 1);
  }
  if (doomed.length) {
    await prisma.userPreference.deleteMany({ where: { id: { in: doomed } } });
  }
  return doomed.length;
}

export async function listPreferences(userId: string) {
  return prisma.userPreference.findMany({
    where: { userId },
    orderBy: [{ scope: 'asc' }, { key: 'asc' }],
  });
}

export async function deletePreference(userId: string, id: string) {
  await prisma.userPreference.deleteMany({ where: { id, userId } });
}

/**
 * Extract durable preferences from a finished conversation.
 *
 * Called after a draft is generated (interview pipeline) and after a goal-chat
 * turn, so it never slows either down; a failure here is non-fatal — the plan
 * or the answer is already built. There is no CopilotSession for a goal-chat
 * turn, so sessionId is optional.
 */
export async function extractPreferences(opts: {
  userId: string;
  sessionId?: string;
  category: string | null;
  transcript: Array<{ role: string; content: string }>;
}) {
  try {
    const result = await chatJson(
      {
        purpose: 'PREFERENCE_EXTRACTION',
        promptVersion: PROMPT_VERSIONS.preference,
        userId: opts.userId,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        thinking: false,
        temperature: 0.2,
        maxTokens: 700,
        messages: [
          { role: 'system', content: preferenceSystemPrompt() },
          {
            role: 'user',
            content: `Goal category: ${opts.category ?? 'unknown'}

Conversation:
${opts.transcript.map((m) => `${m.role}: ${m.content}`).join('\n')}`,
          },
        ],
      },
      preferenceExtractionSchema,
    );

    // SESSION_ONLY scope means the model gave us something not worth storing.
    const durable = result.preferences.filter(
      (p) =>
        p.persistence === 'LONG_TERM' &&
        p.scope !== 'SESSION_ONLY' &&
        p.confidence >= MIN_CONFIDENCE_TO_STORE,
    );

    for (const pref of durable) {
      const category = pref.scope === 'CATEGORY' ? (pref.category ?? '') : '';
      const scope = pref.scope === 'CATEGORY' && !pref.category ? 'GLOBAL' : pref.scope;
      const key = canonicalPreferenceKey(pref.key);
      // Scope+key is unique per user, so a newer statement replaces the older one.
      await prisma.userPreference.upsert({
        where: {
          userId_scope_category_key: {
            userId: opts.userId,
            scope,
            category,
            key,
          },
        },
        create: {
          userId: opts.userId,
          scope,
          category,
          key,
          value: pref.value,
          confidence: pref.confidence,
          source: 'COPILOT',
        },
        update: { value: pref.value, confidence: pref.confidence },
      });
    }
    await pruneMemory(opts.userId);
    return durable.length;
  } catch {
    // Preference learning is a bonus, never a blocker.
    return 0;
  }
}
