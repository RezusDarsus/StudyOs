import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAll } from './setup.js';

loadAll('components/format.js', 'components/badges.js', 'components/states.js', 'chat/citations.js', 'research/research-panel.js', 'course/syllabus-view.js', 'prediction/exam-prediction.js', 'course/topic-view.js', 'tutor/tutor-session.js');
const Chat = globalThis.StudyOSChat;
const Panels = globalThis.StudyOSPanels;
const Tutor = globalThis.StudyOSTutor;
const Format = globalThis.StudyOSFormat;

test('quiz-failure outcomes map to learner language, never internal enums', () => {
  assert.match(Format.quizEmptyMessage('DIAGNOSTIC'), /before it can diagnose/);
  assert.match(Format.quizEmptyMessage('EXAM_STYLE'), /exam-style problem/);
  assert.match(Format.quizEmptyMessage('MISCONCEPTION_FOLLOW_UP'), /clearly different/);
  assert.match(Format.quizEmptyMessage('PRACTICE'), /sufficiently different, well-grounded/);
  assert.match(Format.quizEmptyMessage(''), /sufficiently different, well-grounded/);
});

test('tutor step kinds render as learner labels, never raw enums', () => {
  assert.equal(Tutor.tutorKindLabel({ kind: 'RECALL_CHECK' }), 'Recall check');
  assert.equal(Tutor.tutorKindLabel({ kind: 'SUMMARY' }), 'Summary');
  assert.equal(Tutor.tutorKindLabel({ kind: 'LEARN' }), 'Explanation');
  assert.equal(Tutor.tutorKindLabel({ kind: 'SOMETHING_NEW', kindLabel: 'Backend label' }), 'Backend label');
  assert.equal(Tutor.tutorKindLabel({}), 'Step');
});

test('citation provenance prefers backend source lists over title guessing', () => {
  // With backend provenance loaded, the lists decide — even when the title looks like a domain.
  Chat.setProvenanceSources({
    external: ['Spring Framework Documentation', 'postgresql.org'],
    material: ['Lecture 4', 'midterm-exam-1.pdf']
  });
  assert.equal(Chat.citationKind('Spring Framework Documentation'), 'external');
  assert.equal(Chat.citationKind('postgresql.org'), 'external');
  assert.equal(Chat.citationKind('Lecture 4'), 'material');
  assert.equal(Chat.citationKind('midterm-exam-1.pdf'), 'material');
  // Unknown names fall back to the conservative shape heuristic (legacy messages).
  assert.equal(Chat.citationKind('https://example.com/guide'), 'external');
  assert.equal(Chat.citationKind('CRC handout'), 'material');
  // File extension is stripped for matching, so "name.pdf" from the API matches "name" in a citation.
  assert.equal(Chat.citationKind('midterm-exam-1'), 'material');
});

test('citation kind uses shape, never title guessing games', () => {
  assert.equal(Chat.citationKind('docs.spring.io/spring-security'), 'external');
  assert.equal(Chat.citationKind('https://postgresql.org/docs'), 'external');
  assert.equal(Chat.citationKind('Lecture 4'), 'material');
  assert.equal(Chat.citationKind('CRC handout pages 12-13'), 'material');
});

test('research run summary keeps the honest headline and stops cleanly', () => {
  const running = Panels.summarizeResearchRun({ status: 'RUNNING', plannedQueries: 8, queriesRun: 3, candidatesFound: 9, sourcesIngested: 2, sourcesSkipped: 1, sourcesFailed: 0, bytesFetched: 40960 });
  assert.equal(running.headline, 'Researching course…');
  assert.equal(running.finished, false);
  assert.equal(running.ingested, 2);
  const done = Panels.summarizeResearchRun({ status: 'COMPLETED', sourcesIngested: 4, sourcesSkipped: 2, sourcesFailed: 0 });
  assert.equal(done.headline, 'Research complete');
  assert.equal(done.finished, true);
  assert.equal(Panels.summarizeResearchRun(null), null);
});

test('syllabus parse status maps to a visible warn on zero-result parsing', () => {
  const ok = Panels.mapSyllabusParseStatus({ status: 'PARSED', units: 12, confidence: 'HIGH' });
  assert.equal(ok.kind, 'ok');
  assert.match(ok.message, /12 units/);
  const unparsed = Panels.mapSyllabusParseStatus({ status: 'SYLLABUS_DETECTED_BUT_UNPARSED', units: 0 });
  assert.equal(unparsed.kind, 'warn');
  assert.match(unparsed.message, /could not read its structure/);
  const none = Panels.mapSyllabusParseStatus({ status: 'NOT_SYLLABUS' });
  assert.equal(none.kind, 'muted');
});

test('syllabus unit labels prefer week, then ordinal', () => {
  assert.equal(Panels.syllabusUnitLabel({ weekNumber: 3 }), 'Week 3');
  assert.equal(Panels.syllabusUnitLabel({ ordinal: 2 }), 'Unit 2');
  assert.equal(Panels.syllabusUnitLabel({}), 'Unit');
});

test('exam evidence summary turns stored evidence into plain phrases', () => {
  const summary = Panels.evidenceSummary('t1', [
    { topicId: 't1', evidence: JSON.stringify({ pastExams: '3/4', pastExamPoints: 42, syllabusDocuments: 1 }) }
  ]);
  assert.match(summary, /3\/4 past exam/);
  assert.match(summary, /42 points/);
  assert.match(summary, /syllabus/);
  assert.equal(Panels.evidenceSummary('t1', [{ topicId: 't1' }]), null);
});

test('evidence confidence is its own badge, never merged into the probability', () => {
  // High evidence confidence: plenty of recorded exams behind the topic.
  assert.match(Panels.evidenceConfidenceBadge(0.85, 4), /Evidence confidence: High/);
  // Medium: some evidence exists but the corpus is thin.
  assert.match(Panels.evidenceConfidenceBadge(0.55, 2), /Evidence confidence: Medium/);
  // Low — including the "no evidence yet" phrasing, which must still surface as Low evidence.
  assert.match(Panels.evidenceConfidenceBadge(0.1, 0), /Evidence confidence: Low/);
  // The badge is fed the stored evidence_confidence, never the relevance probability, so the two
  // facts stay separable: a high relevance with a thin evidence base still reads Low/Medium here.
  assert.doesNotMatch(Panels.evidenceConfidenceBadge(0.2, 0), /High/);
});

test('topic relations separate prerequisites from dependents for both edge vocabularies', () => {
  const edges = [
    // di PREREQUISITE_OF security: security depends on di.
    { relationType: 'PREREQUISITE_OF', sourceTopicId: 'di', sourceName: 'DI', targetTopicId: 'security', targetName: 'Security' },
    // transactions BUILDS_ON di: the view semantics make di the prerequisite, transactions the dependent.
    { relationType: 'BUILDS_ON', sourceTopicId: 'transactions', sourceName: 'Transactions', targetTopicId: 'di', targetName: 'DI' },
    // ioc PREREQUISITE_OF di: di itself rests on IoC.
    { relationType: 'PREREQUISITE_OF', sourceTopicId: 'ioc', sourceName: 'IoC', targetTopicId: 'di', targetName: 'DI' }
  ];
  const related = Panels.collectTopicRelations(edges, 'di');
  assert.deepEqual(related.prerequisites, ['IoC']);
  assert.deepEqual(related.dependents, ['Security', 'Transactions']);
});
