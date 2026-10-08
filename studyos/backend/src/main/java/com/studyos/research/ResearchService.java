package com.studyos.research;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Reads and starts research runs, and is the record of what research produced. The bounded work
 * itself happens in {@link ResearchRunner}; this service owns the course-facing rules — whether
 * the workspace's mode allows research at all, and whether a run is already under way.
 */
@Service
public class ResearchService {
    private final JdbcTemplate jdbc;

    public ResearchService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /**
     * Starts a research run for the workspace's stated goal, refusing workspaces whose mode keeps
     * the knowledge base closed and workspaces that already have a run in flight.
     */
    public Run start(UUID courseId, String goal, ResearchMode modeOverride) {
        if (goal == null || goal.isBlank()) throw new IllegalArgumentException("A learning goal is required before research can run");
        Course course = jdbc.query("SELECT name,research_mode FROM courses WHERE id=?", rs -> {
            if (!rs.next()) return null;
            String stored = rs.getString("research_mode");
            return new Course(rs.getString("name"), stored == null ? ResearchMode.SOURCE_ONLY : ResearchMode.valueOf(stored));
        }, courseId);
        if (course == null) throw new IllegalArgumentException("Workspace was not found");
        ResearchMode mode = modeOverride == null ? course.mode() : modeOverride;
        if (!mode.allowsResearch())
            throw new com.studyos.WorkspaceNotReadyException("This workspace's source mode is SOURCE_ONLY, so online research is refused. Switch its research mode first if you want researched material in the knowledge base.");
        Boolean running = jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM research_runs WHERE course_id=? AND status IN ('QUEUED','RUNNING'))", Boolean.class, courseId);
        if (Boolean.TRUE.equals(running)) throw new com.studyos.WorkspaceNotReadyException("A research run is already in progress for this workspace");
        UUID runId = UUID.randomUUID();
        jdbc.update("INSERT INTO research_runs(id,course_id,goal,mode,status) VALUES(?,?,?,?, 'QUEUED')", runId, courseId, goal.trim(), mode.name());
        return new Run(runId, courseId, goal.trim(), mode.name(), "QUEUED", 0, 0, 0, 0, 0, 0, 0, null, Timestamp.from(Instant.now()), null);
    }

    /** The most recent run of the workspace and every source it and earlier runs brought in. */
    public Status status(UUID courseId) {
        Run run = jdbc.query("SELECT id,course_id,goal,mode,status,planned_queries,queries_run,candidates_found,sources_ingested,sources_skipped,sources_failed,bytes_fetched,error,created_at,completed_at FROM research_runs WHERE course_id=? ORDER BY created_at DESC LIMIT 1",
                rs -> rs.next() ? read(rs) : null, courseId);
        List<Source> sources = jdbc.query("SELECT id,run_id,document_id,url,canonical_url,domain,title,provider,query,quality_score,content_hash,byte_size,content_type,retrieved_at,published_at FROM research_sources WHERE course_id=? ORDER BY retrieved_at DESC LIMIT 100",
                (rs, row) -> new Source(rs.getObject("id", UUID.class), rs.getObject("run_id", UUID.class), rs.getObject("document_id", UUID.class),
                        rs.getString("url"), rs.getString("canonical_url"), rs.getString("domain"), rs.getString("title"), rs.getString("provider"),
                        rs.getString("query"), rs.getObject("quality_score", Double.class), rs.getString("content_hash"),
                        rs.getObject("byte_size", Integer.class), rs.getString("content_type"),
                        rs.getTimestamp("retrieved_at"), rs.getTimestamp("published_at")), courseId);
        return new Status(run, sources);
    }

    private Run read(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new Run(rs.getObject("id", UUID.class), rs.getObject("course_id", UUID.class), rs.getString("goal"), rs.getString("mode"), rs.getString("status"),
                rs.getInt("planned_queries"), rs.getInt("queries_run"), rs.getInt("candidates_found"), rs.getInt("sources_ingested"),
                rs.getInt("sources_skipped"), rs.getInt("sources_failed"), rs.getLong("bytes_fetched"), rs.getString("error"),
                rs.getTimestamp("created_at"), rs.getTimestamp("completed_at"));
    }

    public record Run(UUID id, UUID courseId, String goal, String mode, String status, int plannedQueries, int queriesRun,
                      int candidatesFound, int sourcesIngested, int sourcesSkipped, int sourcesFailed, long bytesFetched,
                      String error, Timestamp createdAt, Timestamp completedAt) {}

    public record Source(UUID id, UUID runId, UUID documentId, String url, String canonicalUrl, String domain, String title,
                         String provider, String query, Double qualityScore, String contentHash, Integer byteSize,
                         String contentType, Timestamp retrievedAt, Timestamp publishedAt) {}

    public record Status(Run latestRun, List<Source> sources) {}

    private record Course(String name, ResearchMode mode) {}
}
