// Dashboard: answers "what should I do now, how prepared am I, where am I weak, what is due, what
// changed" from live workspace data. The primary CTA starts a real tutor session.
window.StudyOSDashboard = window.StudyOSDashboard || {};

(function (Dashboard) {
  'use strict';

  const { escapeHtml, percent, formatMinutes, formatDay, reviewDueLabel, studyWeek, formatDate } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  /** "What changed" — the few most recent learning events, in learner language. */
  function recentChanges(events) {
    return (events || []).slice(0, 4).map(event => {
      const label = String(event.eventType || '').replaceAll('_', ' ').toLowerCase();
      return `<div class="memory-row"><div><strong>${escapeHtml(event.topicName || 'Workspace activity')}</strong><small>${escapeHtml(label)} · ${escapeHtml(formatDate(event.occurredAt))}</small></div></div>`;
    }).join('');
  }

  function dueReviewItem(topic) {
    const due = reviewDueLabel(topic.reviewDueAt) || 'Review scheduled';
    return `<div class="memory-row"><div><strong>${escapeHtml(topic.name)}</strong><small>${escapeHtml(due)}</small></div>${UI.masteryBadge(topic.mastery)}</div>`;
  }

  function weakTopicItem(topic, examByTopicId) {
    const signal = examByTopicId.get(topic.id);
    const relevance = signal ? UI.relevanceBadge(signal.relevance) : '';
    return `<div class="memory-row"><div><strong>${escapeHtml(topic.name)}</strong><small>${topic.evidenceCount ? `${topic.evidenceCount} evidence chunk${topic.evidenceCount === 1 ? '' : 's'}` : 'Not assessed yet'}</small></div><span class="badge-line">${UI.masteryBadge(topic.mastery)}${relevance}</span></div>`;
  }

  function misconceptionItem(item) {
    return `<div class="memory-row"><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.status || 'ACTIVE')} · seen ${item.occurrences} time${item.occurrences === 1 ? '' : 's'}</small></div><button class="text-button" data-resolve-misconception="${escapeHtml(item.id)}" type="button">Mark corrected</button></div>`;
  }

  function curriculumPosition(curriculum, frontier) {
    if (!curriculum) return null;
    const next = frontier?.next;
    if (next) return { title: next.title, detail: `Next up on your learning path · ${formatMinutes(next.estimatedMinutes)}` };
    return { title: curriculum.title, detail: `${curriculum.totalLessons} lessons · ${formatMinutes(curriculum.totalMinutes)}` };
  }

  function render() {
    const state = window.StudyOSState;
    const data = state?.data;
    const panel = document.querySelector('#dashboardPanel');
    if (!panel || !data) return;

    const prediction = data.prediction;
    const plan = data.plan;
    const readiness = plan?.id ? Math.round((plan.readiness || 0) * 100) : null;
    const topics = data.topics || [];
    const weak = topics.filter(topic => topic.mastery < .7).slice(0, 5);
    const due = topics.filter(topic => topic.reviewDueAt && new Date(topic.reviewDueAt).getTime() <= Date.now() + 86400000).slice(0, 4);
    const misconceptions = (data.learner?.openMisconceptions || []).slice(0, 3);
    const position = curriculumPosition(data.curriculum, data.frontier);
    const examByTopicId = new Map((data.examAnalysis || []).map(signal => [signal.topicId, signal]));
    const week = studyWeek(data.events);
    const nextReview = data.prediction?.nextReviewAt;
    const nextSession = data.tutorToday;

    const nextAction = nextSession?.steps?.length
      ? { title: nextSession.steps[0].title, detail: `${nextSession.steps.length} planned step${nextSession.steps.length === 1 ? '' : 's'} · ${formatMinutes(nextSession.totalMinutes)} · expected readiness ${percent(nextSession.readinessProjected)}`, ready: true }
      : position
        ? { title: position.title, detail: position.detail, ready: false }
        : null;

    panel.innerHTML = `
      <div class="dashboard-top">
        <div class="dashboard-readiness">
          <span class="card-label">HOW PREPARED AM I</span>
          <div class="readiness-line"><strong>${readiness == null ? '—' : `${readiness}%`}</strong>
            <span>${prediction?.status === 'INSUFFICIENT_EVIDENCE' ? 'Awaiting evidence' : prediction?.status ? `Forecast: ${prediction.status.replaceAll('_', ' ')}` : readiness == null ? 'Complete an assessment to activate readiness' : 'Based on assessed topics'}</span></div>
          <div class="coverage-row"><div class="bar"><span style="width:${readiness || 0}%"></span></div></div>
          ${prediction?.predictedFocus ? `<small>Predicted focus: ${escapeHtml(prediction.predictedFocus)}</small>` : ''}
        </div>
        <div class="dashboard-position">
          <span class="card-label">WHERE I AM</span>
          ${position ? `<strong>${escapeHtml(position.title)}</strong><small>${escapeHtml(position.detail)}</small>` : UI.emptyState('Build a learning path to see your position.')}
          <small>Studied this week: ${formatMinutes(week.minutes)} · ${week.sessions} session${week.sessions === 1 ? '' : 's'}</small>
        </div>
      </div>
      <div class="dashboard-next">
        <div class="dashboard-next-copy">
          <span class="card-label">WHAT SHOULD I DO NOW</span>
          ${nextAction ? `<strong>${escapeHtml(nextAction.title)}</strong><small>${escapeHtml(nextAction.detail)}</small>` : UI.emptyState('Add course material or start online research to build this course.')}
        </div>
        <button class="primary-button dashboard-cta" id="continueStudyingButton" type="button" ${nextSession?.steps?.length ? '' : 'data-fallback="plan"'}>Continue Studying →</button>
      </div>
      <div class="dashboard-grid">
        <div class="dashboard-cell"><span class="card-label">REVIEWS DUE</span>
          ${due.length ? due.map(dueReviewItem).join('') : UI.emptyState('Nothing is due for review right now.')}
          ${nextReview ? `<small>Next review window: ${escapeHtml(formatDate(nextReview))}</small>` : ''}
        </div>
        <div class="dashboard-cell"><span class="card-label">WEAK TOPICS</span>
          ${weak.length ? weak.map(topic => weakTopicItem(topic, examByTopicId)).join('') : UI.emptyState('No measured weak topics yet — gaps appear after study activity.')}
        </div>
        <div class="dashboard-cell"><span class="card-label">ACTIVE MISCONCEPTIONS</span>
          ${misconceptions.length ? misconceptions.map(misconceptionItem).join('') : UI.emptyState('No active misconceptions detected.')}
        </div>
        <div class="dashboard-cell"><span class="card-label">WHAT CHANGED</span>
          ${data.events?.length ? recentChanges(data.events) : UI.emptyState('No learning events recorded yet.')}
        </div>
      </div>`;

    // Primary CTA: a real tutor session when one is planned; otherwise the study-session flow.
    document.querySelector('#continueStudyingButton')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        if (nextSession?.steps?.length) {
          window.StudyOSTutor?.startOrResumeTutorSession?.({ currentTarget: null });
          window.StudyOSRouter?.showView('tutor');
        } else {
          const pending = (plan?.tasks || []).find(task => task.status === 'PENDING') || null;
          await window.StudyOSTutor?.openStudySession?.(pending);
        }
      } finally { button.disabled = false; }
    });
    document.querySelectorAll('[data-resolve-misconception]').forEach(button => button.addEventListener('click', async () => {
      try {
        await window.StudyOSApi.resolveMisconception(state.courseId, button.dataset.resolveMisconception);
        state.setData({ learner: await window.StudyOSApi.getLearnerState(state.courseId) });
        render();
        window.StudyOSPanels?.renderReadinessBreakdown?.(state.data.prediction?.breakdown);
      } catch (error) { console.error('Could not correct misconception', error); }
    }));
  }

  Dashboard.renderDashboard = render;
})(window.StudyOSDashboard);
