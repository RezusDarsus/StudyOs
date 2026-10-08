// Formatting helpers shared by every feature module. Pure where possible so they are testable
// in Node without a DOM.
window.StudyOSFormat = window.StudyOSFormat || {};

(function (Format) {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
  }

  function formatDate(value) {
    if (!value) return 'Not recorded';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatDay(value) {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function percent(value) { return `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`; }

  function formatMinutes(minutes) {
    const value = Math.max(0, Math.round(Number(minutes) || 0));
    return value < 60 ? `${value}m` : `${Math.floor(value / 60)}h${value % 60 ? ` ${value % 60}m` : ''}`;
  }

  /** The backend's own message when it wrote one; otherwise our wording. Never raw statuses. */
  function apiMessage(error, fallback) {
    return error?.detail?.trim() ? error.detail.trim() : fallback;
  }

  function parsePayload(payload) {
    if (!payload) return {};
    if (typeof payload === 'object') return payload;
    try { return JSON.parse(payload) || {}; } catch (_) { return {}; }
  }

  /** Study time in the last seven days, counted from recorded minutes, not event counts. */
  function studyWeek(events) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let minutes = 0; let sessions = 0;
    (events || []).forEach(event => {
      const at = new Date(event.occurredAt).getTime();
      if (Number.isNaN(at) || at < cutoff) return;
      if (/SESSION_COMPLETED$/.test(event.eventType || '')) sessions += 1;
      const payload = parsePayload(event.payload);
      const value = Number(payload.workedMinutes ?? payload.durationMinutes ?? payload.minutes);
      if (Number.isFinite(value) && value > 0) minutes += value;
    });
    return { minutes, sessions };
  }

  /** Review-due phrasing a learner can act on, from a backend timestamp. */
  function reviewDueLabel(reviewDueAt, now = new Date()) {
    if (!reviewDueAt) return null;
    const due = new Date(reviewDueAt);
    if (Number.isNaN(due.getTime())) return null;
    const overdue = due.getTime() <= now.getTime();
    const days = Math.round(Math.abs(due.getTime() - now.getTime()) / 86400000);
    if (overdue) return days <= 1 ? 'Review overdue' : `Review overdue by ${days} day${days === 1 ? '' : 's'}`;
    if (days <= 1) return 'Review due tomorrow';
    return `Review due in ${days} day${days === 1 ? '' : 's'}`;
  }

  /**
   * Learner language for an exercise that could not be produced. An empty generation is a real
   * outcome with a real reason — never a silent blank and never an internal enum.
   */
  function quizEmptyMessage(mode) {
    const normalized = String(mode || '').toUpperCase();
    if (normalized === 'DIAGNOSTIC') return 'StudyOS needs a few graded answers on this topic before it can diagnose what is missing. Try a practice question first.';
    if (normalized === 'EXAM_STYLE' || normalized === 'CHECKPOINT') return 'I don\'t have enough grounded material for a reliable exam-style problem yet. Practice this topic at your current level first.';
    if (normalized === 'MISCONCEPTION_FOLLOW_UP') return 'I couldn\'t build a follow-up that is clearly different from what you just answered. StudyOS will bring one with the next session.';
    return 'I couldn\'t create a sufficiently different, well-grounded exercise right now. Try another topic or difficulty, or ask me to teach this first.';
  }

  Format.escapeHtml = escapeHtml;
  Format.formatDate = formatDate;
  Format.formatDay = formatDay;
  Format.percent = percent;
  Format.formatMinutes = formatMinutes;
  Format.apiMessage = apiMessage;
  Format.parsePayload = parsePayload;
  Format.studyWeek = studyWeek;
  Format.reviewDueLabel = reviewDueLabel;
  Format.quizEmptyMessage = quizEmptyMessage;
})(window.StudyOSFormat);
