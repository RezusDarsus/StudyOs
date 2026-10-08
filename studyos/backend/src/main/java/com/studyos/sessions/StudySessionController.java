package com.studyos.sessions;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/workspaces/{workspaceId}/sessions")
public class StudySessionController {
    private final StudySessionService sessions;
    public StudySessionController(StudySessionService sessions){this.sessions=sessions;}
    @PostMapping
    public ResponseEntity<StudySessionService.Session> start(@PathVariable UUID workspaceId,@RequestBody(required=false) StartRequest request){StartRequest value=request==null?new StartRequest(null,null):request;return ResponseEntity.ok(sessions.start(workspaceId,value.taskId(),value.topicId()));}
    @GetMapping
    public List<StudySessionService.Session> list(@PathVariable UUID workspaceId){return sessions.list(workspaceId);}
    @GetMapping("/{sessionId}")
    public ResponseEntity<StudySessionService.Session> get(@PathVariable UUID workspaceId,@PathVariable UUID sessionId){return ResponseEntity.ok(sessions.get(workspaceId,sessionId));}
    @PostMapping("/{sessionId}/complete")
    public ResponseEntity<StudySessionService.Completion> complete(@PathVariable UUID workspaceId,@PathVariable UUID sessionId,@Valid @RequestBody(required=false) CompleteRequest request){CompleteRequest value=request==null?new CompleteRequest(null,null):request;return ResponseEntity.ok(sessions.complete(workspaceId,sessionId,value.durationMinutes(),value.notes()));}
    public record StartRequest(UUID taskId,UUID topicId){}
    public record CompleteRequest(@Min(1) @Max(720) Integer durationMinutes,@Size(max=10000) String notes){}
}
