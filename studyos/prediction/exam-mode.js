// Exam mode: the bounded "today" preparation plan from the backend planner, with each block's
// machine-readable reason codes translated into learner-readable explanations.
window.StudyOSPanels = window.StudyOSPanels || {};

(function (Panels) {
  'use strict';

  const { escapeHtml, formatMinutes, apiMessage } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  /** Reason codes come from the backend planner verbatim; this is the translation layer. */
  const REASON_TEXT = {
    MASTERY_WEAK: 'Mastery is below the level the exam will demand',
    EXAM_RELEVANCE_HIGH: 'Historical evidence puts this high on likely exam topics',
    RETENTION_RISK: 'Spaced review is due before the exam',
    MISCONCEPTION_ACTIVE: 'An unresolved misconception is active',
    PREREQUISITE_GAP: 'A prerequisite is still weak and is holding this topic back',
    EXAM_STRUCTURE_MIX: 'Practice in the question shapes past exams actually used',
    RECENT_MISTAKE: 'A recent mistake points here'
  };

  function reasonLine(codes) {
    const known = (codes || []).map(code => REASON_TEXT[code]).filter(Boolean);
    return known;
  }

  function renderBlock(block) {
    const reasons = reasonLine(block.reasonCodes);
    const reasonHtml = reasons.length
      ? `<ul class="reason-list">${reasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
      : (block.reason ? `<p class="reason-list">${escapeHtml(block.reason)}</p>` : '');
    return `<article class="exam-mode-block"><span class="step-index">${block.ordinal + 1}</span>`
      + `<div class="block-copy"><strong>${escapeHtml(block.title)}</strong>${reasonHtml}</div>`
      + `<span class="step-minutes">${block.minutes} min</span></article>`;
  }

  function render(plan) {
    const panel = document.querySelector('#examModePanel');
    const button = document.querySelector('#startExamModeButton');
    if (!panel) return;
    if (!plan) { panel.innerHTML = UI.emptyState('Start exam preparation to get a bounded plan for today.'); if (button) button.disabled = false; return; }
    if (!plan.blocks?.length) {
      panel.innerHTML = UI.emptyState(plan.note || 'Nothing needs exam-mode work right now.');
      if (button) button.disabled = false;
      return;
    }
    const days = plan.daysToExam;
    panel.innerHTML = `<div class="panel-heading"><div><span class="eyebrow">EXAM MODE · TODAY</span><h2>${plan.totalMinutes} minutes planned</h2></div>`
      + `<span class="badge badge-medium">${days == null ? 'No exam date set' : `${days} day${days === 1 ? '' : 's'} to exam`}</span></div>`
      + plan.blocks.map(renderBlock).join('')
      + `<div class="modal-actions"><button class="text-button" id="examModeToTutorButton" type="button">Open the tutor session for these topics →</button></div>`;
    if (button) { button.disabled = false; button.textContent = 'Replan preparation'; }
    document.querySelector('#examModeToTutorButton')?.addEventListener('click', () => {
      const tutorButton = document.querySelector('#startTutorSessionButton');
      if (tutorButton) tutorButton.click();
    });
  }

  /** Minutes for the bounded plan: the tutor field when set, otherwise the backend default. */
  function requestedMinutes() {
    const value = Number(document.querySelector('#tutorMinutes')?.value);
    return Number.isFinite(value) && value > 0 ? Math.max(5, Math.min(480, Math.round(value))) : null;
  }

  async function load(workspaceId) {
    const api = window.StudyOSApi;
    const state = window.StudyOSState;
    const panel = document.querySelector('#examModePanel');
    const button = document.querySelector('#startExamModeButton');
    if (!panel || !api || !workspaceId) return;
    const token = state.loadToken;
    if (button) { button.disabled = true; button.textContent = 'Planning…'; }
    panel.innerHTML = UI.loadingState('Reading exam relevance, mastery and prerequisites…');
    try {
      const plan = await api.getExamMode(workspaceId, requestedMinutes());
      if (!state.isCurrent(token)) return; // workspace switched mid-plan: do not paint stale blocks
      render(plan);
    } catch (error) {
      if (!state.isCurrent(token)) return;
      console.error('Could not load the exam-mode plan', error);
      panel.innerHTML = UI.errorState(UI.friendlyError(error, 'Exam preparation could not be planned right now. Your regular study session still works.'), { retry: 'exam-mode' });
      if (button) { button.disabled = false; button.textContent = 'Start Exam Preparation'; }
    }
  }

  Panels.renderExamMode = render;
  Panels.loadExamMode = load;
  Panels.examModeReasonText = reasonLine;
})(window.StudyOSPanels);
