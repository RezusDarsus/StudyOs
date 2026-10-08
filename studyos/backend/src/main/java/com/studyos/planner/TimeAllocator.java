package com.studyos.planner;

/** Pure task-duration policy. */
public final class TimeAllocator {
    private TimeAllocator() {}

    public static int minutesFor(String action) {
        return switch (action) {
            case "LEARN" -> 30;
            case "REVIEW_MISTAKE", "REVIEW" -> 20;
            case "EXAM_STYLE_TEST", "MOCK_EXAM" -> 30;
            case "QUIZ" -> 15;
            default -> 25;
        };
    }
}
