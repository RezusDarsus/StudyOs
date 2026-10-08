package com.studyos.chat;

import com.studyos.memory.TokenBudgetManager;
import com.studyos.memory.MemoryEpisodeService;
import com.studyos.learner.LearnerProfileService;
import com.studyos.prediction.PredictionService;
import com.studyos.retrieval.HybridRetriever;
import com.studyos.summary.SummaryService;
import com.studyos.ai.ContextTokenUsage;
import java.util.List;
import java.util.UUID;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class ContextBuilder {
    /** Ceiling on the learner-profile digest, so a long-lived workspace cannot crowd out evidence. */
    private static final int LEARNER_PROFILE_TOKENS = 500;
    /**
     * Says out loud what a missing figure means. Mastery used to be rendered through {@code COALESCE(...,0)},
     * which turned "never assessed" into the affirmative claim "mastery 0%" for every topic the learner had
     * simply not been tested on yet, and answers then reported that absence back as a measured weakness.
     */
    private static final String TOPIC_STATE_HEADING = "Relevant student state (figures come from recorded attempts only; \"not yet assessed\" means there is no evidence either way and must never be reported as a low score; \"mastery\" is the average over everything attempted, while \"recall now\" is the probability they could answer today given how long it has been, so use recall for readiness and what to review):\n";

    private final HybridRetriever retriever;
    private final JdbcTemplate jdbc;
    private final TokenBudgetManager budget;
    private final PredictionService predictions;
    private final SummaryService summaries;
    private final MemoryEpisodeService memoryEpisodes;
    private final ContextPolicyRegistry policies;
    private final LearnerProfileService learnerProfile;
    private final com.studyos.learner.LearnerEvidence learnerEvidence;

    public ContextBuilder(HybridRetriever retriever, JdbcTemplate jdbc, TokenBudgetManager budget, PredictionService predictions, SummaryService summaries, MemoryEpisodeService memoryEpisodes, ContextPolicyRegistry policies, LearnerProfileService learnerProfile, com.studyos.learner.LearnerEvidence learnerEvidence) {
        this.retriever = retriever;
        this.jdbc = jdbc;
        this.budget = budget;
        this.predictions = predictions;
        this.summaries = summaries;
        this.memoryEpisodes = memoryEpisodes;
        this.policies = policies;
        this.learnerProfile = learnerProfile;
        this.learnerEvidence = learnerEvidence;
    }

    public String build(UUID courseId, UUID chatId, String query, QueryIntent intent) {
        return buildDetailed(courseId,chatId,query,intent).context();
    }

    public BuildResult buildDetailed(UUID courseId, UUID chatId, String query, QueryIntent intent) {
        ContextProfile profile = policies.profile(intent);
        Evidence retrieved = profile.evidenceChunks() == 0 ? Evidence.none() : evidence(courseId,query,profile.evidenceChunks(),profile.evidenceTokenBudget());
        String evidence = retrieved.block();
        String task = switch (intent) {
            case STUDY_PLAN -> "Use the project state to propose a study plan based on mastery, confidence, review due dates, and predicted risk.";
            case QUIZ_GENERATION -> "Retrieved course evidence:\n" + evidence + "\nGenerate targeted assessment from weak predicted topics and recorded misconceptions.";
            case EXAM_ANALYSIS -> "Retrieved course and exam evidence:\n" + evidence + "\nUse source-type-weighted exam evidence, cite the supplied provenance exactly, and explain confidence.";
            case EXAM_PREDICTION -> "Retrieved course, homework, and past-exam pattern evidence:\n"+evidence+"\nInfer new exercise structures from recurring concepts and examiner patterns. Do not reproduce a retrieved exercise or past-exam question.";
            case HARD_NEW -> "HARD_NEW uses a separately resolved closed source scope. Do not add retrieved evidence, project memory, or later-course material.";
            default -> "Retrieved course evidence:\n" + evidence;
        };
        String course = profile.courseSummary() ? budget.limit(summaries.compact(courseId),700) : "";
        String memory = profile.crossChatMemory() ? projectMemory(courseId,chatId,query) : "";
        String learner = profile.learnerProfile() ? budget.limit(learnerProfile.digest(courseId),LEARNER_PROFILE_TOKENS) : "";
        // Bounded by row count and per-row length rather than by the token budget: truncating this block mid-line
        // would leave a half-written handle in the prompt, and a handle that resolves to nothing is exactly the
        // failure it was added to prevent.
        String record = profile.learnerProfile() ? learnerEvidence.block(courseId) : "";
        String state = profile.topicState() ? topicState(courseId,query,profile.forecast(),profile.misconceptions()) : "";
        String history = chatContext(courseId,chatId,profile.recentMessages(),profile.crossChatMemory());
        String forecast = profile.forecast() ? "Predicted project state:\n"+predictions.forecast(courseId).compact()+"\n" : "";
        StringBuilder context = new StringBuilder();
        append(context,course); append(context,memory); append(context,learner); append(context,record); append(context,state); append(context,history); append(context,forecast); context.append(task);
        String sourceVersion=hash(String.join("|",jdbc.query("SELECT COALESCE(content_hash,'') FROM documents WHERE course_id=? AND status='COMPLETED' ORDER BY id",(rs,row)->rs.getString(1),courseId)));
        return new BuildResult(context.toString(),new ContextTokenUsage(budget.estimate(course),budget.estimate(memory),budget.estimate(learner)+budget.estimate(record)+budget.estimate(state),budget.estimate(history),budget.estimate(forecast),budget.estimate(evidence),budget.estimate(task)),hash(evidence),sourceVersion,hash(learner+record+state),evidence,record,retrieved.passages());
    }

    /**
     * The evidence block, verbatim source text under the provenance the citation checker will hold the answer
     * to. The section trail goes on its own line rather than inside the bracket: it is useful for the model to
     * know where in the document a passage sits, and putting it inside the citation would make it something
     * answers copy into their references and the checker then has to parse around.
     *
     * <p>One block per passage rather than per retrieved chunk: a section that matched several times arrives as
     * one stretch of its text under one header, each hit carries the chunk either side of it, and the budget
     * drops whole passages instead of cutting the last one mid-word. That last point is why this is not simply
     * {@code budget.limit} of the assembled string — a cut block still carried the page range of the text that
     * had been cut away, so an answer could cite a page the model was never shown.
     */
    private Evidence evidence(UUID courseId, String query, int retrievalLimit, int tokenLimit) {
        var assembly = retriever.assemble(courseId, query, retrievalLimit, tokenLimit);
        if (assembly.passages().isEmpty()) return new Evidence("(no matching course evidence)", List.of());
        StringBuilder result = new StringBuilder();
        for (var passage : assembly.passages()) {
            result.append("[Source: ").append(passage.documentName()).append("; pages ").append(passage.pageStart()).append('-').append(passage.pageEnd()).append("]\n");
            if (!passage.sectionPath().isBlank()) result.append("Section: ").append(passage.sectionPath()).append('\n');
            // Said where the model can see it, not stored in a side table: an answer that presents a
            // researched web page as the learner's own course material is the exact failure the
            // research provenance exists to prevent, and the model is the last place it can be caught.
            if (passage.external()) result.append("Origin: external web source, retrieved by StudyOS research — not part of the uploaded course material.\n");
            result.append(passage.content()).append("\n\n");
        }
        // Said rather than hidden: evidence that was found and left out for room is a different situation from
        // evidence that does not exist, and only one of them means the answer should hedge.
        if (assembly.droppedToBudget() > 0) result.append("(").append(assembly.droppedToBudget()).append(" further matching passage(s) omitted for space; say so if the answer needs them.)\n");
        return new Evidence(result.toString(), assembly.passages());
    }

    /**
     * The evidence block and the passages it was rendered from, kept together because they must not drift: the
     * block is what the model is shown, and the passages are the record of which chunks that block came from.
     * Provenance is stored against the passages, so a block built from one list and attributed to another would
     * put a chunk id behind a claim that was never written from it.
     *
     * @param passages empty for a turn that retrieved nothing <em>and</em> for one whose profile retrieves nothing
     *     by design. The two are told apart by {@code block}, which carries the "no matching course evidence"
     *     placeholder in the first case and is empty in the second.
     */
    private record Evidence(String block, List<com.studyos.retrieval.PassageAssembler.Passage> passages) {
        static Evidence none() { return new Evidence("", List.of()); }
    }

    private String projectMemory(UUID courseId, UUID chatId, String query) {
        String episodes = String.join("\n", memoryEpisodes.retrieveRelevant(courseId, chatId, query, 6));
        String events = jdbc.query("SELECT event_type,(payload - 'predictionVerification')::text AS payload FROM learning_events WHERE course_id=? ORDER BY occurred_at DESC LIMIT 12", rs -> {
            StringBuilder result = new StringBuilder();
            while (rs.next()) result.append("- ").append(rs.getString("event_type")).append(": ").append(rs.getString("payload")).append("\n");
            return result.toString();
        }, courseId);
        String preferences=String.join("\n",jdbc.query("SELECT preference_key,preference_value FROM workspace_preferences WHERE course_id=? ORDER BY preference_key",(rs,row)->"- "+rs.getString(1)+": "+rs.getString(2),courseId));
        return "Persistent project memory from other chats:\n" + (episodes.isBlank() ? "(none yet)\n" : budget.limit(episodes, 1800)) + "Recent learning events:\n" + (events.isBlank() ? "(none yet)\n" : budget.limit(events, 700))+"\nLearner preferences (adapt presentation, never alter source truth):\n"+(preferences.isBlank()?"(none)\n":budget.limit(preferences,400));
    }

    private String chatContext(UUID courseId, UUID chatId, int limit, boolean includeSummary) {
        String summary = includeSummary ? jdbc.query("SELECT summary FROM chat_summaries WHERE course_id=? AND chat_id=?", rs -> rs.next() ? rs.getString(1) : "", courseId, chatId) : "";
        List<String> recent = jdbc.query("SELECT role,content FROM messages WHERE chat_id=? ORDER BY created_at DESC LIMIT ?", (rs,row) -> rs.getString("role")+": "+rs.getString("content"), chatId, limit);
        StringBuilder result = new StringBuilder("Current chat memory:\n");
        if (summary != null && !summary.isBlank()) result.append(budget.limit(summary,1800)).append("\n");
        if (!recent.isEmpty()) { result.append("Recent messages:\n"); for (int i=recent.size()-1;i>=0;i--) result.append(recent.get(i)).append("\n"); }
        return result.append("\n").toString();
    }

    private String topicState(UUID courseId,String query,boolean allTopics,boolean includeMisconceptions) {
        String sql = "SELECT t.canonical_name,COALESCE(s.measured_mastery,s.mastery),s.confidence,es.relevance,s.learned_probability,s.stability_days,s.last_assessed_at,s.review_due_at FROM topics t LEFT JOIN student_topic_state s ON s.course_id=t.course_id AND s.topic_id=t.id LEFT JOIN exam_topic_signals es ON es.course_id=t.course_id AND es.topic_id=t.id WHERE t.course_id=?" + (allTopics ? " ORDER BY COALESCE(es.relevance,0) DESC LIMIT 12" : " AND LOWER(?) LIKE '%'||LOWER(t.canonical_name)||'%' ORDER BY COALESCE(es.relevance,0) DESC LIMIT 3");
        List<String> rows = allTopics ? jdbc.query(sql,(rs,row)->topicStateRow(rs),courseId) : jdbc.query(sql,(rs,row)->topicStateRow(rs),courseId,query);
        StringBuilder result=new StringBuilder(); if(!rows.isEmpty())result.append(TOPIC_STATE_HEADING).append(String.join("\n",rows)).append('\n');
        if(includeMisconceptions){ List<String> mistakes=jdbc.query("SELECT label,severity FROM misconceptions WHERE course_id=? AND status<>'RESOLVED' ORDER BY severity DESC LIMIT 6",(rs,row)->String.format(java.util.Locale.ROOT,"- %s (severity %.0f%%)",rs.getString(1),rs.getDouble(2)*100),courseId); if(!mistakes.isEmpty())result.append("Active misconceptions:\n").append(String.join("\n",mistakes)).append('\n'); }
        return result.toString();
    }
    /**
     * Formats one topic row, distinguishing an absent measurement from a measured zero. A topic with no
     * {@code student_topic_state} row has never been assessed; a topic with a row and a mastery of zero has
     * been assessed and failed, and the two must not read the same way in a prompt.
     *
     * <p>The recall figure is the traced knowledge estimate discounted by the forgetting curve the topic's own
     * review history earned, so it answers "could they do this today" — which is the question a plan or a
     * readiness claim actually turns on, and a different question from the mastery average beside it. It is
     * deliberately unfloored: this is a reported probability, not a ranking weight.
     */
    private String topicStateRow(java.sql.ResultSet rs) throws java.sql.SQLException {
        String name=rs.getString(1); Double mastery=(Double)rs.getObject(2); Double confidence=(Double)rs.getObject(3); Double relevance=(Double)rs.getObject(4);
        Double known=(Double)rs.getObject(5); Double stability=(Double)rs.getObject(6);
        java.sql.Timestamp assessed=rs.getTimestamp(7); java.sql.Timestamp due=rs.getTimestamp(8);
        java.time.Instant now=java.time.Instant.now();
        Double recall = known==null||stability==null||assessed==null ? null
                : known*com.studyos.mastery.SpacedRepetition.retrievability(java.time.temporal.ChronoUnit.MINUTES.between(assessed.toInstant(),now)/1440.0,stability);
        Long reviewInDays = due==null ? null : java.time.temporal.ChronoUnit.DAYS.between(now,due.toInstant().plus(1,java.time.temporal.ChronoUnit.MINUTES));
        return TopicStateLine.render(name,mastery,confidence,relevance,recall,reviewInDays);
    }
    private void append(StringBuilder target,String value) { if(value!=null&&!value.isBlank())target.append(value).append(value.endsWith("\n")?"":"\n"); }    private String hash(String value){try{byte[] bytes=MessageDigest.getInstance("SHA-256").digest((value==null?"":value).getBytes(StandardCharsets.UTF_8));StringBuilder result=new StringBuilder();for(byte b:bytes)result.append(String.format("%02x",b));return result.toString();}catch(Exception error){throw new IllegalStateException(error);}}
    /**
     * {@code evidence} is the retrieved source block verbatim, kept so the answer's citations can be checked
     * against what the model was actually shown. A turn whose profile retrieves nothing carries it empty,
     * which is the honest input to that check rather than an absence of one.
     *
     * <p>{@code learnerRecord} is the same arrangement for the other kind of evidence: the recorded-attempt
     * block, kept so a claim about the learner can be checked against what was actually measured. The two are
     * separate because they fail separately — an answer can cite a real page for an invented mastery figure.
     *
     * <p>{@code passages} is the same evidence as a list of what it was assembled from, each passage carrying the
     * ids of its chunks. It is what makes the stored provenance of an answer a fact rather than a claim: a chunk
     * id gets behind a sentence by having been in this list, never by a model naming it.
     */
    public record BuildResult(String context,ContextTokenUsage tokens,String evidenceFingerprint,String sourceVersion,String studentStateFingerprint,String evidence,String learnerRecord,List<com.studyos.retrieval.PassageAssembler.Passage> passages) {}
}
