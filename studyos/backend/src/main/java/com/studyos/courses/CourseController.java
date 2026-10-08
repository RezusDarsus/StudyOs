package com.studyos.courses;

import java.time.LocalDate;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.util.List;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping("/api/courses")
public class CourseController {
    private final CourseService courses;
    public CourseController(CourseService courses) { this.courses = courses; }
    @PostMapping
    public ResponseEntity<Course> create(@Valid @RequestBody CreateCourseRequest request) { return ResponseEntity.ok(courses.create(request)); }
    @GetMapping("/{id}")
    public ResponseEntity<Course> get(@PathVariable UUID id) { return courses.find(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build()); }
    @GetMapping public List<Course> list() { return courses.list(); }
    public record CreateCourseRequest(@NotBlank @Size(max=255) String name, @Size(max=2000) String description, LocalDate examDate) {}
    public record Course(UUID id, String name, String description, LocalDate examDate) {}
}
