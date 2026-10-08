// Topic detail view: everything StudyOS knows about one topic in one place, with only actions the
// backend actually supports. Data comes from existing endpoints: topic capsules (summary, sources,
// assessment patterns, misconceptions), objectives, relations, ladder, and the learner state.
window.StudyOSPanels = window.StudyOSPanels || {};

(function (Panels) {
  'use strict';

  const { escapeHtml, formatMinutes, percent, apiMessage } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  function factRow(label, value) { return `<div class="metric-row"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`; }

  function relationNames(relations, topicId, direction) {
    return (relations || [])
      .filter(edge => edge[direction]?.topicId === topicId || (direction === 'prerequisites' ? edge.prerequisiteTopicId === topicId : edge.dependentTopicId === topicId))
      .map(edge => direction === 'prerequisites' ? (edge.dependentName || edge.dependentTopicId) : (edge.prerequisiteName || edge.prerequisiteTopicId));
  }

  /**
   * The backend relation rows are flat edges: {sourceTopicId, sourceName, targetTopicId,
   * targetName, relationType}. A prerequisite of this topic is an edge where this topic is the
   * dependent (PREREQUISITE_OF / BUILDS_ON is already normalised in the topic_prerequisites view
   * the backend reads from — here we re-read it plainly).
   */
  function collectRelations(edges, topicId) {
    const prerequisites = new Map();
    const dependents = new Map();
    (edges || []).forEach(edge => {
      const type = String(edge.relationType || '').toUpperCase();
      let prerequisiteId = null, dependentId = null;
      if (type === 'PREREQUISITE_OF') { prerequisiteId = edge.sourceTopicId; dependentId = edge.targetTopicId; }
      else if (type === 'BUILDS_ON') { prerequisiteId = edge.targetTopicId; dependentId = edge.sourceTopicId; }
      if (prerequisiteId == null || dependentId == null) return;
      const nameFor = id => (id === edge.sourceTopicId ? edge.sourceName : edge.targetName) || id;
      if (prerequisiteId === topicId) dependents.set(dependentId, nameFor(dependentId));
      if (dependentId === topicId) prerequisites.set(prerequisiteId, nameFor(prerequisiteId));
    });
    return { prerequisites: [...prerequisites.values()], dependents: [...dependents.values()] };
  }

  function actionButtons(topicId) {
    return `<div class="modal-actions topic-actions">
      <button class="primary-button" data-topic-action="study" data-topic-id="${escapeHtml(topicId)}" type="button">Study this topic →</button>
      <button class="text-button" data-topic-action="practice" data-topic-id="${escapeHtml(topicId)}" type="button">Practice</button>
      <button class="text-button" data-topic-action="review" data-topic-id="${escapeHtml(topicId)}" type="button">Review</button>
      <button class="text-button" data-topic-action="tutor" data-topic-id="${escapeHtml(topicId)}" type="button">Ask tutor</button>
    </div>`;
  }

  function renderInto(panel, topic, capsule, objectives, relations, ladder) {
    const state = window.StudyOSState;
    const related = collectRelations(relations, topic.id);
    const misconceptions = capsule?.misconceptions || (state.data.learner?.openMisconceptions || []).filter(item => item.topicId === topic.id);
    const sources = capsule?.sources || [];
    const patterns = capsule?.assessmentPatterns || [];
    panel.innerHTML = `
      <div class="topic-facts">
        ${factRow('Mastery', UI.masteryBadge(topic.mastery))}
        ${factRow('Confidence', UI.confidenceBadge(topic.confidence, topic.evidenceCount))}
        ${topic.difficulty != null ? factRow('Demand', UI.badge(UI.difficultyLabel(topic.difficulty), 'muted')) : ''}
        ${topic.importance != null ? factRow('Importance', UI.badge(`${Math.round(topic.importance * 100)}% of course weight`, 'muted')) : ''}
        ${factRow('Source coverage', UI.badge(`${topic.sourceCount} source${topic.sourceCount === 1 ? '' : 's'} · ${topic.evidenceCount} evidence chunk${topic.evidenceCount === 1 ? '' : 's'}`, topic.sourceCount ? 'medium' : 'warn'))}
        ${topic.reviewDueAt ? factRow('Review', UI.badge(reviewDueLabel(topic.reviewDueAt) || 'Review scheduled', 'warn')) : ''}
      </div>
      ${topic.description ? `<p class="profile-note">${escapeHtml(topic.description)}</p>` : ''}
      ${objectives?.length ? `<div class="unit-group"><span class="card-label">WHAT YOU SHOULD BE ABLE TO DO</span><ul class="rich-list">${objectives.slice(0, 6).map(objective => `<li>${escapeHtml(objective.statement)}</li>`).join('')}</ul></div>` : ''}
      ${related.prerequisites.length ? `<div class="unit-group"><span class="card-label">RESTS ON</span><div class="chip-row">${related.prerequisites.map(name => `<span class="topic-chip">${escapeHtml(name)}</span>`).join('')}</div></div>` : ''}
      ${related.dependents.length ? `<div class="unit-group"><span class="card-label">UNLOCKS</span><div class="chip-row">${related.dependents.map(name => `<span class="topic-chip">${escapeHtml(name)}</span>`).join('')}</div></div>` : ''}
      ${misconceptions.length ? `<div class="unit-group"><span class="card-label">ACTIVE MISCONCEPTIONS</span>${misconceptions.map(item => `<div class="memory-row"><div><strong>${escapeHtml(item.label)}</strong><small>seen ${item.occurrences} time${item.occurrences === 1 ? '' : 's'}</small></div></div>`).join('')}</div>` : ''}
      ${sources.length ? `<div class="unit-group"><span class="card-label">SOURCE MATERIAL</span>${sources.map(source => `<div class="memory-row"><div><strong>${escapeHtml(source.documentType?.replaceAll('_', ' ') || 'Material')}</strong><small>${source.count} document${source.count === 1 ? '' : 's'}</small></div>${UI.sourceBadge('MATERIAL')}</div>`).join('')}</div>` : UI.emptyState('No source material bound to this topic yet.')}
      ${patterns.length ? `<div class="unit-group"><span class="card-label">HOW IT HAS BEEN ASKED</span>${patterns.map(pattern => `<div class="memory-row"><div><strong>${escapeHtml((pattern.type || '').replaceAll('_', ' '))}</strong><small>${pattern.count} question${pattern.count === 1 ? '' : 's'}</small></div></div>`).join('')}</div>` : ''}
      ${ladder ? `<div class="unit-group"><span class="card-label">DIFFICULTY LADDER</span><div class="memory-row"><div><strong>${escapeHtml(ladder.level?.label || 'Level 1')}</strong><small>${ladder.attempts || 0} graded attempt${(ladder.attempts || 0) === 1 ? '' : 's'}${ladder.lastReason ? ` · ${escapeHtml(ladder.lastReason)}` : ''}</small></div></div></div>` : ''}
      ${capsule?.summary ? `<details class="why-details"><summary>StudyOS summary</summary><p>${escapeHtml(capsule.summary)}</p></details>` : ''}
      ${actionButtons(topic.id)}`;
  }

  async function open(topicId, topicName) {
    const api = window.StudyOSApi;
    const state = window.StudyOSState;
    const workspaceId = state.courseId;
    if (!workspaceId || !topicId || !api) return;
    const modal = document.querySelector('#topicModal');
    const body = document.querySelector('#topicBody');
    const title = document.querySelector('#topicTitle');
    if (!modal || !body) return;
    const topic = state.data.topics.find(entry => entry.id === topicId) || { id: topicId, name: topicName };
    title.textContent = topic.name || topicName || 'Topic';
    modal.classList.remove('hidden');
    body.innerHTML = UI.loadingState('Collecting what StudyOS knows about this topic…');
    const token = state.loadToken;
    const [capsule, objectives, relations, ladder] = await Promise.all([
      api.getTopicCapsule(workspaceId, topicId).catch(() => null),
      api.listTopicObjectives(workspaceId, topicId).catch(() => []),
      api.listTopicRelations(workspaceId).catch(() => []),
      api.getTopicLadder(workspaceId, topicId).catch(() => null)
    ]);
    if (!state.isCurrent(token)) return;
    renderInto(body, topic, capsule, objectives, relations, ladder);
  }

  function close() { document.querySelector('#topicModal')?.classList.add('hidden'); }

  /** Wires the four actions to the backend flows that already exist. */
  function bindActions({ startSession, askTutor }) {
    document.addEventListener('click', async event => {
      const button = event.target.closest?.('[data-topic-action]');
      if (!button) return;
      const topicId = button.dataset.topicId;
      const state = window.StudyOSState;
      const topic = state.data.topics.find(entry => entry.id === topicId);
      const name = topic?.name || 'this topic';
      if (button.dataset.topicAction === 'tutor') {
        close();
        await askTutor(`Teach me "${name}" using my uploaded material: intuition first, then the formal definition, then one example.`);
        return;
      }
      close();
      const mode = button.dataset.topicAction === 'practice' ? 'PRACTICE'
        : button.dataset.topicAction === 'review' ? 'NEW_VARIANT' : 'PRACTICE';
      await startSession({ topicId, mode, title: topic?.name });
    });
  }

  Panels.openTopic = open;
  Panels.closeTopic = close;
  Panels.bindTopicActions = bindActions;
  Panels.collectTopicRelations = collectRelations;
})(window.StudyOSPanels);
