import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { NvidiaAiChatProvider } from './nvidia-provider.js';
import {
  AiProviderError,
  type AiChatProvider,
  type AiPurpose,
  type ChatMessage,
  type ChatRequest,
} from './provider.js';

/** Built from configuration, so no business code names a vendor. */
export function createProvider(): AiChatProvider | null {
  const provider = process.env.AI_PROVIDER ?? 'nvidia';
  const model = process.env.AI_GOAL_COPILOT_MODEL;
  const key = process.env.NVIDIA_API_KEY;
  const baseUrl = process.env.AI_BASE_URL ?? 'https://integrate.api.nvidia.com/v1';

  if (provider === 'nvidia' && model && key) {
    return new NvidiaAiChatProvider(model, key, baseUrl);
  }
  // No credentials: the Copilot is simply unavailable. Phase 1 keeps working.
  return null;
}

let cached: AiChatProvider | null | undefined;

export function getProvider(): AiChatProvider | null {
  if (cached === undefined) cached = createProvider();
  return cached;
}

/** Tests inject a deterministic provider through this. */
export function setProvider(provider: AiChatProvider | null) {
  cached = provider;
}

export const isCopilotEnabled = () => getProvider() !== null;

export class CopilotUnavailableError extends Error {
  constructor() {
    super('The Copilot is not available right now');
  }
}

async function logCall(entry: {
  userId?: string;
  sessionId?: string;
  provider: string;
  model: string;
  purpose: AiPurpose;
  promptVersion: string;
  latencyMs: number;
  totalMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  status: string;
  errorType?: string;
  retryCount: number;
}) {
  // Deliberately records no prompt or completion text — only telemetry.
  await prisma.aiCallLog.create({ data: entry }).catch(() => {});
}

/**
 * Call the model and parse its reply into a validated shape.
 *
 * If the model returns something that is not valid against the schema, it gets
 * up to two corrective retries with the parse error fed back (one for callers
 * that pass a tighter budget — the Stage 5 interview turn allows at most one
 * schema-repair call). Anything still broken surfaces as an error rather than
 * being half-saved.
 */
export async function chatJson<S extends z.ZodTypeAny>(
  request: Omit<ChatRequest, 'json'>,
  schema: S,
  opts?: { maxAttempts?: number },
): Promise<z.infer<S>> {
  const provider = getProvider();
  if (!provider) throw new CopilotUnavailableError();

  const messages: ChatMessage[] = [...request.messages];
  let lastError = '';
  // Provider time and wall time diverge whenever a schema-repair retry fires.
  // Separating them is what tells us whether a slow call was one slow request or
  // two — they need completely different fixes.
  const startedAt = Date.now();

  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 3);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response;
    try {
      response = await provider.chat({ ...request, messages, json: true });
    } catch (err) {
      const kind = err instanceof AiProviderError ? err.kind : 'UNAVAILABLE';
      await logCall({
        userId: request.userId,
        sessionId: request.sessionId,
        provider: provider.name,
        model: provider.model,
        purpose: request.purpose,
        promptVersion: request.promptVersion,
        latencyMs: 0,
        totalMs: Date.now() - startedAt,
        status: kind === 'TIMEOUT' ? 'TIMEOUT' : 'PROVIDER_ERROR',
        errorType: kind,
        retryCount: attempt,
      });
      // Retry transient failures within the bounded attempt budget.
      if (
        err instanceof AiProviderError &&
        err.retryable &&
        request.retryTransient !== false &&
        attempt < maxAttempts - 1
      ) {
        if (err.kind === 'RATE_LIMIT') {
          const delayMs = Math.min(err.retryAfterMs ?? 5_000 * (attempt + 1), 30_000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        continue;
      }
      throw err;
    }

    const parsed = safeParseJson(response.content);
    const result = parsed.ok ? schema.safeParse(parsed.value) : null;

    if (result?.success) {
      await logCall({
        userId: request.userId,
        sessionId: request.sessionId,
        provider: provider.name,
        model: provider.model,
        purpose: request.purpose,
        promptVersion: request.promptVersion,
        latencyMs: response.latencyMs,
        totalMs: Date.now() - startedAt,
        promptTokens: response.promptTokens,
        completionTokens: response.completionTokens,
        status: 'OK',
        retryCount: attempt,
      });
      return result.data;
    }

    lastError = parsed.ok
      ? JSON.stringify(result?.error.issues.slice(0, 6))
      : 'the reply was not valid JSON';

    // Outside production, surface why so a schema mismatch is debuggable. The
    // AiCallLog deliberately never stores model content.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[ai:${request.purpose}] rejected (attempt ${attempt}): ${lastError}
` +
          `  raw: ${response.content.slice(0, 600)}`,
      );
    }

    await logCall({
      userId: request.userId,
      sessionId: request.sessionId,
      provider: provider.name,
      model: provider.model,
      purpose: request.purpose,
      promptVersion: request.promptVersion,
      latencyMs: response.latencyMs,
      totalMs: Date.now() - startedAt,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      status: 'INVALID_JSON',
      retryCount: attempt,
    });

    if (attempt < maxAttempts - 1) {
      messages.push({ role: 'assistant', content: response.content.slice(0, 4000) });
      messages.push({
        role: 'user',
        content:
          `That response did not match the required schema: ${lastError}. ` +
          'Reply again with ONLY the corrected JSON object. No prose, no markdown fences.',
      });
    }
  }

  throw new AiProviderError(
    'The AI response could not be understood. Please try again.',
    'BAD_RESPONSE',
  );
}

/** Tolerant JSON extraction — handles stray prose or ```json fences. */
export function safeParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const attempt = (candidate: string) => {
    try {
      return { ok: true as const, value: JSON.parse(candidate) };
    } catch {
      return null;
    }
  };

  const direct = attempt(text.trim());
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = attempt(fenced[1].trim());
    if (inner) return inner;
  }

  // Fall back to the outermost {...} span.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const span = attempt(text.slice(start, end + 1));
    if (span) return span;
  }

  return { ok: false };
}
