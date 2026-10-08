// Curriculum view: module → lesson tree with expand/collapse, current-topic highlight, and the
// measured facts for each lesson (mastery, confidence, exam relevance, source coverage, review
// due, estimated time) rendered as human labels. A lesson row opens the topic detail view.
window.StudyOSPanels = window.StudyOSPanels || {};

(function (Panels) {
  'use strict';

  const { escapeHtml, formatMinutes, reviewDueLabel } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  function lessonRow(lesson, placement = null, context = {}) {
    const mastery = Math.round((lesson.effectiveMastery ?? lesson.mastery ?? 0) * 100);
    const held = mastery >= 60;
    const locked = !held && placement === 'locked';
    const state = held ? 'Held' : placement === 'next' ? 'Start here' : placement === 'ready' ? 'Ready' : placement === 'gap' ? 'Blocking' : locked ? 'Locked' : lesson.evidenceCount ? 'Weak' : 'Not started';
    const topic = context.topicsById?.get(lesson.topicId);
    const relevance = context.examByTopicId?.get(lesson.topicId);
    const due = reviewDueLabel(topic?.reviewDueAt);
    const badges = [
      UI.masteryBadge(lesson.effectiveMastery ?? lesson.mastery ?? 0),
      topic ? UI.confidenceBadge(topic.confidence, topic.evidenceCount) : '',
      relevance ? UI.relevanceBadge(relevance.relevance) : '',
      topic?.difficulty != null && UI.difficultyLabel(topic.difficulty) ? UI.badge(UI.difficultyLabel(topic.difficulty), 'muted') : '',
      due ? UI.badge(due, 'warn') : ''
    ].filter(Boolean).join('');
    return `<div class="lesson ${locked ? 'locked' : ''}" data-lesson="${escapeHtml(lesson.id)}" data-topic-id="${escapeHtml(lesson.topicId || '')}" data-lesson-title="${escapeHtml(lesson.title)}" role="button" tabindex="0" aria-label="Open lesson ${escapeHtml(lesson.title)}" title="Open this lesson"><div><strong>${escapeHtml(lesson.title)}</strong><small>${escapeHtml(lesson.objective || lesson.targetLevelLabel || '')}</small><div class="badge-line">${badges}</div></div><div class="lesson-side"><div class="bar ${held ? '' : 'warn'}"><span style="width:${mastery}%"></span></div><div class="lesson-state ${locked ? 'locked' : held ? '' : 'warn'}">${escapeHtml(state)} · ${mastery}% · ${formatMinutes(lesson.estimatedMinutes)}</div></div></div>`;
  }

  function renderFrontier(frontier, curriculum) {
    const panel = document.querySelector('#curriculumFrontier');
    if (!panel) return;
    const any = frontier && (frontier.next || frontier.ready?.length || frontier.criticalGaps?.length);
    if (!any) { panel.innerHTML = UI.emptyState(curriculum ? 'Nothing is unlocked right now — every lesson is either already held or waiting on a prerequisite.' : 'Build a learning path to see what is unlocked next.'); return; }
    const context = rowContext();
    panel.innerHTML = `<div class="panel-heading"><div><span class="eyebrow">WHAT IS UNLOCKED</span><h2>${escapeHtml(frontier.next?.title || 'Your frontier')}</h2></div></div>`
      + `<div class="coverage-row"><span>Curriculum held</span><div class="bar"><span style="width:${Math.round((frontier.coverage || 0) * 100)}%"></span></div><b>${Math.round((frontier.coverage || 0) * 100)}%</b></div>`
      + `<div class="frontier-grid">`
      + `<div><span class="card-label">START HERE</span>${frontier.next ? lessonRow(frontier.next, 'next', context) : UI.emptyState('Nothing is unlocked yet.')}</div>`
      + `<div><span class="card-label">ALSO READY</span>${frontier.ready?.length ? frontier.ready.map(lesson => lessonRow(lesson, 'ready', context)).join('') : UI.emptyState('No other lesson is unlocked.')}</div>`
      + `<div><span class="card-label">BLOCKING THE REST</span>${frontier.criticalGaps?.length ? frontier.criticalGaps.map(lesson => lessonRow(lesson, 'gap', context)).join('') : UI.emptyState('Nothing is blocking progress.')}</div>`
      + `</div>`;
  }

  function rowContext() {
    const state = window.StudyOSState;
    return {
      topicsById: new Map((state?.data.topics || []).map(topic => [topic.id, topic])),
      examByTopicId: new Map((state?.data.examAnalysis || []).map(signal => [signal.topicId, signal]))
    };
  }

  function renderCurriculum(curriculum, frontier, levelLabel) {
    const tree = document.querySelector('#curriculumTree');
    const button = document.querySelector('#generateCurriculumButton');
    if (!tree) return;
    if (button) button.textContent = curriculum ? 'Rebuild learning path →' : 'Build learning path →';
    if (!curriculum) { tree.innerHTML = UI.emptyState('No learning path yet. Upload your syllabus or lecture material, or describe your goal when you create the workspace, then build one.'); return; }
    const context = rowContext();
    const nextId = frontier?.next?.id || null;
    const ready = new Set((frontier?.ready || []).map(lesson => lesson.id));
    const gaps = new Set((frontier?.criticalGaps || []).map(lesson => lesson.id));
    const placement = lesson => lesson.id === nextId ? 'next' : ready.has(lesson.id) ? 'ready' : gaps.has(lesson.id) ? 'gap' : 'locked';
    const label = levelLabel || (rank => rank ? `Level ${rank}` : '');
    // First unlocked module starts expanded; the rest stay collapsed so a long course stays scannable.
    const currentModuleId = curriculum.modules.find(module => module.lessons.some(lesson => lesson.id === nextId))?.id;
    tree.innerHTML = `<section class="panel"><div class="panel-heading"><div><span class="eyebrow">${escapeHtml((curriculum.mode || 'CURRICULUM').replaceAll('_', ' '))}</span><h2>${escapeHtml(curriculum.title || 'Learning path')}</h2></div><span class="source-type">${curriculum.totalLessons} lesson${curriculum.totalLessons === 1 ? '' : 's'} · ${formatMinutes(curriculum.totalMinutes)}</span></div>${curriculum.summary ? `<p class="profile-note">${escapeHtml(curriculum.summary)}</p>` : ''}${curriculum.goal ? `<p class="profile-note"><strong>Goal:</strong> ${escapeHtml(curriculum.goal)}</p>` : ''}</section>`
      + curriculum.modules.map(module => {
        const isCurrent = module.id === currentModuleId;
        return `<details class="module-card ${isCurrent ? 'current' : ''}" ${isCurrent ? 'open' : ''}><summary class="module-heading"><span class="module-toggle" aria-hidden="true"></span><h3>${module.ordinal}. ${escapeHtml(module.title)}${isCurrent ? '<span class="badge badge-strong">Current</span>' : ''}</h3><small>${escapeHtml(module.targetLevelLabel || label(module.targetLevel))} · ${formatMinutes(module.estimatedMinutes)} · ${module.lessons.length} lesson${module.lessons.length === 1 ? '' : 's'}</small></summary>`
          + `<div class="module-body">${module.summary ? `<p>${escapeHtml(module.summary)}</p>` : ''}${module.lessons.map(lesson => lessonRow(lesson, placement(lesson), context)).join('')}</div></details>`;
      }).join('');
  }

  async function load(workspaceId) {
    const api = window.StudyOSApi;
    const state = window.StudyOSState;
    const tree = document.querySelector('#curriculumTree');
    if (!tree || !api || !workspaceId) return;
    const token = state.loadToken;
    if (!state.data.curriculum) tree.innerHTML = UI.loadingState('Loading your learning path…');
    try {
      const [curriculum, frontier] = await Promise.all([
        api.getCurriculum(workspaceId),
        api.getCurriculumFrontier(workspaceId).catch(() => null)
      ]);
      if (!state.isCurrent(token)) return;
      state.setData({ curriculum, frontier });
      renderCurriculum(curriculum, frontier, state.data.levelLabel);
      renderFrontier(frontier, curriculum);
    } catch (error) {
      if (!state.isCurrent(token)) return;
      tree.innerHTML = UI.errorState(UI.friendlyError(error, 'Your learning path could not be loaded. Build one from your material to get started.'), { retry: 'curriculum' });
    }
  }

  Panels.lessonRow = lessonRow;
  Panels.renderFrontier = renderFrontier;
  Panels.renderCurriculum = renderCurriculum;
  Panels.loadCurriculum = load;
})(window.StudyOSPanels);
