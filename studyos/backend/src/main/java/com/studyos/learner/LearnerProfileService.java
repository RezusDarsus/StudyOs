package com.studyos.learner;

import com.studyos.adaptive.CognitiveLevel;
import com.studyos.mastery.RetentionModel;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * The long-term student model. It answers "how does this person learn" rather than "what do they
 * know", and it is shared by every chat in the workspace, so a failure recorded while doing homework
 * is already known to the exam-preparation chat.
 *
 * <p>Everything here is derived from recorded evidence — attempts, misconceptions, support use,
 * session history — by {@link LearnerProfiler}. Reads are cheap and side-effect free; {@link
 * #refresh(UUID)} is the only method that writes, and it mark-and-sweeps so a trait that no longer
 * holds disappears instead of lingering.
 */
@Service
public class LearnerProfileService {
    /** How far back "how often do they actually study" looks. */
    private static final int RHYTHM_WINDOW_DAYS = 28;
    /** Cap on the attempt scan behind the cognitive-level breakdown, so the query stays bounded. */
    private static final int LEVEL_SCAN_LIMIT = 500;
    private static final int DIGEST_TRAITS = 10;

    private final JdbcTemplate jdbc;

    public LearnerProfileService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /** The stored profile. Read-only, so it is safe on any request path. */
    public Profile profile(UUID workspaceId) {
        List<Trait> traits = jdbc.query("SELECT trait_type,subject,topic_id,detail,value,evidence_count,confidence,computed_at FROM learner_profile_traits WHERE course_id=?",
                (rs, row) -> {
                    LearnerTraitKind kind = LearnerTraitKind.of(rs.getString(1));
                    return new Trait(kind, kind.label(), kind.polarity().name(), rs.getString(2), rs.getObject(3, UUID.class),
                            rs.getString(4), rs.getDouble(5), rs.getInt(6), rs.getDouble(7), kind.teachingHint(), rs.getTimestamp(8));
                }, workspaceId).stream().sorted(ordering()).toList();
        Timestamp computedAt = traits.stream().map(Trait::computedAt).filter(Objects::nonNull).max(Comparator.naturalOrder()).orElse(null);
        return new Profile(workspaceId, traits,
                traits.stream().filter(trait -> trait.kind().strength()).toList(),
                traits.stream().filter(trait -> trait.kind().risk()).toList(),
                traits.stream().filter(trait -> trait.kind().polarity() == LearnerTraitKind.Polarity.NEUTRAL).toList(),
                teachingHints(traits), computedAt);
    }

    /** Recomputes the profile from current evidence and replaces what was stored. */
    public Profile refresh(UUID workspaceId) {
        List<LearnerProfiler.Trait> derived = LearnerProfiler.derive(evidence(workspaceId));
        Timestamp stamp = Timestamp.from(Instant.now());
        for (LearnerProfiler.Trait trait : derived)
            jdbc.update("INSERT INTO learner_profile_traits(id,course_id,trait_type,subject,topic_id,detail,value,evidence_count,confidence,computed_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(course_id,trait_type,subject) DO UPDATE SET topic_id=EXCLUDED.topic_id,detail=EXCLUDED.detail,value=EXCLUDED.value,evidence_count=EXCLUDED.evidence_count,confidence=EXCLUDED.confidence,computed_at=EXCLUDED.computed_at",
                    UUID.randomUUID(), workspaceId, trait.kind().name(), trim(trait.subject()), trait.topicId(), trait.detail(),
                    trait.value(), trait.evidenceCount(), trait.confidence(), stamp);
        // Sweep: anything this run did not restate no longer holds. A concurrent later run stamps
        // ahead of us, so its rows survive.
        jdbc.update("DELETE FROM learner_profile_traits WHERE course_id=? AND computed_at<?", workspaceId, stamp);
        return profile(workspaceId);
    }

    /**
     * A compact rendering for prompt context, phrased so the model can act on it. Deliberately says
     * nothing about the subject beyond the workspace's own topic and misconception names.
     */
    public String digest(UUID workspaceId) {
        Profile profile = profile(workspaceId);
        if (profile.traits().isEmpty()) return "";
        StringBuilder result = new StringBuilder("How this student learns (observed across every chat in this workspace):\n");
        profile.traits().stream().limit(DIGEST_TRAITS).forEach(trait -> result.append("- ").append(trait.kindLabel())
                .append(" — ").append(trait.subject())
                .append(trait.detail() == null || trait.detail().isBlank() ? "" : ": " + trait.detail())
                .append(String.format(java.util.Locale.ROOT, " (confidence %.0f%%)", trait.confidence() * 100)).append('\n'));
        if (!profile.teachingHints().isEmpty()) {
            result.append("Adapt teaching accordingly (never alter source truth):\n");
            profile.teachingHints().forEach(hint -> result.append("- ").append(hint).append('\n'));
        }
        return result.toString();
    }

    // ---- evidence gathering -------------------------------------------------------------------

    private LearnerProfiler.Evidence evidence(UUID workspaceId) {
        return new LearnerProfiler.Evidence(topics(workspaceId), mistakes(workspaceId), levels(workspaceId), behaviour(workspaceId));
    }

    private List<LearnerProfiler.TopicEvidence> topics(UUID workspaceId) {
        Instant now = Instant.now();
        return jdbc.query("SELECT t.id,t.canonical_name,COUNT(a.id),COALESCE(s.evidence_count,0),COALESCE(AVG(a.score),0),COALESCE(SUM(a.mastery_impact),0),COALESCE(s.measured_mastery,s.mastery,0),COALESCE(s.last_studied_at,s.last_assessed_at,s.updated_at),COALESCE(s.stability_days,0) FROM topics t LEFT JOIN student_topic_state s ON s.topic_id=t.id AND s.course_id=t.course_id LEFT JOIN assessment_attempts a ON a.topic_id=t.id AND a.course_id=t.course_id WHERE t.course_id=? GROUP BY t.id,t.canonical_name,s.evidence_count,s.measured_mastery,s.mastery,s.last_studied_at,s.last_assessed_at,s.updated_at,s.stability_days ORDER BY t.canonical_name",
                (rs, row) -> {
                    double measured = rs.getDouble(7);
                    Timestamp anchor = rs.getTimestamp(8);
                    // Decayed at the rate this topic's own review history earned, so a topic proved repeatedly
                    // is not written off at the same age as one scraped through once.
                    double effective = RetentionModel.effectiveMastery(measured, anchor == null ? null : anchor.toInstant(), now, rs.getDouble(9));
                    return new LearnerProfiler.TopicEvidence(rs.getObject(1, UUID.class), rs.getString(2), rs.getInt(3),
                            rs.getInt(4), rs.getDouble(5), rs.getDouble(6), measured, effective);
                }, workspaceId);
    }

    private List<LearnerProfiler.MistakeEvidence> mistakes(UUID workspaceId) {
        return jdbc.query("SELECT m.label,m.topic_id,t.canonical_name,m.occurrences,m.severity,m.status FROM misconceptions m LEFT JOIN topics t ON t.id=m.topic_id WHERE m.course_id=? ORDER BY m.severity DESC,m.occurrences DESC LIMIT 40",
                (rs, row) -> new LearnerProfiler.MistakeEvidence(rs.getString(1), rs.getObject(2, UUID.class), rs.getString(3),
                        rs.getInt(4), rs.getDouble(5), rs.getString(6)), workspaceId);
    }

    /**
     * Performance per cognitive level. Attempts recorded before levels existed are placed by their
     * difficulty, using the enum's own bands so the mapping is defined in exactly one place.
     */
    private List<LearnerProfiler.LevelEvidence> levels(UUID workspaceId) {
        Map<Integer, double[]> byLevel = new LinkedHashMap<>();
        jdbc.query("SELECT cognitive_level,difficulty,score FROM assessment_attempts WHERE course_id=? ORDER BY created_at DESC LIMIT " + LEVEL_SCAN_LIMIT,
                rs -> {
                    Integer recorded = rs.getObject(1, Integer.class);
                    int level = recorded != null ? CognitiveLevel.ofRank(recorded).rank()
                            : CognitiveLevel.ofDifficulty(rs.getDouble(2)).rank();
                    double[] bucket = byLevel.computeIfAbsent(level, key -> new double[2]);
                    bucket[0]++;
                    bucket[1] += rs.getDouble(3);
                }, workspaceId);
        List<LearnerProfiler.LevelEvidence> levels = new ArrayList<>();
        byLevel.forEach((level, bucket) -> levels.add(new LearnerProfiler.LevelEvidence(level, (int) bucket[0],
                bucket[0] == 0 ? 0 : bucket[1] / bucket[0])));
        levels.sort(Comparator.comparingInt(LearnerProfiler.LevelEvidence::level));
        return levels;
    }

    private LearnerProfiler.BehaviourEvidence behaviour(UUID workspaceId) {
        int[] support = jdbc.query("SELECT COUNT(*),COUNT(*) FILTER (WHERE COALESCE(support_level_used,0)>0) FROM assessment_attempts WHERE course_id=?",
                rs -> rs.next() ? new int[] {rs.getInt(1), rs.getInt(2)} : new int[2], workspaceId);
        Integer revealed = jdbc.queryForObject("SELECT COUNT(*) FROM exercise_support_events WHERE course_id=? AND revealed_solution", Integer.class, workspaceId);
        Integer activeDays = jdbc.queryForObject("SELECT COUNT(DISTINCT DATE(occurred_at)) FROM learning_events WHERE course_id=? AND occurred_at>=NOW()-make_interval(days => ?)",
                Integer.class, workspaceId, RHYTHM_WINDOW_DAYS);
        int[] sessions = jdbc.query("SELECT COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_minutes),0),COUNT(*) FROM learning_sessions WHERE course_id=? AND duration_minutes>0",
                rs -> rs.next() ? new int[] {(int) Math.round(rs.getDouble(1)), rs.getInt(2)} : new int[2], workspaceId);
        int[] steps = jdbc.query("SELECT COUNT(*) FILTER (WHERE status='COMPLETED'),COUNT(*) FILTER (WHERE status='SKIPPED') FROM tutor_session_steps WHERE course_id=?",
                rs -> rs.next() ? new int[] {rs.getInt(1), rs.getInt(2)} : new int[2], workspaceId);
        return new LearnerProfiler.BehaviourEvidence(support[0], support[1], revealed == null ? 0 : revealed,
                activeDays == null ? 0 : activeDays, RHYTHM_WINDOW_DAYS, sessions[0], sessions[1], steps[0], steps[1]);
    }

    /** One hint per kind present, in reading order, so the same advice is not repeated per topic. */
    private List<String> teachingHints(List<Trait> traits) {
        return traits.stream().map(Trait::kind).filter(kind -> kind.polarity() != LearnerTraitKind.Polarity.NEUTRAL)
                .distinct().sorted(Comparator.comparingInt(Enum::ordinal)).map(LearnerTraitKind::teachingHint).toList();
    }

    private Comparator<Trait> ordering() {
        return Comparator.comparingInt((Trait trait) -> trait.kind().ordinal())
                .thenComparing(Comparator.comparingDouble(Trait::value).reversed())
                .thenComparing(trait -> Objects.toString(trait.subject(), ""));
    }

    private String trim(String value) { String clean = Objects.toString(value, ""); return clean.length() <= 500 ? clean : clean.substring(0, 500); }

    public record Trait(LearnerTraitKind kind, String kindLabel, String polarity, String subject, UUID topicId,
                        String detail, double value, int evidenceCount, double confidence, String teachingHint,
                        Timestamp computedAt) {}
    public record Profile(UUID workspaceId, List<Trait> traits, List<Trait> strengths, List<Trait> risks,
                          List<Trait> behaviour, List<String> teachingHints, Timestamp computedAt) {}
}
