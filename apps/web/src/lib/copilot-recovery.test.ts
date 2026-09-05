import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { useCopilotInterview } from './useCopilotInterview';
import { useGoalCopilot } from './useGoalCopilot';

afterEach(() => vi.restoreAllMocks());
const turn = { sessionId: 's1', status: 'INTERVIEWING', question: {
  id: 'q1', type: 'TEXT' as const, prompt: 'What suits you?', optional: false,
}, questionCount: 2, estimatedTotal: 3, revision: 1, context: {}, canGenerate: false, assistantMessage: 'What suits you?' };
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

describe('Copilot request recovery', () => {
  it('sends only one opening request for two immediate submissions', async () => {
    const pending = deferred();
    const post = vi.spyOn(api, 'post').mockReturnValue(pending.promise);
    const { result } = renderHook(() => useCopilotInterview({ onError: vi.fn() }));
    await act(async () => {
      void result.current.begin('Read more');
      void result.current.begin('Read more');
    });
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(turn));
    expect(result.current.phase).toBe('INTERVIEWING');
  });
  it('does not restore an abandoned conversation when an old request completes', async () => {
    const pending = deferred();
    vi.spyOn(api, 'post').mockReturnValue(pending.promise);
    const { result } = renderHook(() => useCopilotInterview({ onError: vi.fn() }));
    await act(async () => { void result.current.begin('Read more'); });
    act(() => result.current.reset());
    await act(async () => pending.resolve(turn));
    expect(result.current.phase).toBe('OPENING');
    expect(result.current.bubbles).toEqual([]);
  });
  it('reloads the saved question after a lost answer response', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce(turn).mockRejectedValueOnce(new ApiError(0, 'Connection lost', 'NETWORK'));
    vi.spyOn(api, 'get').mockResolvedValue({ ...turn, question: { ...turn.question, id: 'q2' },
      revision: 2, draftId: null, messages: [{ role: 'user', content: 'Evenings' }] });
    const { result } = renderHook(() => useCopilotInterview({ onError: vi.fn() }));
    await act(async () => { await result.current.begin('Read more'); });
    await act(async () => { await result.current.answer('Evenings', 'Evenings'); });
    expect(result.current.question?.id).toBe('q2');
    expect(result.current.turn?.revision).toBe(2);
  });
  it('keeps the conversation when discard fails', async () => {
    vi.spyOn(api, 'post').mockResolvedValue(turn);
    vi.spyOn(api, 'del').mockRejectedValue(new ApiError(503, 'Try again'));
    const error = vi.fn();
    const { result } = renderHook(() => useCopilotInterview({ onError: error }));
    await act(async () => { await result.current.begin('Read more'); });
    await act(async () => { expect(await result.current.discard()).toBe(false); });
    expect(result.current.turn?.sessionId).toBe('s1');
    expect(error).toHaveBeenCalledWith('Try again');
  });
  it('blocks duplicate generation and answers while a draft is building', async () => {
    const pending = deferred();
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(turn).mockReturnValue(pending.promise);
    const { result } = renderHook(() => useCopilotInterview({ onError: vi.fn() }));
    await act(async () => { await result.current.begin('Read more'); });
    await act(async () => {
      void result.current.forceGenerate();
      void result.current.forceGenerate();
      void result.current.answer('Evenings', 'Evenings');
    });
    expect(post).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ draft: { id: 'd1' } }));
    expect(result.current.draft?.id).toBe('d1');
  });
  it('sends only one goal-chat request for immediate repeated clicks', async () => {
    const pending = deferred();
    const post = vi.spyOn(api, 'post').mockReturnValue(pending.promise);
    const { result } = renderHook(() => useGoalCopilot('g1', vi.fn()));
    await act(async () => { void result.current.ask('Suggest something'); void result.current.ask('Suggest something'); });
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ analysis: { explanation: 'Try this' } }));
  });
});
