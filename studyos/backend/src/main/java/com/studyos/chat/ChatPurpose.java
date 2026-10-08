package com.studyos.chat;

import java.util.Locale;
import java.util.Objects;

/**
 * What a chat is for. A workspace holds several at once — a main tutor, homework help, one week's deep
 * dive, exam preparation — and they all read and write the same student and course memory, so a
 * mistake made while working through homework is known to the exam-preparation chat.
 *
 * <p>The purpose earns its place by deciding turns that do not say what they want. "Another one" in a
 * difficult-exercises chat is a request for another exercise; the same words in homework help are a
 * request for help with the next item. It never overrides a turn that names its own request, which is
 * why {@link #fallbackIntent()} is a preference and not a mode.
 *
 * <p>Nothing here names a subject. A purpose describes how the student is working, not what they are
 * working on, so the same six purposes fit a chemistry course and a contract law course.
 */
public enum ChatPurpose {
    /** No stated purpose: every turn is read on its own wording. */
    GENERAL("General", "New study chat", "Every message is read on its own wording.", null),
    /** The course's main thread. Broad enough that guessing at unspecific turns would be wrong. */
    MAIN_TUTOR("Main tutor", "Main tutor", "The main thread for this course — anything, any time.", null),
    /** Work on an item the student already has. Unspecific turns are asking for help with it. */
    HOMEWORK_HELP("Homework help", "Homework help", "Work through something you already have, one step at a time.", QueryIntent.HOMEWORK_HELP),
    /** One week or one topic, taken slowly. A bare phrase here is something to be taught. */
    DEEP_DIVE("Deep dive", "Deep dive", "One week or one topic, taught slowly and from the start.", QueryIntent.EXPLAIN_TOPIC),
    /** Everything aimed at the exam, so a bare topic means "tell me how this sits in the exam". */
    EXAM_PREPARATION("Exam preparation", "Exam preparation", "Everything aimed at the exam: what matters and how ready you are.", QueryIntent.EXAM_ANALYSIS),
    /** Harder work on demand: "again", "another", "more" all mean generate another exercise. */
    HARD_EXERCISES("Difficult exercises", "Difficult exercises", "Harder exercises on demand, built from your own material.", QueryIntent.HARD_NEW),
    /** Short answers during a lecture, where the student has no time to phrase a full request. */
    LECTURE_QUESTIONS("Questions during lecture", "Questions during lecture", "Short answers while a lecture is running.", QueryIntent.FACTUAL_QA);

    private final String label;
    private final String defaultTitle;
    private final String hint;
    private final QueryIntent fallbackIntent;

    ChatPurpose(String label, String defaultTitle, String hint, QueryIntent fallbackIntent) {
        this.label = label;
        this.defaultTitle = defaultTitle;
        this.hint = hint;
        this.fallbackIntent = fallbackIntent;
    }

    public String label() { return label; }

    /** The name a student would give this chat, used when they do not type one. */
    public String defaultTitle() { return defaultTitle; }

    /** One line a student can choose from, so what a purpose means is written down once. */
    public String hint() { return hint; }

    /** How to read a turn that names no request of its own, or null to read it as any other. */
    public QueryIntent fallbackIntent() { return fallbackIntent; }

    /**
     * Unknown and missing values become {@link #GENERAL} rather than failing. A chat row written before
     * purposes existed, or by a client that sends something new, is still a usable chat.
     */
    public static ChatPurpose of(String value) {
        if (value == null || value.isBlank()) return GENERAL;
        String normalized = value.trim().toUpperCase(Locale.ROOT).replace(' ', '_').replace('-', '_');
        for (ChatPurpose purpose : values()) if (purpose.name().equals(normalized)) return purpose;
        return GENERAL;
    }

    public static ChatPurpose orGeneral(ChatPurpose purpose) { return Objects.requireNonNullElse(purpose, GENERAL); }
}
