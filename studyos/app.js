// StudyOS application bootstrap. Feature rendering lives in the feature modules; this file wires
// them together: workspace selection, data loading with race safety, navigation, modals, and the
// shared event bindings.
const defaultState = { completedTasks: [], sources: [] };
const persisted = JSON.parse(localStorage.getItem('studyos-state') || JSON.stringify(defaultState));

const AppState = window.StudyOSState;
const Api = window.StudyOSApi;
const Format = window.StudyOSFormat;
const UI = window.StudyOSUI;
const Router = window.StudyOSRouter;
const Panels = window.StudyOSPanels;
const Chat = window.StudyOSChat;
const Tutor = window.StudyOSTutor;
const Dashboard = window.StudyOSDashboard;

let courses = [];
let chats = [];
let currentChatId = null;
let chatPurposes = [];
let courseReady = Promise.resolve();
let activeMockExam = null;
let mockExamGrades = new Map();

const { escapeHtml, percent, formatMinutes, apiMessage } = Format;

function levelLabel(rank) { return AppState.data.ladderLevels?.find(level => level.rank === rank)?.label || `Level ${rank}`; }
AppState.setData({ levelLabel });
function requestedTutorMinutes() { const value = Number(document.querySelector('#tutorMinutes')?.value); return Number.isFinite(value) && value > 0 ? Math.max(5, Math.min(480, Math.round(value))) : null; }
function workspaceGoal() { return AppState.workspace?.description?.trim() || null; }

// ------------------------------------------------------------------ workspaces & navigation

function renderProjects() {
  const projectList = document.querySelector('#projectList');
  if (!projectList) return;
  document.querySelectorAll('.sidebar > .project-item:not(#newProjectButton):not(#newProjectFooterButton)').forEach(item => item.remove());
  projectList.replaceChildren(...courses.map(course => {
    const button = document.createElement('button');
    button.className = `project-item ${course.id === AppState.courseId ? 'active' : ''}`;
    button.type = 'button';
    const dot = document.createElement('span'); dot.className = 'project-dot';
    const name = document.createElement('span'); name.textContent = courseTitle(course);
    const chevron = document.createElement('span'); chevron.className = 'chevron'; chevron.textContent = '›';
    button.append(dot, name, chevron);
    button.addEventListener('click', () => selectProject(course));
    return button;
  }));
}

function courseTitle(course) { return course?.title || course?.name || 'Learning workspace'; }

async function selectProject(course) {
  const wasDifferent = course.id !== AppState.courseId;
  AppState.selectWorkspace(course.id, course);
  if (wasDifferent) {
    Panels.resetResearch?.();
    Tutor.resetTutorSession?.();
    currentChatId = null;
    chats = [];
    Chat.clear();
  }
  document.querySelector('.topbar h1').textContent = courseTitle(course);
  renderProjects();
  renderDashboardSkeletons();
  renderSources();
  await loadSources();
  await loadProjectData();
  await loadChats();
  Router.showView('today', { force: true });
}

function openProjectModal() { document.querySelector('#projectModal')?.classList.remove('hidden'); document.querySelector('#projectName')?.focus(); }
function closeProjectModal() { document.querySelector('#projectModal')?.classList.add('hidden'); }

async function createProject(event) {
  event?.preventDefault();
  const nameInput = document.querySelector('#projectName');
  const descriptionInput = document.querySelector('#projectDescription');
  const workspaceType = document.querySelector('#workspaceType');
  const objective = document.querySelector('#workspaceObjective');
  const deadline = document.querySelector('#workspaceDeadline');
  const researchMode = document.querySelector('input[name="researchMode"]:checked');
  const modalError = document.querySelector('#projectModalError');
  if (!nameInput.value.trim()) { nameInput.focus(); return; }
  const showError = message => { if (modalError) { modalError.innerHTML = UI.errorState(message); modalError.classList.remove('hidden'); } };
  try {
    const mode = researchMode ? researchMode.value : 'SOURCE_ONLY';
    const course = await Api.createWorkspace({ title: nameInput.value.trim(), description: descriptionInput.value.trim(), workspaceType: workspaceType.value, objective: objective.value, targetDate: deadline.value || null, examDate: objective.value === 'PASS_EXAM' || workspaceType.value === 'EXAM' ? deadline.value || null : null, researchMode: mode });
    courses = [course, ...courses];
    closeProjectModal();
    nameInput.value = ''; descriptionInput.value = ''; deadline.value = '';
    await selectProject(course);
    if (mode !== 'SOURCE_ONLY' && course?.description?.trim()) {
      try {
        await Api.startResearch(course.id, { goal: course.description.trim(), mode });
        await Panels.refreshResearch(course.id);
        Router.showView('sources');
      } catch (error) {
        console.error('Online research could not start', error);
        Router.showView('sources');
        Panels.showResearchError(UI.friendlyError(error, 'The workspace was created, but online research could not start. Check the backend, then start research from the Sources view.'));
      }
    }
  } catch (error) {
    console.error('The project could not be created', error);
    showError(UI.friendlyError(error, 'The project could not be created. Check that the StudyOS backend is running.'));
  }
}

// ------------------------------------------------------------------ workspace deletion

/**
 * Explicitly confirmed workspace deletion. Everything on the backend is course-scoped with FK
 * cascades, so one API call removes the workspace; here we stop background work, clear the local
 * cache, and land on another workspace or the empty state.
 */
async function deleteCurrentWorkspace() {
  const course = AppState.workspace;
  if (!course || !Api) return;
  const title = courseTitle(course);
  if (!window.confirm(`Delete "${title}" and all of its material, chats, progress and history? This cannot be undone.`)) return;
  const button = document.querySelector('#deleteWorkspaceButton');
  if (button) { button.disabled = true; button.textContent = 'Deleting…'; }
  try {
    await Api.deleteWorkspace(course.id);
    Panels.stopResearchPolling?.();
    Tutor.resetTutorSession?.();
    Tutor.closeStudySession?.();
    currentChatId = null; chats = []; Chat.clear();
    courses = courses.filter(entry => entry.id !== course.id);
    AppState.setWorkspaces(courses);
    if (courses.length) await selectProject(courses[0]);
    else {
      AppState.selectWorkspace(null, null);
      localStorage.removeItem('studyos-workspace-id');
      localStorage.removeItem('studyos-course-id');
      document.querySelector('.topbar h1').textContent = 'Create your first workspace';
      renderProjects();
      renderDashboardSkeletons();
      Router.showView('today', { force: true });
      openProjectModal();
    }
  } catch (error) {
    console.error('Could not delete the workspace', error);
    window.alert(apiMessage(error, 'The workspace could not be deleted. Check that the StudyOS backend is running.'));
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Delete workspace'; }
  }
}

// ------------------------------------------------------------------ loading with race safety

function renderDashboardSkeletons() {
  const panel = document.querySelector('#dashboardPanel');
  if (panel) panel.innerHTML = UI.skeleton(5);
  const taskList = document.querySelector('#taskList');
  if (taskList) taskList.innerHTML = UI.skeleton(3);
  const curriculumTree = document.querySelector('#curriculumTree');
  if (curriculumTree) curriculumTree.innerHTML = UI.skeleton(3);
}

/** One failing panel costs that panel, not the whole dashboard. */
function optional(promise, fallback = null) { return promise.catch(error => { console.error('StudyOS request failed', error); return fallback; }); }

async function loadProjectData() {
  const courseId = AppState.courseId;
  if (!courseId || !Api) return;
  const token = AppState.loadToken;
  AppState.setLoading(true);
  try {
    const [topics, events, overview, existingPlan, prediction, examAnalysis, learner, examPredictions, tutorToday, curriculum, frontier, ladder, ladderLevels, profile] = await Promise.all([
      Api.listTopics(courseId), Api.listLearningEvents(courseId), Api.getOverview(courseId), Api.getStudyPlan(courseId), Api.getPredictions(courseId), Api.getExamAnalysis(courseId), Api.getLearnerState(courseId), Api.getExamPredictions(courseId),
      optional(Api.getTodaySession(courseId, requestedTutorMinutes())), optional(Api.getCurriculum(courseId)), optional(Api.getCurriculumFrontier(courseId)),
      optional(Api.listLadder(courseId), []), optional(Api.getLadderLevels(courseId), []), optional(Api.getLearnerProfile(courseId))
    ]);
    if (!AppState.isCurrent(token)) return; // a newer workspace selection won; drop everything
    const plan = existingPlan?.id ? existingPlan : await Api.generateStudyPlan(courseId);
    if (!AppState.isCurrent(token)) return;
    AppState.setData({ topics, events, overview, prediction, examAnalysis, learner, examPredictions, tutorToday, curriculum, frontier, ladder: ladder || [], ladderLevels: ladderLevels || [], profile, plan });
    renderAll();
    await Panels.refreshResearch(courseId);
    syncCitationProvenance();
  } catch (error) {
    if (!AppState.isCurrent(token)) return;
    console.error('Could not load project data', error);
    const panel = document.querySelector('#dashboardPanel');
    if (panel) panel.innerHTML = UI.errorState('This workspace could not be loaded. Check that the StudyOS backend is running.', { retry: 'dashboard' });
  } finally {
    if (AppState.isCurrent(token)) AppState.setLoading(false);
  }
}

function renderAll() {
  const data = AppState.data;
  Dashboard.renderDashboard();
  renderTasks();
  renderStats();
  Panels.renderKnowledge(data.topics);
  Panels.renderHistory(data.events);
  renderSources();
  Panels.renderReadinessBreakdown(data.prediction?.breakdown);
  Panels.renderImprovements(data.prediction?.fastestImprovements || []);
  Panels.renderMisconceptions(data.learner?.openMisconceptions || []);
  Panels.renderPreferences(data.learner?.preferences || []);
  Panels.bindMisconceptionResolve(async id => {
    try {
      await Api.resolveMisconception(AppState.courseId, id);
      AppState.setData({ learner: await Api.getLearnerState(AppState.courseId), prediction: await Api.getPredictions(AppState.courseId) });
      renderAll();
    } catch (error) { console.error('Could not correct misconception', error); }
  });
  Panels.renderExamIntelligence(data.examPredictions, { risks: data.prediction?.risks || [], examAnalysis: data.examAnalysis });
  Panels.bindBacktestDebug(() => AppState.courseId);
  Tutor.renderTutorPlan(data.tutorToday);
  Panels.renderCurriculum(data.curriculum, data.frontier, levelLabel);
  Panels.renderFrontier(data.frontier, data.curriculum);
  Panels.renderLadder(data.ladder, data.ladderLevels);
  Panels.renderLearnerProfile(data.profile);
}

// ------------------------------------------------------------------ dashboard-side panels

function renderStats() {
  const data = AppState.data;
  const overview = data.overview || {};
  const plan = data.plan;
  const readiness = plan && plan.id ? Math.round((plan.readiness || 0) * 100) : null;
  const prediction = data.prediction;
  const workspace = AppState.workspace;
  const cards = document.querySelectorAll('.stats-grid .stat-card');
  if (cards.length >= 4) {
    const week = Format.studyWeek(data.events);
    cards[0].querySelector('strong').textContent = readiness == null ? '—' : `${readiness}%`;
    cards[0].querySelector('.trend').textContent = prediction?.status ? `Forecast: ${prediction.status.replaceAll('_', ' ')}` : readiness == null ? 'Awaiting evidence' : 'Based on assessed topics';
    cards[1].querySelector('strong').textContent = formatMinutes(week.minutes);
    cards[1].querySelector('.trend').textContent = week.sessions ? `${week.sessions} session${week.sessions === 1 ? '' : 's'} in the last 7 days` : week.minutes ? 'Recorded in the last 7 days' : 'No study time in the last 7 days';
    cards[2].querySelector('strong').textContent = data.topics.filter(topic => topic.mastery < .7).length;
    cards[2].querySelector('.trend').textContent = 'Topics below 70% mastery';
    cards[3].querySelector('strong').textContent = overview.topicCount || 0;
    cards[3].querySelector('.trend').textContent = `${overview.eventCount || 0} learning events`;
  }
  const ring = document.querySelector('.readiness-ring strong');
  if (ring) ring.textContent = readiness == null ? '—' : `${readiness}%`;
  const bannerLabel = document.querySelector('.exam-banner .eyebrow');
  const bannerTitle = document.querySelector('.exam-banner h2');
  const milestoneDate = workspace?.examDate || workspace?.targetDate;
  if (bannerLabel) bannerLabel.textContent = milestoneDate ? `${workspace?.examDate ? 'EXAM' : 'TARGET'} · ${new Date(`${milestoneDate}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }).toUpperCase()}` : `${(workspace?.workspaceType || 'LEARNING').replaceAll('_', ' ')} WORKSPACE`;
  if (bannerTitle) bannerTitle.textContent = milestoneDate ? 'Turn today’s evidence into steady progress.' : 'Build understanding one evidence-backed session at a time.';
  const banner = document.querySelector('.exam-banner p');
  if (banner && prediction) banner.textContent = prediction.status === 'INSUFFICIENT_EVIDENCE' ? 'Add and assess learning material to activate evidence-based priorities.' : `Predicted focus: ${prediction.predictedFocus}. Forecast: ${prediction.status.replaceAll('_', ' ')}.`;
}

function renderTasks(plan = AppState.data.plan) {
  const taskList = document.querySelector('#taskList');
  if (!taskList) return;
  const tasks = plan?.tasks || [];
  const planned = tasks.reduce((total, task) => total + (task.durationMinutes || 0), 0);
  const minutesLabel = document.querySelector('#planMinutes');
  if (minutesLabel) minutesLabel.textContent = planned ? `${formatMinutes(planned)} of work planned${plan?.availableMinutes ? ` · ${formatMinutes(plan.availableMinutes)} available` : ''}` : 'Nothing scheduled yet';
  const counter = document.querySelector('.time-row span:last-child');
  const track = document.querySelector('.progress-track span');
  if (!tasks.length) {
    taskList.innerHTML = UI.emptyState('Upload processed course sources to generate a real study plan for this project.');
    if (counter) counter.textContent = '0 tasks';
    if (track) track.style.width = '0%';
    return;
  }
  taskList.innerHTML = tasks.map((task, index) => {
    const key = task.topicId || task.title || index;
    const completed = task.status === 'COMPLETED' || AppState.completedTasks().includes(key);
    return `<article class="task ${completed ? 'completed' : ''}" data-task-id="${escapeHtml(task.taskId || '')}" data-task-key="${escapeHtml(key)}"><span class="task-check"></span><div class="task-copy"><div class="task-title">${escapeHtml(task.title)}</div><div class="task-reason">${escapeHtml(task.reason)}</div></div><span class="task-time">${task.durationMinutes} min</span></article>`;
  }).join('');
  taskList.querySelectorAll('[data-task-key]').forEach(element => element.addEventListener('click', async () => {
    const current = tasks.find(item => item.taskId === element.dataset.taskId) || tasks.find(item => (item.topicId || item.title) === element.dataset.taskKey);
    if (current?.status !== 'COMPLETED') await Tutor.openStudySession(current);
  }));
  updateProgress();
}

function updateProgress() {
  const tasks = AppState.data.plan?.tasks || [];
  const completed = tasks.filter(task => task.status === 'COMPLETED' || AppState.completedTasks().includes(task.topicId || task.title)).length;
  const counter = document.querySelector('.time-row span:last-child');
  if (counter) counter.textContent = `${completed} / ${tasks.length} completed`;
  const track = document.querySelector('.progress-track span');
  if (track) track.style.width = tasks.length ? `${completed / tasks.length * 100}%` : '0%';
}

/** Regenerates today's plan from the backend planner — the "Edit plan" control. */
async function regeneratePlan(event) {
  const courseId = AppState.courseId;
  const button = event?.currentTarget;
  if (!courseId || !Api) return;
  if (button) { button.disabled = true; button.textContent = 'Rebuilding…'; }
  try {
    const plan = await Api.generateStudyPlan(courseId, requestedTutorMinutes() || 120);
    AppState.setData({ plan });
    renderTasks(plan);
    renderStats();
  } catch (error) {
    console.error('Could not regenerate the study plan', error);
    const taskList = document.querySelector('#taskList');
    if (taskList) taskList.innerHTML = UI.errorState(UI.friendlyError(error, apiMessage(error, 'StudyOS could not rebuild the plan right now. Try again shortly.')), { retry: 'dashboard' });
  } finally { if (button) { button.disabled = false; button.textContent = 'Edit plan'; } }
}

// ------------------------------------------------------------------ sources

function renderSources() {
  const sourceList = document.querySelector('#sourceList');
  if (!sourceList) return;
  const sources = AppState.sources.sources || [];
  sourceList.innerHTML = sources.length ? sources.map(source => {
    const [name, type, detail, id, mediaType] = Array.isArray(source) ? source : [source.name, source.type, `${source.pageCount || '—'} ${source.mediaType?.startsWith('text/') ? 'sections' : 'pages'} · ${(source.status || 'queued').toLowerCase()}`, source.id, source.mediaType];
    const icon = mediaType === 'text/markdown' ? 'MD' : mediaType === 'text/plain' ? 'TXT' : 'PDF';
    return `<article class="source-card" data-source-id="${escapeHtml(id || '')}"><span class="source-icon">${escapeHtml(icon)}</span><div class="source-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail)}</small></div><span class="source-type">${escapeHtml(type)}</span>${id ? `<button class="source-delete" data-delete-source="${escapeHtml(id)}" title="Delete source" aria-label="Delete ${escapeHtml(name)}">×</button>` : ''}</article>`;
  }).join('') : UI.emptyState('No sources uploaded yet. Add your syllabus, lectures, homework, exams, or notes to start building project memory.');
  document.querySelector('#sourceCount').textContent = AppState.data.overview.sourceCount || sources.length;
  document.querySelector('#topicCount').textContent = AppState.data.overview.topicCount || '0';
  document.querySelector('#chunkCount').textContent = AppState.data.overview.chunkCount || '0';
  sourceList.querySelectorAll('[data-delete-source]').forEach(button => button.addEventListener('click', async () => {
    const courseId = AppState.courseId;
    if (courseId && Api) { await Api.deleteSource(courseId, button.dataset.deleteSource).catch(error => console.error('Could not delete source', error)); await loadSources(); await loadProjectData(); }
  }));
}

async function loadSources() {
  const courseId = AppState.courseId;
  if (!courseId || !Api) return;
  try { AppState.setSources(await Api.listSources(courseId)); renderSources(); syncCitationProvenance(); }
  catch (error) { console.error('Could not load project sources', error); }
}

/** Citation chips read backend provenance lists, not title shapes. Updated whenever either list changes. */
function syncCitationProvenance() {
  Chat.setProvenanceSources?.({
    external: (AppState.data.researchStatus?.sources || []).map(source => source.title || source.domain).filter(Boolean),
    material: (AppState.sources.sources || []).map(source => Array.isArray(source) ? source[0] : source?.name).filter(Boolean)
  });
}

// ------------------------------------------------------------------ chats

function chatMeta(chat) {
  const count = Number(chat.messageCount) || 0;
  const turns = count ? `${count} message${count === 1 ? '' : 's'}` : 'Nothing yet';
  return chat.purposeLabel && chat.purpose !== 'GENERAL' ? `${chat.purposeLabel} · ${turns}` : turns;
}

function renderChatList() {
  const list = document.querySelector('#chatList');
  if (!list) return;
  if (!chats.length) { const empty = document.createElement('p'); empty.className = 'sidebar-empty'; empty.textContent = 'No chats yet'; list.replaceChildren(empty); return; }
  list.replaceChildren(...chats.map(chat => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `project-item chat-item${chat.id === currentChatId ? ' active' : ''}`;
    const dot = document.createElement('span'); dot.className = 'project-dot';
    const copy = document.createElement('span'); copy.className = 'chat-item-copy';
    const title = document.createElement('span'); title.className = 'chat-item-title'; title.textContent = chat.title || 'Study chat';
    const meta = document.createElement('small'); meta.textContent = chatMeta(chat);
    copy.append(title, meta); button.append(dot, copy);
    button.addEventListener('click', () => openChat(chat.id));
    return button;
  }));
}

function renderActiveChat() {
  const chat = chats.find(value => value.id === currentChatId) || null;
  const title = document.querySelector('#activeChatTitle');
  const tag = document.querySelector('#activeChatPurpose');
  if (title) title.textContent = chat?.title || 'Continue learning';
  if (!tag) return;
  const label = chat && chat.purpose !== 'GENERAL' ? chat.purposeLabel || '' : '';
  tag.textContent = label; tag.classList.toggle('hidden', !label);
}

async function loadChats(preferredChatId = null) {
  const courseId = AppState.courseId;
  if (!courseId || !Api) return;
  const token = AppState.loadToken;
  try {
    chats = (await Api.listChats(courseId)) || [];
    if (!AppState.isCurrent(token)) return;
    const wanted = [preferredChatId, currentChatId].find(id => id && chats.some(chat => chat.id === id));
    currentChatId = wanted || chats[0]?.id || null;
    renderChatList(); renderActiveChat();
    if (currentChatId) await loadChatMessages(currentChatId); else Chat.clear();
  } catch (error) { console.error('Could not load chats', error); }
}

async function loadChatMessages(chatId) {
  const token = AppState.loadToken;
  try {
    const messages = await Api.listMessages(AppState.courseId, chatId);
    if (!AppState.isCurrent(token)) return;
    // Chat-switch race: a slower earlier load must never repaint the newer chat's panel.
    if (currentChatId !== chatId) return;
    Chat.clear();
    messages.forEach(message => Chat.addMessage(message.content, message.role === 'USER' ? 'user' : 'assistant'));
  } catch (error) { console.error('Could not load chat history', error); }
}

async function refreshChatList() {
  const courseId = AppState.courseId;
  if (!courseId || !Api) return;
  try { chats = (await Api.listChats(courseId)) || []; renderChatList(); renderActiveChat(); }
  catch (error) { console.error('Could not refresh the chat list', error); }
}

async function openChat(chatId) {
  if (!chatId || chatId === currentChatId) { Router.showView('today'); document.querySelector('#chatInput')?.focus(); return; }
  currentChatId = chatId;
  renderChatList(); renderActiveChat(); Router.showView('today');
  await loadChatMessages(chatId);
  document.querySelector('#chatInput')?.focus();
}

async function loadChatPurposes() {
  if (chatPurposes.length) return chatPurposes;
  const courseId = AppState.courseId;
  if (!courseId || !Api) return [];
  try { chatPurposes = (await Api.listChatPurposes(courseId)) || []; }
  catch (error) { console.error('Could not load chat purposes', error); chatPurposes = []; }
  return chatPurposes;
}

async function openChatModal() {
  const modal = document.querySelector('#chatModal');
  const list = document.querySelector('#chatPurposeList');
  const titleInput = document.querySelector('#chatTitle');
  if (!modal || !list || !titleInput) return;
  if (!AppState.courseId) { openProjectModal(); return; }
  titleInput.value = '';
  modal.classList.remove('hidden');
  const loading = document.createElement('p'); loading.className = 'sidebar-empty'; loading.textContent = 'Reading what a chat can be for…';
  list.replaceChildren(loading);
  const purposes = await loadChatPurposes();
  if (modal.classList.contains('hidden')) return;
  if (!purposes.length) { loading.textContent = 'Purpose options are unavailable, so this chat will read every message on its own wording.'; titleInput.focus(); return; }
  list.replaceChildren(...purposes.map((purpose, index) => {
    const option = document.createElement('label'); option.className = 'purpose-option';
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'chatPurpose'; radio.value = purpose.value; radio.checked = index === 0;
    const copy = document.createElement('span');
    const name = document.createElement('strong'); name.textContent = purpose.label;
    const hint = document.createElement('small'); hint.textContent = purpose.hint || '';
    radio.addEventListener('change', () => { titleInput.placeholder = purpose.defaultTitle; });
    copy.append(name, hint); option.append(radio, copy);
    return option;
  }));
  titleInput.placeholder = purposes[0].defaultTitle;
  titleInput.focus();
}

function closeChatModal() { document.querySelector('#chatModal')?.classList.add('hidden'); }

async function createChatFromModal(event) {
  event?.preventDefault();
  const courseId = AppState.courseId;
  if (!courseId || !Api) return;
  const button = document.querySelector('#createChatButton');
  const purpose = document.querySelector('input[name="chatPurpose"]:checked')?.value || null;
  button.disabled = true;
  try {
    const chat = await Api.createChat(courseId, document.querySelector('#chatTitle').value.trim(), purpose);
    closeChatModal(); Chat.clear();
    await loadChats(chat.id);
    Router.showView('today');
    document.querySelector('#chatInput')?.focus();
  } catch (error) {
    console.error('Could not create chat', error);
    const modalError = document.querySelector('#chatModalError');
    if (modalError) { modalError.innerHTML = UI.errorState(UI.friendlyError(error, apiMessage(error, 'This chat could not be created. Check that the StudyOS backend is running.'))); modalError.classList.remove('hidden'); }
  } finally { button.disabled = false; }
}

/** Used by the tutor's "Teach me" steps: reuses the active chat, creating one when needed. */
async function ensureChatAndSend(prompt) {
  await courseReady;
  const courseId = AppState.courseId;
  if (!courseId || !Api) throw new Error('StudyOS API is not connected');
  if (!currentChatId) { const chat = await Api.createChat(courseId, '', 'MAIN_TUTOR'); currentChatId = chat.id; chats = [chat, ...chats]; renderChatList(); renderActiveChat(); }
  return Api.sendMessage(courseId, currentChatId, prompt);
}

// ------------------------------------------------------------------ lessons & curriculum actions

let openLessonId = null;

async function openLesson(lessonId, title) {
  const workspaceId = AppState.courseId;
  if (!workspaceId || !lessonId || !Api) return;
  openLessonId = lessonId;
  const token = AppState.loadToken;
  document.querySelector('#lessonModal')?.classList.remove('hidden');
  document.querySelector('#lessonTitle').textContent = title || 'Lesson';
  document.querySelector('#lessonEyebrow').textContent = 'LESSON';
  const rewrite = document.querySelector('#rewriteLessonButton');
  if (rewrite) rewrite.disabled = true;
  document.querySelector('#lessonBody').innerHTML = UI.loadingState('Reading your material for this lesson…');
  try {
    const brief = await Api.getLessonBrief(workspaceId, lessonId);
    if (!AppState.isCurrent(token) || openLessonId !== lessonId) return; // workspace or lesson changed mid-load
    renderLessonBrief(brief);
  } catch (error) {
    if (!AppState.isCurrent(token) || openLessonId !== lessonId) return;
    document.querySelector('#lessonBody').innerHTML = UI.errorState(UI.friendlyError(error, apiMessage(error, 'StudyOS could not open this lesson. Check that the backend is running.')));
  } finally { if (rewrite) rewrite.disabled = false; }
}

function closeLessonModal() { document.querySelector('#lessonModal')?.classList.add('hidden'); openLessonId = null; }

async function rewriteLesson() {
  const workspaceId = AppState.courseId;
  if (!workspaceId || !openLessonId) return;
  const button = document.querySelector('#rewriteLessonButton');
  button.disabled = true; button.textContent = 'Rewriting…';
  try { renderLessonBrief(await Api.rewriteLessonBrief(workspaceId, openLessonId)); }
  catch (error) {
    const body = document.querySelector('#lessonBody');
    if (body) body.insertAdjacentHTML('afterbegin', UI.errorState(UI.friendlyError(error, apiMessage(error, 'StudyOS could not rewrite this lesson.'))));
  }
  finally { button.disabled = false; button.textContent = 'Rewrite from my material'; }
}

function lessonSection(heading) {
  const wrapper = document.createElement('div'); wrapper.className = 'lesson-section';
  const label = document.createElement('span'); label.className = 'card-label'; label.textContent = heading;
  wrapper.append(label);
  return wrapper;
}

/** Answers stay behind a click: seeing the answer before trying teaches nothing. */
function renderLessonBrief(brief) {
  const body = document.querySelector('#lessonBody');
  if (!body || !brief) return;
  document.querySelector('#lessonTitle').textContent = brief.title || 'Lesson';
  document.querySelector('#lessonEyebrow').textContent = `${brief.targetLevelLabel || 'LESSON'}${brief.grounded ? '' : ' · NOT FOUND IN YOUR MATERIAL'}`;
  body.innerHTML = '';
  if (brief.objective) { const note = document.createElement('p'); note.className = 'profile-note'; note.textContent = brief.objective; body.append(note); }
  if (brief.missing?.length) {
    const note = document.createElement('div'); note.className = 'lesson-note';
    note.textContent = `This lesson is still missing its ${brief.missing.join(', ')}. Upload the material that covers it, then rewrite the lesson.`;
    body.append(note);
  }
  const section = (heading, text) => {
    if (!text) return;
    const wrapper = lessonSection(heading);
    Chat.appendAssistantText(wrapper, text);
    body.append(wrapper);
  };
  section('IN PLAIN TERMS', brief.intuition);
  section('STATED PRECISELY', brief.formalDefinition);
  section('WORKED EXAMPLE', brief.workedExample);
  if (brief.checks?.length) {
    const wrapper = lessonSection('CHECK YOURSELF');
    brief.checks.forEach((check, index) => {
      const item = document.createElement('div'); item.className = 'lesson-check';
      const question = document.createElement('p'); Chat.appendRichInline(question, `${index + 1}. ${check.question}`); item.append(question);
      if (check.answer) {
        const answer = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = 'Show answer'; answer.append(summary);
        Chat.appendAssistantText(answer, check.answer); item.append(answer);
      }
      wrapper.append(item);
    });
    body.append(wrapper);
  }
  if (brief.commonMistakes?.length) {
    const wrapper = lessonSection('WATCH OUT FOR');
    const list = document.createElement('ul'); list.className = 'rich-list';
    brief.commonMistakes.forEach(mistake => { const item = document.createElement('li'); Chat.appendRichInline(item, mistake); list.append(item); });
    wrapper.append(list); body.append(wrapper);
  }
  section('NEXT', brief.nextStep);
  if (brief.citations?.length) {
    const wrapper = lessonSection('FROM YOUR MATERIAL');
    const line = document.createElement('p'); line.className = 'lesson-citations';
    line.textContent = brief.citations.map(citation => `${citation.documentName}${citation.pageStart > 0 ? ` p.${citation.pageStart}${citation.pageEnd > citation.pageStart ? `–${citation.pageEnd}` : ''}` : ''}`).join(' · ');
    wrapper.append(line); body.append(wrapper);
  }
}

async function buildCurriculum(event) {
  const workspaceId = AppState.courseId;
  if (!workspaceId || !Api) return;
  const button = event?.currentTarget;
  const label = button?.textContent;
  const tree = document.querySelector('#curriculumTree');
  if (button) { button.disabled = true; button.textContent = 'Building…'; }
  tree.innerHTML = UI.loadingState('Reading your material and organising it into modules and lessons in prerequisite order…');
  try {
    const curriculum = await Api.generateCurriculum(workspaceId, workspaceGoal());
    const frontier = await Api.getCurriculumFrontier(workspaceId).catch(() => null);
    AppState.setData({ curriculum, frontier });
    Panels.renderCurriculum(curriculum, frontier, levelLabel);
    Panels.renderFrontier(frontier, curriculum);
    await Tutor.loadTutorPlan();
    await loadProjectData();
  } catch (error) {
    console.error('Could not build the learning path', error);
    tree.innerHTML = UI.errorState(UI.friendlyError(error, 'StudyOS could not build a learning path from the current material.'));
  } finally { if (button) { button.disabled = false; button.textContent = label; } }
}

// ------------------------------------------------------------------ mock exam

function renderMockExam() {
  const panel = document.querySelector('#mockExamPanel');
  if (!panel) return;
  if (!activeMockExam) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  document.querySelector('#mockExamTitle').textContent = activeMockExam.title;
  document.querySelector('#mockExamStatus').textContent = `${activeMockExam.status} · ${activeMockExam.estimatedMinutes} min`;
  document.querySelector('#mockExamInstructions').textContent = activeMockExam.instructions;
  document.querySelector('#mockExamQuestions').innerHTML = activeMockExam.questions.map(question => {
    const grade = mockExamGrades.get(question.id);
    return `<article class="mock-question" data-mock-question="${escapeHtml(question.id)}"><h3>${question.ordinal}. ${escapeHtml(question.prompt)}</h3><small>${escapeHtml(Tutor.answerLabel(question.answerType))} · difficulty ${Math.round(question.difficulty * 100)}%</small>${grade ? `<div class="exercise-grade"></div>` : `<textarea aria-label="Your answer for question ${question.ordinal}" placeholder="Your answer…"></textarea><div class="modal-actions"><button class="primary-button" type="button" data-submit-mock>Submit answer</button></div>`}</article>`;
  }).join('');
  activeMockExam.questions.forEach(question => {
    const article = document.querySelector(`[data-mock-question="${question.id}"]`);
    if (!article) return;
    const grade = mockExamGrades.get(question.id);
    if (grade) Tutor.renderExerciseGrade(article.querySelector('.exercise-grade'), grade, null);
    else article.querySelector('[data-submit-mock]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      const textarea = article.querySelector('textarea');
      const answer = textarea?.value.trim();
      if (!answer) { textarea?.focus(); return; }
      button.disabled = true;
      try {
        const result = await Api.submitAnswer(AppState.courseId, question.id, answer);
        mockExamGrades.set(question.id, result);
        renderMockExam();
      } catch (error) {
        console.error('Could not grade mock exam answer', error);
        button.disabled = false;
        window.alert(apiMessage(error, 'StudyOS could not grade that answer. Check that the backend is running.'));
      }
    });
  });
  document.querySelector('#finishMockExamButton')?.classList.toggle('hidden', mockExamGrades.size < activeMockExam.questions.length || activeMockExam.status === 'COMPLETED');
}

// ------------------------------------------------------------------ retry wiring & stats

document.addEventListener('click', event => {
  const retry = event.target.closest?.('[data-retry-panel]');
  if (!retry) return;
  const courseId = AppState.courseId;
  if (retry.dataset.retryPanel === 'dashboard') loadProjectData();
  else if (retry.dataset.retryPanel === 'curriculum') Panels.loadCurriculum(courseId);
  else if (retry.dataset.retryPanel === 'syllabus') Panels.loadSyllabus(courseId);
  else if (retry.dataset.retryPanel === 'exam-mode') Panels.loadExamMode(courseId);
  else if (retry.dataset.retryPanel === 'tutor-plan') Tutor.loadTutorPlan();
  else if (retry.dataset.retryPanel === 'study-session-retry') Tutor.openStudySession(null);
  else if (retry.dataset.retryPanel === 'research') Panels.refreshResearch(courseId);
  else if (retry.dataset.retryPanel === 'mock-exam') document.querySelector('#createMockExamButton')?.click();
});

/** Lessons and knowledge-map topics open their detail views from anywhere. */
document.addEventListener('click', event => {
  const topicCard = event.target.closest?.('[data-open-topic]');
  if (topicCard) { Panels.openTopic(topicCard.dataset.openTopic, topicCard.dataset.topicName); return; }
  const row = event.target.closest?.('[data-lesson]');
  if (row) openLesson(row.dataset.lesson, row.dataset.lessonTitle);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (!document.querySelector('#chatModal')?.classList.contains('hidden')) { closeChatModal(); return; }
    if (!document.querySelector('#lessonModal')?.classList.contains('hidden')) { closeLessonModal(); return; }
    if (!document.querySelector('#topicModal')?.classList.contains('hidden')) { Panels.closeTopic(); return; }
  }
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest?.('[data-lesson]');
  if (row) { event.preventDefault(); openLesson(row.dataset.lesson, row.dataset.lessonTitle); }
  const topicCard = event.target.closest?.('[data-open-topic]');
  if (topicCard) { event.preventDefault(); Panels.openTopic(topicCard.dataset.openTopic, topicCard.dataset.topicName); }
});

// ------------------------------------------------------------------ wiring

/** Keyboard containment for modal dialogs: Tab cycles inside, focus never escapes mid-dialog. */
function trapFocus(modal) {
  modal.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const focusables = [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.disabled && element.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  });
}

function wire() {
  ['#projectModal', '#chatModal', '#sessionModal', '#lessonModal', '#topicModal']
    .map(selector => document.querySelector(selector)).filter(Boolean).forEach(trapFocus);

  document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => Router.showView(item.dataset.view)));
  document.querySelectorAll('[data-view-link]').forEach(item => item.addEventListener('click', () => Router.showView(item.dataset.viewLink)));
  document.querySelector('#mobileNavButton')?.addEventListener('click', () => Router.toggleMobileNavigation());

  Router.onShow('curriculum', () => { if (!AppState.data.curriculum) Panels.loadCurriculum(AppState.courseId); Panels.loadSyllabus(AppState.courseId); });
  Router.onShow('exam', () => { Panels.loadExamMode(AppState.courseId); });
  document.querySelector('#startExamModeButton')?.addEventListener('click', () => Panels.loadExamMode(AppState.courseId));

  const chatForm = document.querySelector('#chatForm');
  const chatInput = document.querySelector('#chatInput');
  chatForm?.addEventListener('submit', async event => {
    event.preventDefault();
    let prompt = chatInput.value.trim();
    if (!prompt) return;
    const depth = document.querySelector('#explanationDepth')?.value;
    if (depth) prompt = `${depth === 'exam' ? 'At exam level' : `At a ${depth} level`}: ${prompt}`;
    Chat.addMessage(prompt, 'user');
    chatInput.value = '';
    chatInput.disabled = true;
    const sendButton = chatForm.querySelector('button');
    if (sendButton) sendButton.disabled = true;
    const progress = Chat.addProgress();
    try {
      const reply = await ensureChatAndSend(prompt);
      progress.remove();
      Chat.addMessage(reply.content || 'The AI returned an empty response.', 'assistant');
      // A chat reply changes no mastery or plan, so the heavy dashboard reload is not needed here;
      // only the sidebar list (titles/message counts) has to catch up.
      await refreshChatList();
    } catch (_) {
      progress.remove();
      Chat.addMessage('The StudyOS backend could not answer this message. Check that the backend and AI provider are running.', 'assistant');
    } finally {
      chatInput.disabled = false;
      if (sendButton) sendButton.disabled = false;
      chatInput.focus();
    }
  });
  document.querySelectorAll('.chat-suggestions button').forEach(button => button.addEventListener('click', () => { chatInput.value = button.dataset.prompt; chatInput.focus(); }));

  document.querySelector('#newChatButton')?.addEventListener('click', openChatModal);
  document.querySelector('#newChatForm')?.addEventListener('submit', createChatFromModal);
  document.querySelector('#closeChatModal')?.addEventListener('click', closeChatModal);
  document.querySelector('#cancelChat')?.addEventListener('click', closeChatModal);

  document.querySelector('#editPlanButton')?.addEventListener('click', regeneratePlan);
  document.querySelector('#startSessionButton')?.addEventListener('click', () => Tutor.openStudySession((AppState.data.plan?.tasks || []).find(task => task.status === 'PENDING') || null));
  document.querySelector('#quizWeakButton')?.addEventListener('click', () => { Router.showView('today'); chatInput.value = 'Quiz me on my weakest topic'; chatInput.focus(); });
  document.querySelector('#sessionAnswerForm')?.addEventListener('submit', event => Tutor.submitSessionAnswer(event));
  document.querySelector('#sessionHintButton')?.addEventListener('click', () => Tutor.requestSessionHint());
  document.querySelector('#completeSessionButton')?.addEventListener('click', () => Tutor.completeStudySessionModal());
  document.querySelector('#closeSessionModal')?.addEventListener('click', () => Tutor.closeStudySession());
  document.querySelector('#cancelSession')?.addEventListener('click', () => Tutor.closeStudySession());

  document.querySelector('#closeLessonModal')?.addEventListener('click', closeLessonModal);
  document.querySelector('#doneLessonButton')?.addEventListener('click', closeLessonModal);
  document.querySelector('#rewriteLessonButton')?.addEventListener('click', rewriteLesson);
  document.querySelector('#closeTopicModal')?.addEventListener('click', () => Panels.closeTopic());
  document.querySelector('#doneTopicButton')?.addEventListener('click', () => Panels.closeTopic());

  document.querySelector('#preferenceForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const key = document.querySelector('#preferenceKey').value;
    const value = document.querySelector('#preferenceValue').value.trim();
    if (!value) return;
    try {
      await Api.setLearningPreference(AppState.courseId, key, value);
      document.querySelector('#preferenceValue').value = '';
      AppState.setData({ learner: await Api.getLearnerState(AppState.courseId) });
      Panels.renderPreferences(AppState.data.learner?.preferences || []);
    } catch (error) { console.error('Could not save learning preference', error); }
  });

  document.querySelector('#createMockExamButton')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const panel = document.querySelector('#mockExamPanel');
    button.disabled = true; button.textContent = 'Generating…';
    try {
      activeMockExam = await Api.createMockExam(AppState.courseId, { count: 5, estimatedMinutes: 90 });
      activeMockExam = await Api.startMockExam(AppState.courseId, activeMockExam.id);
      mockExamGrades = new Map();
      renderMockExam();
      document.querySelector('#mockExamPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      console.error('Could not create mock exam', error);
      if (panel) {
        panel.classList.remove('hidden');
        panel.innerHTML = UI.errorState(UI.friendlyError(error, 'StudyOS could not create a supported mock exam. Check that processed sources exist and the AI provider is available, then try again.'), { retry: 'mock-exam' });
      }
    } finally { button.disabled = false; button.textContent = 'Create mock exam →'; }
  });
  document.querySelector('#finishMockExamButton')?.addEventListener('click', async () => {
    if (!activeMockExam) return;
    try {
      activeMockExam = await Api.completeMockExam(AppState.courseId, activeMockExam.id);
      renderMockExam();
      await loadProjectData();
      const status = document.querySelector('#mockExamStatus');
      if (status) status.textContent = `Complete · score ${Math.round((activeMockExam.score || 0) * 100)}% · readiness updated`;
    } catch (error) { console.error('Could not complete mock exam', error); }
  });

  document.querySelector('#sourceUpload')?.addEventListener('change', async event => {
    const files = [...event.target.files];
    const courseId = AppState.courseId;
    for (const file of files) {
      AppState.setSources([[file.name, 'NEW SOURCE', `${Math.ceil(file.size / 1024)} KB · awaiting processing`, null, file.type || (file.name.endsWith('.md') ? 'text/markdown' : 'text/plain')], ...AppState.sources.sources]);
      if (courseId && Api) { try { await Api.uploadSource(courseId, file); } catch (error) { console.error('Could not upload source', error); } }
    }
    event.target.value = '';
    renderSources();
    await loadSources();
    await loadProjectData();
    if (files.length) [2000, 6000, 12000].forEach(delay => setTimeout(async () => {
      if (AppState.courseId !== courseId) return; // workspace switched: stale refreshes stop here
      await loadSources();
      await loadProjectData();
    }, delay));
  });

  document.querySelector('#pasteSourceButton')?.addEventListener('click', async () => {
    const courseId = AppState.courseId;
    if (!courseId || !Api) return;
    const title = window.prompt('Name these notes', 'Pasted notes');
    if (title === null) return;
    const content = window.prompt('Paste your notes');
    if (!content?.trim()) return;
    try {
      await Api.pasteSource(courseId, { title: title.trim() || 'Pasted notes', content, type: 'STUDENT_NOTE' });
      await loadSources(); await loadProjectData();
      [2000, 6000].forEach(delay => setTimeout(async () => {
        if (AppState.courseId !== courseId) return;
        await loadSources(); await loadProjectData();
      }, delay));
    } catch (error) {
      console.error('Could not add pasted notes', error);
      const sourceList = document.querySelector('#sourceList');
      if (sourceList) sourceList.insertAdjacentHTML('afterbegin', UI.errorState(UI.friendlyError(error, 'The notes could not be added. Check that the StudyOS backend is running.')));
    }
  });

  document.querySelector('#newProjectButton')?.addEventListener('click', openProjectModal);
  document.querySelector('#newProjectFooterButton')?.addEventListener('click', openProjectModal);
  document.querySelector('#projectForm')?.addEventListener('submit', createProject);
  document.querySelector('#closeProjectModal')?.addEventListener('click', closeProjectModal);
  document.querySelector('#cancelProject')?.addEventListener('click', closeProjectModal);
  document.querySelector('#deleteWorkspaceButton')?.addEventListener('click', deleteCurrentWorkspace);
  document.querySelector('#startTutorSessionButton')?.addEventListener('click', event => Tutor.startOrResumeTutorSession(event));
  document.querySelector('#tutorMinutes')?.addEventListener('change', () => { if (!Tutor.activeSession()) Tutor.loadTutorPlan(); });
  document.querySelector('#generateCurriculumButton')?.addEventListener('click', buildCurriculum);
  document.querySelector('#refreshProfileButton')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const label = button.textContent;
    button.disabled = true; button.textContent = 'Recomputing…';
    try { AppState.setData({ profile: await Api.refreshLearnerProfile(AppState.courseId) }); Panels.renderLearnerProfile(AppState.data.profile); }
    catch (error) { console.error('Could not recompute the learner profile', error); document.querySelector('#profileNote').textContent = apiMessage(error, 'StudyOS could not recompute your profile.'); }
    finally { button.disabled = false; button.textContent = label; }
  });
}

// ------------------------------------------------------------------ bootstrap

function bootstrap() {
  Chat.bind(document.querySelector('#chatHistory'));
  Chat.onChatTitle(() => chats.find(chat => chat.id === currentChatId)?.title || 'New chat');
  Tutor.init({
    workspaceId: () => AppState.courseId,
    requestedMinutes: requestedTutorMinutes,
    onDataChanged: loadProjectData,
    ensureChatAndSend
  });
  Tutor.initStudySession({
    workspaceId: () => AppState.courseId,
    onDataChanged: loadProjectData
  });
  Panels.bindTopicActions({
    startSession: async payload => { await Tutor.openStudySession({ topicId: payload.topicId }); },
    askTutor: async prompt => {
      Router.showView('today');
      const input = document.querySelector('#chatInput');
      if (input) { input.value = prompt; input.focus(); }
    }
  });
  wire();

  renderTasks();
  updateProgress();
  renderSources();
  renderMockExam();
  Dashboard.renderDashboard();

  if (!Api) return;
  Api.health().then(() => { document.querySelectorAll('.memory-status').forEach(item => { item.innerHTML = '<i></i> API connected'; }); }).catch(() => {});
  courseReady = Api.listWorkspaces().then(async result => {
    const deepLink = new URLSearchParams(window.location.search);
    const linkedWorkspace = deepLink.get('workspace');
    const linkedTask = deepLink.get('task');
    courses = result || [];
    AppState.setWorkspaces(courses);
    const course = courses.find(item => item.id === (linkedWorkspace || AppState.courseId)) || courses[0];
    if (!course) {
      document.querySelector('.topbar h1').textContent = 'Create your first workspace';
      renderProjects();
      openProjectModal();
      return;
    }
    await selectProject(course);
    if (linkedTask) await Tutor.openStudySession({ taskId: linkedTask });
  }).catch(error => { console.error('Could not load projects', error); });
}

bootstrap();
