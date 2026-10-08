// Knowledge map + adaptive difficulty ladder views.
window.StudyOSPanels = window.StudyOSPanels || {};

(function (Panels) {
  'use strict';

  const { escapeHtml, percent } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  function renderKnowledge(topics) {
    const map = document.querySelector('#knowledgeMap');
    if (!map) return;
    if (!topics?.length) { map.innerHTML = UI.emptyState('Upload sources and complete a study activity to build the knowledge map. Open a topic to see its detail.'); return; }
    map.innerHTML = `<div class="map-card"><h3>Workspace topics</h3>${topics.map(topic => {
      const badge = UI.masteryBadge(topic.mastery);
      return `<div class="map-topic" role="button" tabindex="0" data-open-topic="${escapeHtml(topic.id)}" data-topic-name="${escapeHtml(topic.name)}" aria-label="Open topic ${escapeHtml(topic.name)}"><div><strong>${escapeHtml(topic.name)}</strong><small>${escapeHtml(topic.description || `${topic.sourceCount} evidence chunks`)}</small></div><div class="bar ${(topic.mastery || 0) < 60 ? 'warn' : ''}"><span style="width:${Math.round((topic.mastery || 0) * 100)}%"></span></div><div class="topic-status">${badge}</div></div>`;
    }).join('')}</div>`;
  }

  function renderLadder(rows, levels) {
    const list = document.querySelector('#ladderList');
    const legend = document.querySelector('#ladderLegend');
    if (!list) return;
    const levelList = levels || [];
    if (legend && levelList.length) legend.textContent = `${levelList.length} levels · ${levelList[0].label} → ${levelList[levelList.length - 1].label}`;
    if (!rows?.length) { list.innerHTML = UI.emptyState('No topic has been graded yet. The ladder starts moving after your first answered exercise.'); return; }
    const rungs = levelList.length || 6;
    list.innerHTML = rows.map(row => {
      const rank = row.level?.rank || 1;
      const notes = [];
      if (row.diagnosticPending) notes.push('diagnostic next — finding the missing prerequisite');
      if (row.remediationTopic) notes.push(`repairing ${row.remediationTopic} first`);
      if (row.returnLevel && row.returnLevel.rank > rank) notes.push(`returning to ${row.returnLevel.label}`);
      if (!notes.length && row.lastReason) notes.push(row.lastReason);
      const track = Array.from({ length: rungs }, (_, index) => `<i class="${index + 1 <= rank ? (row.diagnosticPending ? 'diagnostic' : 'filled') : ''}"></i>`).join('');
      return `<div class="ladder-row"><div><strong>${escapeHtml(row.topic || 'Topic')}</strong><small>${escapeHtml(notes.length ? notes.join(' · ') : `${row.attempts} graded attempt${row.attempts === 1 ? '' : 's'}`)}</small></div><div class="ladder-track">${track}</div><div class="ladder-level">${escapeHtml(row.level?.label || '')}</div></div>`;
    }).join('');
  }

  Panels.renderKnowledge = renderKnowledge;
  Panels.renderLadder = renderLadder;
})(window.StudyOSPanels);
