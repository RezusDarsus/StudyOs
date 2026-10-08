// Readiness breakdown panel (the "Memory" view). Loaded before app.js.
window.StudyOSPanels = window.StudyOSPanels || {};

(function (Panels) {
  'use strict';

  const { escapeHtml } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  // Readiness, mastery and prediction confidence are different questions; this panel only ever
  // shows the measured components of the readiness score.
  function renderReadinessBreakdown(breakdown) {
    const panel = document.querySelector('#readinessBreakdown');
    if (!panel) return;
    const metrics = breakdown
      ? [['Concept mastery', breakdown.conceptMastery], ['High-priority topics', breakdown.highPriorityTopics], ['Practice coverage', breakdown.practiceCoverage], ['Retention', breakdown.retention]]
      : [];
    panel.innerHTML = metrics.length
      ? metrics.map(([label, value]) => `<div class="metric-row"><span>${escapeHtml(label)}</span><strong>${Math.round(value * 100)}%</strong></div>`).join('')
        + `<div class="metric-row"><span>Open misconceptions</span><strong>${breakdown.openMisconceptions}</strong></div>`
      : UI.emptyState('Complete assessments to build an explainable readiness score.');
  }

  Panels.renderReadinessBreakdown = renderReadinessBreakdown;
})(window.StudyOSPanels);
