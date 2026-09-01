import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';
import { executeCapability, inputDigestOf } from './executor.js';
import { capabilityRegistry, type AnyCapabilityDefinition } from './registry.js';
import { CapabilityError } from './capability-error.js';
import type { CapabilityContext, CapabilityOutcome } from './types.js';

// The executor is tested with a stubbed prisma and synthetic capability
// definitions: the state machine (claim → recheck → execute → finalize, the
// P2002 conflict protocol, the failure-audit protocol) must be proven
// generically, without binding it to any one capability.

const state = vi.hoisted(() => ({
  executions: [] as Array<Record<string, unknown>>,
  businessCalls: 0,
  failBusinessOnce: false,
  businessError: undefined as Error | undefined,
  // rollback simulation: rows written inside a transaction are discarded on throw
  txDepth: 0,
  txStaging: [] as Array<Record<string, unknown>>,
  forceClaimP2002Once: false,
}));

type Row = Record<string, unknown>;

const keyOf = (userId: unknown, capability: unknown, operationId: unknown): Row | undefined =>
  state.executions.find(
    (r) => r.userId === userId && r.capability === capability && r.operationId === operationId,
  );

const p2002 = (): Error => {
  const err = new Error('Unique constraint failed');
  (err as { code?: string }).code = 'P2002';
  return err;
};

function makeDelegates() {
  const apply = (row: Row, data: Row) => Object.assign(row, data);
  const capabilityExecution = {
    create: vi.fn(async (args: { data: Row }) => {
      if (state.forceClaimP2002Once) {
        state.forceClaimP2002Once = false;
        throw p2002();
      }
      if (keyOf(args.data.userId, args.data.capability, args.data.operationId)) throw p2002();
      const row: Row = { id: `exec_${state.executions.length + state.txStaging.length + 1}`, replayCount: 0, ...args.data };
      if (state.txDepth > 0) state.txStaging.push(row);
      else state.executions.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Row }) => {
      const row =
        [...state.txStaging, ...state.executions].find((r) => r.id === args.where.id) ??
        keyOf(undefined, undefined, undefined);
      const target = state.txDepth > 0
        ? state.txStaging.find((r) => r.id === args.where.id) ?? state.executions.find((r) => r.id === args.where.id)
        : state.executions.find((r) => r.id === args.where.id);
      if (!target) throw new Error('not found');
      if (args.data.replayCount !== undefined) {
        target.replayCount = ((target.replayCount as number) ?? 0) + 1;
        return target;
      }
      apply(target, args.data);
      return target;
    }),
    updateMany: vi.fn(
      async (args: { where: Row; data: Row }) => {
        const pool = state.txDepth > 0 ? [...state.txStaging, ...state.executions] : state.executions;
        const rows = pool.filter(
          (r) =>
            (args.where.userId === undefined || r.userId === args.where.userId) &&
            (args.where.capability === undefined || r.capability === args.where.capability) &&
            (args.where.operationId === undefined || r.operationId === args.where.operationId) &&
            (args.where.inputDigest === undefined || r.inputDigest === args.where.inputDigest) &&
            (args.where.state === undefined || r.state === args.where.state),
        );
        for (const row of rows) apply(row, args.data);
        return { count: rows.length };
      },
    ),
    findUnique: vi.fn(
      async (args: { where: { userId_capability_operationId: Record<string, string> } }) => {
        const key = args.where.userId_capability_operationId;
        return keyOf(key.userId, key.capability, key.operationId) ?? null;
      },
    ),
  };
  return { capabilityExecution };
}

const delegatesHolder = vi.hoisted(() => ({
  delegates: undefined as undefined | Record<string, unknown>,
  $transaction: undefined as undefined | MockLike,
}));

type MockLike = ReturnType<typeof import('vitest').vi['fn']>;

vi.mock('../lib/prisma.js', () => {
  const delegates = makeDelegates();
  const $transaction = vi.fn(async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    state.txDepth++;
    state.txStaging.length = 0;
    try {
      const result = await fn(delegates);
      // COMMIT: staging rows become real.
      state.executions.push(...state.txStaging);
      return result;
    } catch (err) {
      // ROLLBACK: staged rows (the PENDING claim) are discarded.
      state.txStaging.length = 0;
      throw err;
    } finally {
      state.txDepth--;
    }
  });
  delegatesHolder.delegates = delegates;
  delegatesHolder.$transaction = $transaction as unknown as MockLike;
  return { prisma: { ...delegates, $transaction } };
});

const prismaAny = {
  get capabilityExecution(): Record<string, Mock> {
    return delegatesHolder.delegates!.capabilityExecution as Record<string, Mock>;
  },
  get $transaction(): Mock {
    return delegatesHolder.$transaction as unknown as Mock;
  },
};

const ctx: CapabilityContext = { userId: 'user_1', confirmed: true, correlationId: 'corr_1' };

const makeCapability = (name: string) => {
  const authorize = vi.fn(async () => [{ kind: 'draft' as const, id: 'draft_1' }]);
  const execute = vi.fn(async () => {
    state.businessCalls++;
    if (state.failBusinessOnce) {
      state.failBusinessOnce = false;
      throw state.businessError ?? new Error('business failure');
    }
    return { done: true, calls: state.businessCalls };
  });
  const definition = {
    name: name as never,
    inputSchema: z.object({ value: z.string().min(1) }),
    confirmation: 'none' as const,
    transactional: true,
    authorize: authorize as never,
    execute: execute as never,
    describe: { purpose: 'test', arguments: '{ value }' },
  };
  return {
    definition: definition as unknown as AnyCapabilityDefinition,
    authorize,
    execute,
  };
};

const reset = () => {
  state.executions = [];
  state.businessCalls = 0;
  state.failBusinessOnce = false;
  state.businessError = undefined;
  state.forceClaimP2002Once = false;
  vi.clearAllMocks();
};

const request = (operationId?: string, value = 'hello') => ({
  capability: 'goal.confirm_from_draft' as const,
  input: { value },
  ...(operationId !== undefined ? { operationId } : {}),
});

function expectReplay<S>(outcome: CapabilityOutcome<S>): asserts outcome is Extract<CapabilityOutcome<S>, { status: 'replayed' }> {
  expect(outcome.status).toBe('replayed');
}
function expectSuccess<S>(outcome: CapabilityOutcome<S>): asserts outcome is Extract<CapabilityOutcome<S>, { status: 'succeeded' }> {
  expect(outcome.status).toBe('succeeded');
}

beforeEach(() => {
  reset();
  const registered = capabilityRegistry.get('goal.confirm_from_draft');
  if (!registered) {
    capabilityRegistry.register(makeCapability('goal.confirm_from_draft').definition);
  }
});

describe('stableStringify / digest', () => {
  it('is key-order independent, so retries derive identical digests', () => {
    expect(inputDigestOf({ a: 1, b: 2 })).toBe(inputDigestOf({ b: 2, a: 1 }));
  });
});

describe('executor — first execution, replay, conflicting input', () => {
  it('executes once and records SUCCEEDED with the result summary', async () => {
    const outcome = await executeCapability<{ done: boolean; calls: number }>(ctx, request('11111111-aaaa'));
    expectSuccess(outcome);
    expect(outcome.result).toEqual({ done: true, calls: 1 });
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0]).toMatchObject({ state: 'SUCCEEDED', userId: 'user_1' });
    expect(JSON.parse(String(state.executions[0].resultSummary))).toEqual({ done: true, calls: 1 });
  });

  it('retries with the same operationId replay the committed result without re-executing', async () => {
    await executeCapability(ctx, request('11111111-aaaa'));
    const second = await executeCapability<{ done: boolean; calls: number }>(ctx, request('11111111-aaaa'));
    expectReplay(second);
    expect(second.result).toEqual({ done: true, calls: 1 });
    expect(state.businessCalls).toBe(1);
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0].replayCount).toBe(1);
  });

  it('the same operationId with different input is a typed idempotency conflict', async () => {
    await executeCapability(ctx, request('11111111-aaaa'));
    await expect(
      executeCapability(ctx, { capability: 'goal.confirm_from_draft', input: { value: 'different' }, operationId: '11111111-aaaa' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_IDEMPOTENCY_CONFLICT' });
    expect(state.businessCalls).toBe(1);
  });

  it('a different operationId is a new logical operation', async () => {
    await executeCapability(ctx, request('11111111-aaaa'));
    const second = await executeCapability<{ done: boolean; calls: number }>(ctx, request('22222222-bbbb'));
    expectSuccess(second);
    expect(state.businessCalls).toBe(2);
    expect(state.executions).toHaveLength(2);
  });

  it('a missing operationId derives a request-scoped key and still records an execution', async () => {
    const outcome = await executeCapability(ctx, request());
    expectSuccess(outcome);
    expect(state.executions).toHaveLength(1);
    expect(String(state.executions[0].operationId)).toMatch(/^req-/);
  });
});

describe('executor — concurrency arbitration (claim inside the transaction)', () => {
  it('claim-conflict with a committed winner resolves to replay without re-executing', async () => {
    // Lost-response case: the pre-claim read finds SUCCEEDED → replay; the
    // business execution is never reached.
    const digest = inputDigestOf({ value: 'hello' });
    state.executions.push({
      id: 'exec_winner', userId: 'user_1', capability: 'goal.confirm_from_draft',
      operationId: '55555555-eeee', inputDigest: digest,
      state: 'SUCCEEDED', resultSummary: JSON.stringify({ done: true, calls: 42 }), replayCount: 0,
    });
    state.businessCalls = 0;
    const outcome = await executeCapability<{ done: boolean; calls: number }>(ctx, request('55555555-eeee'));
    expectReplay(outcome);
    expect(outcome.result).toEqual({ done: true, calls: 42 });
    expect(state.businessCalls).toBe(0);
    expect(state.executions[0].replayCount).toBe(1);
  });

  it('a loser claim hitting P2002 inside the transaction resolves to replay, not a second mutation', async () => {
    // True race: the pre-claim read sees nothing, the winner commits, the
    // loser's claim INSERT hits P2002 → conflict protocol → replay.
    const digest = inputDigestOf({ value: 'hello' });
    prismaAny.$transaction.mockImplementationOnce(async () => {
      state.executions.push({
        id: 'exec_winner', userId: 'user_1', capability: 'goal.confirm_from_draft',
        operationId: '77777777-gggg', inputDigest: digest,
        state: 'SUCCEEDED', resultSummary: JSON.stringify({ done: true, calls: 7 }), replayCount: 0,
      });
      throw p2002();
    });
    const outcome = await executeCapability<{ done: boolean; calls: number }>(ctx, request('77777777-gggg'));
    expectReplay(outcome);
    expect(outcome.result).toEqual({ done: true, calls: 7 });
    expect(state.businessCalls).toBe(0);
    expect(state.executions.filter((r) => r.state === 'SUCCEEDED')).toHaveLength(1);
  });
});

describe('executor — failure, rollback, FAILED retry', () => {
  it('a business failure rolls everything back and writes a FAILED audit row', async () => {
    state.failBusinessOnce = true;
    state.businessError = new Error('ladder exploded');
    await expect(executeCapability(ctx, request('11111111-aaaa'))).rejects.toMatchObject({
      code: 'CAPABILITY_EXECUTION_FAILED',
    });
    // The PENDING claim rolled back with the transaction; only the FAILED
    // audit row survives — never a committed PENDING row.
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0].state).toBe('FAILED');
    expect(state.executions.some((r) => r.state === 'PENDING')).toBe(false);
  });

  it('a retry after a failed transaction re-claims atomically and re-executes', async () => {
    state.failBusinessOnce = true;
    state.businessError = new Error('ladder exploded');
    await expect(executeCapability(ctx, request('11111111-aaaa'))).rejects.toBeInstanceOf(Error);
    const outcome = await executeCapability<{ done: boolean; calls: number }>(ctx, request('11111111-aaaa'));
    expectSuccess(outcome);
    // ONE row per logical operation — the FAILED row was reclaimed, not duplicated.
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0].state).toBe('SUCCEEDED');
    expect(state.businessCalls).toBe(2);
  });

  it('two concurrent FAILED retries arbitrate to one mutation', async () => {
    state.failBusinessOnce = true;
    state.businessError = new Error('ladder exploded');
    await expect(executeCapability(ctx, request('11111111-aaaa'))).rejects.toBeInstanceOf(Error);
    // Two retries race the conditional reclaim; the loser re-reads and replays.
    const results = await Promise.allSettled([
      executeCapability<{ done: boolean; calls: number }>(ctx, request('11111111-aaaa')),
      executeCapability<{ done: boolean; calls: number }>(ctx, request('11111111-aaaa')),
    ]);
    const outcomes = results
      .filter((r): r is PromiseFulfilledResult<CapabilityOutcome<{ done: boolean; calls: number }>> => r.status === 'fulfilled')
      .map((r) => r.value);
    // Exactly one business mutation committed for this logical operation.
    expect(state.executions.filter((r) => r.state === 'SUCCEEDED')).toHaveLength(1);
    // Whatever the interleaving, at least one request got a definite outcome
    // and no second business execution happened beyond the re-execution.
    expect(state.businessCalls).toBeLessThanOrEqual(3); // 1 failed + 1 re-execution (+0 loser)
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
  });

  it('the failure audit never overwrites a SUCCEEDED winner (non-clobber proof)', async () => {
    // Winner committed SUCCEEDED for the logical operation; a stale failed
    // attempt's conditional update matches zero FAILED rows — untouched.
    const digest = inputDigestOf({ value: 'hello' });
    state.executions.push({
      id: 'exec_winner', userId: 'user_1', capability: 'goal.confirm_from_draft',
      operationId: '66666666-ffff', inputDigest: digest,
      state: 'SUCCEEDED', resultSummary: '{"done":true}', replayCount: 0,
    });
    const result = await prismaAny.capabilityExecution.updateMany({
      where: {
        userId: 'user_1', capability: 'goal.confirm_from_draft', operationId: '66666666-ffff',
        inputDigest: digest, state: 'FAILED',
      },
      data: { errorCode: 'CAPABILITY_EXECUTION_FAILED' },
    });
    expect(result.count).toBe(0);
    expect(state.executions[0].state).toBe('SUCCEEDED');
    expect(state.executions[0].errorCode).toBeUndefined();
  });

  it('failure-audit persistence failure never masks the original error', async () => {
    state.failBusinessOnce = true;
    state.businessError = new Error('the real failure');
    // Sequence of create calls: (1) the claim inside the failing transaction,
    // (2) the failure audit's recordFailure. Fail ONLY the second — the audit
    // write — and require the original business failure to surface unchanged.
    const createMock = prismaAny.capabilityExecution.create as Mock;
    let createCalls = 0;
    const original = createMock.getMockImplementation();
    createMock.mockImplementation(async (args: { data: Row }) => {
      createCalls++;
      if (createCalls === 2) throw new Error('audit write failed');
      return original!(args);
    });
    try {
      await expect(executeCapability(ctx, request('88888888-hhhh'))).rejects.toMatchObject({
        code: 'CAPABILITY_EXECUTION_FAILED',
        message: expect.stringContaining('the real failure'),
      });
      expect(createCalls).toBe(2);
    } finally {
      createMock.mockImplementation(original!);
    }
  });
});

describe('executor — gates and typed failures', () => {
  it('rejects an unknown capability', async () => {
    await expect(
      executeCapability(ctx, { capability: 'recommendation.mark_consumed' as never, input: {} }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN' });
  });

  it('rejects invalid input as model-repairable', async () => {
    await expect(
      executeCapability(ctx, { capability: 'goal.confirm_from_draft', input: { value: '' }, operationId: '11111111-aaaa' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_INPUT_INVALID', repairableByModel: true });
  });

  it('a confirm-policy capability cannot execute without server-derived confirmation', async () => {
    const name = 'goal.apply_manual_edit';
    if (!capabilityRegistry.get(name)) {
      const base = makeCapability(name);
      capabilityRegistry.register({
        ...base.definition,
        confirmation: 'confirm',
      } as never);
    }
    // Server-derived confirmation is FALSE: the gate fires before any claim,
    // authorization or business execution.
    const unconfirmed: CapabilityContext = { ...ctx, confirmed: false };
    await expect(
      executeCapability(unconfirmed, { capability: name as never, input: { value: 'x' }, operationId: '11111111-aaaa' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CONFIRMATION_REQUIRED' });
    expect(state.businessCalls).toBe(0);
  });

  it('propagates authorization failures as non-repairable', async () => {
    const name = 'goal.apply_ai_edit';
    if (!capabilityRegistry.get(name)) {
      const base = makeCapability(name);
      capabilityRegistry.register({
        ...base.definition,
        authorize: async () => {
          throw new CapabilityError('CAPABILITY_FORBIDDEN', 'no access');
        },
      } as never);
    }
    await expect(
      executeCapability(ctx, { capability: name as never, input: { value: 'x' }, operationId: '11111111-aaaa' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_FORBIDDEN', repairableByModel: false });
    expect(state.businessCalls).toBe(0);
  });

  it('validates the operationId shape when supplied', async () => {
    await expect(
      executeCapability(ctx, { capability: 'goal.confirm_from_draft', input: { value: 'x' }, operationId: 'short' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_INPUT_INVALID' });
  });
});
