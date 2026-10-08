package com.studyos.memory;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.ai.RequestDeadline;
import com.studyos.retrieval.EmbeddingService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Stores raw chat messages separately and compacts them into episodes that later chats can recall.
 *
 * <p>Two properties matter more than compaction here. Roles are kept apart: each turn is stored as its own
 * record with the role attached, so recall can never hand a later chat the tutor's own earlier claim as
 * something the learner said. And what may be recalled as evidence is decided by an allow-list, so a
 * provenance nobody has taught this class about is withheld rather than quietly treated as course material.
 */
@Service
public class MemoryEpisodeService {
    private static final int CLOSE_AT_TOKENS = 1600;
    /** Ordinary tutoring turns; safe to recall as context in later chats. */
    public static final String CHAT_TURN = "CHAT_TURN";
    /** Model-invented exercises. Kept for transcript replay, never recalled as evidence. */
    public static final String AI_GENERATED_EXERCISE = "AI_GENERATED_EXERCISE";
    /**
     * Allow-list, not a deny-list. Only provenances this class has explicitly cleared are recallable, so
     * adding a new kind of stored turn later cannot silently make it readable as course evidence.
     */
    private static final String EVIDENCE_SAFE = "COALESCE(provenance,'" + CHAT_TURN + "')='" + CHAT_TURN + "'";
    /** A still-open episode has no closed_at, and recall must not rank it as if it had no age at all. */
    private static final String EPISODE_AGE = "COALESCE(closed_at,created_at)";
    private static final String LEARNER = "LEARNER";
    private static final String TUTOR = "TUTOR";
    private final JdbcTemplate jdbc; private final EmbeddingService embeddings; private final ObjectMapper mapper;
    public MemoryEpisodeService(JdbcTemplate jdbc, EmbeddingService embeddings, ObjectMapper mapper) { this.jdbc = jdbc; this.embeddings = embeddings; this.mapper = mapper; }

    public void recordQuestionAnswer(UUID courseId, UUID chatId, UUID userMessageId, UUID assistantMessageId, String question, String answer) {
        recordQuestionAnswer(courseId, chatId, userMessageId, assistantMessageId, question, answer, CHAT_TURN);
    }

    /**
     * Records one turn under an explicit provenance. Model-invented exercises are stored so the chat can be
     * replayed, but {@link #retrieveRelevant} never returns them, so a generated exercise cannot come back
     * later as if it were course evidence.
     */
    public void recordQuestionAnswer(UUID courseId, UUID chatId, UUID userMessageId, UUID assistantMessageId, String question, String answer, String provenance) {
        String origin = provenance == null || provenance.isBlank() ? CHAT_TURN : provenance;
        Episode open = open(courseId, chatId);
        if (open != null && !origin.equals(open.provenance())) { close(courseId, open.id()); open = null; }
        String topic = topicHint(question);
        String turn = "Student asked: " + trim(question, 900) + "\nTutor answered: " + trim(answer, 1300);
        String turnRecords = turnRecords(question, answer);
        int turnTokens = estimateTokens(question) + estimateTokens(answer);
        UUID episodeId;
        int totalTokens;
        if (open == null) {
            episodeId = UUID.randomUUID(); totalTokens = turnTokens;
            jdbc.update("INSERT INTO memory_episodes(id,course_id,chat_id,start_message_id,end_message_id,summary,turns,topics,decisions,unresolved_questions,extracted_events,token_count_original,token_count_summary,status,topic_hint,importance,provenance) VALUES(?,?,?,?,?,?,?::jsonb,?::jsonb,'[]'::jsonb,'[]'::jsonb,?::jsonb,?,?, 'OPEN',?,?,?)", episodeId, courseId, chatId, userMessageId, assistantMessageId, turn, turnRecords, jsonArray(topic), jsonArray("QUESTION: " + trim(question, 300)), totalTokens, estimateTokens(turn), topic, importance(question), origin);
        } else {
            episodeId = open.id(); totalTokens = open.tokens() + turnTokens;
            String summary = trim(open.summary() + "\n\n" + turn, 5500);
            jdbc.update("UPDATE memory_episodes SET end_message_id=?,summary=?,turns=turns||?::jsonb,token_count_original=?,token_count_summary=?,importance=GREATEST(importance,?),topic_hint=COALESCE(topic_hint,?) WHERE id=?", assistantMessageId, summary, turnRecords, totalTokens, estimateTokens(summary), importance(question), topic, episodeId);
        }
        boolean checkpoint = lower(question).contains("checkpoint") || lower(question).contains("assessment complete");
        boolean shifted = open != null && open.topicHint() != null && !topic.equals(open.topicHint()) && question != null && question.length() > 40;
        if (totalTokens >= CLOSE_AT_TOKENS || checkpoint || shifted) close(courseId, episodeId);
        else refreshEmbedding(courseId, episodeId);
        upsertChatSummary(courseId, chatId);
    }

    private Episode open(UUID courseId, UUID chatId) {
        return jdbc.query("SELECT id,summary,token_count_original,topic_hint,COALESCE(provenance,'" + CHAT_TURN + "') FROM memory_episodes WHERE course_id=? AND chat_id=? AND status='OPEN' ORDER BY created_at DESC LIMIT 1", rs -> rs.next() ? new Episode(rs.getObject(1, UUID.class), rs.getString(2), rs.getInt(3), rs.getString(4), rs.getString(5)) : null, courseId, chatId);
    }
    private void close(UUID courseId, UUID id) {
        jdbc.update("UPDATE memory_episodes SET status='CLOSED',closed_at=NOW() WHERE id=? AND status='OPEN'", id);
        refreshEmbedding(courseId, id);
    }
    /**
     * Keeps an episode's embedding current. This runs on every turn rather than only when an episode closes:
     * an episode closes after roughly {@value #CLOSE_AT_TOKENS} tokens or a topic shift, so embedding only at
     * close left the great majority of stored memory with no vector and therefore unreachable by recall.
     * Failure is tolerated — the text is already durable, and the keyword fallback still finds the episode.
     */
    private void refreshEmbedding(UUID courseId, UUID id) {
        if (RequestDeadline.spent()) return;
        try {
            String summary = jdbc.query("SELECT summary FROM memory_episodes WHERE id=?", rs -> rs.next() ? rs.getString(1) : "", id);
            if (summary == null || summary.isBlank()) return;
            jdbc.update("UPDATE memory_episodes SET embedding=CAST(? AS vector) WHERE id=?", vectorLiteral(embeddings.embedPassage(courseId, null, summary)), id);
        } catch (RuntimeException ignored) {
            // The deterministic summary and raw messages are already durable; the embedding is retried next turn.
        }
    }
    /**
     * Recalls episodes from other chats, rendered with the learner's words and the tutor's earlier output
     * under separate headings. Open episodes are included: waiting for an episode to close made most of a
     * workspace's memory unreachable, and being mid-episode says nothing about whether it is relevant.
     */
    public List<String> retrieveRelevant(UUID courseId, UUID currentChatId, String query, int limit) {
        String selection = "SELECT turns,summary,topic_hint," + EPISODE_AGE + " FROM memory_episodes WHERE course_id=? AND " + EVIDENCE_SAFE + " AND (chat_id<>? OR chat_id IS NULL)";
        try {
            String vector = vectorLiteral(embeddings.embed(courseId, null, query));
            return jdbc.query(selection + " AND embedding IS NOT NULL ORDER BY (.70*(1-(embedding <=> CAST(? AS vector))) + .20*importance + .10*EXP(-EXTRACT(EPOCH FROM (NOW()-" + EPISODE_AGE + "))/2592000.0)) DESC LIMIT ?", (rs,row) -> render(rs.getString(1), rs.getString(2), rs.getString(3)), courseId, currentChatId, vector, limit);
        } catch (RuntimeException ignored) {
            return jdbc.query(selection + " ORDER BY importance DESC," + EPISODE_AGE + " DESC LIMIT ?", (rs,row) -> render(rs.getString(1), rs.getString(2), rs.getString(3)), courseId, currentChatId, limit);
        }
    }
    private void upsertChatSummary(UUID courseId, UUID chatId) {
        List<String> episodes = jdbc.query("SELECT turns,summary,topic_hint FROM memory_episodes WHERE course_id=? AND chat_id=? AND status='CLOSED' AND " + EVIDENCE_SAFE + " ORDER BY closed_at DESC LIMIT 12", (rs,row) -> render(rs.getString(1), rs.getString(2), rs.getString(3)), courseId, chatId);
        if (episodes.isEmpty()) return;
        StringBuilder summary = new StringBuilder("Closed conversation memory:\n");
        for (int i=episodes.size()-1; i>=0; i--) { String item=episodes.get(i); if (summary.length()+item.length()+2>6000) break; summary.append(item).append("\n\n"); }
        jdbc.update("INSERT INTO chat_summaries(id,course_id,chat_id,summary,covered_through,token_count_original,token_count_summary) VALUES(?,?,?,? ,NOW(),?,?) ON CONFLICT(chat_id) DO UPDATE SET summary=EXCLUDED.summary,covered_through=EXCLUDED.covered_through,token_count_original=EXCLUDED.token_count_original,token_count_summary=EXCLUDED.token_count_summary,updated_at=NOW()", UUID.randomUUID(), courseId, chatId, summary.toString().trim(), episodes.size()*1200, estimateTokens(summary.toString()));
    }

    /** One turn as two role-tagged records, so nothing downstream has to recover the roles from prose. */
    String turnRecords(String question, String answer) {
        var records = mapper.createArrayNode();
        records.addObject().put("role", LEARNER).put("text", trim(question, 900));
        records.addObject().put("role", TUTOR).put("text", trim(answer, 1300));
        return records.toString();
    }

    /**
     * Renders an episode for a prompt. The learner's words are quoted as evidence about the learner; the
     * tutor's earlier output is labelled as this assistant's own unverified prior text, because recalling it
     * as if it were course material is what let one chat's mistake be read back as the learner's mistake.
     * Episodes written before roles were separated have no records and are rendered without attribution.
     */
    String render(String turnsJson, String summary, String topicHint) {
        List<String> learner = new ArrayList<>(); List<String> tutor = new ArrayList<>();
        try {
            JsonNode records = turnsJson == null || turnsJson.isBlank() ? mapper.createArrayNode() : mapper.readTree(turnsJson);
            for (JsonNode record : records) {
                String text = record.path("text").asText("").trim();
                if (text.isEmpty()) continue;
                if (TUTOR.equals(record.path("role").asText())) tutor.add(text); else learner.add(text);
            }
        } catch (Exception ignored) {
            // Unreadable records fall back to the prose summary below rather than losing the episode.
        }
        if (learner.isEmpty() && tutor.isEmpty()) return "Earlier conversation (roles not recorded, attribute nothing in it to the learner): " + trim(summary, 1200);
        StringBuilder result = new StringBuilder("Earlier conversation");
        if (topicHint != null && !topicHint.isBlank()) result.append(" about ").append(trim(topicHint, 80));
        result.append(":\n");
        if (!learner.isEmpty()) result.append("  The learner wrote: ").append(quoted(learner, 700)).append('\n');
        if (!tutor.isEmpty()) result.append("  You answered then (your own earlier output, not course evidence, and possibly wrong): ").append(quoted(tutor, 500)).append('\n');
        return result.toString();
    }
    private String quoted(List<String> values, int perValue) {
        List<String> quoted = new ArrayList<>();
        for (String value : values) quoted.add("\"" + trim(value, perValue).replace('\n', ' ') + "\"");
        return String.join("; ", quoted);
    }

    private String topicHint(String value) { String normalized=lower(value).replaceAll("[^a-z0-9 ]", " ").replaceAll("\\s+", " ").trim(); return normalized.length()<=80?normalized:normalized.substring(0,80); }
    private String lower(String value) { return value == null ? "" : value.toLowerCase(Locale.ROOT); }
    private double importance(String value) { String text=lower(value); return text.contains("mistake")||text.contains("wrong")||text.contains("exam")||text.contains("score") ? 1 : .2; }
    private int estimateTokens(String value) { return Math.max(1, value == null ? 0 : value.length() / 4); }
    private String trim(String value, int max) { if (value == null) return ""; return value.length() <= max ? value : value.substring(0, max) + "..."; }
    /** Built through the mapper so a value containing a newline or quote cannot produce invalid JSON. */
    String jsonArray(String value) { var array=mapper.createArrayNode(); array.add(value==null?"":value); return array.toString(); }
    private String vectorLiteral(float[] vector) { StringBuilder result = new StringBuilder("["); for (int i=0;i<vector.length;i++) { if (i>0) result.append(','); result.append(vector[i]); } return result.append(']').toString(); }
    private record Episode(UUID id,String summary,int tokens,String topicHint,String provenance) { private Episode { provenance = provenance == null ? CHAT_TURN : provenance; } }
}
