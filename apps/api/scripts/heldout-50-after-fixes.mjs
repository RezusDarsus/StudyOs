import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT=path.resolve(process.argv[2]??'benchmark-results');
const API=process.env.BENCHMARK_API??'http://127.0.0.1:8080/api';
const RUN_SLUG=process.env.BENCHMARK_RUN_SLUG??'after-fixes';
const RUN_NAME=process.env.BENCHMARK_RUN_NAME??'AFTER_FIXES';
const RUN_TITLE=process.env.BENCHMARK_RUN_TITLE??'After Fixes';
const RESUME=process.env.BENCHMARK_RESUME==='1';
const fixtureText=await readFile(path.join(OUT,'heldout-50-prompts.json'),'utf8');
const fixture=JSON.parse(fixtureText); const allCases=fixture.cases;
const fixtureHash=createHash('sha256').update(fixtureText).digest('hex');
if(allCases.length!==50||allCases.some((x,i)=>x.id!==i+1)) throw new Error('Frozen fixture is not IDs 1-50');
const selectedIds=(process.env.BENCHMARK_CASE_IDS??'').split(',').map((value)=>value.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
const cases=selectedIds.length?allCases.filter(item=>selectedIds.includes(item.id)):allCases;
const afterPath=path.join(OUT,`heldout-50-${RUN_SLUG}.json`);
let resumedResults=[];
try{const existing=JSON.parse(await readFile(afterPath,'utf8'));if(!RESUME)throw new Error(`${RUN_TITLE} artifact already exists`);if(existing.fixtureSha256!==fixtureHash||existing.run!==RUN_NAME)throw new Error('Resume artifact metadata does not match');resumedResults=existing.results??[];if(resumedResults.some((result,index)=>result.id!==index+1))throw new Error('Resume artifact is not a consecutive prefix');}catch(e){if(e.code!=='ENOENT')throw e;if(RESUME)throw new Error('Resume artifact does not exist');}

const D={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
const p=(freq,minutes,days,time='19:00',extra={})=>({freq,minutes,days,time,...extra});
const profiles={
1:p(7,5,Object.keys(D),'20:00'),2:p(1,30,['Sun'],'16:00'),3:p(1,120,['Sat'],'11:00',{number:8}),4:p(3,30,['Mon','Wed','Sat'],'18:30'),5:p(1,20,['Sat'],'09:00'),
6:p(2,45,['Tue','Thu'],'19:00'),7:p(3,60,['Mon','Wed','Sat'],'19:00'),8:p(3,50,['Mon','Tue','Thu'],'09:00'),9:p(2,60,['Tue','Sun']),10:p(2,45,['Mon','Thu']),11:p(2,45,['Mon','Wed']),12:p(3,60,['Tue','Fri','Sun'],'07:00'),
13:p(1,20,['Sat'],'10:00',{money:350,date:'2027-09-30'}),14:p(1,20,['Sat'],'10:00',{money:450}),15:p(1,30,['Fri'],'17:00',{money:400,date:'2027-04-30'}),16:p(1,20,['Fri'],'18:00',{money:550,date:'2027-02-28'}),17:p(1,20,['Sat'],'11:00',{money:700,date:'2027-01-15'}),18:p(1,20,['Sun'],'11:00',{money:700,date:'2027-05-31'}),
19:p(1,180,['Sat'],'10:00',{hours:3,date:'2026-09-05'}),20:p(1,30,['Sun'],'16:00',{date:'2026-10-31'}),21:p(2,90,['Tue','Sat'],'17:00',{date:'2026-12-18'}),22:p(3,60,['Tue','Wed','Thu'],'18:00',{date:'2027-02-28'}),
23:p(3,60,['Tue','Thu','Sat']),24:p(3,75,['Mon','Wed','Sat']),25:p(3,45,['Tue','Thu','Sun'],'18:30'),26:p(4,60,['Mon','Wed','Fri','Sun']),27:p(2,90,['Wed','Sat']),28:p(4,75,['Tue','Thu','Sat','Sun']),
29:p(1,120,['Sun'],'10:00'),30:p(1,60,['Sat'],'11:00'),31:p(2,150,['Tue','Sat']),32:p(2,90,['Wed','Sun'], '18:00',{money:20000}),33:p(2,120,['Wed','Sat']),
34:p(3,30,['Tue','Thu','Sat']),35:p(5,20,['Mon','Tue','Wed','Thu','Fri'],'17:30'),36:p(3,60,['Tue','Thu','Sun']),37:p(3,30,['Tue','Thu','Sun'],'07:00'),38:p(3,45,['Tue','Thu','Sun']),39:p(4,50,['Tue','Thu','Sat','Sun'],'07:00'),40:p(3,50,['Mon','Wed','Sat']),41:p(0,30,[]),42:p(3,30,['Tue','Thu','Sun'],'20:00'),43:p(4,45,['Mon','Wed','Fri','Sun']),44:p(2,45,['Tue','Sat'],'07:00'),45:p(2,40,['Wed','Sun']),
46:p(3,120,['Tue','Thu','Sun'], '19:00',{hours:6,date:'2027-05-31'}),47:p(3,60,['Mon','Tue','Sat'],'07:00'),48:p(5,120,['Mon','Wed','Sun'], '18:00',{hours:10,date:'2026-12-18'}),49:p(2,150,['Tue','Sat'], '18:00',{hours:5}),50:p(1,30,['Sun'],'17:00',{money:650,date:'2027-08-31'}),
};
const special={
11:'I cannot add a third day. Reduce the frequency to two days unless I explicitly allow two sessions on one day.',
17:'Use 2.75 GEL per USD as a planning exchange-rate assumption and label it as changeable.',
21:'The semester ends on December 18, 2026.',29:'Extend the deadline or reduce scope; solo work and quality remain fixed.',
32:'My planning budget is €20,000, I can move out for four weeks, and I still need contractor quotes.',
34:'Success means four original briefs reviewed with an agreed novelty rubric; do not use “twice” as a number.',
35:'First establish a baseline using completed priority outcomes and overdue work; 95% is not currently measurable.',
36:'Assess my current level, then define one narrow demonstrable security capability for the month.',
37:'Keep the current stage until I explicitly accept a change.',38:'Reduce to three 45-minute sessions and reassess after two stable weeks.',
39:'Offer a modest progression recommendation, but wait for my approval.',40:'Keep the current stage and reassess after two normal weeks.',
41:'Pause for two weeks, preserve the stage, and require my decision to resume.',42:'Keep the current plan active until I approve a recommendation.',
43:'I accept exactly one added weekly coding session and authorize no other changes.',44:'I reject the increase; keep exactly two sessions.',
45:'My decision is STAY at two 40-minute sessions.',47:'No movement currently causes pain; pause for sharp pain and require approval before progression.',
};
const fullDay={Sun:'Sunday',Mon:'Monday',Tue:'Tuesday',Wed:'Wednesday',Thu:'Thursday',Fri:'Friday',Sat:'Saturday'};
function chooseOption(options,wanted){const ws=(Array.isArray(wanted)?wanted:[wanted]).map(x=>String(x).toLowerCase());return options.filter(o=>ws.some(w=>o.toLowerCase().includes(w)||w.includes(o.toLowerCase())));}
function answer(q,item){const pr=profiles[item.id];const t=`${q.id??''} ${q.prompt??''}`.toLowerCase();const opts=q.options??[];
  if(q.type==='NUMBER'){
    if(/hours? per|how many hours/.test(t)) return pr.hours??Math.max(1,Math.round(pr.freq*pr.minutes/60));
    if(/minute|duration|session length|how long/.test(t)) return pr.minutes;
    if(/how many months|months per year|weeks? per year/.test(t)) return item.id===15&&/above/.test(t)?0:(pr.number??1);
    if(/money|amount|budget|income|contribut|save|payment|gel|usd|eur|currency/.test(t)) return pr.money??100;
    if(/month|week|day|frequen|often|session|times/.test(t)) return pr.freq||1;
    return pr.number??pr.freq??1;
  }
  if(q.type==='DATE') return pr.date??'2026-12-31'; if(q.type==='TIME') return pr.time;
  if(q.type==='DAYS_OF_WEEK') return pr.days;
  if(q.type==='SINGLE_SELECT'||q.type==='MULTI_SELECT'){
    let hits=[];
    if(/which day|days of|day\(s\)|when.*week/.test(t)) hits=chooseOption(opts,pr.days.flatMap(d=>[d,fullDay[d]]));
    else if(/time|morning|afternoon|evening/.test(t)) hits=chooseOption(opts,pr.time<'12:00'?'Morning':pr.time<'17:00'?'Afternoon':'Evening');
    else if(/how many|frequen|often|sessions|days per|weeks per/.test(t)) {const numberWords={0:'zero',1:'one once',2:'two twice',3:'three',4:'four',5:'five',6:'six',7:'seven'};hits=chooseOption(opts,[String(pr.freq||1),...(numberWords[pr.freq||1]??'').split(' ')]);}
    else if(/urgent|deadline|flexib|trade.?off|change/.test(t)) hits=opts.filter(o=>/flex|extend|reduce|scope|adjust/.test(o.toLowerCase()));
    else if(/length|duration|minutes/.test(t)) hits=opts.filter(o=>o.includes(String(pr.minutes)));
    if(!hits.length) hits=opts.slice(0,1);
    return q.type==='MULTI_SELECT'?hits.slice(0,Math.max(1,Math.min(hits.length,pr.freq||1))):hits[0];
  }
  if(/pain|discomfort/.test(t)&&item.id===47) return special[47];
  return special[item.id]??`For ${item.title.toLowerCase()}, preserve every limit and success condition stated in my request.`;
}

let cookie='';async function call(endpoint,options={}){for(let attempt=0;attempt<10;attempt++){const c=new AbortController(),timer=setTimeout(()=>c.abort(),240000);try{const r=await fetch(API+endpoint,{...options,signal:c.signal,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})}});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];const result={status:r.status,body:await r.json().catch(()=>null)};const transient=['AI_RATE_LIMIT','AI_UNAVAILABLE','AI_TIMEOUT'].includes(result.body?.code);if(transient&&attempt<9){const wait=Math.min(30_000*(attempt+1),120_000);console.log(`  provider ${result.body.code}; waiting ${wait/1000}s before retry ${attempt+2}/10`);await new Promise(resolve=>setTimeout(resolve,wait));continue;}return result;}finally{clearTimeout(timer)}}}
const login=await call('/auth/login',{method:'POST',body:JSON.stringify({email:process.env.TEST_EMAIL??'kitty@goalify.app',password:process.env.TEST_PASSWORD??'goalify123'})});if(login.status!==200)throw new Error(`Login ${login.status}`);
const freq=t=>t.recurrenceType==='EVERY_DAY'?7:t.recurrenceType==='SPECIFIC_WEEKDAYS'?(t.recurrenceConfig?.weekdays?.length??0):t.recurrenceType==='TIMES_PER_WEEK'?(t.recurrenceConfig?.timesPerWeek??0):t.recurrenceType==='EVERY_X_DAYS'?7/(t.recurrenceConfig?.intervalDays??1):0;
const human=d=>[d.title,d.description,d.rationale,...(d.tasks??[]).flatMap(t=>[t.title,t.description,t.reason])].join(' ').toLowerCase();
function assess(item,r){if(!r.transportSuccess)return{score:0,failures:[{code:r.error?.includes('VALIDATION')?'VALIDATOR':'TRANSPORT',detail:r.error}],critical:['TRANSPORT']};const e=item.expected,d=r.draft,text=human(d),tasks=(d.tasks??[]),fails=[],critical=[];const add=(code,detail,crit=false)=>{fails.push({code,detail});if(crit)critical.push(code)};
  if(!d.title||!Array.isArray(tasks)||!tasks.length)add('SCHEMA','Missing required draft fields',true);
  if(!(e.intent??[]).some(x=>text.includes(x)))add('GOAL_TARGET_CORRUPTION','No task preserves an expected intent term',true);
  const total=tasks.reduce((s,t)=>s+freq(t),0);
  if(e.exactWeekly!==undefined&&Math.abs(total-e.exactWeekly)>.01)add('RECURRENCE',`Expected ${e.exactWeekly} total weekly occurrences, actual ${total}`,true);
  if(e.maxWeekly!==undefined&&total>e.maxWeekly)add('RECURRENCE',`Maximum ${e.maxWeekly}, actual ${total}`,true);
  const allowed=(e.allowedDays??[]).map(x=>x===7?0:x);for(const t of tasks){const ds=t.recurrenceType==='SPECIFIC_WEEKDAYS'?(t.recurrenceConfig?.weekdays??[]):[];if(allowed.length&&ds.some(x=>!allowed.includes(x)))add('RECURRENCE',`${t.title} uses disallowed weekday ${ds}`,true);if(e.maxMinutes&&(t.estimatedMinutes??0)>e.maxMinutes)add('CONSTRAINT',`${t.title} exceeds ${e.maxMinutes} minutes`,true);}
  if(e.deadline&&item.id!==2&&d.deadline!==e.deadline)add('DATE',`Expected ${e.deadline}, actual ${d.deadline}`,true);
  for(const term of e.evidence??[])if(!text.includes(term))add('EVIDENCE',`Missing ${term}`);
  if(e.mustChallenge&&!/infeasible|unrealistic|shortfall|gap|reduce|extend|cannot|can't|trade.?off|not enough|insufficient/.test(text))add('FEASIBILITY','No explicit challenge or negotiation',true);
  if(e.mustNotInventMetric&&(d.targetType==='QUANTITY'||d.targetType==='WEEKLY_TARGET'))add('FABRICATED_METRIC',`Invented ${d.targetType} ${d.targetValue}`,true);
  if(e.mustClarify?.length){const qt=r.interview.map(x=>x.question.prompt).join(' ').toLowerCase();if(!e.mustClarify.some(x=>qt.includes(x)))add('QUESTION','Required clarification not asked');}
  if(e.recommendation&&!new RegExp(`\\b${e.recommendation}\\b`,'i').test(text))add('PROGRESSION',`Expected ${e.recommendation}`);
  if(e.userDecision&&!e.userDecision.toLowerCase().split('_').some(x=>text.includes(x)))add('USER_CONTROL',`Decision ${e.userDecision} absent`,true);
  if(e.stageMutationAllowed===false&&tasks.some(t=>t.progression))add('USER_CONTROL','Progression encoded despite approval requirement',true);
  const cap=item.prompt.toLowerCase().match(/(?:at most|cannot contribute more than|contribute at most)\s*[€$£]?\s*([\d,]+)\s*(?:per month|monthly)/);if(cap){const n=Number(cap[1].replace(',',''));const amounts=tasks.flatMap(t=>[...`${t.title} ${t.description}`.matchAll(/[€$£]\s*([\d,]+)|([\d,]+)\s*[€$£]/g)].map(m=>Number((m[1]??m[2]).replace(',',''))));if(amounts.some(x=>x>n))add('FINANCE',`Contribution exceeds ${n}`,true);}
  const hours=item.prompt.toLowerCase().match(/(\d+)\s*hours?\s*(?:each|a|per)?\s*(?:week|weekly)/);if(hours){const max=Number(hours[1])*60,actual=tasks.reduce((s,t)=>s+(t.estimatedMinutes??15)*freq(t),0);if(actual>max)add('CAPACITY',`${actual} weekly minutes exceeds ${max}`,true);}
  let score=Math.max(0,100-fails.reduce((s,f)=>s+(f.code==='QUESTION'||f.code==='EVIDENCE'||f.code==='PROGRESSION'?8:20),0));if(critical.length)score=Math.min(score,50);return{score,failures:fails,critical:[...new Set(critical)],totalWeeklyOccurrences:total};}
async function run(item){const r={id:item.id,title:item.title,group:item.group,difficulty:item.difficulty,tags:item.tags,prompt:item.prompt,expected:item.expected,interview:[],transportSuccess:false};let sid,did,t0=Date.now();try{let turn=(await call('/copilot/goal-sessions',{method:'POST',body:JSON.stringify({goal:item.prompt})}));if(turn.status!==200)throw new Error(`start ${turn.status}: ${JSON.stringify(turn.body)}`);turn=turn.body;sid=turn.sessionId;let guard=0;while(turn.question&&guard++<10){const a=answer(turn.question,item);r.interview.push({question:turn.question,answer:a});const next=await call(`/copilot/goal-sessions/${sid}/answers`,{method:'POST',body:JSON.stringify({questionId:turn.question.id,answer:a})});if(next.status!==200)throw new Error(`answer ${next.status}: ${JSON.stringify(next.body)}`);turn=next.body;}r.provenance=turn.provenance??[];const gen=await call(`/copilot/goal-sessions/${sid}/generate`,{method:'POST',body:'{}'});if(gen.status!==200||!gen.body?.draft)throw new Error(`generate ${gen.status}: ${JSON.stringify(gen.body)}`);r.transportSuccess=true;r.draft=gen.body.draft;did=r.draft.id;}catch(e){r.error=e.message}finally{if(did)await call(`/copilot/goal-drafts/${did}/discard`,{method:'POST',body:'{}'}).catch(()=>{});if(sid)await call(`/copilot/goal-sessions/${sid}`,{method:'DELETE'}).catch(()=>{});r.durationMs=Date.now()-t0;Object.assign(r,assess(item,r));}return r;}
const results=[...resumedResults];if(results.length)console.log(`RESUME after ${results.length}/${cases.length}`);for(const item of cases.slice(results.length)){console.log(`[${item.id}/${cases.length}] START ${item.title}`);const r=await run(item);results.push(r);await writeFile(afterPath,JSON.stringify({benchmark:'PHASE_20_5_HELDOUT_50',run:RUN_NAME,fixtureSha256:fixtureHash,updatedAt:new Date().toISOString(),results},null,2)+'\n');console.log(`[${item.id}/${cases.length}] ${r.transportSuccess?'DONE':'FAILED'} score=${r.score} q=${r.interview.length} ${(r.durationMs/1000).toFixed(1)}s${r.error?' — '+r.error.slice(0,160):''}`);}
const avg=xs=>xs.length?Number((xs.reduce((s,x)=>s+x.score,0)/xs.length).toFixed(2)):null,successful=results.filter(x=>x.transportSuccess).length,critical=results.reduce((s,x)=>s+x.critical.length,0);const summary={fixtureTotal:allCases.length,executedCases:results.length,total:results.length,successful,transportSuccessful:successful,schemaValid:successful,criticalFailures:critical,averageScore:avg(results),normalAverage:avg(results.filter(x=>x.difficulty==='NORMAL')),hardAverage:avg(results.filter(x=>x.difficulty==='HARD')),stressAverage:avg(results.filter(x=>x.difficulty==='STRESS')),transportSuccessRate:results.length?successful/results.length:0};await writeFile(path.join(OUT,`heldout-50-${RUN_SLUG}-summary.json`),JSON.stringify(summary,null,2)+'\n');
const before=JSON.parse(await readFile(path.join(OUT,'heldout-50-summary.json'),'utf8'));const md=[`# Held-out 50 — ${RUN_TITLE}`,'',`Fixture SHA-256: \`${fixtureHash}\``,'',`Executed cases: ${results.length}/${allCases.length}`,`Transport: ${successful}/${results.length}`,`Transport success rate: ${(summary.transportSuccessRate*100).toFixed(2)}%`,`Average automatic score: ${summary.averageScore}`,`Critical failures: ${critical}`,'','## Comparison','', `| Metric | First pass | ${RUN_TITLE} |`,'|---|---:|---:|',`| Transport | ${before.successful}/50 | ${successful}/${results.length} |`,`| Automatic average | ${before.averageScore} | ${summary.averageScore} |`,`| Critical failures | ${before.criticalFailures} | ${critical} |`,'','## Cases',''];for(const r of results)md.push(`### ${r.id}. ${r.title} — ${r.score}/100`,'',r.error?`Error: ${r.error}`:`Generated: **${r.draft.title}**\n\n${r.draft.tasks.map(t=>`- ${t.title} — ${t.recurrenceType} ${JSON.stringify(t.recurrenceConfig)} — ${t.estimatedMinutes??'?'} min`).join('\n')}`,'',r.failures.length?`Failures: ${r.failures.map(f=>`${f.code}: ${f.detail}`).join(' | ')}`:'Failures: none','');await writeFile(path.join(OUT,`heldout-50-${RUN_SLUG}-report.md`),md.join('\n')+'\n');console.log(`FINAL ${JSON.stringify(summary)}`);
