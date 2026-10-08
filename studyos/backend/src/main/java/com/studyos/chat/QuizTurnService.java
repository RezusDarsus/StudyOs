package com.studyos.chat;

import com.studyos.assessment.QuizService;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Serves a chat turn that asks to be tested, by issuing real assessment items instead of writing prose.
 *
 * <p>Asking a language model for a quiz and printing what it says put the questions and their answers in the
 * same reply, which is not a quiz. The generator behind the quiz endpoints already solves this: it stores each
 * answer, its hint ladder and its evidence in {@code assessment_items} and hands back only the question. So a
 * chat quiz goes through that path and the reply is assembled from the returned questions, which structurally
 * cannot carry an answer — there is no field on them that holds one.
 *
 * <p>The issued item identifiers travel back with the reply and are recorded against the chat, so the learner
 * can attempt them, ask for a hint one rung at a time, and have the result count towards mastery, exactly as
 * for a quiz started anywhere else in the application.
 */
@Service
public class QuizTurnService {
    /** Beyond this, a "quiz me" turn is a study session rather than a quiz; the generator caps at ten anyway. */
    private static final int MAX_QUESTIONS = 8;

    private final JdbcTemplate jdbc; private final QuizService quizzes;
    public QuizTurnService(JdbcTemplate jdbc, QuizService quizzes) { this.jdbc=jdbc; this.quizzes=quizzes; }

    /**
     * Issues up to {@code requestedCount} questions for this chat. Returns {@code null} when the generator
     * verified none, so the caller can fall back rather than present an empty quiz.
     */
    public Issued issue(UUID courseId, UUID chatId, String request, int requestedCount) {
        int count = Math.max(1, Math.min(requestedCount, MAX_QUESTIONS));
        Topic topic = resolveTopic(courseId, request);
        List<QuizService.Question> questions = quizzes.generate(courseId, topic == null ? null : topic.id(), count, .5, "PRACTICE", "PRACTICE", null, request);
        if (questions.isEmpty()) return null;
        record(courseId, chatId, questions);
        return new Issued(packet(questions, topic == null ? null : topic.name()), questions.stream().map(QuizService.Question::id).toList());
    }

    /**
     * The reply. Expansions are deliberately empty: the standard set offers a worked example, which for an
     * unattempted question is the answer under a different name.
     */
    SemanticAnswerPacket packet(List<QuizService.Question> questions, String topicName) {
        String subject = topicName == null || topicName.isBlank() ? "" : " on " + topicName;
        String core = "Here " + (questions.size() == 1 ? "is one question" : "are " + questions.size() + " questions") + subject
                + ". Answer in your own words and I will mark " + (questions.size() == 1 ? "it" : "them") + " and tell you where you stand."
                + (questions.stream().anyMatch(QuizService.Question::supportAllowed) ? " Ask for a hint on any of them if you get stuck — the hints come one step at a time, so asking early costs you little." : "");
        List<SemanticAnswerPacket.Section> sections = new ArrayList<>();
        for (int index = 0; index < questions.size(); index++) sections.add(new SemanticAnswerPacket.Section("Question " + (index + 1), questions.get(index).prompt()));
        return new SemanticAnswerPacket(core, sections, sources(questions), List.of());
    }

    /** One entry per document the questions rest on, in the order they were first cited. */
    private List<SemanticAnswerPacket.SourceRef> sources(List<QuizService.Question> questions) {
        Map<String,SemanticAnswerPacket.SourceRef> distinct = new LinkedHashMap<>();
        for (QuizService.Question question : questions)
            for (Map<String,Object> basis : question.sourceBasis()) {
                String document = String.valueOf(basis.get("document")); String pages = String.valueOf(basis.get("pages"));
                if (basis.get("document") != null) distinct.putIfAbsent(document + "|" + pages, new SemanticAnswerPacket.SourceRef(document, pages));
            }
        return List.copyOf(distinct.values());
    }

    private void record(UUID courseId, UUID chatId, List<QuizService.Question> questions) {
        for (int index = 0; index < questions.size(); index++)
            jdbc.update("INSERT INTO chat_quiz_items(id,course_id,chat_id,item_id,ordinal) VALUES(?,?,?,?,?) ON CONFLICT(chat_id,item_id) DO NOTHING",
                    UUID.randomUUID(), courseId, chatId, questions.get(index).id(), index + 1);
    }

    /**
     * The topic the request names, preferring the most specific match. Terms are the course's own extracted
     * topics and their aliases; when the request names none, the generator falls back to retrieving on the
     * learner's own wording, which is a better query than an arbitrarily chosen topic.
     */
    private Topic resolveTopic(UUID courseId, String request) {
        String query = TopicMentions.normalize(request);
        if (query.isBlank()) return null;
        List<Term> terms = jdbc.query("SELECT t.id,t.canonical_name,t.canonical_name FROM topics t WHERE t.course_id=? UNION ALL SELECT t.id,t.canonical_name,a.alias FROM topic_aliases a JOIN topics t ON t.id=a.topic_id WHERE t.course_id=?",
                (rs, row) -> new Term(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3)), courseId, courseId);
        Term best = null;
        for (Term term : terms) {
            if (term.term() == null || TopicMentions.normalize(term.term()).length() < 3 || !TopicMentions.matches(query, term.term())) continue;
            if (best == null || term.term().length() > best.term().length()) best = term;
        }
        return best == null ? null : new Topic(best.id(), best.canonicalName());
    }

    /** What the caller needs: the reply to render, and the items the learner may now attempt. */
    public record Issued(SemanticAnswerPacket packet,List<UUID> itemIds) {}
    private record Topic(UUID id,String name) {}
    private record Term(UUID id,String canonicalName,String term) {}
}
