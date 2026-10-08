// Central frontend state. One place owns "which workspace is selected" and the workspace data
// cache, so no feature keeps its own copy that can drift out of sync on a workspace switch.
window.StudyOSState = (function (AppState) {
  'use strict';

  const listeners = new Map();

  const state = {
    courseId: localStorage.getItem('studyos-workspace-id') || localStorage.getItem('studyos-course-id') || null,
    workspace: null,          // the selected workspace object (id, title, examDate, researchMode…)
    workspaces: [],
    route: 'today',
    loading: false,
    data: {                   // per-workspace payload, cleared on switch
      topics: [], events: [], plan: null, prediction: null, learner: null,
      examPredictions: null, examAnalysis: [], overview: { sourceCount: 0, topicCount: 0, chunkCount: 0, eventCount: 0 },
      tutorToday: null, curriculum: null, frontier: null, ladder: [], ladderLevels: [], profile: null
    },
    sources: JSON.parse(localStorage.getItem('studyos-state') || '{"completedTasks":[],"sources":[]}'),
    // Monotonic token: every workspace-scoped request captures it and must drop its result
    // when the token has moved on. This is what makes fast workspace switches race-safe.
    loadToken: 0
  };

  function persistLocal() {
    localStorage.setItem('studyos-state', JSON.stringify({ completedTasks: state.sources.completedTasks || [], sources: state.sources.sources || [] }));
  }

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event)?.delete(handler);
  }

  function emit(event, payload) { (listeners.get(event) || []).forEach(handler => { try { handler(payload); } catch (error) { console.error(`StudyOS listener for ${event} failed`, error); } }); }

  return {
    on, emit,
    get courseId() { return state.courseId; },
    get workspace() { return state.workspace; },
    get workspaces() { return state.workspaces; },
    get route() { return state.route; },
    get data() { return state.data; },
    get sources() { return state.sources; },
    get loadToken() { return state.loadToken; },
    isLoading() { return state.loading; },
    completedTasks() { return state.sources.completedTasks || []; },
    markTaskDone(key) { state.sources.completedTasks = [...(state.sources.completedTasks || []), key]; persistLocal(); },
    setSources(sources) { state.sources.sources = sources || []; persistLocal(); emit('sources', sources); },

    setWorkspaces(workspaces) { state.workspaces = workspaces || []; emit('workspaces', state.workspaces); },
    findWorkspace(id) { return state.workspaces.find(item => item.id === id) || state.workspace; },
    workspaceTitle() { const workspace = state.workspace; return workspace?.title || workspace?.name || 'Learning workspace'; },

    /** Selects a workspace: bumps the race token, clears per-workspace data, notifies listeners. */
    selectWorkspace(id, workspace) {
      state.courseId = id;
      state.workspace = workspace || state.workspaces.find(item => item.id === id) || null;
      state.loadToken += 1;
      state.data = { topics: [], events: [], plan: null, prediction: null, learner: null, examPredictions: null, examAnalysis: [], overview: { sourceCount: 0, topicCount: 0, chunkCount: 0, eventCount: 0 }, tutorToday: null, curriculum: null, frontier: null, ladder: [], ladderLevels: [], profile: null };
      localStorage.setItem('studyos-workspace-id', id);
      localStorage.setItem('studyos-course-id', id);
      emit('workspace', state.workspace);
    },

    /** Drops the result of any request carrying an older token; returns true when still current. */
    isCurrent(token) { return token === state.loadToken; },

    setData(patch) { Object.assign(state.data, patch); emit('data', state.data); },
    setRoute(route) { if (state.route === route) return false; state.route = route; emit('route', route); return true; },
    setLoading(loading) { state.loading = Boolean(loading); emit('loading', state.loading); }
  };
})(window.StudyOSState);
