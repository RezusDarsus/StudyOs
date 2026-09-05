import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { useGoalCopilot } from './useGoalCopilot';

afterEach(() => vi.restoreAllMocks());
const answer = { analysis: { explanation: 'A useful answer' } };
const item = { entityType: 'book', displayName: 'Example', attribution: 'Author' };
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('goal chat lifecycle', () => {
  it('keeps a cleared chat empty after a late reply and preserves the new request lock', async () => {
    const first = deferred();
    const second = deferred();
    const post = vi.spyOn(api, 'post').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useGoalCopilot('g1', vi.fn()));
    await act(async () => { void result.current.ask('Old question'); });
    act(() => result.current.clear());
    await act(async () => { void result.current.ask('New question'); });
    await act(async () => first.resolve(answer));
    expect(result.current.entries).toEqual([]);
    expect(result.current.busy).toBe(true);
    await act(async () => { await result.current.ask('Duplicate'); });
    expect(post).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(answer));
    expect(result.current.entries.map((entry) => entry.question)).toEqual(['New question']);
  });

  it('does not carry history or late replies into another goal', async () => {
    const pending = deferred();
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(answer).mockReturnValueOnce(pending.promise).mockResolvedValue(answer);
    const { result, rerender } = renderHook(({ goal }) => useGoalCopilot(goal, vi.fn()), { initialProps: { goal: 'g1' } });
    await act(async () => { await result.current.ask('First goal'); });
    await act(async () => { void result.current.ask('Pending reply'); });
    rerender({ goal: 'g2' });
    await act(async () => pending.resolve(answer));
    expect(result.current.entries).toEqual([]);
    await act(async () => { await result.current.ask('Second goal'); });
    expect(post).toHaveBeenLastCalledWith('/goals/g2/copilot', { message: 'Second goal', history: [] });
  });

  it('reuses the operation ID when retrying an uncertain mark-as-used request', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new ApiError(0, 'Network lost')).mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useGoalCopilot('g1', vi.fn()));
    await act(async () => { await result.current.markConsumed(item); });
    await act(async () => { await result.current.markConsumed(item); });
    expect(post.mock.calls[0][1]).toEqual(post.mock.calls[1][1]);
    expect(result.current.consumedIdentities.has('example|author')).toBe(true);
    act(() => result.current.clear());
    expect(result.current.consumedIdentities.has('example|author')).toBe(true);
  });

  it('blocks duplicate mark-as-used clicks, including after success', async () => {
    const pending = deferred();
    const post = vi.spyOn(api, 'post').mockReturnValue(pending.promise);
    const { result } = renderHook(() => useGoalCopilot('g1', vi.fn()));
    await act(async () => { void result.current.markConsumed(item); void result.current.markConsumed(item); });
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ ok: true }));
    await act(async () => { await result.current.markConsumed(item); });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
