package com.studyos.curriculum;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.WorkspaceNotReadyException;
import com.studyos.adaptive.CognitiveLevel;
import com.studyos.ai.AiGateway;
import com.studyos.ai.AiOperation;
import com.studyos.ai.AiResult;
import com.studyos.ai.AiUsageService;
import com.studyos.ai.GenerationPolicyRegistry;
import com.studyos.ai.StructuredGenerationException;
import com.studyos.retrieval.HybridRetriever;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Writes the teaching content for one lesson, the first time a student opens it, and reuses it
 * afterwards. Curriculum generation deliberately produces only structure — titles, objectives and
 * prerequisites — because writing every lesson of a sixty-lesson path up front would make the student
 * wait for material most of them will never reach.
 *
 * <p>A brief is grounded in the passages retrieved for that lesson, and it says so: the citations
 * name the documents the student uploaded. When generation is unavailable the lesson still opens,
 * showing those passages instead of invented prose — see {@link LessonBriefComposer#fallback}.
 *
 * <p>Nothing here knows any subject. The prompt describes the material only as material, so the same
 * path produces a lesson on enzyme kinetics, on consideration in contract law, or on Spring beans.
 */
@Service
public class LessonBriefService {
    private static final Logger log = LoggerFactory.getLogger(LessonBriefService.class);
    /** How many passages a lesson is written from: enough for a definition and an example. */
    private static final int EVIDENCE_CHUNKS = 6;
    private static final int EXCERPT_CHARS = 1200;
    private static final int MAX_KNOWN_MISTAKES = 3;

    private static final String SYSTEM_PROMPT = """
            You write one short lesson for a student who is about to study a single idea.
            Teach in this order: plain intuition, then the idea stated precisely, then one worked example, then questions that check it landed.
            Use only what the numbered excerpts contain: their definitions, rules, notation and worked steps. If the excerpts do not support a section, leave that field empty rather than filling it from general knowledge.
            Use the excerpts' own terminology and notation, not synonyms for it.""";

    private final JdbcTemplate jdbc;
    private final AiGateway ai;
    private final AiUsageService usage;
    private final GenerationPolicyRegistry policies;
    private final ObjectMapper mapper;
    private final HybridRetriever retriever;

    public LessonBriefService(JdbcTemplate jdbc, AiGateway ai, AiUsageService usage, GenerationPolicyRegistry policies,
                              ObjectMapper mapper, HybridRetriever retriever) {
        this.jdbc = jdbc; this.ai = ai; this.usage = usage; this.policies = policies;
        this.mapper = mapper; this.retriever = retriever;
    }

    /** The lesson's brief, writing it on first use. */
    public LessonBriefComposer.Brief brief(UUID workspaceId, UUID lessonId) {
        return brief(workspaceId, lessonId, false);
    }

    /**
     * The lesson's brief, rewritten from scratch when asked. Regenerating matters after new material
     * is uploaded, and after a brief came back partial because a generation attempt failed.
     */
    public LessonBriefComposer.Brief brief(UUID workspaceId, UUID lessonId, boolean regenerate) {
        LessonRow lesson = lesson(workspaceId, lessonId);
        if (!regenerate) {
            LessonBriefComposer.Brief stored = stored(lessonId);
            if (stored != null) return stored;
        }
        List<LessonBriefComposer.Excerpt> evidence = evidence(workspaceId, lesson);
        LessonBriefComposer.Request request = new LessonBriefComposer.Request(lesson.title(), lesson.objective(),
                lesson.keyIdeas(), lesson.targetLevel(), mistakes(workspaceId, lesson.topicId()));
        LessonBriefComposer.Draft draft = evidence.isEmpty() ? null : synthesize(workspaceId, request, evidence);
        LessonBriefComposer.Brief brief = draft == null ? LessonBriefComposer.fallback(request, evidence)
                : LessonBriefComposer.compose(request, draft, evidence);
        String status = LessonBriefComposer.contentStatus(brief);
        if ("PENDING".equals(status)) throw new WorkspaceNotReadyException("There is nothing about \"" + lesson.title()
                + "\" in the uploaded material yet. Add the lecture notes or pages that cover it, then open this lesson again.");
        persist(workspaceId, lessonId, lesson, brief, status);
        return brief;
    }

    /** The whole lesson as text, for reading in one piece or copying out. */
    public String markdown(UUID workspaceId, UUID lessonId) {
        return LessonBriefComposer.markdown(brief(workspaceId, lessonId));
    }

    // ---- generation -------------------------------------------------------------------------

    private LessonBriefComposer.Draft synthesize(UUID workspaceId, LessonBriefComposer.Request request, List<LessonBriefComposer.Excerpt> evidence) {
        long started = System.nanoTime();
        AiResult<LessonBriefComposer.Draft> result = null;
        boolean success = false;
        try {
            result = ai.generateStructuredResult(SYSTEM_PROMPT, prompt(request, evidence),
                    LessonBriefComposer.Draft.class, policies.policy(AiOperation.LESSON_BRIEF));
            success = true;
            return result.value();
        } catch (RuntimeException error) {
            if (error instanceof StructuredGenerationException structured) result = structured.telemetryResult();
            log.warn("Lesson brief generation failed for workspace {}: {}", workspaceId, safeMessage(error));
            return null;
        } finally {
            usage.record(AiOperation.LESSON_BRIEF, result, workspaceId, null, null, (System.nanoTime() - started) / 1_000_000, success);
        }
    }

    /** Deliberately neutral: the prompt refers to material and excerpts, never to a subject. */
    private String prompt(LessonBriefComposer.Request request, List<LessonBriefComposer.Excerpt> evidence) {
        CognitiveLevel level = CognitiveLevel.ofRank(request.targetLevel());
        StringBuilder prompt = new StringBuilder("Lesson: ").append(request.title()).append('\n');
        if (request.objective() != null && !request.objective().isBlank()) prompt.append("Objective: ").append(request.objective().trim()).append('\n');
        if (!request.keyIdeas().isEmpty()) prompt.append("Key ideas to cover: ").append(String.join("; ", request.keyIdeas())).append('\n');
        prompt.append("Target demand: ").append(level.label()).append(" — ").append(level.demand()).append('\n');
        if (!request.knownMistakes().isEmpty())
            prompt.append("This student has already gone wrong on: ").append(String.join("; ", request.knownMistakes()))
                    .append("\nAddress those directly under commonMistakes.\n");
        prompt.append("\nExcerpts from the student's material:\n");
        int number = 1;
        for (LessonBriefComposer.Excerpt excerpt : evidence) {
            prompt.append('[').append(number++).append("] ")
                    .append(LessonBriefComposer.reference(new LessonBriefComposer.Citation(excerpt.documentName(), excerpt.pageStart(), excerpt.pageEnd())))
                    .append('\n').append(excerpt.content()).append("\n\n");
        }
        prompt.append("""
                Return JSON only:
                {"intuition":"2-4 sentences, no notation","formalDefinition":"the precise statement, in the notation the excerpts use",
                 "workedExample":"one example worked step by step","checks":[{"question":"...","answer":"..."}],
                 "commonMistakes":["..."],"nextStep":"one sentence on what to practise next"}
                At most 3 checks and 3 commonMistakes. Never reveal the answer inside the question.""");
        return prompt.toString();
    }

    // ---- reads ------------------------------------------------------------------------------

    private LessonRow lesson(UUID workspaceId, UUID lessonId) {
        LessonRow row = jdbc.query("""
                SELECT l.title,l.objective,l.key_ideas::text,l.target_level,l.topic_id,t.canonical_name
                FROM curriculum_lessons l LEFT JOIN topics t ON t.id=l.topic_id
                WHERE l.id=? AND l.course_id=?
                """, rs -> rs.next() ? new LessonRow(rs.getString(1), rs.getString(2), strings(rs.getString(3)),
                rs.getInt(4), rs.getObject(5, UUID.class), rs.getString(6)) : null, lessonId, workspaceId);
        if (row == null) throw new IllegalArgumentException("Lesson was not found in this workspace");
        return row;
    }

    /** A stored brief that no longer parses is treated as absent, so the lesson can still be read. */
    private LessonBriefComposer.Brief stored(UUID lessonId) {
        String payload = jdbc.query("SELECT payload::text FROM curriculum_lesson_briefs WHERE lesson_id=?",
                rs -> rs.next() ? rs.getString(1) : null, lessonId);
        if (payload == null || payload.isBlank()) return null;
        try { return mapper.readValue(payload, LessonBriefComposer.Brief.class); }
        catch (Exception ignored) { return null; }
    }

    /**
     * The passages this lesson is written from. The topic's canonical name joins the query because a
     * lesson title is sometimes shorter than the words the material itself uses.
     */
    private List<LessonBriefComposer.Excerpt> evidence(UUID workspaceId, LessonRow lesson) {
        LinkedHashSet<String> terms = new LinkedHashSet<>();
        terms.add(lesson.title());
        terms.add(lesson.topicName());
        terms.add(lesson.objective());
        terms.addAll(lesson.keyIdeas());
        String query = String.join(" ", terms.stream().filter(value -> value != null && !value.isBlank()).toList());
        List<LessonBriefComposer.Excerpt> excerpts = new ArrayList<>();
        for (HybridRetriever.RetrievedChunk chunk : retriever.retrieve(workspaceId, query, EVIDENCE_CHUNKS)) {
            if (chunk.content() == null || chunk.content().isBlank()) continue;
            excerpts.add(new LessonBriefComposer.Excerpt(chunk.documentName(), chunk.pageStart(), chunk.pageEnd(), trim(chunk.content())));
        }
        return excerpts;
    }

    /** What this student has already got wrong here, so the lesson can pre-empt it. */
    private List<String> mistakes(UUID workspaceId, UUID topicId) {
        if (topicId == null) return List.of();
        return jdbc.query("SELECT label FROM misconceptions WHERE course_id=? AND topic_id=? AND status<>'RESOLVED' ORDER BY severity DESC, occurrences DESC LIMIT ?",
                (rs, row) -> rs.getString(1), workspaceId, topicId, MAX_KNOWN_MISTAKES);
    }

    // ---- persistence ------------------------------------------------------------------------

    private void persist(UUID workspaceId, UUID lessonId, LessonRow lesson, LessonBriefComposer.Brief brief, String status) {
        jdbc.update("""
                INSERT INTO curriculum_lesson_briefs(lesson_id,course_id,grounded,complete,payload)
                VALUES(?,?,?,?,CAST(? AS jsonb))
                ON CONFLICT (lesson_id) DO UPDATE SET grounded=EXCLUDED.grounded,complete=EXCLUDED.complete,payload=EXCLUDED.payload,updated_at=NOW()
                """, lessonId, workspaceId, brief.grounded(), brief.complete(), json(brief));
        jdbc.update("UPDATE curriculum_lessons SET content_status=? WHERE id=? AND course_id=?", status, lessonId, workspaceId);
        jdbc.update("INSERT INTO learning_events(id,course_id,topic_id,event_type,payload) VALUES(?,?,?,?,CAST(? AS jsonb))",
                UUID.randomUUID(), workspaceId, lesson.topicId(), "LESSON_BRIEF_GENERATED",
                json(Map.of("lessonId", lessonId, "status", status, "grounded", brief.grounded(),
                        "citations", brief.citations().size(), "missing", brief.missing())));
    }

    // ---- helpers ----------------------------------------------------------------------------

    private String trim(String value) {
        String flat = value.strip();
        return flat.length() <= EXCERPT_CHARS ? flat : flat.substring(0, EXCERPT_CHARS) + "…";
    }
    private String json(Object value) { try { return mapper.writeValueAsString(value); } catch (Exception ignored) { return "{}"; } }
    private List<String> strings(String value) {
        try { return mapper.readValue(value == null || value.isBlank() ? "[]" : value, new TypeReference<List<String>>() {}); }
        catch (Exception ignored) { return List.of(); }
    }
    private String safeMessage(Throwable error) { return Objects.toString(error.getMessage(), error.getClass().getSimpleName()); }

    private record LessonRow(String title, String objective, List<String> keyIdeas, int targetLevel, UUID topicId, String topicName) {}
}
