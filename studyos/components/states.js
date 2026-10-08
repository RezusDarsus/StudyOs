// Reusable status components: loading, error and empty states, plus a small skeleton set.
// Every list/panel in the app renders through these, so no view can end up silently blank.
window.StudyOSUI = window.StudyOSUI || {};

(function (UI) {
  'use strict';

  const { escapeHtml } = window.StudyOSFormat;

  function emptyState(message) { return `<div class="empty-state">${escapeHtml(message)}</div>`; }

  function loadingState(message = 'Loading…') {
    return `<div class="loading-state" role="status" aria-live="polite"><span class="loading-spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span></div>`;
  }

  /** Friendly, actionable failure text. Raw statuses and provider internals stay out. */
  function errorState(message, options = {}) {
    const retry = options.retry ? `<button class="text-button" data-retry-panel="${escapeHtml(options.retry)}" type="button">Try again</button>` : '';
    return `<div class="error-state" role="alert"><strong>${escapeHtml(options.title || 'Something went wrong here')}</strong><span>${escapeHtml(message)}</span>${retry}</div>`;
  }

  /** Maps an error to learner language. Never surfaces "HTTP 500" or provider internals. */
  function friendlyError(error, fallback) {
    const detail = String(error?.detail || '').toLowerCase();
    if (error?.status === 404) return fallback;
    if (/insufficient|not enough|evidence/i.test(detail)) return fallback;
    if (/provider|model|api key|nvidia|openai/i.test(detail)) return 'The AI provider is temporarily unavailable. Try again shortly.';
    if (/timeout|deadline|time budget/i.test(detail)) return 'This took longer than the allowed time. Try again shortly.';
    return fallback;
  }

  function skeleton(rows = 3) {
    return `<div class="skeleton-stack" aria-hidden="true">${Array.from({ length: rows }, (_, index) => `<div class="skeleton-row" style="animation-delay:${index * 120}ms"><span class="skeleton-line short"></span><span class="skeleton-line"></span></div>`).join('')}</div>`;
  }

  UI.emptyState = emptyState;
  UI.loadingState = loadingState;
  UI.errorState = errorState;
  UI.friendlyError = friendlyError;
  UI.skeleton = skeleton;
})(window.StudyOSUI);
