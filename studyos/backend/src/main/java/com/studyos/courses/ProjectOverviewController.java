package com.studyos.courses;

import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping({"/api/courses/{courseId}/overview", "/api/workspaces/{courseId}/overview"})
public class ProjectOverviewController {
    private final JdbcTemplate jdbc;
    public ProjectOverviewController(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @GetMapping
    public Overview get(@PathVariable UUID courseId) {
        Long sources = jdbc.queryForObject("SELECT COUNT(*) FROM documents WHERE course_id=?", Long.class, courseId);
        Long topics = jdbc.queryForObject("SELECT COUNT(*) FROM topics WHERE course_id=?", Long.class, courseId);
        Long chunks = jdbc.queryForObject("SELECT COUNT(*) FROM chunks WHERE course_id=?", Long.class, courseId);
        Long events = jdbc.queryForObject("SELECT COUNT(*) FROM learning_events WHERE course_id=?", Long.class, courseId);
        return new Overview(sources == null ? 0 : sources, topics == null ? 0 : topics, chunks == null ? 0 : chunks, events == null ? 0 : events);
    }

    public record Overview(long sourceCount,long topicCount,long chunkCount,long eventCount) {}
}
