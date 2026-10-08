package com.studyos.knowledge;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.prediction.ExamGroundTruthService;
import com.studyos.support.PostgresSupport;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The knowledge-graph cleanup, against real PostgreSQL: junk candidates never persist through the
 * extraction funnel, existing junk is renamed/merged/deleted safely, learner evidence survives,
 * the prediction universe excludes rejected and merged rows, and a second cleanup run is a no-op.
 */
class TopicQualityIntegrationTest {

    @BeforeAll
    static void freshDatabase() {
        PostgresSupport.reset();
    }

    private final JdbcTemplate jdbc = PostgresSupport.jdbc();

    private TopicExtractionService extraction() {
        TopicRegistry registry = new TopicRegistry(jdbc);
        TopicRelationService relations = new TopicRelationService(jdbc, new TopicRelationExtractor());
        TopicReconciliationService reconciliation = new TopicReconciliationService(
                jdbc, registry, PostgresSupport.transactionManager(), null, null, null, null);
        return new TopicExtractionService(null, jdbc, null, relations, null, null, registry, null, null, reconciliation, false);
    }

    private TopicQualityCleanupService cleanup() {
        return new TopicQualityCleanupService(jdbc, new TopicRegistry(jdbc),
                new TopicReconciliationService(jdbc, new TopicRegistry(jdbc), PostgresSupport.transactionManager(), null, null, null, null));
    }

    private List<String> topicNames(UUID course) {
        return jdbc.queryForList("SELECT canonical_name FROM topics WHERE course_id=? AND canonical_topic_id IS NULL", String.class, course);
    }

    @Test
    void junkCandidatesNeverPersistThroughTheFunnel() {
        UUID course = PostgresSupport.insertCourse();
        UUID document = PostgresSupport.insertDocument(course, "PAST_EXAM");
        UUID chunk = PostgresSupport.insertChunk(course, document, 0, """
                2. Fairness (20 Pt)
                Fairness means that no process starves.

                3. Show that the protocol satisfies fairness (20 Pt)

                Q4. Calculate the CRC remainder using generator 110101 [10 marks]
                """);

        extraction().extract(course, List.of(new com.studyos.ingestion.Chunk(chunk, 0, 1, 1,
                PostgresSupport.jdbc().queryForObject("SELECT content FROM chunks WHERE id=?", String.class, chunk), 50)));

        List<String> names = topicNames(course);
        assertThat(names).contains("Fairness");
        assertThat(names).doesNotContain("Show");
        assertThat(names).doesNotContain("Calculate");
        assertThat(names.stream().noneMatch(name -> name.matches(".*(20 Pt|10 marks|credit points).*"))).isTrue();

        // The rejection is audited, not silent.
        Integer audits = jdbc.queryForObject(
                "SELECT COUNT(*) FROM topic_extraction_audit WHERE course_id=? AND reason='INSTRUCTION_FRAGMENT'", Integer.class, course);
        assertThat(audits).isGreaterThanOrEqualTo(1);
    }

    @Test
    void cleanupRenamesMergesDeletesAndKeepsEvidence() {
        UUID course = PostgresSupport.insertCourse();
        UUID fairness = PostgresSupport.insertTopic(course, "Fairness");
        UUID packaged1 = PostgresSupport.insertTopic(course, "Fairness (20 Pt)");
        UUID packaged2 = PostgresSupport.insertTopic(course, "Fairness (30 Pt)");
        UUID noBase = PostgresSupport.insertTopic(course, "Leader election in rings (20 credit points)");
        UUID verbJunk = PostgresSupport.insertTopic(course, "Show");

        // Learner evidence on the survivor must survive every merge that touches the family.
        jdbc.update("INSERT INTO student_topic_state(course_id,topic_id,mastery,confidence) VALUES(?,?,0.42,0.7)", course, fairness);

        TopicQualityCleanupService.CleanupReport report = cleanup().cleanup(course);

        assertThat(report.renamed()).isGreaterThanOrEqualTo(1);
        assertThat(report.merged()).isGreaterThanOrEqualTo(1);
        assertThat(report.deleted()).isGreaterThanOrEqualTo(1);

        // "Fairness (20 Pt)" had no base topic at insert time... it does now: order matters is fine,
        // the family must end as ONE canonical Fairness holding all the evidence.
        Integer fairnessStates = jdbc.queryForObject(
                "SELECT COUNT(*) FROM student_topic_state s JOIN topics t ON t.id=s.topic_id WHERE t.canonical_name='Fairness' AND t.course_id=?",
                Integer.class, course);
        assertThat(fairnessStates).isEqualTo(1);
        Double mastery = jdbc.queryForObject(
                "SELECT s.mastery FROM student_topic_state s JOIN topics t ON t.id=s.topic_id WHERE t.canonical_name='Fairness' AND t.course_id=?",
                Double.class, course);
        assertThat(mastery).isEqualTo(0.42);
        Integer stateRows = jdbc.queryForObject(
                "SELECT COUNT(*) FROM student_topic_state WHERE topic_id IN (?,?,?)", Integer.class, packaged1, packaged2, fairness);
        assertThat(stateRows).isEqualTo(1);

        // Salvaged names exist as real topics; "Show" is gone; nothing dangles.
        assertThat(topicNames(course)).contains("Fairness", "Leader election in rings");
        assertThat(topicNames(course)).doesNotContain("Show");
        Integer orphans = jdbc.queryForObject(
                "SELECT COUNT(*) FROM topics t WHERE t.course_id=? AND t.canonical_topic_id IS NULL AND NOT EXISTS (SELECT 1 FROM topics c WHERE c.id=t.id)",
                Integer.class, course);
        assertThat(orphans).isZero();
    }

    @Test
    void cleanupIsIdempotent() {
        UUID course = PostgresSupport.insertCourse();
        PostgresSupport.insertTopic(course, "Fairness");
        PostgresSupport.insertTopic(course, "Fairness (20 Pt)");
        PostgresSupport.insertTopic(course, "Fairness (40 credit points)");
        PostgresSupport.insertTopic(course, "know");

        TopicQualityCleanupService.CleanupReport first = cleanup().cleanup(course);
        List<String> afterFirst = topicNames(course);
        Map<String, Long> auditFirst = auditCounts(course);

        TopicQualityCleanupService.CleanupReport second = cleanup().cleanup(course);
        List<String> afterSecond = topicNames(course);

        // Renamed topics re-evaluate VALID; merged rows are redirects the query never revisits.
        assertThat(second.valid()).isEqualTo(first.valid() + first.renamed());
        assertThat(second.deleted()).isZero();
        assertThat(second.renamed()).isZero();
        assertThat(second.merged()).isZero();
        assertThat(afterSecond).isEqualTo(afterFirst);
        // No duplicated audits, no duplicated aliases.
        assertThat(auditCounts(course)).isEqualTo(auditFirst);
        Integer aliasCount = jdbc.queryForObject(
                "SELECT (SELECT COUNT(*) FROM topic_aliases WHERE course_id=?)", Integer.class, course);
        Integer aliasCountAgain = jdbc.queryForObject(
                "SELECT (SELECT COUNT(*) FROM topic_aliases WHERE course_id=?)", Integer.class, course);
        assertThat(aliasCountAgain).isEqualTo(aliasCount);
    }

    @Test
    void referencedInvalidTopicsAreKeptButExcludedFromThePredictionUniverse() {
        UUID course = PostgresSupport.insertCourse();
        UUID junk = PostgresSupport.insertTopic(course, "know");
        UUID valid = PostgresSupport.insertTopic(course, "Sliding window protocol");

        // Referenced by a parsed exam question, so cleanup must NOT delete it...
        UUID document = PostgresSupport.insertDocument(course, "PAST_EXAM");
        UUID item = UUID.randomUUID();
        jdbc.update("INSERT INTO assessment_items(id,course_id,document_id,topic_id,source_type,type,prompt,points,difficulty,year) VALUES(?,?,?,?,?,?,?,?,?,?)",
                item, course, document, junk, "PAST_EXAM", "PROBLEM_SOLVING", "Do you know the protocol?", 10.0, 0.5, 2024);
        jdbc.update("INSERT INTO assessment_item_topics(item_id,topic_id,relevance) VALUES(?,?,1.0)", item, junk);
        jdbc.update("INSERT INTO assessment_item_topics(item_id,topic_id,relevance) VALUES(?,?,1.0)", item, valid);

        TopicQualityCleanupService.CleanupReport report = cleanup().cleanup(course);
        assertThat(report.keptInvalid()).isGreaterThanOrEqualTo(1);
        assertThat(topicNames(course)).contains("know");

        // ...but it never enters the prediction universe, in profiles or in ground truth.
        com.studyos.prediction.BacktestEngine.Snapshot snapshot = new ExamGroundTruthService(jdbc).snapshot(course);
        List<String> universe = snapshot.topics().values().stream().map(profile -> profile.name()).toList();
        assertThat(universe).doesNotContain("know");
        assertThat(snapshot.topics().keySet()).contains(valid);
        for (var exam : snapshot.exams()) {
            assertThat(exam.topicIds()).doesNotContain(junk);
        }
    }

    private Map<String, Long> auditCounts(UUID course) {
        return jdbc.query(
                "SELECT reason, COUNT(*) AS n FROM topic_extraction_audit WHERE course_id=? AND source='CLEANUP' GROUP BY reason",
                rs -> {
                    Map<String, Long> counts = new java.util.LinkedHashMap<>();
                    while (rs.next()) counts.put(rs.getString(1), rs.getLong(2));
                    return counts;
                }, course);
    }
}
