package com.studyos.knowledge;

import com.studyos.ai.AiGateway;
import com.studyos.ai.AiResult;
import com.studyos.ai.AiUsageService;
import com.studyos.ai.AiOperation;
import com.studyos.ai.GenerationPolicyRegistry;
import com.studyos.ai.StructuredGenerationException;
import com.studyos.ingestion.Chunk;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Async;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import com.studyos.summary.SummaryService;

@Service
public class TopicExtractionService {
    private static final Logger log = LoggerFactory.getLogger(TopicExtractionService.class);
    private final AiGateway ai; private final JdbcTemplate jdbc; private final boolean enabled; private final SummaryService summaries; private final TopicRelationService relations; private final AiUsageService usage; private final GenerationPolicyRegistry policies; private final TopicRegistry registry; private final TopicObjectiveService objectives; private final TopicModelService model; private final TopicReconciliationService reconciliation;
    private final ConcurrentMap<UUID, RebuildStatus> rebuilds = new ConcurrentHashMap<>();
    public TopicExtractionService(AiGateway ai, JdbcTemplate jdbc, SummaryService summaries, TopicRelationService relations, AiUsageService usage, GenerationPolicyRegistry policies, TopicRegistry registry, TopicObjectiveService objectives, TopicModelService model, TopicReconciliationService reconciliation, @Value("${studyos.ai.topic-extraction:false}") boolean enabled) { this.ai=ai;this.jdbc=jdbc;this.summaries=summaries;this.relations=relations;this.usage=usage;this.policies=policies;this.registry=registry;this.objectives=objectives;this.model=model;this.reconciliation=reconciliation;this.enabled=enabled; }

    public void extract(UUID courseId, List<Chunk> chunks) {
        if (chunks.isEmpty()) return;
        for (int start=0; start<chunks.size(); start+=8) {
            List<Chunk> batch=chunks.subList(start,Math.min(start+8,chunks.size())); StringBuilder prompt=new StringBuilder("Extract the important academic topics from these course passages. Return JSON only with a topics array. Each topic needs name, description, relevance from 0 to 1, aliases, and chunkIds containing only the UUIDs of passages that directly support that topic. Do not invent chunk IDs.\n");
            for (Chunk chunk:batch) prompt.append("CHUNK ").append(chunk.id()).append(" pages ").append(chunk.pageStart()).append('-').append(chunk.pageEnd()).append("\n").append(trim(chunk.content(),1800)).append("\n\n");
            for (Chunk chunk:batch) for (TopicCandidate candidate:localCandidates(chunk)) upsert(courseId,List.of(chunk),candidate);
            if (!enabled) continue;
            long started=System.nanoTime(); AiResult<TopicResponse> aiResult=null; boolean success=false;
            try { aiResult=ai.generateStructuredResult("You extract canonical course topics. Do not invent topics not supported by the passages. Return at most 12 topics for this batch.",prompt.toString(),TopicResponse.class,policies.policy(AiOperation.TOPIC_EXTRACTION)); TopicResponse response=aiResult.value(); success=true; for (TopicCandidate candidate:response.topics()) upsert(courseId,batch,candidate); } catch (RuntimeException error) { if(error instanceof StructuredGenerationException structured) aiResult=structured.telemetryResult(); log.warn("AI topic enrichment failed for course {} batch {}-{}; local topics retained: {}",courseId,start,Math.min(start+8,chunks.size()),safeMessage(error)); } finally { usage.record(AiOperation.TOPIC_EXTRACTION,aiResult,courseId,null,null,(System.nanoTime()-started)/1_000_000,success); }
        }
        relations.extract(courseId, chunks);
        // Late-arriving material: anything a fresh passage just named gets compared against the
        // topics the workspace already knows before the duplicate can spread into mastery,
        // prerequisites and exam signals.
        try { reconciliation.reconcileUnbound(courseId); } catch (RuntimeException error) { log.warn("Topic reconciliation after extraction failed for course {}: {}", courseId, safeMessage(error)); }
    }

    @Async("ingestionExecutor")
    public void rebuild(UUID courseId) {
        rebuilds.put(courseId,new RebuildStatus("QUEUED",0,0,null));
        int totalBatches = 0;
        try {
            removeUnassessedTopics(courseId);
            List<Chunk> chunks = jdbc.query("SELECT id,ordinal,page_start,page_end,content,COALESCE(token_count,0) AS token_count FROM chunks WHERE course_id=? ORDER BY document_id,ordinal", (rs,row) -> new Chunk(rs.getObject("id",UUID.class),rs.getInt("ordinal"),rs.getInt("page_start"),rs.getInt("page_end"),rs.getString("content"),rs.getInt("token_count")), courseId);
            totalBatches = (chunks.size()+7)/8;
            rebuilds.put(courseId,new RebuildStatus("RUNNING",0,totalBatches,null));
            for (int start=0; start<chunks.size(); start+=8) {
                extract(courseId,chunks.subList(start,Math.min(start+8,chunks.size())));
                rebuilds.put(courseId,new RebuildStatus("RUNNING",Math.min((start/8)+1,totalBatches),totalBatches,null));
            }
            relations.rebuild(courseId);
            // Once per rebuild, not once per batch: both read the whole workspace, and the topic set is only
            // settled after the last batch and the relation pass that follows it.
            objectives.rebuild(courseId);
            model.rebuild(courseId);
            rebuilds.put(courseId,new RebuildStatus("COMPLETED",totalBatches,totalBatches,null));
            summaries.rebuild(courseId);
        } catch (RuntimeException error) {
            log.error("Topic rebuild failed for course {}",courseId,error);
            rebuilds.put(courseId,new RebuildStatus("FAILED",0,totalBatches,safeMessage(error)));
        }
    }

    public RebuildStatus rebuildStatus(UUID courseId) {
        RebuildStatus status = rebuilds.get(courseId);
        if (status != null) return status;
        Integer chunks = jdbc.queryForObject("SELECT COUNT(*) FROM chunks WHERE course_id=?",Integer.class,courseId);
        Integer topics = jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE course_id=?",Integer.class,courseId);
        return new RebuildStatus(topics != null && topics > 0 ? "COMPLETED" : "NOT_STARTED",0,(chunks == null ? 0 : (chunks+7)/8),null);
    }

    private void upsert(UUID courseId,List<Chunk> batch,TopicCandidate candidate) {
        if (candidate==null || candidate.name()==null || candidate.name().isBlank()) return;
        // The quality gate is the funnel: local signal candidates and AI-proposed candidates face the
        // same structural rules, and a rejection is audited rather than silently dropped.
        TopicCandidateQuality.Decision decision = TopicCandidateQuality.evaluate(candidate.name());
        if (!decision.accepted()) { audit(courseId, candidate.name(), decision, "EXTRACTION"); return; }
        String admittedName = decision.salvaged() != null ? decision.salvaged() : candidate.name().trim();
        String normalized=normalize(admittedName); UUID topic=registry.resolveOrCreate(courseId,admittedName,candidate.description());
        if (topic==null) return;
        for (String alias:candidate.aliases()==null?List.<String>of():candidate.aliases()) { TopicCandidateQuality.Decision aliasDecision=TopicCandidateQuality.evaluate(alias); if(!aliasDecision.accepted()) { audit(courseId,alias,aliasDecision,"EXTRACTION"); continue; } if(!normalize(alias).equals(normalized)) registry.alias(courseId,topic,aliasDecision.salvaged()!=null?aliasDecision.salvaged():alias); }
        Set<UUID> batchIds = batch.stream().map(Chunk::id).collect(java.util.stream.Collectors.toSet());
        List<UUID> supportedChunks = candidate.chunkIds()==null ? List.of() : candidate.chunkIds().stream().filter(batchIds::contains).distinct().toList();
        for (UUID chunkId:supportedChunks) jdbc.update("INSERT INTO chunk_topics(chunk_id,topic_id,relevance) VALUES(?,?,?) ON CONFLICT(chunk_id,topic_id) DO UPDATE SET relevance=EXCLUDED.relevance",chunkId,topic,Math.max(0,Math.min(1,candidate.relevance())));
    }

    /** Durable, idempotent rejection/decision record for the diagnostics surface. */
    private void audit(UUID courseId,String candidate,TopicCandidateQuality.Decision decision,String source) {
        try {
            String normalized=normalize(candidate);
            if (normalized.isBlank()) return;
            jdbc.update("""
                INSERT INTO topic_extraction_audit(id,course_id,normalized_candidate,sample,source,decision,reason,quality_score,extraction_version)
                VALUES(?,?,?,?,?,?,?,?,?)
                ON CONFLICT(course_id,normalized_candidate,source) DO UPDATE SET
                    occurrences=topic_extraction_audit.occurrences+1, last_seen_at=NOW()
                """, UUID.randomUUID(), courseId, normalized, candidate.length()>500?candidate.substring(0,500):candidate,
                source, decision.accepted()?"ACCEPTED":"REJECTED", decision.reason().name(), decision.qualityScore(), TopicCandidateQuality.VERSION);
        } catch (RuntimeException error) { log.warn("Topic quality audit write failed for course {}: {}", courseId, safeMessage(error)); }
    }
    /**
     * Local, provider-free candidates. Grounded entirely in how the passage is written — headings,
     * definition wording, emphasis, repetition — so a course in any subject gets the same treatment.
     * Ungated collection: admission happens in the funnel, where rejections are audited.
     */
    private List<TopicCandidate> localCandidates(Chunk chunk) {
        return TopicSignalExtractor.collectUngated(chunk.content(), 12).stream()
                .map(candidate -> new TopicCandidate(candidate.name(), describe(candidate.signal()), candidate.confidence(), List.of(), List.of(chunk.id())))
                .toList();
    }
    private String describe(TopicSignalExtractor.Signal signal) {
        return switch (signal) {
            case DEFINITION -> "Defined in the uploaded course material.";
            case HEADING -> "Section heading found in the uploaded course material.";
            case EMPHASIS -> "Emphasised in the uploaded course material.";
            case REPEATED_TERM -> "Recurring term in the uploaded course material.";
        };
    }
    private void removeUnassessedTopics(UUID courseId) {
        // Merged-away topics keep no chunk binding on purpose (their evidence moved to the canonical
        // topic), so the garbage collector must never treat a redirect row as an orphan.
        jdbc.update("DELETE FROM chunk_topics WHERE topic_id IN (SELECT t.id FROM topics t WHERE t.course_id=? AND t.canonical_topic_id IS NULL AND NOT EXISTS (SELECT 1 FROM student_topic_state s WHERE s.topic_id=t.id) AND NOT EXISTS (SELECT 1 FROM learning_events e WHERE e.topic_id=t.id))",courseId);
        jdbc.update("DELETE FROM topic_aliases WHERE course_id=? AND topic_id NOT IN (SELECT topic_id FROM chunk_topics) AND topic_id IN (SELECT id FROM topics WHERE course_id=? AND canonical_topic_id IS NULL)",courseId,courseId);
        jdbc.update("DELETE FROM topic_edges WHERE course_id=? AND (source_topic_id NOT IN (SELECT topic_id FROM chunk_topics) OR target_topic_id NOT IN (SELECT topic_id FROM chunk_topics))",courseId);
        jdbc.update("DELETE FROM topics WHERE course_id=? AND canonical_topic_id IS NULL AND NOT EXISTS (SELECT 1 FROM student_topic_state s WHERE s.topic_id=topics.id) AND NOT EXISTS (SELECT 1 FROM learning_events e WHERE e.topic_id=topics.id) AND NOT EXISTS (SELECT 1 FROM chunk_topics c WHERE c.topic_id=topics.id)",courseId);
    }
    private String normalize(String value) { return TopicRegistry.normalize(value); }
    private String trim(String value,int max) { return value.length()<=max?value:value.substring(0,max); }
    private String safeMessage(Throwable error) { String message=error.getMessage(); return message==null?error.getClass().getSimpleName():trim(message,500); }
    public record TopicResponse(List<TopicCandidate> topics) { @JsonCreator public TopicResponse(@JsonProperty("topics") List<TopicCandidate> topics){this.topics=topics==null?List.of():topics;} }
    public record TopicCandidate(String name,String description,double relevance,List<String> aliases,List<UUID> chunkIds) {}
    public record RebuildStatus(String status,int completedBatches,int totalBatches,String error) {}
}
