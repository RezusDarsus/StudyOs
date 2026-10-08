package com.studyos.learner;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/workspaces/{workspaceId}/learner-state")
public class LearnerStateController {
    private final LearnerStateService learner;
    private final LearnerProfileService profiles;
    public LearnerStateController(LearnerStateService learner,LearnerProfileService profiles){this.learner=learner;this.profiles=profiles;}
    @GetMapping public LearnerStateService.LearnerState get(@PathVariable UUID workspaceId){return learner.get(workspaceId);}
    /** How this student learns, derived from recorded evidence and shared by every chat. */
    @GetMapping("/profile") public LearnerProfileService.Profile profile(@PathVariable UUID workspaceId){return profiles.profile(workspaceId);}
    /** Recomputes the profile now, instead of waiting for the next completed session. */
    @PostMapping("/profile/refresh") public LearnerProfileService.Profile refreshProfile(@PathVariable UUID workspaceId){return profiles.refresh(workspaceId);}
    @PutMapping("/preferences/{key}") public LearnerStateService.Preference preference(@PathVariable UUID workspaceId,@PathVariable String key,@Valid @RequestBody PreferenceRequest request){return learner.putPreference(workspaceId,key,request.value());}
    @DeleteMapping("/preferences/{key}") public ResponseEntity<Void> deletePreference(@PathVariable UUID workspaceId,@PathVariable String key){learner.deletePreference(workspaceId,key);return ResponseEntity.noContent().build();}
    @PostMapping("/misconceptions/{misconceptionId}/resolve") public ResponseEntity<Void> resolve(@PathVariable UUID workspaceId,@PathVariable UUID misconceptionId){learner.resolveMisconception(workspaceId,misconceptionId);return ResponseEntity.noContent().build();}
    public record PreferenceRequest(@NotBlank @Size(max=500) String value){}
}
