// The seam between the Copilot and whatever model happens to be behind it.
//
// GoalCopilotService depends on AiChatProvider, never on NVIDIA. Swapping in
// Gemini, OpenAI or a local model means writing one new class here and changing
// one config value — no Copilot logic moves.

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Which prompt this is, for logging and cost attribution. */
  purpose: AiPurpose;
  promptVersion: string;
  /** Ask the provider to guarantee syntactically valid JSON, where supported. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /**
   * Reasoning models are slow and verbose. Only the calls that genuinely benefit
   * (plan generation, progress analysis) should switch this on.
   */
  thinking?: boolean;
  timeoutMs?: number;
  /** Disable the automatic second provider attempt for latency-sensitive UI calls. */
  retryTransient?: boolean;
  userId?: string;
  sessionId?: string;
}

export interface ChatResponse {
  content: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
}

export const AI_PURPOSES = [
  'INTERVIEW',
  'DRAFT_GENERATION',
  'DRAFT_EDIT',
  'PROGRESS_ANALYSIS',
  'PREFERENCE_EXTRACTION',
] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

export class AiProviderError extends Error {
  constructor(
    message: string,
    public kind: 'TIMEOUT' | 'RATE_LIMIT' | 'UNAVAILABLE' | 'BAD_RESPONSE' | 'AUTH',
    public status?: number,
    public retryAfterMs?: number,
  ) {
    super(message);
  }

  /**
   * Whether trying the same call again could plausibly succeed.
   *
   * BAD_RESPONSE covers a truncated or empty completion. That is the model
   * running long on one attempt, not a permanent condition — leaving it out
   * turned a recoverable blip into the one hard failure in a 24-scenario run.
   * AUTH is the only genuinely permanent failure here.
   */
  get retryable() {
    return this.kind !== 'AUTH';
  }
}

export interface AiChatProvider {
  readonly name: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
