// Learner state views: long-term profile, readiness improvements, misconceptions, preferences,
// and the learning history timeline.
window.StudyOSPanels = window.StudyOSPanels || {};

(function (Panels) {
  'use strict';

  const { escapeHtml, percent, formatDate } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  function renderImprovements(improvements) {
    const target = document.querySelector('#readinessImprovements');
    if (!target) return;
    target.innerHTML = improvements?.length
      ? improvements.map(item => `<div class="memory-row"><div><strong>${escapeHtml(item.action)}</strong><small>${escapeHtml(item.reason)}</small></div><span class="source-type">${escapeHtml(item.estimatedImpact)} impact</span></div>`).join('')
      : UI.emptyState('No evidence-backed improvements are available yet.');
  }

  function renderMisconceptions(misconceptions) {
    const target = document.querySelector('#memoryMisconceptions');
    if (!target) return;
    target.innerHTML = misconceptions?.length
      ? misconceptions.map(item => `<div class="memory-row"><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.status)} · seen ${item.occurrences} time${item.occurrences === 1 ? '' : 's'}</small></div><button class="text-button" data-resolve-misconception="${escapeHtml(item.id)}" type="button">Mark corrected</button></div>`).join('')
      : UI.emptyState('No active misconceptions detected.');
  }

  function renderPreferences(preferences) {
    const target = document.querySelector('#memoryPreferences');
    if (!target) return;
    target.innerHTML = preferences?.length
      ? preferences.map(item => `<div class="memory-row"><div><strong>${escapeHtml(item.key.replaceAll('_', ' '))}</strong><small>${escapeHtml(item.value)}</small></div><span class="source-type">${escapeHtml(item.source)}</span></div>`).join('')
      : UI.emptyState('No learning preferences saved yet.');
  }

  function renderTraits(selector, traits, empty) {
    const target = document.querySelector(selector);
    if (!target) return;
    target.innerHTML = traits?.length
      ? traits.map(trait => `<div class="trait ${trait.polarity === 'RISK' ? 'negative' : trait.polarity === 'NEUTRAL' ? 'neutral' : ''}"><div class="trait-top"><strong>${escapeHtml(trait.subject || trait.kindLabel)}</strong><span class="trait-kind">${escapeHtml(trait.kindLabel)}</span></div>${trait.detail ? `<p>${escapeHtml(trait.detail)}</p>` : ''}<small>${trait.evidenceCount} observation${trait.evidenceCount === 1 ? '' : 's'} · ${percent(trait.confidence)} confidence</small></div>`).join('')
      : UI.emptyState(empty);
  }

  function renderProfile(profile) {
    const note = document.querySelector('#profileNote');
    const hints = document.querySelector('#profileHints');
    if (!note || !hints) return;
    const traits = profile?.traits || [];
    note.textContent = traits.length ? `Built from your own recorded work · last recomputed ${formatDate(profile.computedAt)}` : 'StudyOS has not seen enough of your work to describe how you learn yet. Answer a few exercises and this fills in.';
    hints.innerHTML = (profile?.teachingHints || []).map(hint => `<div class="profile-hint">${escapeHtml(hint)}</div>`).join('');
    renderTraits('#profileStrengths', profile?.strengths, 'Nothing has held long enough to call a strength yet.');
    renderTraits('#profileRisks', profile?.risks, 'No recurring risk has shown up yet.');
    renderTraits('#profileBehaviour', profile?.behaviour, 'Not enough sessions yet to describe your study rhythm.');
  }

  function renderHistory(events) {
    const timeline = document.querySelector('#timeline');
    if (!timeline) return;
    timeline.innerHTML = events?.length
      ? events.map(event => `<article class="timeline-item"><div class="timeline-date">${escapeHtml(formatDate(event.occurredAt))}</div><div class="timeline-dot"></div><div><strong>${escapeHtml(String(event.eventType || '').replaceAll('_', ' '))}</strong><p>${escapeHtml(event.topicName || 'Project activity')}</p><small>${escapeHtml(typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload ?? {}))}</small></div></article>`).join('')
      : UI.emptyState('No learning history yet. Your completed sessions will appear here.');
  }

  /** Binds "Mark corrected" buttons after any re-render of the misconceptions panel. */
  function bindMisconceptionResolve(handler) {
    document.querySelectorAll('[data-resolve-misconception]').forEach(button => {
      if (button.dataset.bound) return;
      button.dataset.bound = 'true';
      button.addEventListener('click', () => handler(button.dataset.resolveMisconception));
    });
  }

  Panels.renderImprovements = renderImprovements;
  Panels.renderMisconceptions = renderMisconceptions;
  Panels.renderPreferences = renderPreferences;
  Panels.renderLearnerProfile = renderProfile;
  Panels.renderHistory = renderHistory;
  Panels.bindMisconceptionResolve = bindMisconceptionResolve;
})(window.StudyOSPanels);
