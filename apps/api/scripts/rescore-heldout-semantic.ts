import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildRunSummary, evaluateSemanticCase, type SemanticExpectations } from '../src/benchmark/semantic-validator.js';

const inputPath=path.resolve(process.argv[2]??'benchmark-results/heldout-50-corrected-final.json');
const outputSlug=process.argv[3]??`${path.basename(inputPath,'.json')}-semantic`;
const outDir=path.dirname(inputPath);
const fixturePath=path.join(outDir,'heldout-50-prompts.json');
const semanticPath=path.join(outDir,'heldout-50-v2-semantic.json');
const fixtureText=await readFile(fixturePath,'utf8');
const fixture=JSON.parse(fixtureText) as {cases:Array<{id:number;difficulty:string;expected:Record<string,unknown>}>};
const semanticFixture=JSON.parse(await readFile(semanticPath,'utf8')) as {baseFixtureSha256:string;overrides:Record<string,SemanticExpectations>};
const hash=createHash('sha256').update(fixtureText).digest('hex');
if(hash!==semanticFixture.baseFixtureSha256)throw new Error(`Frozen fixture hash mismatch: ${hash}`);
const source=JSON.parse(await readFile(inputPath,'utf8')) as {results:Array<Record<string,any>>};
const dayNames:Record<string,number>={sunday:0,monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6};

function legacyExpectations(expected:Record<string,any>):SemanticExpectations{
  const allowed=(expected.allowedDays as number[]|undefined)?.map((day)=>day===7?0:day);
  const forbidden=(expected.forbidden as string[]|undefined)?.map((word)=>dayNames[word.toLowerCase()]).filter((day)=>day!==undefined);
  return{
    exactWeekly:expected.exactWeekly,
    maxWeekly:expected.maxWeekly,
    allowedDays:allowed,
    forbiddenDays:forbidden?.length?forbidden:undefined,
    maxMinutesPerSession:expected.maxMinutes,
    stageMutationAllowed:expected.stageMutationAllowed,
    requiredEvidence:expected.evidence,
    forbiddenClaims:(expected.forbidden as string[]|undefined)?.filter((word)=>dayNames[word.toLowerCase()]===undefined),
  };
}

const rescored=source.results.map((result)=>{
  const fixtureCase=fixture.cases.find((item)=>item.id===result.id);
  if(!fixtureCase)throw new Error(`Unknown case ${result.id}`);
  const expected={...legacyExpectations(fixtureCase.expected),...(semanticFixture.overrides[String(result.id)]??{})};
  const semantic=evaluateSemanticCase(expected,{
    draft:result.draft,
    interview:result.interview,
    prompt:result.prompt,
    today:'2026-08-25',
  });
  return{...result,legacyScore:result.score,semanticScore:semantic.score,semanticFailures:semantic.failures,semanticCritical:semantic.critical,constraintPass:semantic.constraintPass};
});
const base=buildRunSummary(fixture.cases.length,rescored.map((result)=>({transportSuccess:result.transportSuccess,schemaValid:result.transportSuccess,semanticScore:result.semanticScore,constraintPass:result.constraintPass})));
const average=(items:any[],field:string)=>items.length?Number((items.reduce((sum,item)=>sum+item[field],0)/items.length).toFixed(2)):null;
const summary={
  ...base,
  legacyAverage:average(rescored,'legacyScore'),
  semanticAverage:average(rescored,'semanticScore'),
  criticalFailures:rescored.reduce((sum,result)=>sum+result.semanticCritical.length,0),
  normalAverage:average(rescored.filter((result)=>result.difficulty==='NORMAL'),'semanticScore'),
  hardAverage:average(rescored.filter((result)=>result.difficulty==='HARD'),'semanticScore'),
  stressAverage:average(rescored.filter((result)=>result.difficulty==='STRESS'),'semanticScore'),
};
await writeFile(path.join(outDir,`${outputSlug}.json`),JSON.stringify({benchmark:'PHASE_20_5_HELDOUT_50_SEMANTIC_V2',fixtureSha256:hash,source:path.basename(inputPath),results:rescored},null,2)+'\n');
await writeFile(path.join(outDir,`${outputSlug}-summary.json`),JSON.stringify(summary,null,2)+'\n');
const report=[
  '# Goalify Copilot — Held-out 50 Semantic Verification','',
  `Source run: \`${path.basename(inputPath)}\``,
  `Fixture SHA-256: \`${hash}\``,'',
  `Executed cases: ${summary.executedCases}/${summary.fixtureTotal}`,
  `Transport: ${summary.transportSuccessful}/${summary.executedCases}`,
  `Transport success rate: ${(summary.transportSuccessRate*100).toFixed(2)}%`,
  `Legacy automatic average: ${summary.legacyAverage}`,
  `Semantic average: ${summary.semanticAverage}`,
  `Constraint pass: ${summary.constraintPass}/${summary.executedCases}`,
  `Semantic critical failures: ${summary.criticalFailures}`,'',
  '## Cases','',
];
for(const result of rescored){
  report.push(`### ${result.id}. ${result.title} — legacy ${result.legacyScore}, semantic ${result.semanticScore}`,'');
  report.push(result.semanticFailures.length
    ? result.semanticFailures.map((failure:any)=>`- ${failure.code}${failure.critical?' (critical)':''}: ${failure.detail}`).join('\n')
    : '- Semantic failures: none','');
}
await writeFile(path.join(outDir,`${outputSlug}-report.md`),report.join('\n')+'\n');
console.log(`SEMANTIC_FINAL ${JSON.stringify(summary)}`);
