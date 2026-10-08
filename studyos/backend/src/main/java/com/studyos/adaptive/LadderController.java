package com.studyos.adaptive;

import java.sql.Timestamp;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Read access to the adaptive difficulty ladder: which demand level every topic currently sits at,
 * what the next activity for one topic should be, and why.
 *
 * <p>Levels are returned as {@code rank + label + demand} rather than as enum constants, so a client
 * renders StudyOS's own wording instead of hardcoding six names it would then have to keep in step.
 *
 * <p>There is deliberately no endpoint for moving the ladder. It advances only from a graded attempt,
 * through {@link CognitiveLadderService#record}, so promotion always has evidence behind it.
 */
@RestController
@RequestMapping({"/api/courses/{courseId}/ladder", "/api/workspaces/{courseId}/ladder"})
public class LadderController {
    private final CognitiveLadderService ladder;
    public LadderController(CognitiveLadderService ladder) { this.ladder = ladder; }

    /** The demand levels StudyOS schedules against, lowest first. */
    @GetMapping("/levels")
    public List<Level> levels() { return Arrays.stream(CognitiveLevel.values()).map(Level::of).toList(); }

    /** Where each topic in this workspace stands, highest level first. */
    @GetMapping
    public List<TopicLadder> list(@PathVariable UUID courseId) {
        return ladder.list(courseId).stream().map(LadderController::view).toList();
    }

    /** The next activity for one topic. Enters the topic at a level derived from its evidence on first use. */
    @GetMapping("/topics/{topicId}")
    public NextActivity topic(@PathVariable UUID courseId, @PathVariable UUID topicId) {
        CognitiveLadderService.Plan plan = ladder.plan(courseId, topicId);
        return new NextActivity(plan.topicId(), plan.topic(), Level.of(plan.level()), round(plan.difficulty()), plan.diagnostic(),
                plan.remediationTopicId(), plan.remediationTopic(), plan.reason(), plan.attempts(),
                plan.consecutiveSuccess(), plan.consecutiveFailure());
    }

    private static TopicLadder view(CognitiveLadderService.Snapshot snapshot) {
        return new TopicLadder(snapshot.topicId(), snapshot.topic(), Level.of(snapshot.level()),
                snapshot.returnLevel() == null ? null : Level.of(snapshot.returnLevel()), snapshot.consecutiveSuccess(),
                snapshot.consecutiveFailure(), snapshot.attempts(), snapshot.diagnosticPending(), snapshot.remediationTopic(),
                snapshot.lastAction(), snapshot.lastReason(), snapshot.updatedAt());
    }

    private static double round(double value) { return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000.0; }

    public record Level(int rank, String name, String label, String demand) {
        static Level of(CognitiveLevel level) { return new Level(level.rank(), level.name(), level.label(), level.demand()); }
    }
    public record NextActivity(UUID topicId, String topic, Level level, double difficulty, boolean diagnostic,
                               UUID remediationTopicId, String remediationTopic, String reason, int attempts,
                               int consecutiveSuccess, int consecutiveFailure) {}
    public record TopicLadder(UUID topicId, String topic, Level level, Level returnLevel, int consecutiveSuccess,
                              int consecutiveFailure, int attempts, boolean diagnosticPending, String remediationTopic,
                              String lastAction, String lastReason, Timestamp updatedAt) {}
}
