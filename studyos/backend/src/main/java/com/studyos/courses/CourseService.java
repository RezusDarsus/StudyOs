package com.studyos.courses;

import java.sql.Date;
import java.time.LocalDate;
import java.util.Optional;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class CourseService {
    private final JdbcTemplate jdbc;
    public CourseService(JdbcTemplate jdbc) { this.jdbc = jdbc; }
    public CourseController.Course create(CourseController.CreateCourseRequest request) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO courses(id,name,description,exam_date) VALUES (?,?,?,?)", id, request.name(), request.description(), request.examDate() == null ? null : Date.valueOf(request.examDate()));
        return new CourseController.Course(id, request.name(), request.description(), request.examDate());
    }
    public Optional<CourseController.Course> find(UUID id) { return jdbc.query("SELECT id,name,description,exam_date FROM courses WHERE id=?", rs -> { if (!rs.next()) return Optional.empty(); Date examDate = rs.getDate("exam_date"); return Optional.of(new CourseController.Course(rs.getObject("id", UUID.class), rs.getString("name"), rs.getString("description"), examDate == null ? null : examDate.toLocalDate())); }, id); }
    public List<CourseController.Course> list() { return jdbc.query("SELECT id,name,description,exam_date FROM courses ORDER BY created_at DESC", (rs,row) -> { Date examDate=rs.getDate("exam_date"); return new CourseController.Course(rs.getObject("id",UUID.class),rs.getString("name"),rs.getString("description"),examDate==null?null:examDate.toLocalDate()); }); }
}
