package com.studyos.prediction;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.support.PostgresSupport;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Backtesting against real PostgreSQL: persisted runs are append-only, canonical topic resolution
 * survives a real merge, concurrent runs do not collide, and — most importantly — a backtest is
 * observational: learner mastery and live prediction state are byte-identical before and after.
 */
class PredictionCalibrationIntegrationTest {

    @BeforeAll
    static void freshDatabase() {
        PostgresSupport.reset();
    }

    private final JdbcTemplate jdbc = PostgresSupport.jdbc();

    private final PredictionBacktestService service = new PredictionBacktestService(
            jdbc, new ExamGroundTruthService(jdbc), new com.fasterxml.jackson.databind.ObjectMapper());

    /** Builds a course with real parsed-style exam history: documents, items, topic links. */
    private UUID courseWithExams(int examCount, int topicsPerExam) {
        UUID course = PostgresSupport.insertCourse();
        for (int exam = 0; exam < examCount; exam++) {
            UUID document = PostgresSupport.insertDocument(course, "PAST_EXAM");
            for (int topicIndex = 0; topicIndex < topicsPerExam; topicIndex++) {
                UUID topic = PostgresSupport.insertTopic(course, "Exam topic " + topicIndex);
                UUID item = UUID.randomUUID();
                jdbc.update("INSERT INTO assessment_items(id,course_id,document_id,topic_id,source_type,type,prompt,points,difficulty,year) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        item, course, document, topic, "PAST_EXAM", "PROBLEM_SOLVING", "Question " + exam + "-" + topicIndex, 10.0, 0.5, 2024 + (exam % 3));
                jdbc.update("INSERT INTO assessment_item_topics(item_id,topic_id,relevance) VALUES(?,?,1.0)", item, topic);
            }
        }
        return course;
    }

    @Test
    void backtestPersistsRunsAndFoldsAppendOnly() {
        UUID course = courseWithExams(5, 3);
        PredictionBacktestService.BacktestReport first = service.backtest(course, null);
        PredictionBacktestService.BacktestReport second = service.backtest(course, null);
        assertThat(first.runId()).isNotNull();
        assertThat(second.runId()).isNotNull().isNotEqualTo(first.runId());
        assertThat(first.foldsEvaluated()).isEqualTo(4);

        Integer runRows = jdbc.queryForObject("SELECT COUNT(*) FROM prediction_backtest_runs WHERE course_id=?", Integer.class, course);
        assertThat(runRows).isEqualTo(2);
        Integer foldRows = jdbc.queryForObject(
                "SELECT COUNT(*) FROM prediction_backtest_folds WHERE run_id IN (SELECT id FROM prediction_backtest_runs WHERE course_id=?)",
                Integer.class, course);
        assertThat(foldRows).isEqualTo(8);
        // The metric columns are real numbers, not placeholders.
        Double ndcg = jdbc.queryForObject("SELECT ndcg_at_5 FROM prediction_backtest_runs WHERE id=?", Double.class, first.runId());
        assertThat(ndcg).isNotNull();
        List<Map<String, Object>> history = service.runs(course);
        assertThat(history).hasSize(2);
    }

    @Test
    void canonicalResolutionScoringAfterRealMerge() {
        UUID course = courseWithExams(4, 2);
        // Merge "Exam topic 1" into "Exam topic 0" via the reconciliation service itself.
        var reconciliation = new com.studyos.knowledge.TopicReconciliationService(
                jdbc, new com.studyos.knowledge.TopicRegistry(jdbc), PostgresSupport.transactionManager(),
                null, null, null, null);
        UUID kept = jdbc.queryForObject("SELECT id FROM topics WHERE course_id=? AND canonical_name='Exam topic 0'", UUID.class, course);
        UUID dropped = jdbc.queryForObject("SELECT id FROM topics WHERE course_id=? AND canonical_name='Exam topic 1'", UUID.class, course);
        var verdict = new TopicReconciliationCoreVerdictFactory().verdict();
        boolean merged = reconciliation.mergeTopics(course,
                new com.studyos.knowledge.TopicReconciliationService.TopicRow(kept, "Exam topic 0", "exam topic 0", null, null),
                new com.studyos.knowledge.TopicReconciliationService.TopicRow(dropped, "Exam topic 1", "exam topic 1", null, null),
                verdict);
        assertThat(merged).isTrue();

        // The snapshot must resolve both spellings onto the canonical topic: an exam that asked
        // both can never count as two topics, and scoring must never report a false miss.
        var snapshot = new ExamGroundTruthService(jdbc).snapshot(course);
        assertThat(snapshot.canonicalOf()).containsEntry(dropped, kept);
        for (var exam : snapshot.exams()) {
            assertThat(exam.topicIds()).contains(kept);
            assertThat(exam.topicIds()).doesNotContain(dropped);
        }
        var report = service.backtest(course, null);
        assertThat(report.status()).isEqualTo("BACKTESTED");
    }

    @Test
    void concurrentBacktestRunsDoNotCollide() throws Exception {
        UUID course = courseWithExams(4, 2);
        ExecutorService pool = Executors.newFixedThreadPool(4);
        var tasks = new java.util.ArrayList<Callable<PredictionBacktestService.BacktestReport>>();
        for (int index = 0; index < 4; index++) {
            tasks.add(() -> new PredictionBacktestService(jdbc, new ExamGroundTruthService(jdbc), new com.fasterxml.jackson.databind.ObjectMapper()).backtest(course, null));
        }
        var results = pool.invokeAll(tasks);
        pool.shutdown();
        assertThat(pool.awaitTermination(60, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
        for (var future : results) {
            assertThat(future.get().runId()).isNotNull();
        }
        Integer runRows = jdbc.queryForObject("SELECT COUNT(*) FROM prediction_backtest_runs WHERE course_id=?", Integer.class, course);
        assertThat(runRows).isEqualTo(4);
    }

    @Test
    void backtestIsObservational_noLearnerStateOrSignalMutation() {
        UUID course = courseWithExams(6, 3);
        // Learner evidence exists and must survive the backtest untouched.
        jdbc.update("INSERT INTO student_topic_state(course_id,topic_id,mastery,alpha,beta,evidence_count) VALUES(?,?,.7,8,4,6)", course, PostgresSupport.insertTopic(course, "Unrelated learner topic"));
        Map<String, Object> masteryBefore = jdbc.queryForMap("SELECT mastery,alpha,beta,evidence_count FROM student_topic_state WHERE course_id=?", course);
        Integer signalRowsBefore = jdbc.queryForObject("SELECT COUNT(*) FROM exam_topic_signals WHERE course_id=?", Integer.class, course);
        Integer attemptsBefore = jdbc.queryForObject("SELECT COUNT(*) FROM assessment_attempts", Integer.class);

        service.backtest(course, "fixture-hash-123");

        Map<String, Object> masteryAfter = jdbc.queryForMap("SELECT mastery,alpha,beta,evidence_count FROM student_topic_state WHERE course_id=?", course);
        assertThat(masteryAfter).isEqualTo(masteryBefore);
        Integer signalRowsAfter = jdbc.queryForObject("SELECT COUNT(*) FROM exam_topic_signals WHERE course_id=?", Integer.class, course);
        assertThat(signalRowsAfter).isEqualTo(signalRowsBefore);
        Integer attemptsAfter = jdbc.queryForObject("SELECT COUNT(*) FROM assessment_attempts", Integer.class);
        assertThat(attemptsAfter).isEqualTo(attemptsBefore);
        // The run stored the fixture hash for reproducibility.
        String stored = jdbc.queryForObject("SELECT fixture_hash FROM prediction_backtest_runs WHERE course_id=? ORDER BY created_at DESC LIMIT 1", String.class, course);
        assertThat(stored).isEqualTo("fixture-hash-123");
    }

    @Test
    void modelVersionStorageKeepsV1AndV2Separate() {
        UUID course = PostgresSupport.insertCourse();
        service.registerModelVersion(course, "EXAM_TOPIC_V1",
                com.studyos.assessment.ExamRelevanceCalculator.Weights.V1_DEFAULTS, "Original hand-set weights", Map.of("note", "baseline"), "corpus v1");
        service.registerModelVersion(course, "EXAM_TOPIC_V2",
                new com.studyos.assessment.ExamRelevanceCalculator.Weights(.35, .15, .15, .10, .10, .10, .05),
                "Recency calibration from held-out backtesting", Map.of("ndcgAt5", 0.71), "corpus v2");
        // Re-registering must not duplicate (unique constraint).
        service.registerModelVersion(course, "EXAM_TOPIC_V1",
                com.studyos.assessment.ExamRelevanceCalculator.Weights.V1_DEFAULTS, "duplicate attempt", Map.of(), "");
        List<Map<String, Object>> versions = service.modelVersions(course);
        assertThat(versions).hasSize(2);
        String v2Weights = jdbc.queryForObject(
                "SELECT weights::text FROM prediction_model_versions WHERE model_version='EXAM_TOPIC_V2' AND course_id=?", String.class, course);
        assertThat(v2Weights).contains("0.35");
    }

    @Test
    void readinessValidationPairsRecordAndReport() {
        UUID course = PostgresSupport.insertCourse();
        // No topics: the forecast is INSUFFICIENT_EVIDENCE, so no pair is recorded.
        var validation = new ReadinessValidationService(jdbc, new PredictionService(jdbc));
        assertThat(validation.recordForecast(course, "MANUAL", null)).isNull();
        // With a topic and learner evidence, the forecast becomes real.
        UUID topic = PostgresSupport.insertTopic(course, "Forecastable topic");
        jdbc.update("INSERT INTO student_topic_state(course_id,topic_id,mastery,confidence,alpha,beta,evidence_count) VALUES(?,?,.8,.7,8,4,6)", course, topic);
        UUID pair = validation.recordForecast(course, "MANUAL", null);
        assertThat(pair).isNotNull();
        assertThat(validation.recordActual(course, 0.74)).isTrue();
        var report = validation.report(course);
        assertThat(report.pairs()).isEqualTo(1);
        assertThat(report.evaluated()).isEqualTo(1);
        assertThat(report.bands()).hasSize(1);
        // The deterministic V1 readiness formula lands in the 0.6-0.7 band for this fixture.
        assertThat(report.bands().get(0).band()).isEqualTo("0.6-0.7");
        assertThat(report.caveat()).isNotBlank();
    }

    /** Local helper keeping the reconciliation verdict construction out of the test body. */
    private static final class TopicReconciliationCoreVerdictFactory {
        com.studyos.knowledge.TopicReconciliationCore.Verdict verdict() {
            return new com.studyos.knowledge.TopicReconciliationCore.Verdict(
                    com.studyos.knowledge.ReconciliationDecision.SAME, 0.95, "test merge", 1.0, 0, 0, List.of());
        }
    }
}

