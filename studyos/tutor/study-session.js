// Focused study session (the modal opened from plan tasks and the Continue Studying CTA). Uses the
// shared exercise view and hint ladder so both study paths behave identically.
window.StudyOSTutor = window.StudyOSTutor || {};

(function (Tutor) {
  'use strict';

  const { escapeHtml, percent, apiMessage } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  let activeSession = null;
  let activeExercise = null;
  let ladder = null;
  let timerHandle = null;
  let context = {};

  function init(overrides = {}) { context = { ...context, ...overrides }; }

  function elapsedMinutes() { return activeSession?.startedAt ? Math.max(1, Math.ceil((Date.now() - new Date(activeSession.startedAt).getTime()) / 60000)) : 1; }

  function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }

  function startTimer() {
    stopTimer();
    const update = () => {
      if (!activeSession) return;
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(activeSession.startedAt).getTime()) / 1000));
      const field = document.querySelector('#sessionTimer');
      if (field) field.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    };
    update();
    timerHandle = setInterval(update, 1000);
  }

  function close() { document.querySelector('#sessionModal')?.classList.add('hidden'); stopTimer(); activeSession = null; activeExercise = null; ladder?.dispose(); ladder = null; }

  async function loadExercise(difficulty, mode) {
    const exerciseHost = document.querySelector('#sessionExercise');
    exerciseHost.innerHTML = UI.loadingState('Generating and verifying a new exercise…');
    document.querySelector('#sessionAnswerForm')?.classList.add('hidden');
    const feedback = document.querySelector('#sessionFeedback');
    feedback.classList.add('hidden');
    const questions = await window.StudyOSApi.generateQuiz(context.workspaceId(), { topicId: activeSession.topicId, count: 1, difficulty, mode });
    const question = questions?.[0];
    if (!question) {
      // Empty generation is an outcome with a reason — show it, keep the session open, offer a way forward.
      exerciseHost.innerHTML = UI.emptyState(window.StudyOSFormat.quizEmptyMessage(mode))
        + `<div class="modal-actions"><button class="text-button" id="sessionStudyInsteadButton" type="button">Teach me this instead →</button></div>`;
      document.querySelector('#sessionStudyInsteadButton')?.addEventListener('click', () => {
        exerciseHost.innerHTML = UI.emptyState('Ask in the chat to the left — "teach me this" — and come back to practice after.');
      });
      document.querySelector('#completeSessionButton')?.classList.remove('hidden');
      return;
    }
    ladder?.dispose();
    exerciseHost.innerHTML = '';
    activeExercise = Tutor.renderExercise(exerciseHost, question, { workspaceId: context.workspaceId(), mode });
    ladder = activeExercise.ladder;
    document.querySelector('#sessionAnswerForm')?.classList.remove('hidden');
    document.querySelector('#sessionHintButton')?.classList.toggle('hidden', false);
  }

  async function open(task = null) {
    const api = window.StudyOSApi;
    const state = window.StudyOSState;
    const workspaceId = state.courseId;
    if (!workspaceId || !api) return;
    const fallbackTopic = state.data.topics.find(topic => topic.mastery < .7) || state.data.topics[0];
    try {
      const details = task?.taskId ? await api.getStudyTask(workspaceId, task.taskId) : null;
      activeSession = await api.startStudySession(workspaceId, { taskId: task?.taskId || null, topicId: details?.topicId || task?.topicId || fallbackTopic?.id || null });
      ladder?.dispose(); ladder = null;
      document.querySelector('#sessionModal')?.classList.remove('hidden');
      document.querySelector('#sessionTitle').textContent = details?.title || `Study ${activeSession.topic || 'your workspace'}`;
      document.querySelector('#sessionTopic').textContent = (details?.topic || activeSession.topic || 'STUDY SESSION').toUpperCase();
      document.querySelector('#sessionReason').textContent = details?.whyNow || task?.reason || 'This session targets your current highest-value learning opportunity.';
      document.querySelector('#sessionOutcome').textContent = details?.expectedOutcome || 'Generate useful learning evidence and identify the next best step.';
      document.querySelector('#sessionSources').textContent = details?.sourceReferences?.length
        ? details.sourceReferences.map(source => `${source.document}, pages ${source.pageStart}${source.pageEnd !== source.pageStart ? `–${source.pageEnd}` : ''}`).join('; ')
        : 'StudyOS will retrieve the strongest available source evidence.';
      document.querySelector('#sessionExercise').innerHTML = UI.loadingState('Preparing your evidence-grounded exercise…');
      document.querySelector('#sessionAnswerForm')?.classList.add('hidden');
      document.querySelector('#sessionFeedback')?.classList.add('hidden');
      document.querySelector('#completeSessionButton')?.classList.add('hidden');
      startTimer();
      await loadExercise(details?.difficulty ?? .55, details?.action === 'EXAM_STYLE_TEST' ? 'EXAM_STYLE' : details?.action === 'REVIEW_MISTAKE' ? 'MISCONCEPTION_FOLLOW_UP' : 'PRACTICE');
    } catch (error) {
      console.error('Could not start study session', error);
      // The modal may not have opened yet (session start failed): open it so the error is seen.
      document.querySelector('#sessionModal')?.classList.remove('hidden');
      document.querySelector('#sessionExercise').innerHTML = UI.errorState(UI.friendlyError(error, 'StudyOS could not prepare an exercise. Check the AI provider and source processing state, then try again.'), { retry: 'study-session-retry' });
      document.querySelector('#completeSessionButton')?.classList.remove('hidden');
    }
  }

  /** Retry path for a failed session start: re-open with the last attempted task. */
  let lastTask = null;

  async function openWithRetry(task = null) {
    lastTask = task;
    await open(task);
  }

  async function requestHint() {
    if (!ladder) return;
    const support = await ladder.release();
    if (support?.revealsSolution) document.querySelector('#completeSessionButton')?.classList.remove('hidden');
  }

  async function submitAnswer(event) {
    event.preventDefault();
    if (!activeExercise) return;
    const button = event.currentTarget.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    try {
      const answer = activeExercise.getAnswer();
      if (!answer) { activeExercise.focusAnswer(); return; }
      const grade = await window.StudyOSApi.submitAnswer(context.workspaceId(), activeExercise.question.id, answer);
      activeExercise.lockAnswer();
      const feedback = document.querySelector('#sessionFeedback');
      feedback.classList.remove('hidden');
      feedback.className = `session-feedback ${grade.correctness === 'INCORRECT' ? 'incorrect' : ''}`;
      Tutor.renderExerciseGrade(feedback, grade, null);
      const followUp = document.createElement('div');
      followUp.className = 'modal-actions';
      if (grade.correctness !== 'CORRECT') {
        followUp.innerHTML = '<button class="primary-button" id="followUpExerciseButton" type="button">Try targeted follow-up →</button>';
        feedback.append(followUp);
        followUp.querySelector('#followUpExerciseButton')?.addEventListener('click', async clickEvent => {
          clickEvent.currentTarget.disabled = true;
          try { await loadExercise(Math.max(.25, activeExercise.question.difficulty - (grade.correctness === 'INCORRECT' ? .15 : .05)), 'MISCONCEPTION_FOLLOW_UP'); }
          catch (error) { console.error('Could not generate follow-up exercise', error); clickEvent.currentTarget.disabled = false; }
        });
      }
      document.querySelector('#completeSessionButton')?.classList.remove('hidden');
    } catch (error) {
      console.error('Could not grade answer', error);
      const feedback = document.querySelector('#sessionFeedback');
      feedback.classList.remove('hidden');
      feedback.innerHTML = UI.errorState(UI.friendlyError(error, apiMessage(error, 'StudyOS could not grade that answer right now.')));
    } finally { if (button) button.disabled = false; }
  }

  async function complete() {
    if (!activeSession) return;
    try {
      const result = await window.StudyOSApi.completeStudySession(context.workspaceId(), activeSession.id, { durationMinutes: elapsedMinutes() });
      const summary = result.summary;
      close();
      if (context.onDataChanged) await context.onDataChanged();
      window.alert(`Session complete: ${summary.exercises} exercise${summary.exercises === 1 ? '' : 's'}, ${summary.correct} correct${summary.masteryBefore == null ? '' : `, mastery ${Math.round(summary.masteryBefore * 100)}% → ${Math.round(summary.masteryAfter * 100)}%`}.`);
    } catch (error) { console.error('Could not complete study session', error); }
  }

  function activeSessionId() { return activeSession?.id || null; }

  Tutor.initStudySession = init;
  Tutor.openStudySession = openWithRetry;
  Tutor.closeStudySession = close;
  Tutor.requestSessionHint = requestHint;
  Tutor.submitSessionAnswer = submitAnswer;
  Tutor.completeStudySessionModal = complete;
  Tutor.studySessionId = activeSessionId;
})(window.StudyOSTutor);
