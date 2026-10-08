// Research panel: run status with live polling (exactly one loop per workspace), run statistics,
// ingested external sources, and per-topic evidence coverage. External content is rendered as
// escaped text only — research pages are never injected as HTML.
window.StudyOSPanels = window.StudyOSPanels || {};

(function (Panels) {
  'use strict';

  const { escapeHtml, formatMinutes } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  const POLL_INTERVAL_MS = 5000;
  const POLL_MAX_MS = 10 * 60 * 1000; // a bounded run should finish well inside this; stop anyway

  let poll = null; // { courseId, timer, startedAt }

  function stopPolling() {
    if (poll?.timer) clearInterval(poll.timer);
    poll = null;
  }

  /** Only one loop may exist, and it dies on workspace change, completion, failure or timeout. */
  function ensurePolling(courseId, refresh) {
    if (poll && poll.courseId === courseId) return;
    stopPolling();
    poll = { courseId, startedAt: Date.now(), timer: null };
    poll.timer = setInterval(async () => {
      const state = window.StudyOSState;
      if (!poll) return stopPolling();
      // Workspace changed or the app navigated far away: this loop is stale.
      if (!state || state.courseId !== poll.courseId) return stopPolling();
      if (Date.now() - poll.startedAt > POLL_MAX_MS) { stopPolling(); render(); return; }
      await refresh(poll.courseId, { silent: true });
      if (!poll) return; // refresh may have completed the run and stopped us
      const run = state.data.researchStatus?.latestRun;
      if (!run || ['COMPLETED', 'FAILED'].includes(run.status)) stopPolling();
    }, POLL_INTERVAL_MS);
  }

  function summarizeRun(run) {
    if (!run) return null;
    const finished = ['COMPLETED', 'FAILED'].includes(run.status);
    return {
      status: run.status,
      finished,
      headline: run.status === 'RUNNING' || run.status === 'QUEUED' ? 'Researching course…'
        : run.status === 'FAILED' ? 'Research run failed'
        : `Research complete`,
      planned: run.plannedQueries ?? null,
      executed: run.queriesRun ?? null,
      candidates: run.candidatesFound ?? null,
      ingested: run.sourcesIngested ?? 0,
      skipped: run.sourcesSkipped ?? 0,
      failed: run.sourcesFailed ?? 0,
      bytes: run.bytesFetched ?? 0,
      error: run.error || null
    };
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function renderRun(summary) {
    const parts = [`<span class="research-headline ${summary.finished ? '' : 'active'}">${escapeHtml(summary.headline)}</span>`];
    const stats = [];
    if (summary.planned != null) stats.push(`${summary.executed ?? 0}/${summary.planned} queries executed`);
    if (summary.candidates != null) stats.push(`${summary.candidates} candidates found`);
    stats.push(`${summary.ingested} source${summary.ingested === 1 ? '' : 's'} added`);
    stats.push(`${summary.skipped} skipped`);
    stats.push(`${summary.failed} failed`);
    if (summary.bytes) stats.push(formatBytes(summary.bytes));
    parts.push(`<span class="research-stats">${escapeHtml(stats.join(' · '))}</span>`);
    if (summary.error) parts.push(`<span class="research-error">${escapeHtml(summary.error)}</span>`);
    return `<div class="research-run">${parts.join('')}</div>`;
  }

  function renderSources(sources) {
    if (!sources?.length) return UI.emptyState('No external sources recorded yet.');
    return sources.map(source => `<div class="memory-row source-row"><div><strong>${escapeHtml(source.title || source.domain || 'External source')}</strong>`
      + `<small>${escapeHtml(source.domain || '')}${source.query ? ` · found via “${escapeHtml(source.query)}”` : ''}${source.byteSize ? ` · ${formatBytes(source.byteSize)}` : ''}</small></div>`
      + `<span class="badge badge-external" title="External research source retrieved from the web">External · ${escapeHtml(source.provider || 'web')}</span></div>`).join('');
  }

  function renderCoverage(coverage) {
    if (!coverage) return '';
    const topics = (coverage.topics || []).filter(topic => topic.importance >= 0.45 || topic.researchGap).slice(0, 8);
    const limitNote = coverage.enrichmentAllowed === false
      ? '<div class="empty-state">Additional automatic research limit reached — new research runs still work whenever you ask for them.</div>'
      : '';
    if (!topics.length) return limitNote;
    const rows = topics.map(topic => {
      const badge = UI.coverageBadge(topic.level);
      const gap = topic.researchGap ? '<span class="badge badge-warn">Research candidate</span>' : '';
      const meta = `${topic.independentSources} source${topic.independentSources === 1 ? '' : 's'} · ${topic.depthChunks} chunk${topic.depthChunks === 1 ? '' : 's'}`;
      return `<div class="memory-row coverage-row-item"><div><strong>${escapeHtml(topic.topic)}</strong><small>${escapeHtml(meta)}</small></div><span class="coverage-badges">${badge}${gap}</span></div>`;
    }).join('');
    return `<div class="panel-heading"><div><span class="eyebrow">EVIDENCE COVERAGE</span><h2>What your research covers</h2></div></div>${rows}${limitNote}`;
  }

  function render() {
    const panel = document.querySelector('#researchPanel');
    if (!panel) return;
    const state = window.StudyOSState;
    const status = state?.data.researchStatus;
    const run = status?.latestRun;
    const sources = status?.sources || [];
    const summary = summarizeRun(run);

    if (!state?.courseId) { panel.innerHTML = UI.emptyState('Select a workspace to see its research.'); return; }
    if (!run) {
      panel.innerHTML = `<div class="panel-heading"><div><span class="eyebrow">ONLINE RESEARCH</span><h2>Research</h2></div></div>`
        + UI.emptyState(state.workspace?.researchMode === 'SOURCE_ONLY'
          ? 'This workspace uses your documents only. Create a workspace with a research mode to add online sources.'
          : 'No research has run for this workspace yet. Ask in chat, or create the workspace with a research mode.');
      return;
    }
    panel.innerHTML = `<div class="panel-heading"><div><span class="eyebrow">ONLINE RESEARCH</span><h2>Research status</h2></div>`
      + `<span class="badge badge-${summary.finished ? (summary.status === 'FAILED' ? 'warn' : 'strong') : 'medium'}">${escapeHtml(summary.status)}</span></div>`
      + renderRun(summary)
      + `<div class="research-sources">${renderSources(sources)}</div>`
      + (state.data.researchCoverage === undefined ? '' : `<div class="research-coverage">${renderCoverage(state.data.researchCoverage)}</div>`);
  }

  /** One refresh cycle: fetch status (and coverage once), render, and manage the polling loop. */
  async function refresh(courseId, options = {}) {
    const api = window.StudyOSApi;
    const state = window.StudyOSState;
    if (!courseId || !api) return;
    const token = state.loadToken;
    try {
      const status = await api.getResearchStatus(courseId);
      if (!state.isCurrent(token)) return;
      state.setData({ researchStatus: status });
      if (state.data.researchCoverage === undefined && options.withCoverage !== false) {
        const coverage = await api.getResearchCoverage(courseId).catch(() => null);
        if (!state.isCurrent(token)) return;
        state.setData({ researchCoverage: coverage });
      }
    } catch (error) {
      if (!state.isCurrent(token)) return;
      state.setData({ researchStatus: state.data.researchStatus || null });
      console.error('Could not load research status', error);
    }
    if (options.silent !== true || !options.skipRender) render();
    const run = state.data.researchStatus?.latestRun;
    if (run && ['QUEUED', 'RUNNING'].includes(run.status)) ensurePolling(courseId, refresh);
    else stopPolling();
  }

  function reset() { stopPolling(); const state = window.StudyOSState; if (state) state.setData({ researchStatus: undefined, researchCoverage: undefined }); }

  Panels.renderResearch = render;
  Panels.refreshResearch = refresh;
  Panels.summarizeResearchRun = summarizeRun;
  Panels.stopResearchPolling = () => stopPolling();
  /** Inline research failure, shown where the learner is already looking. */
  Panels.showResearchError = message => {
    const panel = document.querySelector('#researchPanel');
    if (panel) panel.innerHTML = `<div class="panel-heading"><div><span class="eyebrow">ONLINE RESEARCH</span><h2>Research</h2></div></div>` + UI.errorState(message, { retry: 'research' });
  };
  Panels.resetResearch = reset;
})(window.StudyOSPanels);
