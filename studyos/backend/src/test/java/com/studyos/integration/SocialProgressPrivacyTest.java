package com.studyos.integration;

import static org.junit.jupiter.api.Assertions.assertFalse;
import java.util.Arrays;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

class SocialProgressPrivacyTest {
    @Test void socialContractCannotExposePrivateLearnerState(){Set<String> fields=Arrays.stream(GoalifyIntegrationService.SocialProgress.class.getRecordComponents()).map(component->component.getName().toLowerCase()).collect(Collectors.toSet());for(String forbidden:Set.of("mastery","misconception","readiness","topic","answer","source"))assertFalse(fields.stream().anyMatch(field->field.contains(forbidden)));}
}
