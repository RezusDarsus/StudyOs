import { describe, expect, it } from 'vitest';
import { explicitActivityCoverageGaps, explicitConstraintErrors, extractEvidenceRequirements, goalCoverageGaps, statedDayOfMonth } from './goal-constraints.js';
import type { NormalizedTask } from './draft-validator.js';
import { installRuntimeContent } from '../runtime-content.js';

// The role and activity vocabularies are runtime data; the port must exist
// before the lexicons are read (the same bootstrap the server runs).
installRuntimeContent();

const task = (title:string, weekdays:number[], minutes=45):NormalizedTask => ({
  title, description:'', recurrenceType:'SPECIFIC_WEEKDAYS', recurrenceConfig:{weekdays},
  estimatedMinutes:minutes, preferredTime:null, reason:'', reward:20, progression:null,
});
const draft = (tasks:NormalizedTask[], deadline:string|null=null) => ({ targetType:'HABIT',targetValue:null,deadline,tasks });
const textTask = (title:string, description='', reason=''):Array<Pick<NormalizedTask,'title'|'description'|'reason'>> => [{ title, description, reason }];

describe('goal coverage gaps',()=>{
  it('requires every explicitly joined activity, not merely one of them', () => {
    expect(
      explicitActivityCoverageGaps(
        'I want lose weight; I will start boxing and gym',
        textTask('Boxing session'),
      ),
    ).toEqual(['gym']);
    expect(
      explicitActivityCoverageGaps(
        'I want lose weight; I will start boxing and gym',
        [...textTask('Boxing session'), ...textTask('Gym strength session')],
      ),
    ).toEqual([]);
  });

  it('does not require both activities when the user offered alternatives', () => {
    expect(
      explicitActivityCoverageGaps('I could do boxing or gym', textTask('Boxing session')),
    ).toEqual([]);
  });

  it('reports nothing when every first-sentence stem is covered',()=>{
    expect(goalCoverageGaps('Prepare for backend interviews',textTask('Backend interview drill'))).toEqual([]);
    expect(goalCoverageGaps('Prepare for backend interviews',textTask('Mock interview practice for backend roles'))).toEqual([]);
  });

  it('reports the goal stems no task pursues, in order of appearance',()=>{
    // The baseline miss: a plan whose only task shares nothing with the request.
    expect(goalCoverageGaps('Prepare for backend interviews',textTask('Review core Java concepts'))).toEqual(['backend','interview']);
    expect(goalCoverageGaps('Prepare for backend interviews',textTask('Review core Java concepts','Read one chapter.','You want steady review.'))).toEqual(['backend','interview']);
  });

  it('keeps a saving goal honest against an unrelated budget task',()=>{
    const gaps=goalCoverageGaps('save money for a house',textTask('Grocery budget review'));
    expect(gaps).toContain('save');
    expect(gaps).toContain('house');
  });

  it('never reports incidental scheduling or framing words as gaps',()=>{
    expect(goalCoverageGaps('Prepare for backend interviews, three sessions per week',textTask('Review core Java concepts'))).toEqual(['backend','interview']);
    expect(goalCoverageGaps('Improve my Spanish by studying every day',textTask('Spanish vocabulary drill'))).toEqual([]);
  });

  it('counts only the first sentence as the goal',()=>{
    // Later sentences carry context and constraints, not the request.
    expect(goalCoverageGaps('Save money for a house. My partner says I waste money.',textTask('Save money for the house fund'))).toEqual([]);
    expect(goalCoverageGaps('Prepare for backend interviews. I own two laptops.',textTask('Backend interview drill'))).toEqual([]);
  });

  it('matches inflections with the benchmark tolerance',()=>{
    // "savings" covers "save", so the plan pursues the goal: the stems are
    // chances to match under ANY-match, not a checklist — demanding "money"
    // here rejected honest transfer plans ("save money" -> gap "money").
    expect(goalCoverageGaps('save money for a house',textTask('Weekly savings transfer'))).toEqual([]);
  });

  it('accepts natural near-synonym drafts that pursue any central stem',()=>{
    // Each pair was a live false-reject: the draft shares an inflection, the
    // goal's own verb, or — for a one-stem request — a goal-family sibling.
    expect(goalCoverageGaps('save money',textTask('Weekly savings transfer'))).toEqual([]);
    expect(goalCoverageGaps('read more books',textTask('Read 20 pages daily'))).toEqual([]);
    expect(goalCoverageGaps('sleep better',textTask('Wind-down routine'))).toEqual([]);
    expect(goalCoverageGaps('I want to get fitter',textTask('5k interval runs'))).toEqual([]);
    expect(goalCoverageGaps('prepare for an exam',textTask('Do 20 practice questions'))).toEqual([]);
    expect(goalCoverageGaps('get stronger',textTask('Push-ups and squats at home'))).toEqual([]);
    expect(goalCoverageGaps('study more consistently',textTask('Pomodoro sessions at a fixed desk time'))).toEqual([]);
    expect(goalCoverageGaps('improve my public speaking',textTask('Speaking drills: introduce myself aloud'))).toEqual([]);
  });

  it('still rejects a draft that shares nothing with the request',()=>{
    // The true corruption shape: a "backend interview preparation" request
    // answered only by unrelated subject matter.
    expect(goalCoverageGaps('backend interview preparation',textTask('Review core Java concepts'))).toEqual(['backend','interview']);
    // Family tolerance is scoped to one-stem requests: with several stems the
    // domain overlap of an unrelated task is not pursuit.
    expect(goalCoverageGaps('sleep better',textTask('Grocery budget review'))).toEqual(['sleep']);
    expect(goalCoverageGaps('save money for a house',textTask('Grocery budget review'))).toEqual(['save','money','house']);
  });

  it('returns no gaps when the request has no usable central tokens',()=>{
    expect(goalCoverageGaps('Three sessions per week',textTask('Anything at all'))).toEqual([]);
    expect(goalCoverageGaps('',textTask('Anything at all'))).toEqual([]);
  });
});
