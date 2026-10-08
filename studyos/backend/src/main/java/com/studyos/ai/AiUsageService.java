package com.studyos.ai;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class AiUsageService {
    private final JdbcTemplate jdbc; private final AiUsageProperties properties;
    public AiUsageService(JdbcTemplate jdbc, AiUsageProperties properties) { this.jdbc = jdbc; this.properties = properties; }
    public void record(AiOperation operation, AiResult<?> result, UUID courseId, UUID chatId, UUID documentId, long durationMs, boolean success) {
        record(operation,result,courseId,chatId,documentId,durationMs,success,null);
    }
    public void record(AiOperation operation, AiResult<?> result, UUID courseId, UUID chatId, UUID documentId, long durationMs, boolean success, ContextTokenUsage context) {
        record(operation,result,courseId,chatId,documentId,durationMs,success,context,null);
    }
    public void record(AiOperation operation, AiResult<?> result, UUID courseId, UUID chatId, UUID documentId, long durationMs, boolean success, ContextTokenUsage context,Boolean cacheHit) {
        String model = result != null && result.model() != null && !result.model().isBlank() ? result.model() : (operation==AiOperation.EMBEDDING ? properties.getEmbeddingModel() : properties.getChatModel());
        Integer input = result == null ? null : result.inputTokens(); Integer output = result == null ? null : result.outputTokens();
        java.math.BigDecimal cost = estimatedCost(input, output);
        jdbc.update("INSERT INTO ai_usage(id,operation,model,input_tokens,output_tokens,estimated_cost,finish_reason,reasoning_tokens,structured_parse_success,structured_repair_used,duration_ms,course_id,chat_id,document_id,provider,success,cache_hit,course_summary_tokens,memory_tokens,student_state_tokens,chat_history_tokens,forecast_tokens,evidence_tokens,instruction_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", UUID.randomUUID(), operation.name(), model, input, output, cost, result == null ? null : result.finishReason(), result == null ? null : result.reasoningTokens(), result == null ? null : result.structuredParseSuccess(), result == null ? null : result.structuredRepairUsed(), durationMs, courseId, chatId, documentId, properties.getProvider(), success,cacheHit,context==null?null:context.courseSummary(),context==null?null:context.memory(),context==null?null:context.studentState(),context==null?null:context.chatHistory(),context==null?null:context.forecast(),context==null?null:context.evidence(),context==null?null:context.instructions());
    }

    public UsageSummary summary(UUID courseId) {
        var operations = jdbc.query("SELECT operation,COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),COUNT(*),SUM(estimated_cost) FROM ai_usage WHERE course_id=? GROUP BY operation ORDER BY operation", (rs,row) -> new OperationUsage(rs.getString(1),rs.getLong(2),rs.getLong(3),rs.getLong(4),rs.getBigDecimal(5)), courseId);
        Double averageChatInput = jdbc.queryForObject("SELECT AVG(input_tokens) FROM ai_usage WHERE course_id=? AND operation='CHAT' AND input_tokens IS NOT NULL", Double.class, courseId);
        Double averageChatOutput = jdbc.queryForObject("SELECT AVG(output_tokens) FROM ai_usage WHERE course_id=? AND operation='CHAT' AND output_tokens IS NOT NULL", Double.class, courseId);
        var dailyCosts = jdbc.query("SELECT created_at::date,operation,SUM(estimated_cost) FROM ai_usage WHERE course_id=? AND estimated_cost IS NOT NULL GROUP BY created_at::date,operation ORDER BY created_at::date DESC,operation", (rs,row) -> new DailyCost(rs.getObject(1,java.time.LocalDate.class),rs.getString(2),rs.getBigDecimal(3)), courseId);
        var documentUsage = jdbc.query("SELECT d.id,d.name,COALESCE(SUM(u.input_tokens),0),COALESCE(SUM(u.output_tokens),0),SUM(u.estimated_cost) FROM documents d LEFT JOIN ai_usage u ON u.document_id=d.id WHERE d.course_id=? GROUP BY d.id,d.name ORDER BY d.name", (rs,row) -> new DocumentUsage(rs.getObject(1,UUID.class),rs.getString(2),rs.getLong(3),rs.getLong(4),rs.getBigDecimal(5)), courseId);
        StructuredMetrics structured = jdbc.query("SELECT COUNT(*) FILTER (WHERE structured_parse_success IS NOT NULL),COUNT(*) FILTER (WHERE structured_parse_success=TRUE),COUNT(*) FILTER (WHERE structured_parse_success=FALSE),COUNT(*) FILTER (WHERE structured_repair_used=TRUE),COUNT(*) FILTER (WHERE structured_parse_success IS NOT NULL AND finish_reason='length') FROM ai_usage WHERE course_id=?", rs -> { rs.next(); long total=rs.getLong(1),success=rs.getLong(2),failed=rs.getLong(3),repaired=rs.getLong(4),truncated=rs.getLong(5); return new StructuredMetrics(total,success,failed,repaired,truncated,ratio(failed,total),ratio(repaired,total),ratio(truncated,total)); }, courseId);
        CompletionMetrics completion = jdbc.query("SELECT COUNT(*) FILTER (WHERE finish_reason IS NOT NULL),COUNT(*) FILTER (WHERE finish_reason='length') FROM ai_usage WHERE course_id=?",rs->{rs.next();long total=rs.getLong(1),truncated=rs.getLong(2);return new CompletionMetrics(total,truncated,ratio(truncated,total));},courseId);
        var latency = jdbc.query("SELECT operation,AVG(duration_ms),percentile_cont(.95) WITHIN GROUP (ORDER BY duration_ms) FROM ai_usage WHERE course_id=? GROUP BY operation ORDER BY operation", (rs,row) -> new OperationLatency(rs.getString(1),rs.getDouble(2),rs.getDouble(3)), courseId);
        CacheMetrics cache=jdbc.query("SELECT COUNT(*) FILTER(WHERE cache_hit IS NOT NULL),COUNT(*) FILTER(WHERE cache_hit=TRUE) FROM ai_usage WHERE course_id=?",rs->{rs.next();long eligible=rs.getLong(1),hits=rs.getLong(2);return new CacheMetrics(eligible,hits,ratio(hits,eligible));},courseId);
        return new UsageSummary(operations,averageChatInput,averageChatOutput,dailyCosts,documentUsage,structured,completion,latency,cache);
    }
    private java.math.BigDecimal estimatedCost(Integer input, Integer output) {
        if (input == null || output == null || properties.getInputCostPerMillion() == null || properties.getOutputCostPerMillion() == null) return null;
        return java.math.BigDecimal.valueOf(input * properties.getInputCostPerMillion() / 1_000_000d + output * properties.getOutputCostPerMillion() / 1_000_000d);
    }
    private double ratio(long value,long total) { return total == 0 ? 0 : (double)value/total; }
    public record OperationUsage(String operation,long inputTokens,long outputTokens,long requests,java.math.BigDecimal cost) {}
    public record DailyCost(java.time.LocalDate day,String operation,java.math.BigDecimal cost) {}
    public record DocumentUsage(UUID documentId,String documentName,long inputTokens,long outputTokens,java.math.BigDecimal cost) {}
    public record StructuredMetrics(long total,long successful,long failed,long repairUsed,long truncated,double parseFailureRate,double repairRate,double truncationRate) {}
    public record CompletionMetrics(long total,long truncated,double truncationRate) {}
    public record OperationLatency(String operation,double averageMs,double p95Ms) {}
    public record CacheMetrics(long eligibleRequests,long hits,double hitRate) {}
    public record UsageSummary(java.util.List<OperationUsage> byOperation,Double averageChatInputTokens,Double averageChatOutputTokens,java.util.List<DailyCost> costByDay,java.util.List<DocumentUsage> ingestionByDocument,StructuredMetrics structured,CompletionMetrics completion,java.util.List<OperationLatency> latency,CacheMetrics cache) {}
}
