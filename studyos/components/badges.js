// Badge components: measured values get human labels. Raw 0.4382-style numbers never reach the
// learner without a word attached. All labels are pure functions so they are directly testable.
window.StudyOSUI = window.StudyOSUI || {};

(function (UI) {
  'use strict';

  const { escapeHtml } = window.StudyOSFormat;

  /** Mastery uses the vocabulary of learning, not percentages alone. */
  function masteryLabel(value) {
    const mastery = Math.max(0, Math.min(1, Number(value) || 0));
    if (mastery >= 0.85) return { label: 'Strong', tone: 'strong' };
    if (mastery >= 0.7) return { label: 'Held', tone: 'strong' };
    if (mastery >= 0.45) return { label: 'Developing', tone: 'medium' };
    if (mastery > 0) return { label: 'Weak', tone: 'warn' };
    return { label: 'Not started', tone: 'muted' };
  }

  /** Evidence-backed confidence: how much recorded work stands behind the mastery figure. */
  function confidenceLabel(value, evidenceCount) {
    const confidence = Math.max(0, Math.min(1, Number(value) || 0));
    if (!evidenceCount && confidence < 0.3) return { label: 'No evidence yet', tone: 'muted' };
    if (confidence >= 0.7) return { label: 'High', tone: 'strong' };
    if (confidence >= 0.4) return { label: 'Medium', tone: 'medium' };
    return { label: 'Low', tone: 'warn' };
  }

  /** Exam relevance: a prediction, always paired with the confidence in that prediction. */
  function relevanceLabel(value) {
    const relevance = Math.max(0, Math.min(1, Number(value) || 0));
    if (relevance >= 0.7) return { label: 'High relevance', tone: 'strong' };
    if (relevance >= 0.45) return { label: 'Moderate relevance', tone: 'medium' };
    if (relevance > 0) return { label: 'Low relevance', tone: 'muted' };
    return { label: 'No exam signal', tone: 'muted' };
  }

  /** Coverage levels come from the backend research coverage engine verbatim. */
  function coverageLabel(level) {
    const normalized = String(level || '').toUpperCase();
    if (normalized === 'STRONG') return { label: 'Evidence coverage: Strong', tone: 'strong' };
    if (normalized === 'MODERATE') return { label: 'Evidence coverage: Moderate', tone: 'medium' };
    if (normalized === 'WEAK') return { label: 'Evidence coverage: Weak', tone: 'warn' };
    return { label: 'Evidence coverage: None', tone: 'muted' };
  }

  /** Difficulty as a demand level, when the topic model has measured one. */
  function difficultyLabel(value) {
    if (value == null) return null;
    const difficulty = Math.max(0, Math.min(1, Number(value) || 0));
    if (difficulty >= 0.8) return 'Very demanding';
    if (difficulty >= 0.6) return 'Demanding';
    if (difficulty >= 0.35) return 'Moderate';
    return 'Foundational';
  }

  function badge(text, tone) {
    return `<span class="badge badge-${escapeHtml(tone || 'muted')}">${escapeHtml(text)}</span>`;
  }

  function masteryBadge(value) { const item = masteryLabel(value); return badge(`${item.label} · ${Math.round((Number(value) || 0) * 100)}%`, item.tone); }
  function confidenceBadge(value, evidenceCount) { const item = confidenceLabel(value, evidenceCount); return badge(`Confidence: ${item.label}`, item.tone); }
  function relevanceBadge(value) { const item = relevanceLabel(value); return badge(item.label, item.tone); }
  function coverageBadge(level) { const item = coverageLabel(level); return badge(item.label, item.tone); }

  /**
   * Provenance badge for a source. The backend's own provenance fields decide the category —
   * never the title text. Every category carries a text label, so colour is never the only signal.
   */
  function sourceBadge(kind) {
    const normalized = String(kind || '').toUpperCase();
    if (normalized === 'EXTERNAL') return badge('External research', 'external');
    if (normalized === 'DERIVED') return badge('StudyOS synthesis', 'derived');
    return badge('Course material', 'material');
  }

  UI.masteryLabel = masteryLabel;
  UI.confidenceLabel = confidenceLabel;
  UI.relevanceLabel = relevanceLabel;
  UI.coverageLabel = coverageLabel;
  UI.difficultyLabel = difficultyLabel;
  UI.badge = badge;
  UI.masteryBadge = masteryBadge;
  UI.confidenceBadge = confidenceBadge;
  UI.relevanceBadge = relevanceBadge;
  UI.coverageBadge = coverageBadge;
  UI.sourceBadge = sourceBadge;
})(window.StudyOSUI);
