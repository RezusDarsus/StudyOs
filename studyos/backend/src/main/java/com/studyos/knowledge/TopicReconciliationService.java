package com.studyos.knowledge;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.studyos.ai.AiGateway;
import com.studyos.ai.AiOperation;
import com.studyos.ai.AiResult;
import com.studyos.ai.AiUsageService;
import com.studyos.ai.GenerationPolicyRegistry;
import com.studyos.assessment.ExamAnalysisService;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Finds equivalent topics across a workspace and folds them into one canonical topic.
 *
 * <p>This is not extraction — it runs after extraction, whenever new material has just arrived: a
 * document upload, a research source, a syllabus, a generated curriculum. Every subsystem downstream
 * of topics (mastery, prerequisites, retrieval, assessment, exam prediction, coverage, the tutor)
 * reads a single topic identity, so the reconciliation result model is deliberately conservative:
 * a false merge corrupts all of those at once, a surviving duplicate costs almost nothing.
 *
 * <p>Merge mechanics: every topic-level reference is <em>moved</em> to the kept topic inside one
 * transaction and the merged-away row survives as a redirect ({@code topics.canonical_topic_id}),
 * so old stored names still resolve and nothing is silently deleted.
 */
@Service
public class TopicReconciliationService {
    private static final Logger log = LoggerFactory.getLogger(TopicReconciliationService.class);
    /** Hard cap on LLM verifications per run, so ambiguity can never become an unbounded cost. */
    private static final int MAX_LLM_VERIFICATIONS = 8;
    private static final int MAX_PAIRS = 400;
    private static final double VECTOR_MIN_SIMILARITY = 0.86;

    private final JdbcTemplate jdbc;
    private final TopicRegistry registry;
    private final TransactionTemplate transaction;
    private final ExamAnalysisService examAnalysis;
    private final AiGateway ai;
    private final GenerationPolicyRegistry policies;
    private final AiUsageService usage;

    public TopicReconciliationService(JdbcTemplate jdbc, TopicRegistry registry, PlatformTransactionManager transactionManager,
                                      ExamAnalysisService examAnalysis, AiGateway ai, GenerationPolicyRegistry policies, AiUsageService usage) {
        this.jdbc = jdbc;
        this.registry = registry;
        this.transaction = new TransactionTemplate(transactionManager);
        this.examAnalysis = examAnalysis;
        this.ai = ai;
        this.policies = policies;
        this.usage = usage;
    }

    public record StageTrace(String stage, double score, boolean matched, String detail) {}

    public record MergeRecord(UUID keptTopicId, String keptName, UUID mergedTopicId, String mergedName,
                              ReconciliationDecision decision, double confidence, String reason, List<StageTrace> stages) {}

    public record Report(int pairsExamined, int merged, int rejectedUnsafe, int ambiguous, List<MergeRecord> merges) {}

    /** A freshly created, still-unbound topic compared against everything the workspace already knows. */
    public record UnboundPair(UUID freshTopicId, String freshName, UUID existingTopicId, String existingName) {}

    /**
     * Full pass over the workspace. Returns what was examined, what merged and what stayed apart.
     */
    public Report reconcile(UUID courseId) {
        List<TopicRow> topics = canonicalTopics(courseId);
        if (topics.size() < 2) return new Report(0, 0, 0, 0, List.of());
        Map<UUID, List<String>> aliases = aliases(courseId);
        Map<UUID, float[]> vectors = new HashMap<>();
        for (TopicRow topic : topics) if (topic.embedding != null) vectors.put(topic.id(), parseVector(topic.embedding));

        List<ScoredPair> pairs = candidatePairs(topics, vectors);
        return resolve(courseId, pairs, aliases);
    }

    /**
     * Late-arriving material: compares topics that were just created and still have no source
     * binding against the topics that already have one. Cheap by construction — fresh topics are
     * few — and it is exactly where a duplicate is born.
     */
    public Report reconcileUnbound(UUID courseId) {
        List<TopicRow> topics = canonicalTopics(courseId);
        if (topics.isEmpty()) return new Report(0, 0, 0, 0, List.of());
        Map<UUID, List<String>> aliases = aliases(courseId);
        Set<UUID> bound = new HashSet<>(jdbc.queryForList("SELECT DISTINCT topic_id FROM chunk_topics ct JOIN topics t ON t.id=ct.topic_id WHERE t.course_id=? AND t.canonical_topic_id IS NULL", UUID.class, courseId));
        List<TopicRow> fresh = topics.stream().filter(topic -> !bound.contains(topic.id())).limit(50).toList();
        List<TopicRow> established = topics.stream().filter(topic -> bound.contains(topic.id())).toList();
        if (fresh.isEmpty() || established.isEmpty()) return new Report(0, 0, 0, 0, List.of());

        Map<UUID, float[]> vectors = new HashMap<>();
        for (TopicRow topic : topics) if (topic.embedding != null) vectors.put(topic.id(), parseVector(topic.embedding));
        List<ScoredPair> pairs = new ArrayList<>();
        for (TopicRow freshTopic : fresh) {
            for (TopicRow establishedTopic : established) {
                double score = pairScore(freshTopic, establishedTopic, vectors);
                if (score >= VECTOR_MIN_SIMILARITY || TopicReconciliationCore.lexicalSimilarity(freshTopic.name, establishedTopic.name) >= TopicReconciliationCore.LEXICAL_FLOOR) {
                    pairs.add(new ScoredPair(freshTopic, establishedTopic, score));
                }
            }
        }
        return resolve(courseId, pairs, aliases);
    }

    private Report resolve(UUID courseId, List<ScoredPair> pairs, Map<UUID, List<String>> aliases) {
        pairs.sort(Comparator.comparingDouble((ScoredPair pair) -> pair.score).reversed());
        if (pairs.size() > MAX_PAIRS) pairs = pairs.subList(0, MAX_PAIRS);

        Map<UUID, TopicRow> byId = new LinkedHashMap<>();
        for (ScoredPair pair : pairs) {
            byId.putIfAbsent(pair.left.id(), pair.left);
            byId.putIfAbsent(pair.right.id(), pair.right);
        }
        Map<UUID, Set<String>> context = contextTerms(byId.values());

        int merged = 0, rejected = 0, ambiguous = 0, llmChecks = 0;
        List<MergeRecord> records = new ArrayList<>();
        Set<UUID> foldedAway = new HashSet<>();
        for (ScoredPair pair : pairs) {
            if (foldedAway.contains(pair.left.id()) || foldedAway.contains(pair.right.id())) continue;
            TopicReconciliationCore.CandidateTopic left = candidate(pair.left, aliases, context);
            TopicReconciliationCore.CandidateTopic right = candidate(pair.right, aliases, context);
            TopicReconciliationCore.Verdict verdict = TopicReconciliationCore.evaluate(left, right);
            if (verdict.decision() == ReconciliationDecision.AMBIGUOUS && llmChecks < MAX_LLM_VERIFICATIONS) {
                llmChecks++;
                TopicReconciliationCore.Verdict verified = verifyWithLlm(left, right, verdict);
                if (verified != null) verdict = verified;
            }
            switch (verdict.decision()) {
                case SAME -> {
                    if (verdict.confidence() >= TopicReconciliationCore.MERGE_CONFIDENCE && mergeTopics(courseId, pair.right, pair.left, verdict)) {
                        merged++;
                        foldedAway.add(pair.left.id());
                        records.add(record(pair.right, pair.left, verdict));
                    } else {
                        rejected++;
                    }
                }
                case AMBIGUOUS -> ambiguous++;
                case DIFFERENT -> rejected++;
            }
        }
        if (merged > 0) {
            try {
                examAnalysis.rebuild(courseId);
            } catch (RuntimeException error) {
                log.warn("Exam analysis rebuild after topic merge failed for course {}: {}", courseId, error.getMessage());
            }
        }
        return new Report(pairs.size(), merged, rejected, ambiguous, records);
    }

    private TopicReconciliationCore.CandidateTopic candidate(TopicRow row, Map<UUID, List<String>> aliases, Map<UUID, Set<String>> context) {
        List<String> aliasList = aliases.getOrDefault(row.id(), List.of());
        Set<String> terms = context.getOrDefault(row.id(), Set.of());
        return new TopicReconciliationCore.CandidateTopic(row.id().toString(), row.name, aliasList, parseVector(row.embedding), terms);
    }

    private MergeRecord record(TopicRow kept, TopicRow dropped, TopicReconciliationCore.Verdict verdict) {
        List<StageTrace> stages = verdict.stages().stream()
                .map(stage -> new StageTrace(stage.stage(), stage.score(), stage.matched(), stage.detail()))
                .toList();
        return new MergeRecord(kept.id, kept.name, dropped.id, dropped.name, verdict.decision(), verdict.confidence(), verdict.reason(), stages);
    }

    private TopicReconciliationCore.Verdict verifyWithLlm(TopicReconciliationCore.CandidateTopic left, TopicReconciliationCore.CandidateTopic right, TopicReconciliationCore.Verdict fallback) {
        String prompt = "Two candidate course topics must be compared for identity.\n"
                + "Topic A: \"" + left.name() + "\"\n"
                + "Topic B: \"" + right.name() + "\"\n"
                + "Context A: " + String.join(", ", left.contextTerms()) + "\n"
                + "Context B: " + String.join(", ", right.contextTerms()) + "\n\n"
                + "Decide whether A and B are the SAME academic concept, DIFFERENT concepts, or the evidence is genuinely ambiguous. "
                + "Related but distinct concepts (e.g. 'TCP flow control' vs 'TCP congestion control', 'gradient' vs 'gradient descent') are DIFFERENT. "
                + "Return JSON only: {\"decision\":\"SAME|DIFFERENT|AMBIGUOUS\",\"confidence\":0.0-1.0,\"reason\":\"...\"}";
        long started = System.nanoTime();
        AiResult<LlmVerdict> result = null;
        boolean success = false;
        try {
            result = ai.generateStructuredResult(
                    "You judge whether two course topic names refer to the same concept. Be conservative: when in doubt, answer DIFFERENT.",
                    prompt, LlmVerdict.class, policies.policy(AiOperation.RECONCILIATION));
            success = true;
            LlmVerdict verdict = result.value();
            if (verdict == null || verdict.decision() == null) return null;
            ReconciliationDecision decision;
            try {
                decision = ReconciliationDecision.valueOf(verdict.decision().trim().toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException error) {
                return null;
            }
            double confidence = Math.max(0, Math.min(1, verdict.confidence()));
            // A verified SAME only merges when the model is at least as sure as the safe stages require.
            if (decision == ReconciliationDecision.SAME && confidence < TopicReconciliationCore.MERGE_CONFIDENCE) {
                decision = ReconciliationDecision.AMBIGUOUS;
            }
            return new TopicReconciliationCore.Verdict(decision, confidence, "LLM verification: " + (verdict.reason() == null ? "no reason given" : verdict.reason()),
                    fallback.lexicalScore(), fallback.embeddingScore(), fallback.sourceOverlap(), fallback.stages());
        } catch (RuntimeException error) {
            log.info("LLM reconciliation verification unavailable: {}", error.getMessage());
            return null;
        } finally {
            usage.record(AiOperation.RECONCILIATION, result, null, null, null, (System.nanoTime() - started) / 1_000_000, success);
        }
    }

    /**
     * Moves every topic-level reference from {@code dropped} to {@code kept} and leaves a redirect.
     * One transaction: a half-merged topic would be worse than a duplicate.
     */
    public boolean mergeTopics(UUID courseId, TopicRow kept, TopicRow dropped, TopicReconciliationCore.Verdict verdict) {
        Boolean done = transaction.execute(status -> {
            Integer sameCourse = jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE id IN (?,?) AND course_id=? AND canonical_topic_id IS NULL", Integer.class, kept.id, dropped.id, courseId);
            if (sameCourse == null || sameCourse != 2) return false;

            // Descriptions and the stronger model figures survive on the kept topic.
            jdbc.update("UPDATE topics SET description=COALESCE(description,(SELECT description FROM topics WHERE id=?)) WHERE id=?", dropped.id, kept.id);
            jdbc.update("UPDATE topics SET importance=GREATEST(COALESCE(importance,0),(SELECT COALESCE(importance,0) FROM topics WHERE id=?)),difficulty_attempts=GREATEST(COALESCE(difficulty_attempts,0),(SELECT COALESCE(difficulty_attempts,0) FROM topics WHERE id=?)) WHERE id=?", dropped.id, dropped.id, kept.id);

            moveChunkTopics(kept, dropped);
            moveAliases(courseId, kept, dropped);
            moveEdges(courseId, kept, dropped);
            moveStudentState(courseId, kept, dropped);
            moveObjectives(courseId, kept, dropped);
            moveAssessmentLinks(courseId, kept, dropped);
            moveExamSignals(courseId, kept, dropped);
            moveSingleColumnReferences(courseId, kept, dropped);
            jdbc.update("DELETE FROM topic_capsule_cache WHERE course_id=? AND topic_id=?", courseId, dropped.id);
            moveLadderState(courseId, kept, dropped);

            jdbc.update("UPDATE topics SET canonical_topic_id=?,merged_at=NOW(),merge_note=? WHERE id=?", kept.id, verdict.reason(), dropped.id);
            jdbc.update("INSERT INTO topic_reconciliations(id,course_id,kept_topic_id,merged_topic_id,decision,confidence,reason,stages) VALUES(?,?,?,?,?,?,?,CAST(? AS jsonb))",
                    UUID.randomUUID(), courseId, kept.id, dropped.id, verdict.decision().name(), verdict.confidence(), verdict.reason(), stageJson(verdict));
            return true;
        });
        return Boolean.TRUE.equals(done);
    }

    private void moveChunkTopics(TopicRow kept, TopicRow dropped) {
        jdbc.update("INSERT INTO chunk_topics(chunk_id,topic_id,relevance) SELECT chunk_id,?,relevance FROM chunk_topics WHERE topic_id=? ON CONFLICT (chunk_id,topic_id) DO UPDATE SET relevance=GREATEST(chunk_topics.relevance,EXCLUDED.relevance)", kept.id, dropped.id);
        jdbc.update("DELETE FROM chunk_topics WHERE topic_id=?", dropped.id);
    }

    private void moveAliases(UUID courseId, TopicRow kept, TopicRow dropped) {
        jdbc.update("DELETE FROM topic_aliases WHERE topic_id=? AND (normalized_alias IN (SELECT normalized_name FROM topics WHERE id=?) OR normalized_alias IN (SELECT normalized_alias FROM topic_aliases WHERE topic_id=?))", dropped.id, kept.id, kept.id);
        jdbc.update("UPDATE topic_aliases SET topic_id=? WHERE topic_id=?", kept.id, dropped.id);
        registry.alias(courseId, kept.id, dropped.name);
    }

    private void moveEdges(UUID courseId, TopicRow kept, TopicRow dropped) {
        record Edge(UUID id, UUID source, UUID target, String type, Double confidence, UUID chunkId, String method, java.sql.Timestamp createdAt) {}
        List<Edge> edges = jdbc.query("SELECT id,source_topic_id,target_topic_id,relation_type,confidence,source_chunk_id,extraction_method,created_at FROM topic_edges WHERE course_id=? AND (source_topic_id=? OR target_topic_id=?)",
                (rs, row) -> new Edge(rs.getObject("id", UUID.class), rs.getObject("source_topic_id", UUID.class), rs.getObject("target_topic_id", UUID.class), rs.getString("relation_type"), rs.getObject("confidence", Double.class), rs.getObject("source_chunk_id", UUID.class), rs.getString("extraction_method"), rs.getTimestamp("created_at")), courseId, dropped.id, dropped.id);
        // Remove first, then re-insert remapped: a remapped edge keeps its id, so the old row
        // (still carrying the merged-away endpoint) must be gone before the insert runs.
        jdbc.update("DELETE FROM topic_edges WHERE course_id=? AND (source_topic_id=? OR target_topic_id=?)", courseId, dropped.id, dropped.id);
        for (Edge edge : edges) {
            UUID source = edge.source().equals(dropped.id()) ? kept.id() : edge.source();
            UUID target = edge.target().equals(dropped.id()) ? kept.id() : edge.target();
            if (source.equals(target)) continue; // an edge the merge turned into a self-loop dies here
            jdbc.update("INSERT INTO topic_edges(id,course_id,source_topic_id,target_topic_id,relation_type,confidence,source_chunk_id,extraction_method,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT (course_id,source_topic_id,target_topic_id,relation_type) DO UPDATE SET confidence=GREATEST(COALESCE(topic_edges.confidence,0),COALESCE(EXCLUDED.confidence,0))",
                    edge.id(), courseId, source, target, edge.type(), edge.confidence(), edge.chunkId(), edge.method(), edge.createdAt());
        }
    }

    private void moveStudentState(UUID courseId, TopicRow kept, TopicRow dropped) {
        jdbc.update("""
                INSERT INTO student_topic_state(course_id,topic_id,mastery,confidence,review_due_at,updated_at,alpha,beta,evidence_count,last_assessed_at,last_studied_at,measured_mastery,retention_estimate,retention_calculated_at,difficulty_estimate,stability_days,learned_probability)
                SELECT course_id,?,mastery,confidence,review_due_at,updated_at,alpha,beta,evidence_count,last_assessed_at,last_studied_at,measured_mastery,retention_estimate,retention_calculated_at,difficulty_estimate,stability_days,learned_probability
                FROM student_topic_state WHERE course_id=? AND topic_id=?
                ON CONFLICT (course_id,topic_id) DO UPDATE SET
                    alpha=student_topic_state.alpha+EXCLUDED.alpha,
                    beta=student_topic_state.beta+EXCLUDED.beta,
                    evidence_count=student_topic_state.evidence_count+EXCLUDED.evidence_count,
                    mastery=CASE WHEN student_topic_state.evidence_count+EXCLUDED.evidence_count>0
                        THEN (COALESCE(student_topic_state.mastery,0)*student_topic_state.evidence_count+COALESCE(EXCLUDED.mastery,0)*EXCLUDED.evidence_count)/(student_topic_state.evidence_count+EXCLUDED.evidence_count)
                        ELSE student_topic_state.mastery END,
                    measured_mastery=CASE WHEN student_topic_state.evidence_count+EXCLUDED.evidence_count>0
                        THEN (COALESCE(student_topic_state.measured_mastery,student_topic_state.mastery,0)*student_topic_state.evidence_count+COALESCE(EXCLUDED.measured_mastery,EXCLUDED.mastery,0)*EXCLUDED.evidence_count)/(student_topic_state.evidence_count+EXCLUDED.evidence_count)
                        ELSE student_topic_state.measured_mastery END,
                    confidence=GREATEST(COALESCE(student_topic_state.confidence,0),COALESCE(EXCLUDED.confidence,0)),
                    review_due_at=LEAST(student_topic_state.review_due_at,EXCLUDED.review_due_at),
                    updated_at=GREATEST(student_topic_state.updated_at,EXCLUDED.updated_at),
                    last_assessed_at=GREATEST(student_topic_state.last_assessed_at,EXCLUDED.last_assessed_at),
                    last_studied_at=GREATEST(student_topic_state.last_studied_at,EXCLUDED.last_studied_at),
                    retention_estimate=LEAST(COALESCE(student_topic_state.retention_estimate,1),COALESCE(EXCLUDED.retention_estimate,1)),
                    retention_calculated_at=GREATEST(student_topic_state.retention_calculated_at,EXCLUDED.retention_calculated_at),
                    difficulty_estimate=CASE WHEN student_topic_state.difficulty_estimate IS NULL THEN EXCLUDED.difficulty_estimate
                        WHEN EXCLUDED.difficulty_estimate IS NULL THEN student_topic_state.difficulty_estimate
                        ELSE (student_topic_state.difficulty_estimate*GREATEST(student_topic_state.evidence_count,1)+EXCLUDED.difficulty_estimate*GREATEST(EXCLUDED.evidence_count,1))/(GREATEST(student_topic_state.evidence_count,1)+GREATEST(EXCLUDED.evidence_count,1)) END,
                    stability_days=CASE WHEN student_topic_state.stability_days IS NULL THEN EXCLUDED.stability_days
                        WHEN EXCLUDED.stability_days IS NULL THEN student_topic_state.stability_days
                        ELSE (student_topic_state.stability_days*GREATEST(student_topic_state.evidence_count,1)+EXCLUDED.stability_days*GREATEST(EXCLUDED.evidence_count,1))/(GREATEST(student_topic_state.evidence_count,1)+GREATEST(EXCLUDED.evidence_count,1)) END,
                    learned_probability=CASE WHEN student_topic_state.learned_probability IS NULL THEN EXCLUDED.learned_probability
                        WHEN EXCLUDED.learned_probability IS NULL THEN student_topic_state.learned_probability
                        ELSE (student_topic_state.learned_probability*GREATEST(student_topic_state.evidence_count,1)+EXCLUDED.learned_probability*GREATEST(EXCLUDED.evidence_count,1))/(GREATEST(student_topic_state.evidence_count,1)+GREATEST(EXCLUDED.evidence_count,1)) END
                """, kept.id, courseId, dropped.id);
        jdbc.update("DELETE FROM student_topic_state WHERE course_id=? AND topic_id=?", courseId, dropped.id);
    }

    private void moveObjectives(UUID courseId, TopicRow kept, TopicRow dropped) {
        // Fresh ids: the source rows still exist inside this transaction, so reusing their ids
        // would collide with the primary key before the identity conflict ever fires.
        jdbc.update("""
                INSERT INTO topic_objectives(id,course_id,topic_id,statement,normalized_statement,cognitive_level,source_kind,document_id,source_chunk_id,section_path,page_start,page_end)
                SELECT md5(random()::text || clock_timestamp()::text || o.id::text)::uuid, o.course_id, ?, o.statement, o.normalized_statement, o.cognitive_level, o.source_kind, o.document_id, o.source_chunk_id, o.section_path, o.page_start, o.page_end
                FROM topic_objectives o WHERE o.topic_id=?
                ON CONFLICT (course_id,topic_id,normalized_statement) DO NOTHING
                """, kept.id, dropped.id);
        jdbc.update("DELETE FROM topic_objectives WHERE topic_id=?", dropped.id);
    }

    private void moveAssessmentLinks(UUID courseId, TopicRow kept, TopicRow dropped) {
        jdbc.update("INSERT INTO assessment_item_topics(item_id,topic_id,relevance) SELECT item_id,?,relevance FROM assessment_item_topics WHERE topic_id=? ON CONFLICT (item_id,topic_id) DO UPDATE SET relevance=GREATEST(assessment_item_topics.relevance,EXCLUDED.relevance)", kept.id, dropped.id);
        jdbc.update("DELETE FROM assessment_item_topics WHERE topic_id=?", dropped.id);
        jdbc.update("UPDATE assessment_items SET topic_id=? WHERE topic_id=?", kept.id, dropped.id);
        jdbc.update("UPDATE assessment_attempts SET topic_id=? WHERE topic_id=?", kept.id, dropped.id);
    }

    private void moveExamSignals(UUID courseId, TopicRow kept, TopicRow dropped) {
        // Fresh ids, same reason as moveObjectives: the source row still exists in this transaction.
        jdbc.update("""
                INSERT INTO exam_topic_signals(id,course_id,topic_id,past_exam_frequency,past_exam_points,homework_frequency,lecture_coverage,syllabus_importance,professor_emphasis,quiz_frequency,recent_lecture_emphasis,topic_centrality,relevance,evidence_confidence,evidence,updated_at)
                SELECT md5(random()::text || clock_timestamp()::text || s.id::text)::uuid, s.course_id, ?, s.past_exam_frequency, s.past_exam_points, s.homework_frequency, s.lecture_coverage, s.syllabus_importance, s.professor_emphasis, s.quiz_frequency, s.recent_lecture_emphasis, s.topic_centrality, s.relevance, s.evidence_confidence, s.evidence, NOW()
                FROM exam_topic_signals s WHERE s.course_id=? AND s.topic_id=?
                ON CONFLICT (course_id,topic_id) DO UPDATE SET relevance=GREATEST(exam_topic_signals.relevance,EXCLUDED.relevance),evidence_confidence=GREATEST(exam_topic_signals.evidence_confidence,EXCLUDED.evidence_confidence),updated_at=NOW()
                """, kept.id, courseId, dropped.id);
        jdbc.update("DELETE FROM exam_topic_signals WHERE course_id=? AND topic_id=?", courseId, dropped.id);
    }

    private void moveSingleColumnReferences(UUID courseId, TopicRow kept, TopicRow dropped) {
        String[][] updates = {
                {"misconceptions", "topic_id"},
                {"learning_events", "topic_id"},
                {"learning_sessions", "topic_id"},
                {"learner_profile_traits", "topic_id"},
                {"tutor_session_steps", "topic_id"},
                {"curriculum_lessons", "topic_id"},
                {"topic_relation_rejections", "source_topic_id"},
                {"topic_relation_rejections", "target_topic_id"},
        };
        for (String[] update : updates) {
            jdbc.update("UPDATE " + update[0] + " SET " + update[1] + "=? WHERE course_id=? AND " + update[1] + "=?", kept.id, courseId, dropped.id);
        }
        // study_tasks carries no course_id of its own; it flows through its plan.
        jdbc.update("UPDATE study_tasks t SET topic_id=? FROM study_plans p WHERE p.id=t.plan_id AND p.course_id=? AND t.topic_id=?", kept.id, courseId, dropped.id);
    }

    private void moveLadderState(UUID courseId, TopicRow kept, TopicRow dropped) {
        jdbc.update("UPDATE topic_ladder_state SET remediation_topic_id=NULL WHERE course_id=? AND remediation_topic_id=? AND topic_id=?", courseId, dropped.id, kept.id);
        jdbc.update("UPDATE topic_ladder_state SET remediation_topic_id=? WHERE course_id=? AND remediation_topic_id=?", kept.id, courseId, dropped.id);
        jdbc.update("INSERT INTO topic_ladder_state(course_id,topic_id,level,return_level,consecutive_success,consecutive_failure,attempts,diagnostic_pending,remediation_topic_id,last_action,last_reason,updated_at) SELECT course_id,?,level,return_level,consecutive_success,consecutive_failure,attempts,diagnostic_pending,remediation_topic_id,last_action,last_reason,updated_at FROM topic_ladder_state WHERE course_id=? AND topic_id=? ON CONFLICT (course_id,topic_id) DO NOTHING", kept.id, courseId, dropped.id);
        jdbc.update("DELETE FROM topic_ladder_state WHERE course_id=? AND topic_id=?", courseId, dropped.id);
    }

    private String stageJson(TopicReconciliationCore.Verdict verdict) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("lexical", verdict.lexicalScore());
        payload.put("embedding", verdict.embeddingScore());
        payload.put("contextOverlap", verdict.sourceOverlap());
        List<Map<String, Object>> stages = new ArrayList<>();
        for (TopicReconciliationCore.StageResult stage : verdict.stages()) {
            stages.add(Map.of("stage", stage.stage(), "score", stage.score(), "matched", stage.matched(), "detail", stage.detail()));
        }
        payload.put("stages", stages);
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(payload);
        } catch (Exception error) {
            return "{}";
        }
    }

    private List<TopicRow> canonicalTopics(UUID courseId) {
        return jdbc.query("SELECT id,canonical_name,normalized_name,description,embedding::text AS embedding FROM topics WHERE course_id=? AND canonical_topic_id IS NULL ORDER BY canonical_name",
                (rs, row) -> new TopicRow(rs.getObject("id", UUID.class), rs.getString("canonical_name"), rs.getString("normalized_name"), rs.getString("description"), rs.getString("embedding")), courseId);
    }

    private Map<UUID, List<String>> aliases(UUID courseId) {
        Map<UUID, List<String>> result = new HashMap<>();
        jdbc.query("SELECT topic_id,alias FROM topic_aliases WHERE course_id=?", rs -> {
            while (rs.next()) result.computeIfAbsent(rs.getObject("topic_id", UUID.class), key -> new ArrayList<>()).add(rs.getString("alias"));
            return null;
        }, courseId);
        return result;
    }

    private List<ScoredPair> candidatePairs(List<TopicRow> topics, Map<UUID, float[]> vectors) {
        List<ScoredPair> pairs = new ArrayList<>();
        for (int left = 0; left < topics.size(); left++) {
            TopicRow first = topics.get(left);
            for (int right = left + 1; right < topics.size(); right++) {
                TopicRow second = topics.get(right);
                double score = pairScore(first, second, vectors);
                if (score >= VECTOR_MIN_SIMILARITY || TopicReconciliationCore.lexicalSimilarity(first.name, second.name) >= TopicReconciliationCore.LEXICAL_FLOOR) {
                    pairs.add(new ScoredPair(first, second, score));
                }
            }
        }
        return pairs;
    }

    private double pairScore(TopicRow first, TopicRow second, Map<UUID, float[]> vectors) {
        float[] leftVector = vectors.get(first.id());
        float[] rightVector = vectors.get(second.id());
        return leftVector == null || rightVector == null ? 0 : TopicReconciliationCore.cosine(leftVector, rightVector);
    }

    /** Top terms of each candidate topic's supporting chunks, for the context stage. */
    private Map<UUID, Set<String>> contextTerms(java.util.Collection<TopicRow> topics) {
        Map<UUID, Set<String>> result = new HashMap<>();
        List<UUID> ids = topics.stream().map(topic -> topic.id).limit(60).toList();
        if (ids.isEmpty()) return result;
        for (UUID topicId : ids) {
            List<String> snippets = jdbc.query("SELECT c.content FROM chunk_topics ct JOIN chunks c ON c.id=ct.chunk_id WHERE ct.topic_id=? ORDER BY ct.relevance DESC LIMIT 2", (rs, row) -> rs.getString(1), topicId);
            StringBuilder text = new StringBuilder();
            for (String snippet : snippets) text.append(snippet, 0, Math.min(snippet.length(), 1200)).append(' ');
            result.put(topicId, TopicReconciliationCore.contextTerms(text.toString(), 40));
        }
        return result;
    }

    static float[] parseVector(String text) {
        if (text == null || text.isBlank()) return null;
        String trimmed = text.trim();
        if (trimmed.startsWith("[")) trimmed = trimmed.substring(1);
        if (trimmed.endsWith("]")) trimmed = trimmed.substring(0, trimmed.length() - 1);
        String[] parts = trimmed.split(",");
        float[] vector = new float[parts.length];
        try {
            for (int index = 0; index < parts.length; index++) vector[index] = Float.parseFloat(parts[index].trim());
        } catch (NumberFormatException error) {
            return null;
        }
        return vector;
    }

    public record TopicRow(UUID id, String name, String normalized, String description, String embedding) {}

    private record ScoredPair(TopicRow left, TopicRow right, double score) {}

    public record LlmVerdict(String decision, Double confidence, String reason) {
        @JsonCreator public LlmVerdict(@JsonProperty("decision") String decision, @JsonProperty("confidence") Double confidence, @JsonProperty("reason") String reason) {
            this.decision = decision;
            this.confidence = confidence;
            this.reason = reason;
        }
    }
}
