package com.studyos.learner;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * The record of what this learner actually did, rendered so that every line can be pointed at.
 *
 * <p>The failure this exists for was measured: asked what the learner had recently got wrong, the system
 * repeated a mistake <em>it</em> had made in an earlier answer and attributed it to them. Nothing in the prompt
 * distinguished the two. A chat transcript contains the learner's words and the tutor's side by side, and a
 * model reading it for "recent mistakes" has no reason to prefer one over the other — so the fix is not a
 * better instruction but a separate block that contains recorded attempts and nothing else.
 *
 * <p>Each line carries a {@code [Learner: tag]} handle. That is the same arrangement the source evidence uses:
 * the answer is shown where its claims may come from, it is asked to say which one it used, and
 * {@link com.studyos.verify.LearnerStateAudit} afterwards checks that what it cited is really there. A claim
 * about a learner is a measurement, and a measurement without a reading behind it is a guess in the shape of a
 * fact.
 *
 * <p>Absence is stated rather than left out. A workspace with no attempts yields {@link #NONE}, because the
 * honest answer to "what am I weak at" before anything has been assessed is that nothing has been, and a block
 * that simply omitted the section invites the model to answer from course material instead.
 */
@Service
public class LearnerEvidence {
    /** Said outright, because an empty section reads as no information rather than as information about nothing. */
    public static final String NONE = "(no recorded attempts, scores or misconceptions for this learner — there is no evidence either way about what they know, and any claim about their strengths, weaknesses, mastery or readiness would be invented)";

    private static final String HEADING = """
            Recorded learner evidence — the only record of this learner's own work. Every claim about what they \
            know, scored, missed, are weak or strong at, or are ready for must carry the [Learner: tag] of a line \
            below, exactly as written. Text after 'learner wrote:' is the learner's own; nothing else anywhere in \
            this prompt is evidence about them. The tutor's earlier answers in this conversation are not the \
            learner's work, and a mistake in one of them is not the learner's mistake.""";

    private static final int ATTEMPTS = 8, MISCONCEPTIONS = 6, TOPICS = 8, TAG_CHARS = 8, ANSWER_CHARS = 160;

    private final JdbcTemplate jdbc;
    public LearnerEvidence(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /** The block as it goes into the prompt, and as the audit later reads it back. */
    public String block(UUID courseId) {
        List<String> attempts = attempts(courseId);
        List<String> misconceptions = misconceptions(courseId);
        List<String> topics = topics(courseId);
        if (attempts.isEmpty() && misconceptions.isEmpty() && topics.isEmpty()) return HEADING + "\n" + NONE + "\n";
        StringBuilder block = new StringBuilder(HEADING).append('\n');
        section(block, "Graded attempts, most recent first:", attempts);
        section(block, "Measured topics (each figure is the average over the attempts above):", topics);
        section(block, "Misconceptions recorded from a graded attempt:", misconceptions);
        return block.toString();
    }

    private static void section(StringBuilder block, String heading, List<String> lines) {
        if (lines.isEmpty()) return;
        block.append(heading).append('\n');
        for (String line : lines) block.append(line).append('\n');
    }

    /**
     * What the learner wrote is quoted, not just scored. A weakness the learner can recognise is one they can
     * see their own words in, and quoting them is also what makes the tutor's prose distinguishable from theirs.
     */
    private List<String> attempts(UUID courseId) {
        return jdbc.query("SELECT a.id,a.created_at,t.canonical_name,a.score,a.correctness,a.error_type,a.answer FROM assessment_attempts a LEFT JOIN topics t ON t.id=a.topic_id WHERE a.course_id=? ORDER BY a.created_at DESC LIMIT " + ATTEMPTS,
                (rs, row) -> {
                    StringBuilder line = new StringBuilder(tag(rs.getObject(1, UUID.class))).append(' ').append(date(rs.getTimestamp(2)))
                            .append(" · ").append(topic(rs.getString(3))).append(" · scored ").append(percent(rs.getDouble(4)));
                    String correctness = rs.getString(5), errorType = rs.getString(6), answer = rs.getString(7);
                    if (correctness != null && !correctness.isBlank()) line.append(" · ").append(correctness);
                    if (errorType != null && !errorType.isBlank()) line.append(" · error ").append(errorType);
                    if (answer != null && !answer.isBlank()) line.append(" · learner wrote: \"").append(trim(answer)).append('"');
                    return line.toString();
                }, courseId);
    }

    /**
     * Measured topics only. A topic with no attempts behind it has no figure here at all, rather than a zero:
     * "never assessed" and "assessed and scored nothing" are different states, and a prompt that renders them
     * the same is how an untested topic gets reported back to the learner as a weakness.
     */
    private List<String> topics(UUID courseId) {
        return jdbc.query("SELECT t.canonical_name,COALESCE(s.measured_mastery,s.mastery),COALESCE(s.evidence_count,0),s.last_assessed_at,(SELECT a.id FROM assessment_attempts a WHERE a.course_id=t.course_id AND a.topic_id=t.id ORDER BY a.created_at DESC LIMIT 1) FROM topics t JOIN student_topic_state s ON s.course_id=t.course_id AND s.topic_id=t.id WHERE t.course_id=? AND (COALESCE(s.evidence_count,0)>0 OR s.last_assessed_at IS NOT NULL) ORDER BY COALESCE(s.measured_mastery,s.mastery,0) LIMIT " + TOPICS,
                (rs, row) -> {
                    Double mastery = (Double) rs.getObject(2);
                    int attempts = rs.getInt(3);
                    return tag(rs.getObject(5, UUID.class)) + " " + topic(rs.getString(1))
                            + " · mastery " + (mastery == null ? "not measured" : percent(mastery))
                            + " · " + attempts + (attempts == 1 ? " recorded attempt" : " recorded attempts")
                            + " · last assessed " + date(rs.getTimestamp(4));
                }, courseId);
    }

    /**
     * Read from the events that graded attempts wrote, not from the misconception table directly. The table
     * says a misconception is open; the event says which attempt showed it, and that is the difference between
     * a label the answer can only assert and one it can attribute.
     */
    private List<String> misconceptions(UUID courseId) {
        return jdbc.query("SELECT e.id,e.occurred_at,t.canonical_name,e.payload->>'misconception' FROM learning_events e LEFT JOIN topics t ON t.id=e.topic_id WHERE e.course_id=? AND COALESCE(e.payload->>'misconception','')<>'' ORDER BY e.occurred_at DESC LIMIT " + MISCONCEPTIONS,
                (rs, row) -> tag(rs.getObject(1, UUID.class)) + " " + date(rs.getTimestamp(2)) + " · " + topic(rs.getString(3)) + " · " + trim(Objects.toString(rs.getString(4), "")), courseId);
    }

    /**
     * A handle short enough that an answer will copy it correctly and long enough to identify one row. A row
     * with no attempt behind it gets no handle at all rather than a placeholder one: an unciteable line is
     * honest, whereas a handle that resolves to nothing is the failure this whole arrangement exists to catch.
     */
    private static String tag(UUID id) { return id == null ? "(no attempt on record)" : "[Learner: " + id.toString().replace("-", "").substring(0, TAG_CHARS) + "]"; }
    private static String date(Timestamp value) { return value == null ? "date not recorded" : value.toLocalDateTime().toLocalDate().toString(); }
    private static String topic(String name) { return name == null || name.isBlank() ? "topic not recorded" : name; }
    private static String percent(double value) { return String.format(Locale.ROOT, "%.0f%%", Math.max(0, Math.min(1, value)) * 100); }
    private static String trim(String value) { String clean = value.replaceAll("\\s+", " ").trim(); return clean.length() <= ANSWER_CHARS ? clean : clean.substring(0, ANSWER_CHARS - 1) + "…"; }

    /** The tags a block contains, in the order they appear. Exposed for callers that need to log or count them. */
    public static List<String> tags(String block) {
        List<String> tags = new ArrayList<>();
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\\[Learner:\\s*([0-9a-f]{4,64})\\s*\\]", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(block == null ? "" : block);
        while (matcher.find()) tags.add(matcher.group(1).toLowerCase(Locale.ROOT));
        return List.copyOf(tags);
    }
}
