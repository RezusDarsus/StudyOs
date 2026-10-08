package com.studyos.ingestion;

import java.util.Locale;

/** Deterministic first-pass classification; callers can override it explicitly. */
public final class SourceClassifier {
    private SourceClassifier() {}

    public static Classification classify(String filename, String content) {
        String name = normalize(filename);
        String text = normalize(content);
        String sample = (name + " " + text.substring(0, Math.min(text.length(), 30_000))).trim();

        if (containsAny(sample, "syllabus", "grading policy", "course schedule", "learning objectives"))
            return new Classification(DocumentType.SYLLABUS, .92, "syllabus structure");
        if (containsAny(sample, "past exam", "final examination", "midterm examination", "exam solutions") || name.matches(".*(?:exam|midterm|final)[ _-]?(?:19|20)\\d{2}.*"))
            return new Classification(DocumentType.PAST_EXAM, .90, "exam wording or dated exam filename");
        if (containsAny(name, "homework", "problem set", "worksheet", "assignment") || containsAny(sample, "homework problems", "submit your solutions", "due date"))
            return new Classification(name.contains("assignment") ? DocumentType.ASSIGNMENT : DocumentType.HOMEWORK, .86, "exercise and submission wording");
        if (containsAny(name, "quiz") || containsAny(sample, "quiz questions", "quiz instructions"))
            return new Classification(DocumentType.QUIZ, .84, "quiz wording");
        if (containsAny(name, "lecture", "slides", "week ", "module ") || containsAny(sample, "lecture notes", "today's lecture"))
            return new Classification(DocumentType.LECTURE, .78, "lecture or module wording");
        if (containsAny(name, "textbook", "chapter") || text.matches("(?s).*\\bchapter\\s+\\d+\\b.*"))
            return new Classification(DocumentType.TEXTBOOK, .72, "chapter structure");
        if (containsAny(name, "professor note", "instructor note"))
            return new Classification(DocumentType.PROFESSOR_NOTE, .78, "instructor-note filename");
        if (containsAny(name, "notes", "note"))
            return new Classification(DocumentType.STUDENT_NOTE, .62, "notes filename");
        return new Classification(DocumentType.OTHER, .35, "no strong source-type signal");
    }

    private static boolean containsAny(String value, String... needles) {
        for (String needle : needles) if (value.contains(needle)) return true;
        return false;
    }

    private static String normalize(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
    }

    public record Classification(DocumentType type, double confidence, String reason) {}
}
