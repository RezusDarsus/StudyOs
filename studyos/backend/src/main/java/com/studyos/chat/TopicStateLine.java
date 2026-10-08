package com.studyos.chat;

import java.util.Locale;

/**
 * One line of the student-state block that a turn's prompt carries.
 *
 * <p>Extracted from the query that reads it so the wording can be tested without a database, because the
 * distinctions it draws are the ones the answers kept getting wrong. A topic with no recorded attempt must not
 * read as a topic that scored zero. A mastery figure must not be presented as what the learner can do right
 * now, when it is what they averaged over everything they have ever attempted. And a schedule that is overdue
 * has to say so, or a plan built from this block will keep proposing whatever is alphabetically first.
 *
 * <p>Only figures and the workspace's own topic name appear here, so the line reads the same in any subject.
 */
final class TopicStateLine {
    private TopicStateLine() {}

    /**
     * @param mastery   the counted mastery, or null when nothing has been recorded for this topic
     * @param recall    probability the learner could answer now — the traced knowledge estimate discounted by
     *                  how long it has been since they last proved it — or null when it was never measured
     * @param reviewInDays days until the scheduler brings the topic back; negative when it is already overdue
     */
    static String render(String name, Double mastery, Double confidence, Double relevance, Double recall, Long reviewInDays) {
        StringBuilder line = new StringBuilder("- ").append(name).append(": ");
        line.append(mastery == null ? "not yet assessed"
                : percent("mastery", mastery) + ", confidence " + (confidence == null ? "not recorded" : figure(confidence)));
        if (mastery != null && recall != null) line.append(", ").append(percent("recall now", recall));
        if (mastery != null && reviewInDays != null) line.append(", ").append(review(reviewInDays));
        return line.append(", ").append(relevance == null ? "exam relevance unknown" : percent("exam relevance", relevance)).toString();
    }

    /** Overdue is stated as overdue: "due in minus four days" is not something a plan can act on. */
    private static String review(long days) {
        if (days < 0) return "review overdue by " + -days + (days == -1 ? " day" : " days");
        if (days == 0) return "review due today";
        return "review due in " + days + (days == 1 ? " day" : " days");
    }

    private static String percent(String label, double value) { return label + " " + figure(value); }
    private static String figure(double value) { return String.format(Locale.ROOT, "%.0f%%", Math.max(0, Math.min(1, value)) * 100); }
}
