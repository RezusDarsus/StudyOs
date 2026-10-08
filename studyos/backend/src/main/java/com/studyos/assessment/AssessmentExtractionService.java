package com.studyos.assessment;

import com.studyos.ingestion.DocumentType;
import com.studyos.ingestion.SourceClassifier;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** Turns uploaded exam/homework material into provenance-preserving assessment items without blocking on an LLM. */
@Service
public class AssessmentExtractionService {
    private static final Pattern QUESTION_BOUNDARY = Pattern.compile("(?im)(?=\\b(?:question|exercise|problem|task)\\s*(?:no\\.?\\s*)?\\d+\\s*[:.)-])|(?=^\\s*\\d+\\s+[A-Z][^\\n]{2,120}(?:\\(\\s*\\d+\\s*(?:pt|points?|credit points?)\\))?)|(?=^\\s*\\d+\\.\\s+[^\\n]{2,120}\\(\\s*\\d+\\s*(?:pt|points?|credit points?)\\))|(?=^\\s*[A-Z][^\\n]{2,120}\\(\\s*\\d+\\s*(?:pt|points?|credit points?)\\))");
    private static final Pattern QUESTION_NUMBER = Pattern.compile("(?i)\\b(?:question|exercise|problem|task|q)\\s*(?:no\\.?\\s*)?(\\d+)");
    private static final Pattern POINTS = Pattern.compile("(?i)(\\d+(?:\\.\\d+)?)\\s*(?:points?|pts?|credits?)");
    private static final Pattern YEAR = Pattern.compile("\\b(20\\d{2})\\b");
    /**
     * Filename signals for assessment material, matched on word boundaries. Substring matching read
     * "latest-notes" as a test and "worked-examples" as an exam, and then extracted every paragraph
     * of them as exam questions.
     */
    private static final Pattern EXAM_FILENAME = Pattern.compile("(?<![a-z])(?:exams?|midterms?|finals?|tests?)(?![a-z])");
    private static final Pattern HOMEWORK_FILENAME = Pattern.compile("(?<![a-z])(?:homework|hw|exercises?|assignments?|worksheets?|problem[ _-]?sets?)(?![a-z])");
    private final JdbcTemplate jdbc;

    public AssessmentExtractionService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public void extractDocument(UUID documentId, UUID courseId) {
        DocumentRow document = jdbc.query("SELECT name,document_type FROM documents WHERE id=? AND course_id=?", rs -> {
            if (!rs.next()) return null;
            return new DocumentRow(rs.getString("name"), rs.getString("document_type"));
        }, documentId, courseId);
        if (document == null) return;
        List<ChunkRow> chunks = jdbc.query("SELECT id,page_start,page_end,content FROM chunks WHERE document_id=? ORDER BY ordinal", (rs, row) -> new ChunkRow(rs.getObject("id", UUID.class), rs.getObject("page_start", Integer.class), rs.getObject("page_end", Integer.class), rs.getString("content")), documentId);
        String sample = chunks.stream().limit(2).map(ChunkRow::content).reduce("", (a, b) -> a + "\n" + b);
        String effectiveType = effectiveType(document.name(), document.type(), sample);
        if (!effectiveType.equalsIgnoreCase(document.type())) jdbc.update("UPDATE documents SET document_type=? WHERE id=?", effectiveType, documentId);
        if (!isAssessment(effectiveType)) return;

        jdbc.update("DELETE FROM assessment_item_topics WHERE item_id IN (SELECT id FROM assessment_items WHERE document_id=?)", documentId);
        jdbc.update("DELETE FROM assessment_items WHERE document_id=?", documentId);
        int year = extractYear(document.name());
        int questionNumber = 0;
        for (ChunkRow chunk : chunks) {
            List<String> questions = splitQuestions(chunk.content());
            for (String question : questions) {
                String clean = clean(question);
                if (!looksLikePrompt(clean)) continue;
                Integer parsedNumber = number(clean);
                int ordinal = parsedNumber == null ? ++questionNumber : parsedNumber;
                String type = classify(clean);
                Double points = points(clean);
                if (DocumentType.PAST_EXAM.name().equals(effectiveType) && parsedNumber == null && points == null) continue;
                double difficulty = difficulty(type, points);
                UUID itemId = UUID.randomUUID();
                jdbc.update("INSERT INTO assessment_items(id,course_id,topic_id,source_chunk_id,document_id,type,prompt,answer,difficulty,question_number,points,page_start,page_end,source_type,year,explanation,extraction_confidence,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb)",
                        itemId, courseId, null, chunk.id(), documentId, type, clean, null, difficulty, ordinal, points, chunk.pageStart(), chunk.pageEnd(), effectiveType, year == 0 ? null : year, null, parsedNumber == null ? .5 : .8,
                        "{\"extracted\":true,\"parser\":\"local-v1\"}");
                linkTopics(courseId, itemId, chunk.id(), clean);
            }
        }
    }

    public int rebuild(UUID courseId) {
        List<UUID> documents = jdbc.query("SELECT id FROM documents WHERE course_id=? AND status='COMPLETED' ORDER BY created_at", (rs, row) -> rs.getObject("id", UUID.class), courseId);
        for (UUID documentId : documents) extractDocument(documentId, courseId);
        return jdbc.queryForObject("SELECT COUNT(*) FROM assessment_items WHERE course_id=? AND document_id IS NOT NULL", Integer.class, courseId);
    }

    private void linkTopics(UUID courseId, UUID itemId, UUID chunkId, String question) {
        List<TopicRow> linked = jdbc.query("SELECT t.id,t.canonical_name,COALESCE(ct.relevance,0),COALESCE((SELECT string_agg(a.normalized_alias,'|') FROM topic_aliases a WHERE a.topic_id=t.id),'') FROM topics t LEFT JOIN chunk_topics ct ON ct.topic_id=t.id AND ct.chunk_id=? WHERE t.course_id=?", (rs, row) -> new TopicRow(rs.getObject(1, UUID.class), rs.getString(2), rs.getDouble(3), rs.getString(4)), chunkId, courseId);
        String normalizedQuestion = normalize(question);
        for (TopicRow topic : linked) {
            String normalizedTopic = normalize(topic.name());
            double lexical = phraseMatch(normalizedQuestion, normalizedTopic) ? 1 : tokenOverlap(normalizedQuestion, normalizedTopic);
            if (aliasMatch(topic.aliases(), normalizedQuestion)) lexical = Math.max(lexical, .8);
            if (lexical >= .6) jdbc.update("INSERT INTO assessment_item_topics(item_id,topic_id,relevance) VALUES(?,?,?) ON CONFLICT(item_id,topic_id) DO UPDATE SET relevance=GREATEST(assessment_item_topics.relevance,EXCLUDED.relevance)", itemId, topic.id(), Math.min(1, lexical));
        }
    }

    /**
     * Whether one of the topic's own recorded aliases appears in the question. The aliases were extracted
     * from the student's uploaded material, so a question that writes "CRC" for "cyclic redundancy check"
     * and one that writes "SN1" for "unimolecular nucleophilic substitution" are matched the same way.
     */
    static boolean aliasMatch(String aliases, String question) {
        if (aliases == null || aliases.isBlank()) return false;
        for (String alias : aliases.split("\\|")) if (phraseMatch(question, alias.trim())) return true;
        return false;
    }

    /**
     * Whether the phrase occurs in the text as a whole word, tolerating a short inflectional ending so
     * "hash table" still matches "hash tables" and "Enzym" still matches "Enzyme". Plain containment
     * matched a short topic name inside an unrelated longer word — "ion" inside "ionosphere" — which
     * linked questions to topics they never mention. Two trailing letters is the limit: three would let
     * "react" match "reaction".
     */
    static boolean phraseMatch(String text, String phrase) {
        if (text == null || phrase == null || phrase.length() < 3) return false;
        for (int at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
            if (at > 0 && text.charAt(at - 1) != ' ') continue;
            int end = at + phrase.length();
            int tail = end;
            while (tail < text.length() && tail - end < 2 && Character.isLetter(text.charAt(tail))) tail++;
            if (tail == text.length() || text.charAt(tail) == ' ') return true;
        }
        return false;
    }

    private double tokenOverlap(String left, String right) {
        Set<String> a = new HashSet<>(Arrays.asList(left.split(" ")));
        Set<String> b = new HashSet<>(Arrays.asList(right.split(" ")));
        a.removeIf(token -> token.length() < 4); b.removeIf(token -> token.length() < 4);
        if (a.isEmpty() || b.isEmpty()) return 0;
        a.retainAll(b);
        return Math.min(1, (double) a.size() / Math.max(1, b.size()));
    }

    private List<String> splitQuestions(String content) {
        String clean = content == null ? "" : content.replace('\r', '\n');
        String[] parts = QUESTION_BOUNDARY.split(clean);
        List<String> result = new ArrayList<>();
        for (String part : parts) if (clean(part).length() >= 20) result.add(part);
        return result.isEmpty() ? List.of(clean) : result;
    }

    /**
     * Whether the fragment reads like a prompt rather than leftover heading or numbering debris. Counting
     * real words instead of characters keeps a line such as "Exercise/TTF 1 2 3 4 5 6" out of the item
     * table without naming any one course's section headings, and {@code \p{L}} keeps it working for
     * material that is not written in English.
     */
    static boolean looksLikePrompt(String clean) {
        if (clean == null || clean.length() < 20) return false;
        return Arrays.stream(clean.split("[^\\p{L}]+")).filter(word -> word.length() >= 3).count() >= 4;
    }

    private String clean(String value) {
        return value == null ? "" : value.replaceAll("\\s+", " ").replaceAll("(?i)^(question|exercise|problem|task)\\s*(?:no\\.?\\s*)?\\d+\\s*[:.)-]?\\s*", "").replaceFirst("^\\d+\\s*[.)]?\\s+", "").trim();
    }

    private Integer number(String value) { Matcher matcher = QUESTION_NUMBER.matcher(value); if (matcher.find()) return Integer.valueOf(matcher.group(1)); Matcher numeric = Pattern.compile("^\\s*(\\d+)\\s*[.)]?\\s+").matcher(value); return numeric.find() ? Integer.valueOf(numeric.group(1)) : null; }
    private Double points(String value) { Matcher matcher = POINTS.matcher(value); return matcher.find() ? Double.valueOf(matcher.group(1)) : null; }
    private int extractYear(String value) { Matcher matcher = YEAR.matcher(value == null ? "" : value); return matcher.find() ? Integer.parseInt(matcher.group(1)) : 0; }

    /**
     * The kind of task the question asks for, keyed on cognitive verbs rather than subject nouns:
     * "protocol" used to mean DESIGN, which mislabels a chemistry lab protocol, and "relax" used to mean
     * ALGORITHM_EXECUTION, which mislabels every question about a relaxed muscle or a relaxed constraint.
     */
    private String classify(String value) {
        String lower = value.toLowerCase(Locale.ROOT);
        if (lower.contains("multiple choice") || lower.matches(".*\\([a-d]\\).*")) return "MULTIPLE_CHOICE";
        if (lower.contains("prove") || lower.contains("proof") || lower.contains("show that")) return "PROOF";
        if (lower.contains("calculate") || lower.contains("compute") || lower.contains("find the value")) return "CALCULATION";
        if (lower.contains("trace") || lower.contains("execute") || lower.contains("step through") || lower.contains("simulate")) return "ALGORITHM_EXECUTION";
        if (lower.contains("compare") || lower.contains("difference between") || lower.contains("contrast")) return "COMPARE";
        if (lower.contains("define") || lower.contains("what is") || lower.contains("give the definition")) return "DEFINITION";
        if (lower.contains("explain") || lower.contains("describe")) return "EXPLANATION";
        if (lower.contains("design") || lower.contains("construct")) return "DESIGN";
        if (lower.contains("code") || lower.contains("implement") || lower.contains("program")) return "CODE";
        return "SHORT_ANSWER";
    }

    private double difficulty(String type, Double points) {
        double base = switch (type) { case "DEFINITION", "MULTIPLE_CHOICE" -> .35; case "EXPLANATION", "SHORT_ANSWER" -> .5; case "COMPARE", "CALCULATION" -> .65; case "ALGORITHM_EXECUTION", "CODE" -> .72; case "PROOF", "DESIGN" -> .82; default -> .55; };
        return Math.min(1, points == null ? base : Math.max(base, Math.min(1, .25 + points / 20)));
    }

    /**
     * The document type extraction should work from. A type the student actually chose wins outright:
     * previously a lecture deck named "midterm-review" was silently relabelled a past exam, and every
     * paragraph of it became an exam question.
     *
     * <p>Only an unset or OTHER type is inferred — first from unambiguous assessment wording, then from
     * the shared {@link SourceClassifier} so there is one place that recognises the remaining types.
     */
    static String effectiveType(String name, String current, String sample) {
        if (current != null && !current.isBlank() && !DocumentType.OTHER.name().equalsIgnoreCase(current)) return current;
        String nameLower = name == null ? "" : name.toLowerCase(Locale.ROOT);
        String text = nameLower + "\n" + (sample == null ? "" : sample.toLowerCase(Locale.ROOT));
        if (EXAM_FILENAME.matcher(nameLower).find() || text.contains("past exam")) return DocumentType.PAST_EXAM.name();
        if (HOMEWORK_FILENAME.matcher(nameLower).find() || text.contains("exercise sheet") || text.contains("problem set"))
            return DocumentType.HOMEWORK.name();
        return SourceClassifier.classify(name, sample).type().name();
    }

    private boolean isAssessment(String type) { return Set.of("PAST_EXAM", "HOMEWORK", "QUIZ", "ASSIGNMENT").contains(type.toUpperCase(Locale.ROOT)); }
    private String normalize(String value) { return value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9 ]", " ").replaceAll("\\s+", " ").trim(); }
    private record DocumentRow(String name, String type) {}
    private record ChunkRow(UUID id, Integer pageStart, Integer pageEnd, String content) {}
    private record TopicRow(UUID id, String name, double relevance, String aliases) {}
}
