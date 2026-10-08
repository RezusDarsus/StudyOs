// Tutor session: the explicit step-by-step study experience. The plan (with reasons) renders as
// an ordered sequence; the runner renders one step at a time with a session header, progress,
// exercise/teaching content, and completion wired to the backend's advance endpoint.
window.StudyOSTutor = window.StudyOSTutor || {};

(function (Tutor) {
  'use strict';

  const { escapeHtml, percent, formatMinutes, apiMessage, quizEmptyMessage } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  let session = null;
  let exercise = null;
  let stepStartedAt = null;
  let context = {}; // { workspaceId(), requestedMinutes(), onDataChanged(), ensureChatAndSend() }

  function init(overrides = {}) { context = { ...context, ...overrides }; }

  /** Human label for a backend step kind — the visual step types the session renders. */
  function kindLabel(step) {
    const kinds = {
      LEARN: 'Explanation', WORKED_EXAMPLE: 'Example', GUIDED_PRACTICE: 'Guided practice',
      PRACTICE: 'Practice', EXERCISE: 'Independent practice', REVIEW: 'Review',
      REMEDIATE_PREREQUISITE: 'Remediation', DIAGNOSTIC: 'Diagnostic', EXAM_STYLE: 'Exam-style problem',
      CHECKPOINT: 'Checkpoint', RECALL_CHECK: 'Recall check', SUMMARY: 'Summary'
    };
    return kinds[step.kind] || step.kindLabel || 'Step';
  }

  function requestedMinutes() { return context.requestedMinutes ? context.requestedMinutes() : null; }

  function stepTags(step) {
    const tags = [`<span class="step-tag">${escapeHtml(kindLabel(step))}</span>`];
    if (step.targetLevelLabel) tags.push(`<span class="step-tag level">${escapeHtml(step.targetLevelLabel)}</span>`);
    if (step.topic) tags.push(`<span class="step-tag">${escapeHtml(step.topic)}</span>`);
    if (step.activityKind && !step.supportAllowed) tags.push('<span class="step-tag unaided">Unaided — no hints</span>');
    return `<div class="step-tags">${tags.join('')}</div>`;
  }

  function stepRow(step, status = '') {
    const mark = status === 'done' ? '✓' : status === 'skipped' ? '–' : step.ordinal + 1;
    const right = step.score == null ? `${step.minutes} min` : `${percent(step.score)} · ${step.minutes} min`;
    return `<article class="step ${status}"><span class="step-index">${mark}</span><div class="step-copy"><strong>${escapeHtml(step.title)}</strong>${step.why ? `<p>${escapeHtml(step.why)}</p>` : ''}${stepTags(step)}</div><span class="step-minutes">${right}</span></article>`;
  }

  function renderPlan(plan) {
    const panel = document.querySelector('#tutorPlan');
    const button = document.querySelector('#startTutorSessionButton');
    const minutesField = document.querySelector('#tutorMinutes');
    if (!panel) return;
    if (!plan) { panel.innerHTML = UI.errorState('StudyOS could not read today’s session. Check that the backend is running.', { retry: 'tutor-plan' }); if (button) button.disabled = true; return; }
    if (minutesField && !minutesField.value) minutesField.value = plan.availableMinutes || '';
    if (button) { button.textContent = plan.activeSessionId ? 'Resume study session →' : 'Start study session →'; button.disabled = !plan.steps?.length; }
    if (!plan.steps?.length) { panel.innerHTML = UI.emptyState(plan.blockedReason || 'StudyOS has nothing to schedule for this workspace yet.'); return; }
    const days = plan.daysUntilDeadline;
    panel.innerHTML = `<div class="tutor-summary">
        <div><small>WORKSPACE</small><strong>${escapeHtml(plan.workspace || 'Learning workspace')}</strong></div>
        ${days == null ? '' : `<div><small>${days < 0 ? 'DEADLINE PASSED' : 'DEADLINE IN'}</small><strong>${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}${days < 0 ? ' ago' : ''}</strong></div>`}
        <div><small>RECOMMENDED TODAY</small><strong>${formatMinutes(plan.totalMinutes)}</strong></div>
        <div><small>STEPS</small><strong>${plan.steps.length}</strong></div>
      </div>
      <div class="readiness-shift"><span>Expected readiness</span><b>${percent(plan.readinessBefore)}</b><span class="arrow">→</span><b class="projected">${percent(plan.readinessProjected)}</b><span>if you finish the whole sequence</span></div>
      <div class="step-list">${plan.steps.map(step => stepRow(step)).join('')}</div>`;
  }

  async function loadPlan() {
    const api = window.StudyOSApi;
    const state = window.StudyOSState;
    const workspaceId = state.courseId;
    if (!workspaceId || !api) return;
    const token = state.loadToken;
    try {
      const plan = await api.getTodaySession(workspaceId, requestedMinutes());
      if (!state.isCurrent(token)) return;
      state.setData({ tutorToday: plan });
    } catch (error) {
      if (!state.isCurrent(token)) return;
      console.error('Could not load today’s session', error);
      state.setData({ tutorToday: null });
    }
    renderPlan(state.data.tutorToday);
  }

  async function startOrResume(event) {
    const api = window.StudyOSApi;
    const state = window.StudyOSState;
    const workspaceId = state.courseId;
    if (!workspaceId || !api) return;
    const button = event?.currentTarget;
    const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'Preparing…'; }
    try {
      const active = state.data.tutorToday?.activeSessionId;
      session = active ? await api.getTutorSession(workspaceId, active) : await api.startTutorSession(workspaceId, requestedMinutes());
      exercise = null;
      await renderRunner();
      document.querySelector('#tutorRunner')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      console.error('Could not start the study session', error);
      const planPanel = document.querySelector('#tutorPlan');
      if (planPanel) planPanel.innerHTML = UI.errorState(UI.friendlyError(error, apiMessage(error, 'StudyOS could not start a study session for this workspace yet. Check the learning path and AI provider, then try again.')), { retry: 'tutor-plan' });
    } finally { if (button) { button.disabled = false; button.textContent = label; } }
  }

  function renderLog() {
    const log = document.querySelector('#tutorLog');
    if (!log) return;
    const finished = (session?.steps || []).filter(step => step.status === 'COMPLETED' || step.status === 'SKIPPED');
    log.classList.toggle('hidden', !finished.length);
    log.innerHTML = finished.length
      ? `<div class="panel-heading"><div><span class="eyebrow">THIS SESSION SO FAR</span><h2>${finished.length} step${finished.length === 1 ? '' : 's'} behind you</h2></div></div><div class="step-list">${finished.map(step => stepRow(step, step.status === 'SKIPPED' ? 'skipped' : 'done')).join('')}</div>`
      : '';
  }

  /** The generation mode that matches what this kind of step is for. */
  function stepMode(step) {
    if (step.kind === 'DIAGNOSTIC') return 'DIAGNOSTIC';
    if (step.kind === 'EXAM_STYLE' || step.kind === 'CHECKPOINT') return 'EXAM_STYLE';
    if (step.kind === 'REVIEW') return 'NEW_VARIANT';
    return 'PRACTICE';
  }

  async function loadStepExercise(step, body) {
    exercise = null;
    body.innerHTML = UI.loadingState('Building an exercise from your own source material…');
    try {
      const questions = await window.StudyOSApi.generateQuiz(context.workspaceId(), { topicId: step.topicId, count: 1, difficulty: step.difficulty, mode: stepMode(step), activityKind: step.activityKind, level: step.targetLevel });
      const question = questions?.[0];
      if (!question) {
        // An empty generation is an outcome, not a blank: say what happened and offer the way forward.
        body.innerHTML = UI.emptyState(quizEmptyMessage(stepMode(step)))
          + `<div class="runner-actions"><span class="spacer"></span><button class="text-button" data-step-skip type="button">Skip</button><button class="text-button" data-step-teach type="button">Teach me this instead →</button><button class="primary-button" data-step-done type="button">Mark done →</button></div>`;
        body.querySelector('[data-step-skip]')?.addEventListener('click', () => completeStep(step, { skipped: true }));
        body.querySelector('[data-step-teach]')?.addEventListener('click', () => teachStep(step));
        body.querySelector('[data-step-done]')?.addEventListener('click', () => completeStep(step, {}));
        return;
      }
      exercise = Tutor.renderExercise(body, question, { workspaceId: context.workspaceId(), supportAllowed: step.supportAllowed });
      const actions = document.createElement('div');
      actions.className = 'runner-actions';
      actions.innerHTML = `<span class="spacer"></span><button class="text-button" data-step-skip type="button">Skip</button><button class="primary-button" data-step-submit type="button">Submit answer</button>`;
      body.append(actions);
      actions.querySelector('[data-step-skip]')?.addEventListener('click', () => completeStep(step, { skipped: true }));
      actions.querySelector('[data-step-submit]')?.addEventListener('click', () => submitStepAnswer(step));
    } catch (error) {
      console.error('Could not build the exercise for this step', error);
      body.innerHTML = UI.errorState(UI.friendlyError(error, 'StudyOS could not build a supported exercise for this step from the available evidence.'))
        + `<div class="runner-actions"><span class="spacer"></span><button class="text-button" data-step-skip type="button">Skip</button><button class="text-button" data-step-teach type="button">Teach me this instead →</button><button class="primary-button" data-step-done type="button">Mark done →</button></div>`;
      body.querySelector('[data-step-skip]')?.addEventListener('click', () => completeStep(step, { skipped: true }));
      body.querySelector('[data-step-teach]')?.addEventListener('click', () => teachStep(step));
      body.querySelector('[data-step-done]')?.addEventListener('click', () => completeStep(step, {}));
    }
  }

  async function submitStepAnswer(step) {
    if (!exercise) return;
    const submit = document.querySelector('#tutorRunner [data-step-submit]');
    if (submit) { submit.disabled = true; submit.textContent = 'Grading…'; }
    try {
      const grade = await exercise.submit();
      if (!grade) return;
      exercise.lockAnswer();
      exercise.showGrade(grade, { onContinue: () => completeStep(step, { score: grade.score }) });
    } catch (error) {
      console.error('Could not grade this step', error);
      exercise.showGradeError(error);
    } finally {
      if (submit) { submit.disabled = false; submit.textContent = 'Submit answer'; }
    }
  }

  async function renderRunner() {
    const panel = document.querySelector('#tutorRunner');
    if (!panel) return;
    if (!session) { panel.classList.add('hidden'); panel.innerHTML = ''; document.querySelector('#tutorLog')?.classList.add('hidden'); return; }
    renderLog();
    const step = session.current;
    if (!step) { renderFinished(); return; }
    panel.classList.remove('hidden');
    panel.innerHTML = `<div class="runner-heading"><div><span class="eyebrow">SESSION · STEP ${step.ordinal + 1} OF ${session.steps.length}</span><h2>${escapeHtml(step.title)}</h2></div><span class="runner-progress">${escapeHtml(kindLabel(step))} · ${step.minutes} min planned</span></div>`
      + `${step.why ? `<p class="runner-why">${escapeHtml(step.why)}</p>` : ''}`
      + `${stepTags(step)}`
      + `<div class="runner-body" id="tutorStepBody">${UI.loadingState('Preparing this step…')}</div>`;
    stepStartedAt = Date.now();
    const body = document.querySelector('#tutorStepBody');
    if (step.activityKind) await loadStepExercise(step, body); else renderTeachingStep(step, body);
  }

  function renderTeachingStep(step, body) {
    body.innerHTML = `<h3>${escapeHtml(kindLabel(step))}</h3><p>${escapeHtml(step.why || 'StudyOS will teach this from your own material.')}</p><div class="teaching-note" id="tutorTeaching"></div>`
      + `<div class="runner-actions"><span class="spacer"></span><button class="text-button" data-step-skip type="button">Skip</button><button class="text-button" data-step-teach type="button">Teach me this →</button><button class="primary-button" data-step-done type="button">Mark done →</button></div>`;
    body.querySelector('[data-step-skip]')?.addEventListener('click', () => completeStep(step, { skipped: true }));
    body.querySelector('[data-step-teach]')?.addEventListener('click', () => teachStep(step));
    body.querySelector('[data-step-done]')?.addEventListener('click', () => completeStep(step, {}));
  }

  function teachingPrompt(step) {
    const level = step.targetLevelLabel ? ` Aim at this level of demand: ${step.targetLevelLabel}.` : '';
    if (step.kind === 'WORKED_EXAMPLE') return `Walk me through one worked example of "${step.title}" taken from my uploaded material, step by step, saying what justifies each step.${level}`;
    if (step.kind === 'REMEDIATE_PREREQUISITE') return `I am missing the prerequisite "${step.title}". Teach only that, as briefly as it can be taught correctly, then show where it is used in my material.`;
    return `Teach me "${step.title}" using my uploaded material: an intuitive explanation first, then the formal definition, then one example from the evidence.${level}`;
  }

  async function teachStep(step) {
    const target = document.querySelector('#tutorTeaching');
    const button = document.querySelector('[data-step-teach]');
    if (!target) return;
    if (button) { button.disabled = true; button.textContent = 'Teaching…'; }
    target.textContent = 'Reading your sources and writing the explanation…';
    try {
      const reply = await context.ensureChatAndSend(teachingPrompt(step));
      target.replaceChildren();
      window.StudyOSChat?.renderAssistantContent(target, reply.content || 'The AI returned an empty explanation.');
    } catch (error) {
      console.error('Could not teach this step', error);
      target.textContent = apiMessage(error, 'StudyOS could not write this explanation. Check the backend and AI provider.');
    } finally { if (button) { button.disabled = false; button.textContent = 'Teach me again →'; } }
  }

  async function completeStep(step, { score = null, skipped = false } = {}) {
    const api = window.StudyOSApi;
    const elapsed = stepStartedAt ? Math.round((Date.now() - stepStartedAt) / 60000) : 0;
    const minutes = elapsed >= 1 ? Math.min(480, elapsed) : null;
    document.querySelectorAll('#tutorStepBody button').forEach(button => { button.disabled = true; });
    try {
      session = await api.advanceTutorStep(context.workspaceId(), session.id, step.ordinal, { score, minutes, skipped });
      exercise = null;
      await renderRunner();
      if (!session.current && context.onDataChanged) await context.onDataChanged();
    } catch (error) {
      console.error('Could not record this step', error);
      const body = document.querySelector('#tutorStepBody');
      if (body) body.insertAdjacentHTML('afterbegin', UI.errorState(UI.friendlyError(error, apiMessage(error, 'StudyOS could not record that step. Check that the backend is running, then try again.'))));
      document.querySelectorAll('#tutorStepBody button').forEach(button => { button.disabled = false; });
    }
  }

  function renderFinished() {
    const panel = document.querySelector('#tutorRunner');
    const done = session.steps.filter(step => step.status === 'COMPLETED');
    const skipped = session.steps.filter(step => step.status === 'SKIPPED');
    const scored = done.filter(step => step.score != null);
    const worked = done.reduce((total, step) => total + (step.minutes || 0), 0);
    const landed = session.readinessAfter ?? session.readinessProjected;
    panel.classList.remove('hidden');
    panel.innerHTML = `<div class="runner-heading"><div><span class="eyebrow">SESSION COMPLETE</span><h2>${done.length} of ${session.steps.length} steps done</h2></div><span class="runner-progress">${formatMinutes(worked)} worked</span></div>`
      + `<div class="readiness-shift"><span>Readiness</span><b>${percent(session.readinessBefore)}</b><span class="arrow">→</span><b class="projected">${percent(landed)}</b><span>${session.readinessAfter == null ? 'projected' : `measured · ${percent(session.readinessProjected)} was projected`}</span></div>`
      + `${scored.length ? `<p class="runner-why">Average score across ${scored.length} graded step${scored.length === 1 ? '' : 's'}: ${percent(scored.reduce((total, step) => total + step.score, 0) / scored.length)}. Every one of them moved your mastery record and the difficulty ladder.</p>` : ''}`
      + `${skipped.length ? `<p class="runner-why">${skipped.length} step${skipped.length === 1 ? '' : 's'} skipped — StudyOS will bring ${skipped.length === 1 ? 'it' : 'them'} back when it plans the next session.</p>` : ''}`
      + `<div class="runner-actions"><span class="spacer"></span><button class="text-button" id="closeTutorRunnerButton" type="button">Close</button><button class="primary-button" id="planNextTutorSessionButton" type="button">Plan the next session →</button></div>`;
    document.querySelector('#planNextTutorSessionButton')?.addEventListener('click', async () => { session = null; await loadPlan(); await renderRunner(); });
    document.querySelector('#closeTutorRunnerButton')?.addEventListener('click', () => { session = null; renderRunner(); });
  }

  function reset() { session = null; exercise = null; const panel = document.querySelector('#tutorRunner'); if (panel) { panel.classList.add('hidden'); panel.innerHTML = ''; } document.querySelector('#tutorLog')?.classList.add('hidden'); }

  Tutor.init = init;
  Tutor.renderTutorPlan = renderPlan;
  Tutor.loadTutorPlan = loadPlan;
  Tutor.startOrResumeTutorSession = startOrResume;
  Tutor.renderTutorRunner = renderRunner;
  Tutor.tutorKindLabel = kindLabel;
  Tutor.resetTutorSession = reset;
  Tutor.activeSession = () => session;
})(window.StudyOSTutor);
