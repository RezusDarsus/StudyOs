// Exercise view: renders one generated exercise with the right input for its answer type, the
// incremental hint ladder, and a graded-result panel that shows score, feedback, demonstrated and
// missing concepts, and the mastery change — never raw grader JSON.
window.StudyOSTutor = window.StudyOSTutor || {};

(function (Tutor) {
  'use strict';

  const { escapeHtml, percent, apiMessage } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  const ANSWER_LABELS = {
    TEXT: 'Written answer',
    MULTIPLE_CHOICE: 'Multiple choice',
    NUMERIC: 'Numeric answer',
    CODE: 'Code / problem solving',
    EQUATION: 'Equation',
    PROOF: 'Proof or justification'
  };

  function answerLabel(type) { return ANSWER_LABELS[type] || (type ? String(type).replaceAll('_', ' ') : 'Written answer'); }

  /**
   * Input per backend answer type. The backend does not expose MCQ options, so a multiple-choice
   * item still gets a written answer field labelled for what it is — the input never pretends to
   * be a choice list the backend did not send.
   */
  function answerInput(type, id) {
    if (String(type).toUpperCase() === 'NUMERIC') {
      return `<input id="${id}" class="numeric-answer" inputmode="decimal" autocomplete="off" placeholder="Your numeric answer…" aria-label="Your numeric answer" />`;
    }
    return `<textarea id="${id}" rows="4" placeholder="Work through your reasoning here…" aria-label="Your answer"></textarea>`;
  }

  function conceptLines(grade) {
    const concepts = grade.conceptScores || [];
    const demonstrated = concepts.filter(concept => (concept.score ?? 0) >= 0.7).map(concept => concept.concept || concept.name).filter(Boolean);
    const missing = concepts.filter(concept => (concept.score ?? 1) < 0.7).map(concept => concept.concept || concept.name).filter(Boolean);
    const lines = [];
    if (demonstrated.length) lines.push(`<div class="unit-group"><span class="card-label">DEMONSTRATED</span><div class="chip-row">${demonstrated.map(name => `<span class="topic-chip ok">${escapeHtml(name)}</span>`).join('')}</div></div>`);
    if (missing.length) lines.push(`<div class="unit-group"><span class="card-label">NEEDS WORK</span><div class="chip-row">${missing.map(name => `<span class="topic-chip warn">${escapeHtml(name)}</span>`).join('')}</div></div>`);
    (grade.mistakes || []).slice(0, 3).forEach(mistake => {
      const label = typeof mistake === 'string' ? mistake : mistake.label || mistake.mistake;
      if (label) lines.push(`<div class="unit-group"><span class="card-label">MISTAKE TO REVIEW</span><p class="reason-list">${escapeHtml(label)}</p></div>`);
    });
    return lines.join('');
  }

  function nextActionLine(grade) {
    const ladder = [];
    if (grade.ladderAction) ladder.push(`${String(grade.ladderAction).replaceAll('_', ' ').toLowerCase()}${grade.nextLevelLabel ? ` → ${grade.nextLevelLabel}` : ''}`);
    if (grade.remediationTopic) ladder.push(`next: repair ${grade.remediationTopic}`);
    if (grade.ladderReason) ladder.push(grade.ladderReason);
    return ladder.join(' · ');
  }

  /**
   * Renders the graded result. Correctness, score, feedback, concepts and mastery stay separate
   * facts; nothing here invents a verdict the backend did not give.
   */
  function renderGrade(container, grade, handlers) {
    // Handlers are optional and callers pass null after tutor-session grades; a null argument must
    // render the grade, not land in the error branch.
    const onContinue = handlers?.onContinue;
    const correct = grade.correctness === 'CORRECT';
    const mastery = grade.masteryBefore == null ? '' : `<small>Mastery ${percent(grade.masteryBefore)} → ${percent(grade.masteryAfter)}${grade.evidenceWeight < 1 ? ` · counted at ${percent(grade.evidenceWeight)} because support was used` : ''}</small>`;
    const nextAction = nextActionLine(grade);
    container.innerHTML = `<div class="grade-note ${correct ? '' : 'incorrect'}"><strong>${escapeHtml((grade.correctness || '').replaceAll('_', ' '))} · ${percent(grade.score)}</strong><span class="grade-text"></span>${mastery}</div>`
      + conceptLines(grade)
      + (grade.misconception && grade.misconceptionVerdict === 'CONFIRMED' ? `<div class="error-state warn" role="status"><strong>Misconception recorded</strong><span>${escapeHtml(grade.misconception)}</span></div>` : '')
      + (nextAction ? `<p class="reason-list">${escapeHtml(nextAction)}</p>` : '')
      + (onContinue ? '<div class="modal-actions"><button class="primary-button continue-button" type="button">Continue →</button></div>' : '');
    window.StudyOSChat?.appendRichInline?.(container.querySelector('.grade-text'), grade.feedback || '');
    if (onContinue) container.querySelector('.continue-button')?.addEventListener('click', onContinue);
  }

  /**
   * Renders an exercise with its answer form and hint ladder. Returns { getAnswer, setBusy,
   * renderGrade, ladder } so the host (tutor step or study session) controls submission.
   */
  function renderExercise(container, question, options = {}) {
    const supportAllowed = options.supportAllowed !== false;
    container.innerHTML = `<h3>${escapeHtml(question.levelLabel || options.levelLabel || 'Exercise')}</h3>`
      + `<div class="exercise-prompt"></div>`
      + `<small>${escapeHtml(answerLabel(question.answerType))} · difficulty ${percent(question.difficulty)}${question.diagnostic ? ' · diagnostic probe' : ''}</small>`
      + `<div class="exercise-answer">${answerInput(question.answerType, options.inputId || 'exerciseAnswer')}</div>`
      + `<div class="hint-ladder-host"></div><div class="exercise-grade"></div>`;
    window.StudyOSChat?.appendRichInline?.(container.querySelector('.exercise-prompt'), question.prompt || '');
    const answer = container.querySelector('.exercise-answer')?.querySelector('input,textarea');
    const gradeHost = container.querySelector('.exercise-grade');
    const ladderHost = container.querySelector('.hint-ladder-host');
    const ladder = window.StudyOSTutor.createHintLadder(ladderHost, {
      workspaceId: options.workspaceId,
      itemId: question.id,
      initialLevel: options.initialSupportLevel || 0
    });
    if (supportAllowed) ladder.attachTrigger();
    return {
      question,
      ladder,
      getAnswer: () => (answer?.value || '').trim(),
      focusAnswer: () => answer?.focus(),
      lockAnswer() { if (answer) answer.disabled = true; },
      unlockAnswer() { if (answer) { answer.disabled = false; answer.value = ''; } },
      async submit() {
        const value = (answer?.value || '').trim();
        if (!value) { answer?.focus(); return null; }
        return window.StudyOSApi.submitAnswer(options.workspaceId, question.id, value);
      },
      showGrade(grade, handlers) { renderGrade(gradeHost, grade, handlers); },
      showGradeError(error) {
        gradeHost.innerHTML = UI.errorState(UI.friendlyError(error, apiMessage(error, 'StudyOS could not grade that answer.')));
      }
    };
  }

  Tutor.answerLabel = answerLabel;
  Tutor.renderExercise = renderExercise;
  Tutor.renderExerciseGrade = renderGrade;
})(window.StudyOSTutor);
