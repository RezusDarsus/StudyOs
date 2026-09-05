import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { chatJson, setProvider } from './client.js';
import { NvidiaAiChatProvider } from './nvidia-provider.js';
import type { ChatRequest } from './provider.js';

vi.mock('../lib/prisma.js', () => ({ prisma: { aiCallLog: { create: async () => ({}) } } }));
afterEach(() => { setProvider(null); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Copilot recovery', () => {
  it('repairs advice without switching the task to requirement extraction', async () => {
    const requests: ChatRequest[] = [];
    setProvider({ name: 'test', model: 'test', chat: async (request) => {
      requests.push(structuredClone(request));
      return { content: requests.length === 1 ? '{}' : '{"explanation":"Try a space opera"}', latencyMs: 1 };
    } });
    await expect(chatJson({ purpose: 'PROGRESS_ANALYSIS', promptVersion: 'test', messages: [] },
      z.object({ explanation: z.string() }))).resolves.toEqual({ explanation: 'Try a space opera' });
    const repair = requests[1].messages.at(-1)!.content;
    expect(repair).toContain('Preserve the answer to the current request');
    expect(repair).not.toContain('requirements');
    expect(repair).not.toContain('atom');
  });

  it('times out when headers arrive but the response body stalls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    })));
    const provider = new NvidiaAiChatProvider('test', 'test', 'https://example.invalid');
    const result = expect(provider.chat({ purpose: 'PROGRESS_ANALYSIS', promptVersion: 'test', messages: [], timeoutMs: 50 }))
      .rejects.toMatchObject({ kind: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(51);
    await result;
  });
});
