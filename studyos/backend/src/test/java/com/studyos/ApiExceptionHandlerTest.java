package com.studyos;

import static org.assertj.core.api.Assertions.assertThat;

import com.studyos.ai.AiProviderException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;

class ApiExceptionHandlerTest {
    private final ApiExceptionHandler handler = new ApiExceptionHandler();

    @Test
    void mapsExhaustedTransientProviderFailuresToServiceUnavailable() {
        var request = new MockHttpServletRequest("POST", "/api/workspaces/one/chats/two/messages");

        var response = handler.providerFailure(new AiProviderException("NVIDIA", 404, true, "NVIDIA returned HTTP 404"), request);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(response.getHeaders().getFirst("Retry-After")).isEqualTo("2");
        assertThat(response.getBody().message()).contains("temporarily unavailable");
    }

    @Test
    void mapsPermanentProviderRejectionsToBadGateway() {
        var request = new MockHttpServletRequest("POST", "/api/workspaces/one/chats/two/messages");

        var response = handler.providerFailure(new AiProviderException("NVIDIA", 404, false, "NVIDIA returned HTTP 404"), request);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_GATEWAY);
        assertThat(response.getHeaders().containsKey("Retry-After")).isFalse();
        assertThat(response.getBody().message()).contains("configured model and credentials");
    }

    /**
     * "Upload a syllabus first" is an answer, not a failure. Before this mapping existed the reason was
     * logged server-side and the student saw a bare 500, which reads as "StudyOS is broken".
     */
    @Test
    void returnsTheStudentFacingReasonWhenTheWorkspaceIsNotReadyYet() {
        var request = new MockHttpServletRequest("POST", "/api/workspaces/one/mock-exams");

        var response = handler.notReady(new WorkspaceNotReadyException("Upload lecture material before generating a mock exam."), request);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().message()).isEqualTo("Upload lecture material before generating a mock exam.");
        assertThat(response.getBody().status()).isEqualTo(409);
        assertThat(response.getBody().path()).isEqualTo("/api/workspaces/one/mock-exams");
    }

    @Test
    void stillExplainsItselfWhenTheReasonIsMissing() {
        var response = handler.notReady(new WorkspaceNotReadyException(null), new MockHttpServletRequest("GET", "/api/workspaces/one/curriculum"));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().message()).isNotBlank();
    }

    /**
     * The opposite guarantee: internal failure text — provider response bodies, missing-credential
     * messages — must never travel to a client, which is why not-ready has its own exception type.
     */
    @Test
    void neverLeaksInternalFailureTextToTheClient() {
        var request = new MockHttpServletRequest("POST", "/api/workspaces/one/chats/two/messages");

        var response = handler.unexpected(new IllegalStateException("OPENAI_API_KEY is not configured"), request);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        assertThat(response.getBody().message()).isEqualTo("The request could not be completed").doesNotContain("OPENAI_API_KEY");
    }

    @Test
    void reportsAnInvalidRequestWithoutHidingWhatWasWrong() {
        var response = handler.badRequest(new IllegalArgumentException("count must be between 1 and 20"), new MockHttpServletRequest("POST", "/api/workspaces/one/quiz"));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody().message()).isEqualTo("count must be between 1 and 20");
    }
}
