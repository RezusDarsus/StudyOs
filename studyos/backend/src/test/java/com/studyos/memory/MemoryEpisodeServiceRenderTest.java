package com.studyos.memory;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

/**
 * Recall is where one chat's text becomes another chat's context, so the roles it renders are a correctness
 * property rather than formatting: a tutor claim read back as the learner's words becomes a false statement
 * about the learner, and that is what produced a review of "your mistake" for a mistake the tutor had made.
 */
class MemoryEpisodeServiceRenderTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final MemoryEpisodeService service = new MemoryEpisodeService(null, null, mapper);

    @Test void aTurnIsStoredWithTheRoleAttachedToEachSideOfIt() {
        String records = service.turnRecords("Is the remainder 01110?", "No — dividing gives 01101.");
        assertThat(records).contains("\"role\":\"LEARNER\"").contains("Is the remainder 01110?")
                .contains("\"role\":\"TUTOR\"").contains("dividing gives 01101");
    }

    @Test void recallKeepsTheLearnersWordsApartFromTheTutorsOwnEarlierOutput() {
        String rendered = service.render(service.turnRecords("I think the answer is 00101", "The remainder is 01110."), "unused prose", "crc remainder");
        assertThat(rendered).contains("about crc remainder");
        assertThat(rendered).contains("The learner wrote: \"I think the answer is 00101\"");
        assertThat(rendered).contains("You answered then").contains("not course evidence");
        int learnerAt = rendered.indexOf("The learner wrote"), tutorAt = rendered.indexOf("You answered then");
        assertThat(learnerAt).isLessThan(tutorAt);
        assertThat(rendered.substring(learnerAt, tutorAt)).doesNotContain("The remainder is 01110");
    }

    /** Episodes written before roles were separated must not be presented as though the learner said them. */
    @Test void anEpisodeWithNoRecordedRolesIsRenderedWithoutAttribution() {
        String rendered = service.render("[]", "Student asked: x\nTutor answered: y", "topic");
        assertThat(rendered).contains("roles not recorded").contains("attribute nothing in it to the learner");
        assertThat(rendered).doesNotContain("The learner wrote");
    }

    @Test void unreadableRecordsFallBackToTheProseSummaryRatherThanLosingTheEpisode() {
        String rendered = service.render("{not json", "Student asked: x", "topic");
        assertThat(rendered).contains("roles not recorded").contains("Student asked: x");
    }

    /** A newline or a quote in a learner's message used to produce a JSON literal Postgres would reject. */
    @Test void storedJsonSurvivesTextThatWouldBreakHandBuiltEscaping() throws Exception {
        String array = service.jsonArray("QUESTION: solve\nx+1=2 and say \"why\"\\");
        assertThat(mapper.readTree(array).get(0).asText()).isEqualTo("QUESTION: solve\nx+1=2 and say \"why\"\\");
        assertThat(mapper.readTree(service.turnRecords("line one\nline \"two\"", "a\\b")).get(0).path("text").asText()).isEqualTo("line one\nline \"two\"");
    }
}
