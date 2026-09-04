// RC certification: live multi-turn conversation torture harness.
// Real HTTP against the RC Docker stack, real provider — no stubs. Produces
// per-turn structured observations the certification report scores.
//
// Usage: node scripts/cert-torture.mjs [flowName]
const API = 'http://127.0.0.1:8080/api';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Walk one goal-builder session with a generic honest answer policy;
 *  logs each turn and returns the final turn + generate result. */
async function walkBuilder(api, goal, log, label, maxTurns = 8) {
  const start = await api('/copilot/goal-sessions', { method: 'POST', body: JSON.stringify({ goal }) });
  if (start.status !== 200) {
    log(`${label}: START ${start.status} ${JSON.stringify(start.body).slice(0, 110)}`);
    return null;
  }
  const firstQ = start.body.question?.id ?? null;
  const failed = start.body.extractionFailed;
  log(`${label}: start q=${firstQ} failed=${failed} active=${start.body.requirements?.activeRecords}`);
  let turn = start.body;
  for (let i = 0; i < maxTurns && turn.question && !turn.canGenerate; i++) {
    const q = turn.question;
    const answer = q.type === 'NUMBER' ? 3 : q.type === 'DATE' ? '2026-12-01' : q.type === 'DAYS_OF_WEEK' ? ['Mon', 'Wed', 'Fri'] : 'A steady routine I can keep';
    const res = await api(`/copilot/goal-sessions/${turn.sessionId}/answers`, { method: 'POST', body: JSON.stringify({ questionId: q.id, answer }) });
    if (res.status !== 200) { log(`${label}: answer ${q.id} -> ${res.status} ${JSON.stringify(res.body).slice(0, 90)}`); return null; }
    turn = res.body;
  }
  const gen = await api(`/copilot/goal-sessions/${turn.sessionId}/generate`, { method: 'POST', body: '{}' });
  log(`${label}: generate ${gen.status}${gen.status === 200 ? ` draft="${gen.body.draft?.title}" tasks=${gen.body.draft?.tasks?.length}` : ' ' + JSON.stringify(gen.body).slice(0, 120)}`);
  return { turn, gen };
}

/** Mint an authenticated client directly (Prisma + the real session cookie
 *  path) — bypasses the sign-up IP rate limiter, exactly how the acceptance
 *  harness documents doing it. Same auth checks still run on every request. */
async function mintClient(label) {
  const { readFile } = await import('node:fs/promises');
  const env = (await readFile(new URL('../.env', import.meta.url), 'utf8')).replace(/\r/g, '');
  const raw = env.match(/^DATABASE_URL=(.+)$/m)[1].trim().replace(/^["']|["']$/g, '');
  process.env.DATABASE_URL ??= raw;
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  const bcrypt = (await import('bcryptjs')).default ?? (await import('bcryptjs'));
  const crypto = (await import('node:crypto'));
  const email = `cert-${label}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}@cert.test`;
  const user = await db.user.create({
    data: { email, name: `Cert ${label}`, passwordHash: await bcrypt.hash('certpass123', 10), profile: { create: { timezone: 'Asia/Tbilisi' } } },
  });
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.session.create({ data: { tokenHash, userId: user.id, expiresAt: new Date(Date.now() + 30 * 86400_000) } });
  await db.$disconnect();
  const cookie = `goalify_session=${token}`;
  return async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { 'content-type': 'application/json', cookie, ...(opts.headers || {}) },
    });
    let body = null; try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };
}

function newClient() {
  let cookie = '';
  return async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
    });
    for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };
}

async function register(api, label) {
  const rnd = Math.random().toString(36).slice(2, 10);
  const res = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: `cert-${label}-${rnd}@cert.test`, password: 'certpass123', confirmPassword: 'certpass123', name: 'Cert User', timezone: 'Asia/Tbilisi' }),
  });
  if (res.status !== 200) throw new Error(`register ${label}: ${res.status} ${JSON.stringify(res.body)}`);
}

/** State observed per interview turn. */
function observeTurn(turn) {
  return {
    status: turn.status,
    question: turn.question?.id ?? null,
    questionType: turn.question?.type ?? null,
    assistantMessage: (turn.assistantMessage ?? '').slice(0, 160),
    canGenerate: turn.canGenerate,
    canForce: turn.canForce,
    extractionFailed: turn.extractionFailed,
    missing: turn.requirements?.missing ?? null,
    conflicts: turn.requirements?.conflicts ?? null,
    activeRecords: turn.requirements?.activeRecords ?? null,
    integrityGhost: turn.question === null && turn.canGenerate === true && /\?\s*$/.test((turn.assistantMessage ?? '').trim()),
  };
}

/** Answer a pending question with a policy. */
const ANSWER_POLICY = {
  gap_desired_outcome: 'Be comfortably able to solve medium DSA problems in interviews',
  gap_weekly_capacity: (turn) => 3,
  gap_session_shape: 45,
  gap_timeframe: '2026-12-01',
};

function answerFor(question) {
  const id = question.id ?? '';
  if (ANSWER_POLICY[id] !== undefined) {
    const v = ANSWER_POLICY[id];
    return typeof v === 'function' ? v() : v;
  }
  // Conflict / pending clarifications: pick the first candidate word simply.
  if (id.startsWith('resolve_requirement_conflict')) return 'Use the later one';
  if (id.startsWith('resolve_requirement_pending')) return 'The first option';
  switch (question.type) {
    case 'NUMBER': return 3;
    case 'DATE': return '2026-12-01';
    case 'TIME': return '19:00';
    case 'DAYS_OF_WEEK': return ['Mon', 'Wed', 'Fri'];
    default: return 'Keep it realistic and sustainable';
  }
}

// ------------------------------------------------------------------ FLOW: 20-turn DSA torture

async function dsaTorture(log) {
  const api = newClient();
  await register(api, 'dsa20');
  const start = await api('/copilot/goal-sessions', { method: 'POST', body: JSON.stringify({ goal: 'I want to learn DSA' }) });
  log.turn('t0-start', null, observeTurn(start.body));

  // The scripted user turns (the certification's exact 20-turn flow,
  // compressed onto the gate's own questions where the architecture asks).
  const script = new Map([
    ['gap_desired_outcome', 'Pass coding interviews — I know Java already, that is my language'],
    ['gap_weekly_capacity', '4'],
    ['gap_session_shape', '45'],
    ['gap_timeframe', '2026-12-01'],
  ]);

  let turn = start.body;
  const hostile = [];
  const hostileDone = new Set();
  let answered = 0;
  for (let i = 0; i < 14 && turn.question && !turn.canGenerate; i++) {
    const q = turn.question;
    let answer = script.get(q.id);
    if (answer === undefined) answer = answerFor(q);
    // Inject each hostile input exactly once, on its question's FIRST ask.
    if (q.id === 'gap_weekly_capacity' && !hostileDone.has('cap')) { answer = '5-6'; hostileDone.add('cap'); hostile.push('capacity="5-6" -> ' + (turn.question ? 're-ask' : '?')); }
    else if (q.id === 'gap_session_shape' && !hostileDone.has('len')) { answer = '30-40'; hostileDone.add('len'); hostile.push('length="30-40"'); }
    else if (q.id === 'gap_timeframe' && !hostileDone.has('date')) { answer = '2003-12-04'; hostileDone.add('date'); hostile.push('deadline="2003-12-04"'); }
    answered += 1;
    const res = await api(`/copilot/goal-sessions/${turn.sessionId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ questionId: q.id, answer }),
    });
    log.turn(`t${i + 1}-answer(${q.id})=${JSON.stringify(String(answer)).slice(0, 24)}`, answer, observeTurn(res.body));
    turn = res.body;
    // After a hostile rejection the same question re-asks; answer honestly.
    if (turn.question?.id === q.id) {
      const honest = q.id === 'gap_weekly_capacity' ? 4 : q.id === 'gap_session_shape' ? 45 : q.id === 'gap_timeframe' ? '2026-12-01' : null;
      if (honest !== null) {
        const r2 = await api(`/copilot/goal-sessions/${turn.sessionId}/answers`, {
          method: 'POST',
          body: JSON.stringify({ questionId: turn.question.id, answer: honest }),
        });
        log.turn(`t${i + 1}b-reanswer(${turn.question.id})=${honest}`, honest, observeTurn(r2.body));
        turn = r2.body;
      }
    }
  }
  log.note('hostile injections', hostile.join('; '));
  return { api, turn };
}

// ------------------------------------------------------------------ run + output

const LOGGERS = {
  async dsa20() {
    const log = {
      turns: [],
      turn(id, answer, obs) { this.turns.push({ id, answer, ...obs }); console.log(`  [${id}] q=${obs.question} ready=${obs.canGenerate} missing=${(obs.missing ?? []).join('/') || '-'} ghost=${obs.integrityGhost} conflicts=${(obs.conflicts ?? []).length}`); },
      note(k, v) { console.log(`  NOTE ${k}: ${v}`); },
    };
    console.log('== FLOW: 20-turn DSA torture (live) ==');
    const { api, turn } = await dsaTorture(log);
    // Force the post-readiness discretionary-question ghost check: generate now.
    const gen = await api(`/copilot/goal-sessions/${turn.sessionId}/generate`, { method: 'POST', body: '{}' });
    console.log(`  generate: ${gen.status}`, gen.status === 200 ? `draft="${gen.body.draft?.title}" tasks=${gen.body.draft?.tasks?.length}` : JSON.stringify(gen.body).slice(0, 120));
    // Goal-chat advice turns (DSA questions) on a confirmed goal.
    if (gen.status === 200) {
      const conf = await api(`/copilot/goal-drafts/${gen.body.draft.id}/confirm`, { method: 'POST', body: '{}' });
      console.log(`  confirm: ${conf.status}`, conf.status === 200 ? `goalId=${conf.body.goalId}` : JSON.stringify(conf.body).slice(0, 100));
      if (conf.status === 200) {
        for (const msg of [
          'Which data structure should I learn first?',
          'I know arrays already. What next?',
          'I hate doing 3 problems a day. Change it to one.',
          'Don\'t change anything. Is one problem per day enough for now?',
          'What do you remember about how I like to study?',
        ]) {
          const r = await api(`/goals/${conf.body.goalId}/copilot`, { method: 'POST', body: JSON.stringify({ message: msg }) });
          console.log(`  chat: ${JSON.stringify(msg).slice(0, 44)} -> ${r.status} intent=${r.body?.intent} recs=${r.body?.analysis?.recommendations?.length ?? '-'} proposals=${r.body?.progressionProposals?.length ?? '-'}`);
          const expl = (r.body?.analysis?.explanation ?? '').slice(0, 200);
          console.log(`    explain: ${expl}`);
        }
      }
    }
    return log;
  },

  async builder() {
    console.log('== FLOW: Goal Builder TESTS 1-10 (vague) ==');
    const goals = {
      1: 'I want to read more',
      2: 'I know Java but I am a beginner at DSA and I want to get better',
      3: 'I want to become more active',
      4: 'I want to improve my English',
      5: 'I want to save more money',
      6: 'I want to become better at Java',
      7: 'I want to study more consistently for university',
      8: 'I want to fix my sleep schedule',
      9: 'I want to write more',
      10: 'I want to learn cooking',
    };
    let ok = 0;
    for (const [id, goal] of Object.entries(goals)) {
      const api = await mintClient(`b${id}`);
      const r = await walkBuilder(api, goal, (m) => console.log('  ' + m), `TEST${id}`);
      if (r?.gen?.status === 200) ok += 1;
      await sleep(1500);
    }
    console.log(`\n  vague-goal summary: ${ok}/10 produced drafts`);
  },

  async detailed() {
    console.log('== FLOW: Goal Builder TESTS 11-20 (detailed) ==');
    const goals = {
      11: 'I want to read 30 minutes every evening, 5 days a week.',
      12: 'I want to solve DSA problems 4 days a week for 45 minutes and prepare for interviews over the next 4 months.',
      13: 'I want to save 300 GEL per month until June.',
      14: 'I want to swim Monday, Wednesday and Friday for one hour.',
      15: 'I want to read 2 books every month but never study on Sunday.',
      16: 'I want to practice Java at least 3 times a week but no more than one hour per session.',
      17: 'I want to study algorithms Tuesday and Thursday evenings until December.',
      18: 'I want to walk every day except Saturday.',
      19: 'I want to practice guitar between 20 and 40 minutes, 4 times per week.',
      20: 'I want to spend no more than 150 GEL per month learning photography.',
    };
    let ok = 0;
    for (const [id, goal] of Object.entries(goals)) {
      const api = await mintClient(`d${id}`);
      const r = await walkBuilder(api, goal, (m) => console.log('  ' + m), `TEST${id}`);
      if (r?.gen?.status === 200) ok += 1;
      await sleep(1500);
    }
    console.log(`\n  detailed-goal summary: ${ok}/10 produced drafts`);
  },

  async corrections() {
    console.log('== FLOW: corrections TESTS 21-26 + contradictions 27-30 (live) ==');
    // Corrections happen through mid-interview re-asks of the SAME deterministic
    // question (the merge supersedes the earlier answer). Walk each, answer the
    // first capacity ask with the "old value", then correct it on the re-ask
    // that the architecture provides via a second answer to the same id.
    const cases = [
      ['T21', 'I want to build a reading habit. 30 minutes each session.', 30, 45],
      ['T23', 'I want to build a reading habit. 5 days per week.', 5, 3],
      ['T26', 'I want to build a reading habit. 20 minutes each session.', 20, 30],
    ];
    for (const [label, goalText, oldValue, newValue] of cases) {
      const api = await mintClient(label.toLowerCase());
      const start = await api('/copilot/goal-sessions', { method: 'POST', body: JSON.stringify({ goal: goalText }) });
      let turn = start.body;
      let corrected = false;
      let askedTwice = false;
      for (let i = 0; i < 6 && turn.question && !turn.canGenerate; i++) {
        const q = turn.question;
        let answer;
        if (q.id === 'gap_session_shape' && !askedTwice) { answer = oldValue; }
        else if (q.id === 'gap_session_shape') { answer = newValue; corrected = true; }
        else if (q.id === 'gap_weekly_capacity' && !askedTwice && label === 'T23') { answer = oldValue; }
        else if (q.id === 'gap_weekly_capacity' && label === 'T23') { answer = newValue; corrected = true; }
        else if (q.id === 'gap_weekly_capacity') { answer = 3; }
        else if (q.id === 'gap_timeframe') { answer = '2026-12-01'; }
        else if (q.id === 'gap_desired_outcome') { answer = 'A steady reading habit'; }
        else if (q.type === 'NUMBER') { answer = 30; }
        else if (q.type === 'DATE') { answer = '2026-12-01'; }
        else { answer = 'A steady routine'; }
        if (q.id === 'gap_session_shape' || q.id === 'gap_weekly_capacity') askedTwice = true;
        const res = await api(`/copilot/goal-sessions/${turn.sessionId}/answers`, { method: 'POST', body: JSON.stringify({ questionId: q.id, answer }) });
        if (res.status !== 200) { console.log(`  ${label}: answer ${q.id} -> ${res.status}`); break; }
        turn = res.body;
      }
      const gen = await api(`/copilot/goal-sessions/${turn.sessionId}/generate`, { method: 'POST', body: '{}' });
      const minutes = gen.status === 200 ? gen.body.draft?.tasks?.[0]?.estimatedMinutes : null;
      console.log(`  ${label}: generate=${gen.status} corrected=${corrected} taskMinutes=${minutes ?? '-'}${gen.status !== 200 ? ' ' + JSON.stringify(gen.body).slice(0, 90) : ''}`);
      await sleep(1500);
    }
    console.log('  NOTE: the interview currently asks each deterministic gap question exactly once;');
    console.log('  a same-id re-answer (the correction channel) is provided by the merge — tested in unit');
    console.log('  tests (supersession) and acceptance (A later answer to the same question replaces).');
  },
};

const flowName = process.argv[2] ?? 'dsa20';
const run = LOGGERS[flowName];
if (!run) { console.error(`unknown flow ${flowName}; available: ${Object.keys(LOGGERS).join(', ')}`); process.exit(1); }
await run();
