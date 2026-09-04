// RC certification: live multi-turn conversation torture harness.
// Real HTTP against the RC Docker stack, real provider — no stubs. Produces
// per-turn structured observations the certification report scores.
//
// Usage: node scripts/cert-torture.mjs [flowName]
const API = 'http://127.0.0.1:8080/api';

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
};

const flowName = process.argv[2] ?? 'dsa20';
const run = LOGGERS[flowName];
if (!run) { console.error(`unknown flow ${flowName}; available: ${Object.keys(LOGGERS).join(', ')}`); process.exit(1); }
await run();
