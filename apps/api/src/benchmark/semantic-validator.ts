import type { RecurrenceType } from '../domain/enums.js';
import { computeFinancialFeasibility, monthlyCapPeriods, parseFinancialPlan } from '../ai/financial-plan.js';
import { evaluateUsefulness, passesQualityGates, scoreStructuralQuality } from './quality-evaluator.js';

export type BenchmarkRole = 'STRENGTH' | 'TRAIL' | 'LONG_RUN' | 'FINANCE_TRANSFER' | 'PROJECT_EVIDENCE' | 'INTERVIEW_PREP';
export interface BenchmarkTask {
  title: string;
  description?: string;
  reason?: string;
  recurrenceType: RecurrenceType;
  recurrenceConfig: {
    weekdays?: number[]; timesPerWeek?: number; intervalDays?: number;
    dayOfMonth?: number|'LAST'; intervalMonths?: number;
    allowedWeekdays?: number[]; excludedWeekdays?: number[];
    activeFrom?:string;activeUntil?:string;excludedMonths?:string[];
  };
  estimatedMinutes?: number|null;
  progression?: unknown;
}
export interface BenchmarkDraft {
  title:string; description?:string; rationale?:string; tasks:BenchmarkTask[];
}
export interface SemanticExpectations {
  exactWeekly?:number;
  maxWeekly?:number;
  allowedDays?:number[];
  forbiddenDays?:number[];
  maxMinutesPerSession?:number;
  recurrenceRequirements?:Array<{role:BenchmarkRole;frequency:'WEEKLY'|'MONTHLY';minOccurrences?:number;exactOccurrences?:number}>;
  requiredRoleDays?:Array<{role:BenchmarkRole;days:number[]}>;
  clarificationPolicy?:{anyOf:Array<{askedTopic?:string;explicitAssumptionTopic?:string}>};
  capacity?:{maxMinutesPerWeek?:number;preferredBlocksPerWeek?:number;prohibitConsecutiveEvenings?:boolean;rotatingFlexibility?:boolean};
  progressionPolicy?:{painFreeWeeks?:number;reduceOnRepeatedPain?:boolean;pauseOnSharpPain?:boolean;approvalRequired?:boolean};
  stageMutationAllowed?:boolean;
  userDecision?:'ACCEPT'|'REJECT'|'OVERRIDE';
  requiredEvidence?:string[];
  forbiddenClaims?:string[];
  financial?:{requireUnitAwareFeasibility:boolean};
}
export interface SemanticFailure { code:string; detail:string; critical:boolean }

export function weeklyOccurrences(task:BenchmarkTask):number {
  if(task.recurrenceType==='EVERY_DAY') return 7;
  if(task.recurrenceType==='SPECIFIC_WEEKDAYS') return task.recurrenceConfig.weekdays?.length??0;
  if(task.recurrenceType==='TIMES_PER_WEEK') return task.recurrenceConfig.timesPerWeek??0;
  if(task.recurrenceType==='EVERY_X_DAYS') return 7/(task.recurrenceConfig.intervalDays??1);
  return 0;
}

export function monthlyOccurrences(task:BenchmarkTask):number {
  if(task.recurrenceType==='MONTHLY') return 1;
  if(task.recurrenceType==='EVERY_X_MONTHS') return 1/(task.recurrenceConfig.intervalMonths??1);
  return 0;
}

function normalizedTokens(text:string):Set<string>{
  const stem=(word:string)=>word.endsWith('ies')?`${word.slice(0,-3)}y`:word.endsWith('es')?word.slice(0,-2):word.endsWith('s')&&word.length>4?word.slice(0,-1):word;
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g)?.map(stem)??[]);
}

export function benchmarkTaskRoles(task:BenchmarkTask):Set<BenchmarkRole>{
  const text=`${task.title} ${task.description??''} ${task.reason??''}`.toLowerCase();
  const roles=new Set<BenchmarkRole>();
  if(/\b(strength|resistance|weights?|lower-body|ankle strengthening)\b/.test(text))roles.add('STRENGTH');
  if(/\b(trail|technical terrain)\b/.test(text))roles.add('TRAIL');
  if(/\blong\s+run\b/.test(text))roles.add('LONG_RUN');
  if(/\b(save|saving|contribut|deposit|transfer|payment|budget)\b|[€$£]\s*[\d,]+|\b(?:USD|EUR|GBP|GEL)\b/i.test(text))roles.add('FINANCE_TRANSFER');
  if(/\b(interview prep|mock interview|interview practice)\b/.test(text))roles.add('INTERVIEW_PREP');
  if(/\b(pipeline|prototype|transformation|deployment|architecture|portfolio|deliverable|project)\b/.test(text))roles.add('PROJECT_EVIDENCE');
  return roles;
}

function allText(draft:BenchmarkDraft):string{
  return `${draft.title} ${draft.description??''} ${draft.rationale??''} ${draft.tasks.map((task)=>`${task.title} ${task.description??''} ${task.reason??''}`).join(' ')}`;
}

function assertsForbiddenClaim(text:string,claim:string):boolean{
  const escaped=claim.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const occurrences=[...text.matchAll(new RegExp(escaped,'gi'))];
  return occurrences.some((match)=>{
    const before=text.slice(Math.max(0,(match.index??0)-80),match.index).toLowerCase();
    return !/(?:do not|don't|never|without|not|no|cannot|can't|avoid|instead of)\s+(?:\w+\s+){0,8}$/.test(before);
  });
}

function topicPresent(topic:string,text:string):boolean{
  const tokens=normalizedTokens(text);
  if(topic==='exchange_rate') return /\b(?:exchange|planning)\s+rate\b|\b(?:USD|EUR|GBP|GEL)\b[^.]{0,30}\bper\b[^.]{0,20}\b(?:USD|EUR|GBP|GEL)\b/i.test(text);
  return [...normalizedTokens(topic.replace(/_/g,' '))].every((token)=>tokens.has(token));
}

export function evaluateSemanticCase(
  expected:SemanticExpectations,
  result:{draft?:BenchmarkDraft;interview?:Array<{question:{prompt:string}}>;prompt?:string;today?:string},
):{
  score:number;
  structuralScore:number;
  usefulnessScore:number;
  usefulness:ReturnType<typeof evaluateUsefulness>|null;
  failures:SemanticFailure[];
  critical:string[];
  constraintPass:boolean;
  finalPass:boolean;
}{
  const failures:SemanticFailure[]=[];
  const add=(code:string,detail:string,critical=false)=>failures.push({code,detail,critical});
  const draft=result.draft;
  if(!draft)return{score:0,structuralScore:0,usefulnessScore:0,usefulness:null,failures:[{code:'TRANSPORT',detail:'No generated draft',critical:true}],critical:['TRANSPORT'],constraintPass:false,finalPass:false};
  const tasks=draft.tasks;
  const totalWeekly=tasks.reduce((sum,task)=>sum+weeklyOccurrences(task),0);
  if(expected.exactWeekly!==undefined&&Math.abs(totalWeekly-expected.exactWeekly)>.01)add('RECURRENCE',`Expected exactly ${expected.exactWeekly} weekly occurrences; found ${totalWeekly}`,true);
  if(expected.maxWeekly!==undefined&&totalWeekly>expected.maxWeekly)add('RECURRENCE',`Maximum ${expected.maxWeekly}; found ${totalWeekly}`,true);
  for(const task of tasks){
    const days=task.recurrenceType==='SPECIFIC_WEEKDAYS'?task.recurrenceConfig.weekdays??[]:[];
    if(expected.allowedDays&&days.some((day)=>!expected.allowedDays!.includes(day)))add('SCHEDULE',`${task.title} uses a day outside the allowed set`,true);
    if(expected.forbiddenDays&&days.some((day)=>expected.forbiddenDays!.includes(day)))add('SCHEDULE',`${task.title} uses a forbidden day`,true);
    if(task.recurrenceType==='TIMES_PER_WEEK'){
      const allowed=task.recurrenceConfig.allowedWeekdays;
      const excluded=task.recurrenceConfig.excludedWeekdays??[];
      if(expected.allowedDays&&(!allowed||allowed.some((day)=>!expected.allowedDays!.includes(day))))add('SCHEDULE',`${task.title} lacks the flexible allowed-day boundary`,true);
      if(expected.forbiddenDays?.some((day)=>!excluded.includes(day)&&(!allowed||allowed.includes(day))))add('SCHEDULE',`${task.title} may occur on a forbidden day`,true);
    }
    if(expected.maxMinutesPerSession!==undefined&&(task.estimatedMinutes??0)>expected.maxMinutesPerSession)add('CAPACITY',`${task.title} exceeds ${expected.maxMinutesPerSession} minutes`,true);
  }
  for(const requirement of expected.recurrenceRequirements??[]){
    const matches=tasks.filter((task)=>benchmarkTaskRoles(task).has(requirement.role));
    const actual=matches.reduce((sum,task)=>sum+(requirement.frequency==='WEEKLY'?weeklyOccurrences(task):monthlyOccurrences(task)),0);
    if(requirement.minOccurrences!==undefined&&actual<requirement.minOccurrences)add('ROLE_RECURRENCE',`${requirement.role} requires at least ${requirement.minOccurrences} ${requirement.frequency.toLowerCase()} occurrence`,true);
    if(requirement.exactOccurrences!==undefined&&Math.abs(actual-requirement.exactOccurrences)>.01)add('ROLE_RECURRENCE',`${requirement.role} requires exactly ${requirement.exactOccurrences} ${requirement.frequency.toLowerCase()} occurrence`,true);
  }
  for(const requirement of expected.requiredRoleDays??[]){
    const days=new Set(tasks.filter((task)=>benchmarkTaskRoles(task).has(requirement.role)&&task.recurrenceType==='SPECIFIC_WEEKDAYS').flatMap((task)=>task.recurrenceConfig.weekdays??[]));
    if(requirement.days.some((day)=>!days.has(day)))add('ROLE_DAY',`${requirement.role} is absent from required day(s) ${requirement.days.join(',')}`,true);
  }
  const text=allText(draft);
  if(expected.clarificationPolicy){
    const questions=(result.interview??[]).map((item)=>item.question.prompt).join(' ');
    const valid=expected.clarificationPolicy.anyOf.some((alternative)=>
      (alternative.askedTopic&&topicPresent(alternative.askedTopic,questions))
      ||(alternative.explicitAssumptionTopic&&/\bassum(?:e|ed|ption)\b|\bplanning rate\b/i.test(text)&&topicPresent(alternative.explicitAssumptionTopic,text)));
    if(!valid)add('CLARIFICATION_POLICY','Neither an allowed clarification nor an explicit labeled assumption was present');
  }
  if((expected.recurrenceRequirements??[]).some((item)=>item.frequency==='MONTHLY')){
    const malformed=(result.interview??[]).some((item)=>/which days? of (?:the )?week|weekday/i.test(item.question.prompt));
    if(malformed)add('QUESTION_DOMAIN','A monthly plan asked for weekly scheduling');
  }
  if(expected.capacity?.maxMinutesPerWeek!==undefined){
    const actual=tasks.reduce((sum,task)=>sum+(task.estimatedMinutes??0)*weeklyOccurrences(task),0);
    if(actual>expected.capacity.maxMinutesPerWeek)add('CAPACITY',`Weekly work is ${actual} minutes, above ${expected.capacity.maxMinutesPerWeek}`,true);
  }
  if(expected.capacity?.preferredBlocksPerWeek!==undefined){
    const blocks=expected.capacity.preferredBlocksPerWeek;
    if(Math.abs(totalWeekly-blocks)>.01&&!new RegExp(`\\b${blocks}\\s+(?:flexible\\s+)?blocks?\\b|\\bthree\\s+(?:flexible\\s+)?blocks?\\b`,'i').test(text))add('CAPACITY',`The ${blocks}-block weekly structure is not represented`,true);
  }
  if(expected.capacity?.prohibitConsecutiveEvenings&&!/non-consecutive evenings|never on consecutive evenings|no consecutive evenings/i.test(text))add('SCHEDULE_POLICY','Non-consecutive-evening constraint is missing',true);
  if(expected.capacity?.rotatingFlexibility&&!/rotating|flexible/i.test(text))add('SCHEDULE_POLICY','Rotating-shift flexibility is missing');
  const policy=expected.progressionPolicy;
  if(policy?.painFreeWeeks&&!new RegExp(`${policy.painFreeWeeks}|two`,'i').test(text)||policy?.painFreeWeeks&&!/pain-free weeks?/i.test(text))add('PROGRESSION_POLICY','Pain-free progression condition is missing',true);
  if(policy?.reduceOnRepeatedPain&&!/REDUCE after repeated pain/i.test(text))add('PROGRESSION_POLICY','Repeated-pain reduction condition is missing',true);
  if(policy?.pauseOnSharpPain&&!/PAUSE for sharp pain/i.test(text))add('PROGRESSION_POLICY','Sharp-pain pause condition is missing',true);
  if(policy?.approvalRequired&&!/approv/i.test(text))add('USER_CONTROL','Approval requirement is missing',true);
  if(expected.stageMutationAllowed===false&&tasks.some((task)=>task.progression))add('USER_CONTROL','Progression was encoded despite reserved approval',true);
  if(expected.userDecision){
    const decisionText=draft.rationale??'';
    const represented=expected.userDecision==='ACCEPT'
      ? /\baccept(?:ed|ance)?\b/i.test(decisionText)
      : expected.userDecision==='REJECT'
        ? /\breject(?:ed|ion)?\b/i.test(decisionText)
        : /\boverride\b/i.test(decisionText);
    if(!represented)add('USER_DECISION',`${expected.userDecision} decision is not represented distinctly in the plan rationale`,true);
  }
  for(const evidence of expected.requiredEvidence??[]){
    const taskTokens=normalizedTokens(tasks.map((task)=>`${task.title} ${task.description??''} ${task.reason??''}`).join(' '));
    if(![...normalizedTokens(evidence)].every((expectedToken)=>[...taskTokens].some((actualToken)=>actualToken===expectedToken||actualToken.startsWith(expectedToken)||expectedToken.startsWith(actualToken))))add('EVIDENCE',`Missing executable evidence: ${evidence}`,true);
  }
  for(const claim of expected.forbiddenClaims??[]){if(assertsForbiddenClaim(text,claim))add('FORBIDDEN_CLAIM',`Asserts forbidden claim: ${claim}`,true);}
  if(expected.financial?.requireUnitAwareFeasibility){
    const plan=parseFinancialPlan(result.prompt??'',text);
    if(!plan)add('FINANCE','Could not normalize the target and periodic contribution',true);
    else{
      const feasibility=computeFinancialFeasibility(plan,(result.today??'2026-08-25') as `${number}-${number}-${number}`);
      if(feasibility.missing.includes('EXCHANGE_RATE'))add('FINANCE','Cross-currency amounts lack an exchange rate',true);
      if(plan.monthlyCaps?.length){
        if(feasibility.maximumContributable!==null&&!text.includes(String(feasibility.maximumContributable)))add('FINANCE',`Maximum capped contributions ${feasibility.maximumContributable} are not shown`,true);
        if((feasibility.shortfall??0)>0&&!text.includes(String(feasibility.shortfall)))add('FINANCE',`Financial shortfall ${feasibility.shortfall} is not shown`,true);
        const periods=monthlyCapPeriods(plan,(result.today??'2026-08-25') as `${number}-${number}-${number}`);
        for(const period of periods){
          const amountPattern=new RegExp(`(?:[€$£]\\s*${period.amount}\\b|\\b${period.amount}\\s*${period.currency}\\b)`,'i');
          const represented=tasks.some((task)=>benchmarkTaskRoles(task).has('FINANCE_TRANSFER')
            &&task.recurrenceType==='MONTHLY'
            &&task.recurrenceConfig.activeFrom===period.activeFrom
            &&task.recurrenceConfig.activeUntil===period.activeUntil
            &&amountPattern.test(`${task.title} ${task.description??''} ${task.reason??''}`));
          if(!represented)add('FINANCE_SCHEDULE',`Missing bounded ${period.amount} ${period.currency} monthly phase ${period.activeFrom} through ${period.activeUntil}`,true);
        }
      }else if(feasibility.requiredContributions!==null&&!text.includes(String(feasibility.requiredContributions)))add('FINANCE',`Required contribution count ${feasibility.requiredContributions} is not shown`,true);
      if(plan.skippedMonths?.length){
        const monthlyTasks=tasks.filter((task)=>benchmarkTaskRoles(task).has('FINANCE_TRANSFER')&&(task.recurrenceType==='MONTHLY'||task.recurrenceType==='EVERY_X_MONTHS'));
        if(monthlyTasks.some((task)=>plan.skippedMonths!.some((month)=>!task.recurrenceConfig.excludedMonths?.includes(month))))add('FINANCE_SCHEDULE','Explicitly skipped months are absent from the executable recurrence',true);
      }
      if(feasibility.feasible===false&&!/shortfall|not feasible|insufficient|not enough|later deadline/i.test(text))add('FINANCE','The converted timeline is infeasible but no shortfall is disclosed',true);
    }
  }
  const score=Math.max(0,100-failures.reduce((sum,failure)=>sum+(failure.critical?20:8),0));
  const semanticStructural=failures.some((failure)=>failure.critical)?Math.min(score,50):score;
  const generalStructural=scoreStructuralQuality(draft,result.today);
  for(const issue of generalStructural.issues)add('STRUCTURE',issue,true);
  const structuralScore=Math.min(semanticStructural,generalStructural.score);
  const critical=[...new Set(failures.filter((failure)=>failure.critical).map((failure)=>failure.code))];
  const usefulness=evaluateUsefulness(result.prompt??draft.title,draft,result.interview??[]);
  return{
    score:structuralScore,
    structuralScore,
    usefulnessScore:usefulness.usefulnessScore,
    usefulness,
    failures,
    critical,
    constraintPass:critical.length===0,
    finalPass:passesQualityGates({criticalFailure:critical.length>0,structuralScore,usefulnessScore:usefulness.usefulnessScore}),
  };
}

export function buildRunSummary(fixtureTotal:number,results:Array<{transportSuccess:boolean;schemaValid?:boolean;semanticScore:number;structuralScore?:number;usefulnessScore?:number;constraintPass:boolean;finalPass?:boolean}>){
  const executed=results.length;
  const transport=results.filter((result)=>result.transportSuccess).length;
  const schema=results.filter((result)=>result.schemaValid??result.transportSuccess).length;
  return{
    fixtureTotal,executedCases:executed,transportSuccessful:transport,schemaValid:schema,
    transportSuccessRate:executed?transport/executed:0,
    averageSemanticScore:executed?Number((results.reduce((sum,result)=>sum+result.semanticScore,0)/executed).toFixed(2)):null,
    averageStructuralScore:executed?Number((results.reduce((sum,result)=>sum+(result.structuralScore??result.semanticScore),0)/executed).toFixed(2)):null,
    averageUsefulnessScore:executed?Number((results.reduce((sum,result)=>sum+(result.usefulnessScore??0),0)/executed).toFixed(2)):null,
    constraintPass:results.filter((result)=>result.constraintPass).length,
    finalPass:results.filter((result)=>result.finalPass??result.constraintPass).length,
  };
}
