import {
  AiProviderError,
  type AiChatProvider,
  type ChatRequest,
  type ChatResponse,
} from './provider.js';

/**
 * NVIDIA NIM provider (OpenAI-compatible chat completions).
 *
 * Two behaviours of this model family matter and are handled here:
 *
 *  1. It is a reasoning model. With thinking enabled it streams its chain of
 *     thought into `reasoning_content`, and a truncated response can leak that
 *     thinking into `content`. Thinking is therefore OFF unless a caller asks
 *     for it, and any stray <think> block is stripped.
 *  2. It supports `response_format: json_object`, which is what makes structured
 *     Copilot output reliable rather than regex-scraped.
 */
export class NvidiaAiChatProvider implements AiChatProvider {
  readonly name = 'nvidia';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          // Low temperature: schedules should be consistent and realistic, not creative.
          temperature: request.temperature ?? 0.3,
          top_p: 0.95,
          max_tokens: request.maxTokens ?? 2048,
          stream: false,
          chat_template_kwargs: { enable_thinking: request.thinking ?? false },
          ...(request.thinking ? { reasoning_budget: 4096 } : {}),
          ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
    } catch (err) {
      clearTimeout(timeout);
      if ((err as Error).name === 'AbortError') {
        throw new AiProviderError('The AI took too long to respond', 'TIMEOUT');
      }
      throw new AiProviderError('Could not reach the AI provider', 'UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // The body may echo request content, so only the status is surfaced.
      if (response.status === 401 || response.status === 403) {
        throw new AiProviderError('AI provider rejected the credentials', 'AUTH', response.status);
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new AiProviderError(
          'AI provider is rate limiting',
          'RATE_LIMIT',
          response.status,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
        );
      }
      throw new AiProviderError(
        `AI provider returned ${response.status}${body ? ` (${body.slice(0, 120)})` : ''}`,
        'UNAVAILABLE',
        response.status,
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;

    const choice = payload?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string') {
      throw new AiProviderError('AI provider returned no message content', 'BAD_RESPONSE');
    }
    if (choice?.finish_reason === 'length') {
      // A truncated reply is very likely to be unparseable; say so honestly
      // rather than handing a half-object to the parser.
      throw new AiProviderError('The AI response was cut off before it finished', 'BAD_RESPONSE');
    }

    return {
      content: stripThinking(content),
      promptTokens: payload?.usage?.prompt_tokens,
      completionTokens: payload?.usage?.completion_tokens,
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** Remove any reasoning block that leaked into the visible content. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .trim();
}
