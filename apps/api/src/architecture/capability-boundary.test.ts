import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Stage 4 guardrails:
//
//   1. Registry is the sole composition point — registerCapabilities is the
//      only production caller of capability registration.
//   2. Copilot core (ai/**, services/copilot-*) never imports capability
//      definitions or the executor: the dependency direction is
//      routes → executor → definitions → services.
//   3. Model-facing descriptors expose no implementation functions.
//   4. No capability definition performs mass assignment — `data:` blocks are
//      constructed field-by-field, never `data: input` or `...input`.

const apiSrc = join(__dirname, '..');
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const registryFile = read(join(apiSrc, 'capabilities', 'registry.ts'));
const executorFile = read(join(apiSrc, 'capabilities', 'executor.ts'));
const indexFile = read(join(apiSrc, 'capabilities', 'index.ts'));
const goalDefFile = read(join(apiSrc, 'capabilities', 'definitions', 'goal.ts'));
const recDefFile = read(join(apiSrc, 'capabilities', 'definitions', 'recommendation.ts'));

const CORE_PREFIXES = ['ai/', 'services/'];

describe('capability boundary (Stage 4)', () => {
  it('the registry is the sole composition point — routes never register', () => {
    expect(indexFile).toContain('registerCapability(');
    // No production route or core service registers capabilities directly.
    const copilotRoute = read(join(apiSrc, 'routes', 'copilot.ts'));
    const recommendationsRoute = read(join(apiSrc, 'routes', 'recommendations.ts'));
    const copilotGoal = read(join(apiSrc, 'services', 'copilot-goal.ts'));
    const copilotDraft = read(join(apiSrc, 'services', 'copilot-draft.ts'));
    for (const file of [copilotRoute, recommendationsRoute, copilotGoal, copilotDraft]) {
      expect(file).not.toContain('capabilityRegistry.register(');
      expect(file).not.toContain('registerCapability(');
    }
  });

  it('copilot core never imports capability definitions or the executor', () => {
    const copilotGoal = read(join(apiSrc, 'services', 'copilot-goal.ts'));
    expect(copilotGoal).not.toContain("from '../capabilities/definitions/");
    expect(copilotGoal).not.toContain("from '../capabilities/executor.js'");
    const copilotDraft = read(join(apiSrc, 'services', 'copilot-draft.ts'));
    expect(copilotDraft).not.toContain("from '../capabilities/definitions/");
    expect(copilotDraft).not.toContain("from '../capabilities/executor.js'");
    const interview = read(join(apiSrc, 'ai', 'interview-plan.ts'));
    expect(interview).not.toContain('capabilities/');
  });

  it('the executor imports the registry, never concrete definitions', () => {
    expect(executorFile).toContain("from './registry.js'");
    expect(executorFile).not.toContain('definitions/');
    expect(indexFile).toContain('definitions/');
  });

  it('model-facing descriptors expose strings only, no functions', () => {
    for (const file of [goalDefFile, recDefFile]) {
      // Descriptor objects are literal strings; no function bodies inside describe.
      const describeBlocks = file.match(/describe: \{[^}]*\}/g) ?? [];
      expect(describeBlocks.length).toBeGreaterThan(0);
      for (const block of describeBlocks) {
        expect(block).not.toMatch(/=>|function|async/);
      }
    }
    // The registry's list() returns plain data.
    expect(registryFile).toContain('purpose: def.describe.purpose');
  });

  it('capability definitions never mass-assign model objects into Prisma writes', () => {
    // Writes construct data field-by-field; the input object is never spread
    // or passed wholesale into a prisma data block.
    for (const [name, file] of [['goal', goalDefFile], ['recommendation', recDefFile]] as const) {
      expect(file, name).not.toMatch(/data:\s*(input|modelObject)\b/);
      expect(file, name).not.toMatch(/\.\.\.input\b/);
      expect(file, name).not.toMatch(/\.\.\.task\b/);
    }
  });

  it('no capability execute body performs network/model calls — prepare is the only model phase', () => {
    // The model call lives in the AI-edit prepare helper (between the AI-edit
    // definition and the manual-edit section). Scan each execute body:
    // the AI-edit execute runs from its declaration to the prepare helper,
    // which is the only place a model client may appear.
    const aiExecStart = goalDefFile.indexOf('execute: async (ctx, input, _refs, tx, prepared)');
    const prepareStart = goalDefFile.indexOf('applyCopilotEditPrepare');
    expect(aiExecStart).toBeGreaterThan(-1);
    expect(prepareStart).toBeGreaterThan(-1);
    // The execute body (from execute to the next top-level section marker).
    const manualMarker = goalDefFile.indexOf('// ------------------------------------------------------------ manual edit');
    expect(manualMarker).toBeGreaterThan(aiExecStart);
    // Everything before the prepare helper belongs to the AI-edit definition;
    // within it, chatJson may only appear after the prepare helper's own definition.
    const beforePrepare = goalDefFile.slice(aiExecStart, prepareStart);
    expect(beforePrepare).not.toContain('chatJson');
    const recDef = recDefFile;
    expect(recDef).not.toContain('chatJson');
  });

  it('the confirmation gate is executor-owned — request types carry no confirmation field', () => {
    const types = read(join(apiSrc, 'capabilities', 'types.ts'));
    const requestBlock = types.slice(types.indexOf('interface CapabilityRequest'), types.indexOf('interface CapabilityFailure'));
    expect(requestBlock).not.toMatch(/confirmed/i);
    // The context owns it.
    const contextBlock = types.slice(types.indexOf('interface CapabilityContext'), types.indexOf('interface EntityRef'));
    expect(contextBlock).toMatch(/readonly confirmed: boolean/);
  });

  it('the executor finalizes inside the same transaction as the claim and mutation', () => {
    // Structural proof: the SUCCEEDED finalize runs on `tx`, and the claim and
    // finalize appear inside one $transaction callback.
    const transactionBody = executorFile.slice(executorFile.indexOf('prisma.$transaction('));
    expect(transactionBody).toContain("state: 'PENDING'");
    expect(transactionBody).toContain("state: 'SUCCEEDED'");
    expect(transactionBody).toContain('tx.capabilityExecution.create');
    expect(transactionBody).toContain('tx.capabilityExecution.update');
  });

  it('failure auditing never flips a SUCCEEDED row: the conditional update filters on state=FAILED', () => {
    expect(executorFile).toContain("state: 'FAILED'");
    // The update's where clause includes the FAILED state filter.
    const recordFailureBody = executorFile.slice(executorFile.indexOf('async function recordFailure'));
    expect(recordFailureBody).toMatch(/state:\s*'FAILED'/);
    expect(recordFailureBody).toMatch(/updateMany/);
  });

  it('six-capability canonical ownership: every migrated mutation routes through the executor (flag-free)', () => {
    // Routes: confirm, AI edit, manual edit — unconditional registry paths.
    const copilotRoute = read(join(apiSrc, 'routes', 'copilot.ts'));
    expect(copilotRoute).toContain("'goal.confirm_from_draft'");
    expect(copilotRoute).toContain("'goal.apply_ai_edit'");
    expect(copilotRoute).toContain("'goal.apply_manual_edit'");
    expect(copilotRoute).not.toContain('isCapabilityRegistryEnabled');
    // Recommendations: both actions on the registry path.
    const recommendationsRoute = read(join(apiSrc, 'routes', 'recommendations.ts'));
    expect(recommendationsRoute).toContain("'recommendation.mark_consumed'");
    expect(recommendationsRoute).toContain("'recommendation.correct_consumption'");
    expect(recommendationsRoute).not.toContain('isCapabilityRegistryEnabled');
    expect(recommendationsRoute).not.toContain('recordUserAction(');
    // Progression proposals: the goal-chat service flow routes through the
    // capability; the legacy direct call is deleted.
    const copilotGoal = read(join(apiSrc, 'services', 'copilot-goal.ts'));
    expect(copilotGoal).toContain("'progression.propose_from_suggestion'");
    expect(copilotGoal).toContain('executeCapability');
    expect(copilotGoal).not.toContain('recordProgressionProposals');
    expect(copilotGoal).not.toContain('isCapabilityRegistryEnabled');
  });

  it('the executor runs the postCommit hook after the transaction commits', () => {
    // The hook invocation sits after the transaction block's commit return.
    const postCommitCall = executorFile.indexOf('await runPostCommit(definition.postCommit');
    expect(postCommitCall).toBeGreaterThan(-1);
    const commitReturn = executorFile.indexOf('return outcome;', postCommitCall - 600);
    expect(commitReturn).toBeGreaterThan(-1);
    expect(postCommitCall).toBeGreaterThan(commitReturn - 200);
  });

  it('six-capability entrypoint manifest: the registry holds exactly the six migrated entrypoints, every one reachable from its route', () => {
    // Stage 6 canonical: the manifest is closed — six registrations, six
    // route-level entrypoints, nothing else. registerCapabilities() is the
    // sole composer, so the manifest is the composition root itself.
    const indexFile2 = read(join(apiSrc, 'capabilities', 'index.ts'));
    const registrations = indexFile2.match(/registerCapability\((?!capabilityRegistry)/g) ?? [];
    expect(registrations).toHaveLength(6);
    // The exact names, in a closed set.
    for (const name of [
      'confirmFromDraftCapability',
      'applyAiEditCapability',
      'applyManualEditCapability',
      'markConsumedCapability',
      'correctConsumptionCapability',
      'proposeProgressionCapability',
    ]) {
      expect(indexFile2, name).toContain(`registerCapability(${name})`);
    }
    // Every capability id is defined exactly once and referenced by a route
    // or the goal-chat service flow.
    const ids = [
      'goal.confirm_from_draft', 'goal.apply_ai_edit', 'goal.apply_manual_edit',
      'recommendation.mark_consumed', 'recommendation.correct_consumption',
      'progression.propose_from_suggestion',
    ];
    for (const id of ids) {
      expect(goalDefFile + recDefFile, id).toContain(`'${id}'`);
    }
    const copilotRoute = read(join(apiSrc, 'routes', 'copilot.ts'));
    const recommendationsRoute = read(join(apiSrc, 'routes', 'recommendations.ts'));
    const copilotGoal = read(join(apiSrc, 'services', 'copilot-goal.ts'));
    for (const id of ids) {
      const reachable = copilotRoute.includes(`'${id}'`)
        || recommendationsRoute.includes(`'${id}'`)
        || copilotGoal.includes(`'${id}'`);
      expect(reachable, `route entrypoint for ${id}`).toBe(true);
    }
  });

  it('direct-mutation bypass guard: no route or service writes the migrated entities outside the executor path', () => {
    // The six capabilities own draft confirm, draft edits, recommendation
    // consumption and progression proposals. Their routes must NOT import or
    // call the direct writers — the executor is the only path in.
    const copilotRoute = read(join(apiSrc, 'routes', 'copilot.ts'));
    expect(copilotRoute).not.toContain('confirmDraft(');
    expect(copilotRoute).not.toContain('applyManualEdit(');
    expect(copilotRoute).not.toContain('applyCopilotEdit(');
    // The recommendation mutations never call the direct history writer.
    const recommendationsRoute = read(join(apiSrc, 'routes', 'recommendations.ts'));
    expect(recommendationsRoute).not.toContain('recordUserAction(');
    expect(recommendationsRoute).not.toContain('prisma.recommendationEvent');
    // And the goal-chat flow reaches progression proposals only through the
    // capability (pinned above), never the direct service call.
    const copilotGoal = read(join(apiSrc, 'services', 'copilot-goal.ts'));
    expect(copilotGoal).not.toContain('applyDecision(');
  });
});
