// Syllabus view: renders what the parser actually extracted — units with their title, week/date,
// topics, readings and assignments, plus assessments — and shows a visible warning when a syllabus
// was detected but could not be parsed. An empty syllabus is never presented as truth.
window.StudyOSPanels = window.StudyOSPanels || {};

(function (Panels) {
  'use strict';

  const { escapeHtml, formatDay } = window.StudyOSFormat;
  const UI = window.StudyOSUI;

  /** Pure mapping of backend parse status to a UI state; testable without a DOM. */
  function mapParseStatus(info) {
    const status = String(info?.status || 'NOT_SYLLABUS').toUpperCase();
    if (status === 'PARSED') return { kind: 'ok', message: `Parsed${info?.units ? ` · ${info.units} unit${info.units === 1 ? '' : 's'}` : ''}${info?.confidence ? ` · ${info.confidence.toLowerCase()} confidence` : ''}` };
    if (status === 'SYLLABUS_DETECTED_BUT_UNPARSED') return { kind: 'warn', message: 'StudyOS recognised this document as a syllabus but could not read its structure. The content is still searchable — re-upload a cleaner copy or paste the schedule as notes to get week-by-week structure.' };
    return { kind: 'muted', message: 'No course schedule structure was detected in this document.' };
  }

  function unitLabel(unit) {
    if (unit.weekNumber != null) return `Week ${unit.weekNumber}`;
    if (unit.ordinal != null) return `Unit ${unit.ordinal}`;
    return 'Unit';
  }

  function renderUnit(unit) {
    const date = unit.unitDate ? formatDay(unit.unitDate) : null;
    const topics = unit.topics || [];
    const readings = unit.requiredReadings || [];
    const assignments = unit.assignments || [];
    const objectives = unit.learningObjectives || [];
    const chips = items => items.map(item => `<span class="topic-chip">${escapeHtml(item)}</span>`).join('');
    const group = (label, items) => items.length ? `<div class="unit-group"><span class="card-label">${label}</span><div class="chip-row">${chips(items)}</div></div>` : '';
    return `<details class="syllabus-unit"><summary><span class="unit-label">${escapeHtml(unitLabel(unit))}</span>`
      + `<strong>${escapeHtml(unit.title || '')}</strong>${date ? `<small>${escapeHtml(date)}</small>` : ''}</summary>`
      + `<div class="unit-body">${group('TOPICS', topics)}${group('READINGS', readings)}${group('ASSIGNMENTS', assignments)}${group('OBJECTIVES', objectives)}</div></details>`;
  }

  function render(syllabus) {
    const panel = document.querySelector('#syllabusPanel');
    if (!panel) return;
    if (!syllabus) { panel.innerHTML = UI.emptyState('Upload a syllabus to see the parsed course structure here.'); return; }
    const units = syllabus.units || [];
    const assessments = syllabus.assessments || [];
    const parseWarnings = (syllabus.parseStatuses || [])
      .map(info => ({ info, mapped: mapParseStatus(info) }))
      .filter(entry => entry.mapped.kind === 'warn');

    const unitsHtml = units.length
      ? units.map(renderUnit).join('')
      : UI.emptyState('No parsed units yet. Upload a syllabus document and StudyOS will extract weeks, modules, topics and dates.');

    const assessmentsHtml = assessments.length
      ? assessments.map(assessment => `<div class="memory-row"><div><strong>${escapeHtml(assessment.title)}</strong><small>${escapeHtml((assessment.assessmentType || '').replaceAll('_', ' '))}${assessment.assessmentDate ? ` · ${escapeHtml(formatDay(assessment.assessmentDate))}` : ''}</small></div>${assessment.weightPercent != null ? `<span class="badge badge-medium">${Math.round(assessment.weightPercent)}%</span>` : ''}</div>`).join('')
      : UI.emptyState('No scheduled assessments found in the syllabus.');

    const warningHtml = parseWarnings.length
      ? parseWarnings.map(entry => `<div class="error-state warn" role="status"><strong>${escapeHtml(entry.info.documentName || 'Syllabus')}</strong><span>${escapeHtml(entry.mapped.message)}</span></div>`).join('')
      : '';

    panel.innerHTML = `<div class="panel-heading"><div><span class="eyebrow">PARSED COURSE STRUCTURE</span><h2>Syllabus</h2></div>`
      + `<span class="badge badge-${units.length ? 'strong' : 'muted'}">${units.length} unit${units.length === 1 ? '' : 's'} · ${assessments.length} assessment${assessments.length === 1 ? '' : 's'}</span></div>`
      + warningHtml
      + `<div class="syllabus-units">${unitsHtml}</div>`
      + `<div class="panel-heading"><div><span class="eyebrow">SCHEDULED</span><h2>Assessments</h2></div></div>${assessmentsHtml}`;
  }

  async function load(workspaceId) {
    const api = window.StudyOSApi;
    const state = window.StudyOSState;
    const panel = document.querySelector('#syllabusPanel');
    if (!panel || !api || !workspaceId) return;
    const token = state.loadToken;
    panel.innerHTML = UI.loadingState('Reading the parsed syllabus…');
    try {
      const syllabus = await api.getSyllabus(workspaceId);
      if (!state.isCurrent(token)) return;
      render(syllabus);
    } catch (error) {
      if (!state.isCurrent(token)) return;
      panel.innerHTML = UI.errorState(UI.friendlyError(error, 'The syllabus could not be read right now.'), { retry: 'syllabus' });
    }
  }

  Panels.renderSyllabus = render;
  Panels.loadSyllabus = load;
  Panels.mapSyllabusParseStatus = mapParseStatus;
  Panels.syllabusUnitLabel = unitLabel;
})(window.StudyOSPanels);
