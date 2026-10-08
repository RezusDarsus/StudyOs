// Exam page: likely topics and question structures, with relevance, mastery and prediction
// confidence rendered as three separate facts — never merged into one magic score — plus an
// expandable "why this matters" built from the exam analysis evidence.
window.StudyOSPanels = window.StudyOSPanels || {};

(function (Panels) {
  'use strict';

  const { escapeHtml } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  function relevanceLabel(probability) {
    const value = Number(probability) || 0;
    return value >= 0.7 ? 'High relevance' : value >= 0.45 ? 'Moderate relevance' : value > 0 ? 'Low relevance' : 'No signal';
  }

  function structureLabel(probability) {
    const value = Number(probability) || 0;
    return value >= 0.7 ? 'Likely' : value >= 0.45 ? 'Possible' : 'Occurs occasionally';
  }

  /**
   * Evidence text from the exam analysis signal, already human phrasing from the backend.
   * Rendered as text, so nothing in it can become markup.
   */
  function evidenceSummary(topicId, examAnalysis) {
    const signal = (examAnalysis || []).find(item => item.topicId === topicId || item.topic === topicId);
    if (!signal) return null;
    const evidence = signal.evidence;
    if (!evidence) return null;
    let parsed = evidence;
    if (typeof evidence === 'string') { try { parsed = JSON.parse(evidence); } catch (_) { return String(evidence); } }
    const parts = [];
    if (parsed?.pastExams && parsed.pastExams !== '0/0') parts.push(`appeared on ${parsed.pastExams} past exam(s)`);
    if (Number(parsed.pastExamPoints) > 0) parts.push(`${Math.round(Number(parsed.pastExamPoints))} points across past exams`);
    if (Number(parsed.homeworkQuestions) > 0) parts.push(`${parsed.homeworkQuestions} homework question(s)`);
    if (Number(parsed.lectureCount) > 0) parts.push(`${parsed.lectureCount} lecture reference(s)`);
    if (Number(parsed.syllabusDocuments) > 0) parts.push('named in the syllabus');
    return parts.length ? parts.join(' · ') : null;
  }

  function renderExamIntelligence(report, context = {}) {
    const topicsPanel = document.querySelector('#examTopicPredictions');
    const structurePanel = document.querySelector('#examStructurePredictions');
    if (!topicsPanel || !structurePanel) return;
    const unavailable = !report || report.status === 'INSUFFICIENT_EVIDENCE';
    if (unavailable) {
      topicsPanel.innerHTML = UI.emptyState(report?.disclaimer || 'Upload past exams and assessed material to activate predictions.');
      structurePanel.innerHTML = UI.emptyState('StudyOS will not invent question structures without enough historical evidence.');
      renderBacktestDebug(null);
      return;
    }

    // Mastery comes from the learner's measured state (PredictionService risks), relevance from
    // the historical-exam model, and the two confidences are different facts: prediction
    // confidence says how likely the ranking is to hold, evidence confidence says how much
    // recorded exam evidence stands behind the topic at all. They are joined, never averaged.
    const risks = context.risks || [];
    topicsPanel.innerHTML = report.likelyTopics.map(item => {
      const risk = risks.find(entry => entry.topicId === item.topicId) || risks.find(entry => entry.name === item.topic);
      const mastery = risk ? UI.masteryBadge(risk.effectiveMastery ?? risk.mastery) : UI.badge('Mastery: not measured', 'muted');
      const evidence = risk ? evidenceConfidenceBadge(risk.evidenceConfidence, risk.evidenceCount) : '';
      const detailId = `exam-why-${item.topicId}`;
      const why = evidenceSummary(item.topicId, context.examAnalysis) || item.why;
      return `<div class="memory-row exam-topic-row"><div><strong>${escapeHtml(item.topic)}</strong>`
        + `<div class="badge-line">${UI.relevanceBadge(item.probability)}${mastery}${evidence}${UI.badge(`Prediction confidence: ${item.confidence}`, 'muted')}</div>`
        + `<details class="why-details"><summary>Why this matters</summary><p>${escapeHtml(why)}</p></details></div></div>`;
    }).join('')
      + (report.modelVersion ? `<div class="empty-state">Model ${escapeHtml(report.modelVersion)} · predictions describe recurring topics, not guaranteed exam content.</div>` : '');

    structurePanel.innerHTML = report.likelyStructures.map(item => `<div class="memory-row"><div><strong>${escapeHtml(item.questionType.replaceAll('_', ' '))}</strong><small>${escapeHtml(item.why)} · ${escapeHtml(item.sourceEvidence || '')}</small></div><span class="badge badge-medium">${structureLabel(item.probability)}<br>Prediction confidence: ${escapeHtml(item.confidence)}</span></div>`).join('');
    renderBacktestDebug(report.modelVersion);
  }

  /** Evidence confidence describes the recorded evidence base, never the probability itself. */
  function evidenceConfidenceBadge(value, evidenceCount) {
    const item = UI.confidenceLabel(value, evidenceCount);
    if (item.label === 'No evidence yet') return UI.badge('Evidence confidence: Low', 'warn');
    return UI.badge(`Evidence confidence: ${item.label}`, item.tone);
  }

  /**
   * Engineering-only backtest panel. Learner metrics stay qualitative; this surface exists so the
   * measured quality of the live model is visible instead of hidden behind an API call. It renders
   * collapsed, loads lazily on first open, and never appears when there is no model output.
   */
  function renderBacktestDebug(modelVersion) {
    const panel = document.querySelector('#examBacktestDebug');
    if (!panel) return;
    panel.classList.toggle('hidden', !modelVersion);
    panel.open = false;
    const body = panel.querySelector('[data-backtest-body]');
    if (body) body.innerHTML = '<div class="empty-state">Expand to load the measured backtest quality of this model.</div>';
  }

  async function loadBacktestDebug(courseId) {
    const panel = document.querySelector('#examBacktestDebug');
    const body = panel?.querySelector('[data-backtest-body]');
    if (!panel || !body) return;
    try {
      const report = await window.StudyOSApi.getExamBacktest(courseId);
      if (!report || report.status !== 'BACKTESTED') {
        body.innerHTML = UI.emptyState('No backtest has been run for this workspace yet (needs at least two historical exams).');
        return;
      }
      const row = (label, value) => `<div class="metric-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
      const r = report.ranking || {};
      const baselines = Object.entries(report.baselineRanking || {}).map(([model, stats]) =>
        row(`${model} NDCG@5`, (stats.ndcgAt5 ?? 0).toFixed(3))).join('');
      const buckets = (report.calibration || []).slice(0, 5).map(bucket =>
        row(`Predicted ${bucket.from.toFixed(1)}–${bucket.to.toFixed(1)}`, `${bucket.meanPredicted.toFixed(2)} → ${Math.round(bucket.observedRate * 100)}% · n=${bucket.count}`)).join('');
      body.innerHTML =
        `<div class="memory-row"><div><strong>${escapeHtml(report.modelVersion)} — walk-forward backtest</strong>`
        + `<small>${report.foldsEvaluated} fold(s) over ${report.historicalExams} historical exam(s) · ${escapeHtml(report.fittingPolicy || '')}</small></div>`
        + `<span class="badge badge-medium">${escapeHtml(report.confidenceLabel || '')}</span></div>`
        + row('Precision@5', (r.precisionAt5 ?? 0).toFixed(3))
        + row('Recall@5', (r.recallAt5 ?? 0).toFixed(3))
        + row('NDCG@5', (r.ndcgAt5 ?? 0).toFixed(3))
        + row('Brier', (report.brier ?? 0).toFixed(4))
        + baselines
        + (buckets ? `<details class="why-details"><summary>Calibration buckets (top)</summary>${buckets}</details>` : '')
        + (report.notes || []).map(note => `<small>${escapeHtml(note)}</small>`).join('<br>');
    } catch (error) {
      body.innerHTML = UI.emptyState('Backtest diagnostics are unavailable right now.');
    }
  }

  /** Wire the collapsed engineering panel: fetch once, on first expansion. */
  function bindBacktestDebug(getCourseId) {
    const panel = document.querySelector('#examBacktestDebug');
    if (!panel || panel.dataset.bound) return;
    panel.dataset.bound = 'true';
    panel.addEventListener('toggle', () => {
      if (panel.open) loadBacktestDebug(getCourseId());
    });
  }

  Panels.renderExamIntelligence = renderExamIntelligence;
  Panels.bindBacktestDebug = bindBacktestDebug;
  Panels.evidenceConfidenceBadge = evidenceConfidenceBadge;
  Panels.evidenceSummary = evidenceSummary;
})(window.StudyOSPanels);
