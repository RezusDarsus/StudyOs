// Citation rendering for chat replies. Loaded before app.js.
// Provenance comes from backend-decided facts, in priority order:
//   1. an exact match against the workspace's ingested external research sources (research status)
//   2. an exact match against the learner's uploaded source names
//   3. for legacy messages written before either list existed, a conservative shape heuristic on
//      the cited name — clearly a fallback, never the primary signal.
window.StudyOSChat = window.StudyOSChat || {};

(function (StudyOSChat) {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Set from live backend data: external = research status source titles, material = uploaded source names.
  const provenance = { external: new Set(), material: new Set() };

  function normalize(name) { return String(name || '').trim().toLowerCase().replace(/\.[a-z0-9]+$/i, ''); }

  function setProvenanceSources({ external = [], material = [] } = {}) {
    provenance.external = new Set(external.map(normalize).filter(Boolean));
    provenance.material = new Set(material.map(normalize).filter(Boolean));
  }

  // Legacy fallback only: a citation whose name looks like a domain or URL is almost certainly
  // external research; anything else is assumed to be the learner's own material.
  function looksExternal(name) {
    const clean = String(name || '').trim();
    if (/^https?:\/\//i.test(clean)) return true;
    return !/\s/.test(clean) && /\.[a-z]{2,}(\/|$)/i.test(clean);
  }

  function citationKind(name) {
    const key = normalize(name);
    if (key && provenance.external.has(key)) return 'external';
    if (key && provenance.material.has(key)) return 'material';
    return looksExternal(name) ? 'external' : 'material';
  }

  // Takes a raw [[source: X]] / [source: X] token and appends a provenance-tagged chip to target.
  function attachCitation(target, token) {
    const name = token.replace(/^\[\[?source:\s*/i, '').replace(/\]\]?$/, '').trim();
    const kind = citationKind(name);
    const citation = document.createElement('span');
    citation.className = `source-citation ${kind}`;
    citation.textContent = kind === 'external' ? `Research · ${name}` : `Source · ${name}`;
    citation.title = kind === 'external'
      ? 'External research source retrieved from the web'
      : 'Citation from your uploaded course material';
    target.append(citation);
  }

  StudyOSChat.citationKind = citationKind;
  StudyOSChat.attachCitation = attachCitation;
  StudyOSChat.setProvenanceSources = setProvenanceSources;
  StudyOSChat.escapeHtml = escapeHtml;
})(window.StudyOSChat);
