package com.studyos.curriculum;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.adaptive.CognitiveLevel;
import com.studyos.ai.AiGateway;
import com.studyos.ai.AiOperation;
import com.studyos.ai.AiResult;
import com.studyos.ai.GenerationPolicyRegistry;
import com.studyos.ai.StructuredGenerationException;
import com.studyos.knowledge.TopicRegistry;
import com.studyos.ai.AiUsageService;
import com.studyos.mastery.RetentionModel;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Builds and reads the curriculum graph: an ordered set of modules and lessons with real
 * prerequisites between them. A workspace with uploaded material is organised from that material;
 * a workspace that only has a stated goal gets one synthesised for it.
 *
 * <p>Nothing here knows any subject vocabulary. Source-derived curricula are grounded in the
 * student's own extracted topics and syllabus units, and goal-derived prompts stay neutral, so the
 * same code produces a Spring Boot path, an organic chemistry path, or a contract law path.
 */
@Service
public class CurriculumService {
    private static final Logger log = LoggerFactory.getLogger(CurriculumService.class);
    private static final int MAX_MODULES = 12;
    private static final int MAX_LESSONS_PER_MODULE = 8;
    private static final int MAX_LESSONS = 60;
    /** Observed writing density: roughly 120 output tokens per lesson once title, topic, objective, key ideas and prerequisites are written. */
    private static final int TOKENS_PER_LESSON = 120;
    /** Share of the output budget the document may use, so it always ends before the token cap instead of being cut mid-JSON. */
    private static final double BUDGET_SAFETY_FACTOR = 0.75;

    /** The output budget decides how large a curriculum the model may be asked for; prompt and gates read the same contract. */
    private record SizeContract(int maxModules, int maxLessonsPerModule, int maxLessons) {}

    private SizeContract sizeContract() {
        int budget = policies.policy(AiOperation.CURRICULUM).maxOutputTokens();
        int maxLessons = Math.max(8, Math.min(MAX_LESSONS, (int) (budget * BUDGET_SAFETY_FACTOR / TOKENS_PER_LESSON)));
        int maxModules = Math.max(2, Math.min(MAX_MODULES, maxLessons / 4));
        int maxPerModule = Math.max(2, Math.min(MAX_LESSONS_PER_MODULE, maxLessons / maxModules));
        return new SizeContract(maxModules, maxPerModule, maxLessons);
    }

    private final JdbcTemplate jdbc;
    private final AiGateway ai;
    private final AiUsageService usage;
    private final GenerationPolicyRegistry policies;
    private final ObjectMapper mapper;
    private final TopicRegistry topics;
    private final CurriculumIntegrityService integrity;

    public CurriculumService(JdbcTemplate jdbc, AiGateway ai, AiUsageService usage, GenerationPolicyRegistry policies, ObjectMapper mapper, TopicRegistry topics, CurriculumIntegrityService integrity) {
        this.jdbc = jdbc; this.ai = ai; this.usage = usage; this.policies = policies; this.mapper = mapper; this.topics = topics; this.integrity = integrity;
    }

    /** Builds a curriculum the best way this workspace allows, and reuses one that already exists. */
    public Curriculum ensure(UUID workspaceId) {
        Curriculum existing = active(workspaceId);
        if (existing != null) return existing;
        return generate(workspaceId, null);
    }

    /**
     * Replaces the workspace's curriculum. With uploaded material the structure comes from the
     * material; otherwise it is synthesised from the stated goal.
     */
    public Curriculum generate(UUID workspaceId, String goal) {
        Workspace workspace = workspace(workspaceId);
        String statedGoal = goal == null || goal.isBlank() ? workspace.goal() : goal.trim();
        List<Evidence> evidence = evidence(workspaceId);
        Draft draft = evidence.isEmpty() ? fromGoal(workspaceId, workspace, statedGoal) : fromSources(workspaceId, workspace, statedGoal, evidence);
        if (draft.modules().isEmpty()) throw new com.studyos.WorkspaceNotReadyException(evidence.isEmpty()
                ? "StudyOS needs a learning goal or some source material before it can build a curriculum"
                : "StudyOS could not organise this material into a curriculum yet");
        return persist(workspaceId, evidence.isEmpty() ? "GOAL" : "SOURCES", statedGoal, draft, evidence);
    }

    /** The workspace's current curriculum with live mastery on every lesson, or null when it has none. */
    public Curriculum active(UUID workspaceId) {
        Header header = jdbc.query("SELECT id,mode,goal,title,summary,generated_at FROM curricula WHERE course_id=? AND status='ACTIVE' ORDER BY generated_at DESC LIMIT 1",
                rs -> rs.next() ? new Header(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5), rs.getTimestamp(6)) : null, workspaceId);
        return header == null ? null : read(workspaceId, header);
    }

    /** What to study next, and what is standing in the way when nothing is unlocked. */
    public Frontier frontier(UUID workspaceId) {
        Curriculum curriculum = active(workspaceId);
        if (curriculum == null) return new Frontier(null, List.of(), List.of(), 0);
        CurriculumGraph graph = graph(curriculum);
        List<Lesson> ready = graph.frontier().stream().map(lesson -> lesson(curriculum, lesson.id())).filter(Objects::nonNull).toList();
        List<Lesson> gaps = graph.criticalGaps().stream().map(lesson -> lesson(curriculum, lesson.id())).filter(Objects::nonNull).limit(5).toList();
        CurriculumGraph.Lesson next = graph.next();
        return new Frontier(next == null ? null : lesson(curriculum, next.id()), ready, gaps, round(graph.coverage()));
    }

    /** The prerequisite structure of a curriculum, ready for ordering and unlock questions. */
    public CurriculumGraph graph(Curriculum curriculum) {
        List<CurriculumGraph.Lesson> lessons = new ArrayList<>();
        for (Module module : curriculum.modules())
            for (Lesson lesson : module.lessons())
                lessons.add(new CurriculumGraph.Lesson(lesson.id(), lesson.topicId(), lesson.title(), module.ordinal(), lesson.ordinal(),
                        lesson.targetLevel(), lesson.estimatedMinutes(), lesson.effectiveMastery()));
        List<CurriculumGraph.Edge> edges = jdbc.query("SELECT p.lesson_id,p.prerequisite_lesson_id FROM curriculum_lesson_prerequisites p JOIN curriculum_lessons l ON l.id=p.lesson_id WHERE l.course_id=?",
                (rs, row) -> new CurriculumGraph.Edge(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class)), curriculum.workspaceId());
        return CurriculumGraph.of(lessons, edges);
    }

    // ---- generation -------------------------------------------------------------------------

    /**
     * Organises material the student actually uploaded. Syllabus weeks become modules when present;
     * otherwise the extracted topics are grouped in the order the material introduces them.
     */
    private Draft fromSources(UUID workspaceId, Workspace workspace, String goal, List<Evidence> evidence) {
        List<SyllabusUnit> units = jdbc.query("SELECT week_number,title,topics::text,learning_objectives::text FROM syllabus_units WHERE course_id=? ORDER BY COALESCE(week_number,9999),created_at",
                (rs, row) -> new SyllabusUnit(rs.getObject(1, Integer.class), rs.getString(2), strings(rs.getString(3)), strings(rs.getString(4))), workspaceId);
        List<TopicSummary> topicSummaries = jdbc.query("SELECT t.id,t.canonical_name,t.description,COALESCE(MAX(es.relevance),0),MIN(c.ordinal) FROM topics t JOIN chunk_topics ct ON ct.topic_id=t.id JOIN chunks c ON c.id=ct.chunk_id LEFT JOIN exam_topic_signals es ON es.topic_id=t.id AND es.course_id=t.course_id WHERE t.course_id=? GROUP BY t.id,t.canonical_name,t.description ORDER BY MIN(c.ordinal),t.canonical_name",
                (rs, row) -> new TopicSummary(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getDouble(4)), workspaceId);
        if (topicSummaries.isEmpty()) return new Draft(workspace.title(), null, List.of());
        Draft ai = synthesize(workspaceId, prompt(workspace, goal, units, topicSummaries), topicSummaries);
        return ai.modules().isEmpty() ? deterministic(workspace, units, topicSummaries) : ai;
    }

    /** Synthesises a path for a stated goal, when there is nothing uploaded to organise. */
    private Draft fromGoal(UUID workspaceId, Workspace workspace, String goal) {
        if (goal == null || goal.isBlank()) return new Draft(workspace.title(), null, List.of());
        SizeContract contract = sizeContract();
        String prompt = "Design a study curriculum that takes a learner from their current starting point to this goal.\n"
                + "GOAL: " + goal + "\n"
                + "Return JSON only: {title, summary, modules:[{title, summary, targetLevel, lessons:[{title, objective, keyIdeas:[...], targetLevel, estimatedMinutes, prerequisites:[lesson titles from earlier in this curriculum]}]}]}.\n"
                + "Use at most " + contract.maxModules() + " modules and at most " + contract.maxLessonsPerModule() + " lessons per module, " + contract.maxLessons() + " lessons in total — the document must be complete JSON, never cut off. "
                + "Keep each summary to one sentence and each keyIdeas list to at most four short phrases. "
                + "targetLevel is 1 to 6 where 1 is recall, 3 is applying a rule to a new case, and 6 is solving an unfamiliar problem of the kind an examiner would set. "
                + "Order modules so that nothing is taught before what it depends on. List a prerequisite only when the later lesson genuinely cannot be done without the earlier one. "
                + "Lesson titles must name what is being learned, not the position in the sequence.";
        return synthesize(workspaceId, prompt, List.of());
    }

    /** The grounded prompt for source-derived curricula: neutral wording, evidence-supplied names. */
    private String prompt(Workspace workspace, String goal, List<SyllabusUnit> units, List<TopicSummary> topicSummaries) {
        StringBuilder prompt = new StringBuilder("Organise this learner's own uploaded course material into a study curriculum.\n");
        prompt.append("WORKSPACE: ").append(workspace.title()).append('\n');
        if (goal != null && !goal.isBlank()) prompt.append("GOAL: ").append(goal).append('\n');
        if (!units.isEmpty()) {
            prompt.append("The material is organised into these units. Keep this order and these groupings.\n");
            for (SyllabusUnit unit : units) prompt.append("- ").append(unit.week() == null ? "Unit" : "Week " + unit.week()).append(": ")
                    .append(Objects.toString(unit.title(), "")).append(unit.topics().isEmpty() ? "" : " [covers: " + String.join(", ", unit.topics()) + "]").append('\n');
        }
        prompt.append("These are the concepts extracted from the material. Use these names exactly; do not introduce concepts that are not listed.\n");
        for (TopicSummary topic : topicSummaries.stream().limit(120).toList())
            prompt.append("- ").append(topic.name()).append(topic.description() == null || topic.description().isBlank() ? "" : " — " + trim(topic.description(), 160)).append('\n');
        SizeContract contract = sizeContract();
        prompt.append("Return JSON only: {title, summary, modules:[{title, summary, targetLevel, lessons:[{title, topic, objective, keyIdeas:[...], targetLevel, estimatedMinutes, prerequisites:[lesson titles from earlier in this curriculum]}]}]}.\n")
                .append("Every lesson's topic must be one of the listed concept names. Use at most ").append(contract.maxModules()).append(" modules and at most ")
                .append(contract.maxLessonsPerModule()).append(" lessons per module, ").append(contract.maxLessons()).append(" lessons in total — the document must be complete JSON, never cut off. ")
                .append("Keep each summary to one sentence and each keyIdeas list to at most four short phrases. ")
                .append("targetLevel is 1 to 6 where 1 is recall, 3 is applying a rule to a new case, and 6 is solving an unfamiliar problem of the kind an examiner would set. ")
                .append("List a prerequisite only when the later lesson genuinely cannot be done without the earlier one, judged from the material itself.");
        return prompt.toString();
    }

    private Draft synthesize(UUID workspaceId, String prompt, List<TopicSummary> allowed) {
        long started = System.nanoTime();
        AiResult<CurriculumDraft> result = null;
        boolean success = false;
        try {
            result = ai.generateStructuredResult("You design study curricula. Sequence what has to be understood first before what builds on it. Never invent material the learner does not have.",
                    prompt, CurriculumDraft.class, policies.policy(AiOperation.CURRICULUM));
            success = true;
            return normalize(result.value(), allowed);
        } catch (RuntimeException error) {
            if (error instanceof StructuredGenerationException structured) result = structured.telemetryResult();
            log.warn("Curriculum synthesis failed for workspace {}: {}", workspaceId, safeMessage(error));
            return new Draft(null, null, List.of());
        } finally {
            usage.record(AiOperation.CURRICULUM, result, workspaceId, null, null, (System.nanoTime() - started) / 1_000_000, success);
        }
    }

    /** Keeps only what the workspace can support: known concepts, sane sizes, backward-only prerequisites. */
    private Draft normalize(CurriculumDraft draft, List<TopicSummary> allowed) {
        if (draft == null || draft.modules().isEmpty()) return new Draft(null, null, List.of());
        SizeContract contract = sizeContract();
        Map<String, TopicSummary> byName = new LinkedHashMap<>();
        for (TopicSummary topic : allowed) byName.put(TopicRegistry.normalize(topic.name()), topic);
        List<DraftModule> modules = new ArrayList<>();
        Set<String> seenLessons = new LinkedHashSet<>();
        int lessonCount = 0;
        for (ModuleDraft module : draft.modules()) {
            if (module == null || blank(module.title()) || modules.size() >= contract.maxModules()) continue;
            List<DraftLesson> lessons = new ArrayList<>();
            for (LessonDraft lesson : module.lessons()) {
                if (lesson == null || blank(lesson.title()) || lessons.size() >= contract.maxLessonsPerModule() || lessonCount >= contract.maxLessons()) continue;
                String key = TopicRegistry.normalize(lesson.title());
                if (key.isBlank() || !seenLessons.add(key)) continue;
                TopicSummary matched = match(byName, lesson.topic(), lesson.title());
                if (!allowed.isEmpty() && matched == null) continue;
                List<String> prerequisites = lesson.prerequisites().stream().map(TopicRegistry::normalize)
                        .filter(value -> !value.isBlank() && !value.equals(key) && seenLessons.contains(value)).distinct().toList();
                lessons.add(new DraftLesson(lesson.title().trim(), matched == null ? null : matched.id(), lesson.objective(),
                        lesson.keyIdeas().stream().filter(value -> value != null && !value.isBlank()).limit(6).toList(),
                        level(lesson.targetLevel(), module.targetLevel()), minutes(lesson.estimatedMinutes()), prerequisites));
                lessonCount++;
            }
            if (!lessons.isEmpty()) modules.add(new DraftModule(module.title().trim(), module.summary(), level(module.targetLevel(), 3), lessons));
        }
        return new Draft(draft.title(), draft.summary(), modules);
    }

    /** Falls back to the material's own order when synthesis is unavailable or unusable. */
    private Draft deterministic(Workspace workspace, List<SyllabusUnit> units, List<TopicSummary> topicSummaries) {
        List<DraftModule> modules = new ArrayList<>();
        Set<UUID> used = new LinkedHashSet<>();
        for (SyllabusUnit unit : units.stream().limit(MAX_MODULES).toList()) {
            List<DraftLesson> lessons = new ArrayList<>();
            for (String name : unit.topics()) {
                TopicSummary topic = topicSummaries.stream().filter(value -> TopicRegistry.normalize(value.name()).equals(TopicRegistry.normalize(name))).findFirst().orElse(null);
                if (topic == null || !used.add(topic.id()) || lessons.size() >= MAX_LESSONS_PER_MODULE) continue;
                lessons.add(lesson(topic, lessons.isEmpty() ? List.of() : List.of(TopicRegistry.normalize(lessons.getLast().title()))));
            }
            if (!lessons.isEmpty()) modules.add(new DraftModule(unitTitle(unit), null, 3, lessons));
        }
        List<TopicSummary> remaining = topicSummaries.stream().filter(topic -> !used.contains(topic.id())).limit(MAX_LESSONS).toList();
        for (int start = 0; start < remaining.size() && modules.size() < MAX_MODULES; start += MAX_LESSONS_PER_MODULE) {
            List<TopicSummary> batch = remaining.subList(start, Math.min(start + MAX_LESSONS_PER_MODULE, remaining.size()));
            List<DraftLesson> lessons = new ArrayList<>();
            for (TopicSummary topic : batch) lessons.add(lesson(topic, lessons.isEmpty() ? List.of() : List.of(TopicRegistry.normalize(lessons.getLast().title()))));
            modules.add(new DraftModule("Part " + (modules.size() + 1), null, 3, lessons));
        }
        return new Draft(workspace.title(), "Organised from the order this material introduces each idea.", modules);
    }

    private DraftLesson lesson(TopicSummary topic, List<String> prerequisites) {
        int target = topic.relevance() >= .7 ? CognitiveLevel.L5_COMBINE.rank() : CognitiveLevel.L3_APPLY.rank();
        return new DraftLesson(topic.name(), topic.id(), "Work with " + topic.name() + " using the definitions and rules in the material.",
                List.of(), target, 25, prerequisites);
    }

    private String unitTitle(SyllabusUnit unit) {
        if (!blank(unit.title())) return trim(unit.title().trim(), 200);
        return unit.week() == null ? "Unit" : "Week " + unit.week();
    }

    // ---- persistence ------------------------------------------------------------------------

    private Curriculum persist(UUID workspaceId, String mode, String goal, Draft draft, List<Evidence> evidence) {
        jdbc.update("UPDATE curricula SET status='SUPERSEDED',updated_at=NOW() WHERE course_id=? AND status='ACTIVE'", workspaceId);
        UUID curriculumId = UUID.randomUUID();
        String title = blank(draft.title()) ? "Study path" : trim(draft.title().trim(), 500);
        jdbc.update("INSERT INTO curricula(id,course_id,mode,goal,title,summary,status,evidence_basis) VALUES(?,?,?,?,?,?,?,CAST(? AS jsonb))",
                curriculumId, workspaceId, mode, goal, title, draft.summary(), "ACTIVE", json(evidence.stream().map(Evidence::name).toList()));
        Map<String, UUID> lessonsByKey = new LinkedHashMap<>();
        Map<UUID, List<String>> pendingPrerequisites = new LinkedHashMap<>();
        int moduleOrdinal = 0;
        for (DraftModule module : draft.modules()) {
            UUID moduleId = UUID.randomUUID();
            int moduleMinutes = module.lessons().stream().mapToInt(DraftLesson::estimatedMinutes).sum();
            jdbc.update("INSERT INTO curriculum_modules(id,curriculum_id,course_id,ordinal,title,summary,target_level,estimated_minutes) VALUES(?,?,?,?,?,?,?,?)",
                    moduleId, curriculumId, workspaceId, moduleOrdinal++, trim(module.title(), 500), module.summary(), module.targetLevel(), moduleMinutes);
            int lessonOrdinal = 0;
            for (DraftLesson lesson : module.lessons()) {
                UUID lessonId = UUID.randomUUID();
                UUID topicId = lesson.topicId() != null ? lesson.topicId() : topics.resolveOrCreate(workspaceId, lesson.title(), lesson.objective());
                jdbc.update("INSERT INTO curriculum_lessons(id,module_id,course_id,topic_id,ordinal,title,objective,key_ideas,target_level,estimated_minutes,content_status) VALUES(?,?,?,?,?,?,?,CAST(? AS jsonb),?,?,?)",
                        lessonId, moduleId, workspaceId, topicId, lessonOrdinal++, trim(lesson.title(), 500), lesson.objective(),
                        json(lesson.keyIdeas()), lesson.targetLevel(), lesson.estimatedMinutes(), "PENDING");
                lessonsByKey.put(TopicRegistry.normalize(lesson.title()), lessonId);
                if (!lesson.prerequisites().isEmpty()) pendingPrerequisites.put(lessonId, lesson.prerequisites());
            }
        }
        pendingPrerequisites.forEach((lessonId, names) -> {
            for (String name : names) {
                UUID prerequisiteId = lessonsByKey.get(name);
                if (prerequisiteId != null && !prerequisiteId.equals(lessonId))
                    jdbc.update("INSERT INTO curriculum_lesson_prerequisites(lesson_id,prerequisite_lesson_id) VALUES(?,?) ON CONFLICT DO NOTHING", lessonId, prerequisiteId);
            }
        });
        jdbc.update("INSERT INTO learning_events(id,course_id,event_type,payload) VALUES(?,?,?,CAST(? AS jsonb))", UUID.randomUUID(), workspaceId, "CURRICULUM_GENERATED",
                json(Map.of("curriculumId", curriculumId, "mode", mode, "modules", draft.modules().size(),
                        "lessons", draft.modules().stream().mapToInt(module -> module.lessons().size()).sum())));
        // Every generation is validated before the learner sees it; findings are stored on the row.
        try { integrity.validate(workspaceId, curriculumId); }
        catch (RuntimeException error) { log.warn("Curriculum integrity validation failed for course {}: {}", workspaceId, error.getMessage()); }
        return active(workspaceId);
    }

    private Curriculum read(UUID workspaceId, Header header) {
        List<LessonRow> rows = jdbc.query("""
                SELECT m.id,m.ordinal,m.title,m.summary,m.target_level,m.estimated_minutes,
                       l.id,l.ordinal,l.title,l.objective,l.key_ideas::text,l.target_level,l.estimated_minutes,l.content_status,l.topic_id,
                       COALESCE(s.measured_mastery,s.mastery,0),COALESCE(s.evidence_count,0),COALESCE(s.last_studied_at,s.last_assessed_at,s.updated_at),COALESCE(s.stability_days,0)
                FROM curriculum_modules m
                LEFT JOIN curriculum_lessons l ON l.module_id=m.id
                LEFT JOIN student_topic_state s ON s.topic_id=l.topic_id AND s.course_id=m.course_id
                WHERE m.curriculum_id=? ORDER BY m.ordinal,l.ordinal
                """, (rs, row) -> new LessonRow(rs.getObject(1, UUID.class), rs.getInt(2), rs.getString(3), rs.getString(4), rs.getInt(5), rs.getInt(6),
                rs.getObject(7, UUID.class), rs.getInt(8), rs.getString(9), rs.getString(10), strings(rs.getString(11)), rs.getInt(12), rs.getInt(13),
                rs.getString(14), rs.getObject(15, UUID.class), rs.getDouble(16), rs.getInt(17), rs.getTimestamp(18), rs.getDouble(19)), header.id());
        Map<UUID, List<Lesson>> lessonsByModule = new LinkedHashMap<>();
        Map<UUID, LessonRow> moduleRows = new LinkedHashMap<>();
        Instant now = Instant.now();
        for (LessonRow row : rows) {
            moduleRows.putIfAbsent(row.moduleId(), row);
            List<Lesson> lessons = lessonsByModule.computeIfAbsent(row.moduleId(), key -> new ArrayList<>());
            if (row.lessonId() == null) continue;
            double retention = RetentionModel.retention(row.anchor() == null ? null : row.anchor().toInstant(), now, row.stabilityDays());
            lessons.add(new Lesson(row.lessonId(), row.topicId(), row.lessonTitle(), row.lessonOrdinal(), row.objective(), row.keyIdeas(),
                    row.lessonTargetLevel(), CognitiveLevel.ofRank(row.lessonTargetLevel()).label(), row.lessonMinutes(), row.contentStatus(),
                    round(row.mastery()), round(row.mastery() * retention), row.evidenceCount()));
        }
        List<Module> modules = new ArrayList<>();
        moduleRows.forEach((moduleId, row) -> modules.add(new Module(moduleId, row.moduleOrdinal(), row.moduleTitle(), row.moduleSummary(),
                row.moduleTargetLevel(), row.moduleMinutes(), List.copyOf(lessonsByModule.getOrDefault(moduleId, List.of())))));
        int totalLessons = modules.stream().mapToInt(module -> module.lessons().size()).sum();
        int totalMinutes = modules.stream().flatMap(module -> module.lessons().stream()).mapToInt(Lesson::estimatedMinutes).sum();
        return new Curriculum(header.id(), workspaceId, header.mode(), header.goal(), header.title(), header.summary(),
                modules, totalLessons, totalMinutes, header.generatedAt());
    }

    private Lesson lesson(Curriculum curriculum, UUID lessonId) {
        return curriculum.modules().stream().flatMap(module -> module.lessons().stream())
                .filter(lesson -> lesson.id().equals(lessonId)).findFirst().orElse(null);
    }

    // ---- helpers ----------------------------------------------------------------------------

    private Workspace workspace(UUID workspaceId) {
        Workspace workspace = jdbc.query("SELECT name,description,objective FROM courses WHERE id=?",
                rs -> rs.next() ? new Workspace(rs.getString(1), goal(rs.getString(1), rs.getString(2), rs.getString(3))) : null, workspaceId);
        if (workspace == null) throw new IllegalArgumentException("Workspace was not found");
        return workspace;
    }

    /** A workspace's own words are the goal; the objective only fills in when nothing was written. */
    private String goal(String title, String description, String objective) {
        if (description != null && !description.isBlank()) return description.trim();
        if (objective == null || objective.isBlank()) return null;
        return switch (objective) {
            case "PASS_EXAM" -> "Pass the exam for " + title;
            case "UNDERSTAND_DEEPLY" -> "Understand " + title + " deeply";
            case "FINISH_COURSE" -> "Finish the course " + title;
            case "PREPARE_CERTIFICATION" -> "Prepare for certification in " + title;
            case "BUILD_SKILL" -> "Become able to work with " + title;
            case "IMPROVE_LANGUAGE" -> "Improve at " + title;
            default -> "Learn " + title;
        };
    }

    private List<Evidence> evidence(UUID workspaceId) {
        return jdbc.query("SELECT d.name FROM documents d WHERE d.course_id=? AND d.status='COMPLETED' AND d.document_type<>'GENERATED_LESSON' AND EXISTS(SELECT 1 FROM chunks c WHERE c.document_id=d.id) ORDER BY d.created_at",
                (rs, row) -> new Evidence(rs.getString(1)), workspaceId);
    }

    private TopicSummary match(Map<String, TopicSummary> byName, String topic, String title) {
        TopicSummary direct = byName.get(TopicRegistry.normalize(topic));
        if (direct != null) return direct;
        return byName.get(TopicRegistry.normalize(title));
    }

    private int level(Integer value, Integer fallback) {
        Integer chosen = value != null && value >= 1 && value <= 6 ? value : fallback;
        return chosen == null || chosen < 1 || chosen > 6 ? CognitiveLevel.L3_APPLY.rank() : chosen;
    }
    private int minutes(Integer value) { return value == null ? 25 : Math.max(5, Math.min(120, value)); }
    private boolean blank(String value) { return value == null || value.isBlank(); }
    private String trim(String value, int max) { String clean = Objects.toString(value, ""); return clean.length() <= max ? clean : clean.substring(0, max); }
    private double round(double value) { return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000.0; }
    private String json(Object value) { try { return mapper.writeValueAsString(value); } catch (Exception ignored) { return "[]"; } }
    private List<String> strings(String value) {
        try { return mapper.readValue(value == null || value.isBlank() ? "[]" : value, new com.fasterxml.jackson.core.type.TypeReference<List<String>>() {}); }
        catch (Exception ignored) { return List.of(); }
    }
    private String safeMessage(Throwable error) { String message = error.getMessage(); return message == null ? error.getClass().getSimpleName() : trim(message, 300); }

    private record Workspace(String title, String goal) {}
    private record Evidence(String name) {}
    private record SyllabusUnit(Integer week, String title, List<String> topics, List<String> objectives) {}
    private record TopicSummary(UUID id, String name, String description, double relevance) {}
    private record Header(UUID id, String mode, String goal, String title, String summary, Timestamp generatedAt) {}
    private record Draft(String title, String summary, List<DraftModule> modules) {}
    private record DraftModule(String title, String summary, int targetLevel, List<DraftLesson> lessons) {}
    private record DraftLesson(String title, UUID topicId, String objective, List<String> keyIdeas, int targetLevel, int estimatedMinutes, List<String> prerequisites) {}
    private record LessonRow(UUID moduleId, int moduleOrdinal, String moduleTitle, String moduleSummary, int moduleTargetLevel, int moduleMinutes,
                             UUID lessonId, int lessonOrdinal, String lessonTitle, String objective, List<String> keyIdeas, int lessonTargetLevel,
                             int lessonMinutes, String contentStatus, UUID topicId, double mastery, int evidenceCount, Timestamp anchor, double stabilityDays) {}

    public record CurriculumDraft(String title, String summary, List<ModuleDraft> modules) {
        @JsonCreator public CurriculumDraft(@JsonProperty("title") String title, @JsonProperty("summary") String summary, @JsonProperty("modules") List<ModuleDraft> modules) {
            this.title = title; this.summary = summary; this.modules = modules == null ? List.of() : modules;
        }
    }
    public record ModuleDraft(String title, String summary, Integer targetLevel, List<LessonDraft> lessons) {
        @JsonCreator public ModuleDraft(@JsonProperty("title") String title, @JsonProperty("summary") String summary, @JsonProperty("targetLevel") Integer targetLevel, @JsonProperty("lessons") List<LessonDraft> lessons) {
            this.title = title; this.summary = summary; this.targetLevel = targetLevel; this.lessons = lessons == null ? List.of() : lessons;
        }
    }
    public record LessonDraft(String title, String topic, String objective, List<String> keyIdeas, Integer targetLevel, Integer estimatedMinutes, List<String> prerequisites) {
        @JsonCreator public LessonDraft(@JsonProperty("title") String title, @JsonProperty("topic") String topic, @JsonProperty("objective") String objective,
                                        @JsonProperty("keyIdeas") List<String> keyIdeas, @JsonProperty("targetLevel") Integer targetLevel,
                                        @JsonProperty("estimatedMinutes") Integer estimatedMinutes, @JsonProperty("prerequisites") List<String> prerequisites) {
            this.title = title; this.topic = topic; this.objective = objective;
            this.keyIdeas = keyIdeas == null ? List.of() : keyIdeas; this.targetLevel = targetLevel;
            this.estimatedMinutes = estimatedMinutes; this.prerequisites = prerequisites == null ? List.of() : prerequisites;
        }
    }

    public record Curriculum(UUID id, UUID workspaceId, String mode, String goal, String title, String summary,
                             List<Module> modules, int totalLessons, int totalMinutes, Timestamp generatedAt) {}
    public record Module(UUID id, int ordinal, String title, String summary, int targetLevel, int estimatedMinutes, List<Lesson> lessons) {}
    public record Lesson(UUID id, UUID topicId, String title, int ordinal, String objective, List<String> keyIdeas, int targetLevel,
                         String targetLevelLabel, int estimatedMinutes, String contentStatus, double mastery, double effectiveMastery, int evidenceCount) {}
    public record Frontier(Lesson next, List<Lesson> ready, List<Lesson> criticalGaps, double coverage) {}
}
