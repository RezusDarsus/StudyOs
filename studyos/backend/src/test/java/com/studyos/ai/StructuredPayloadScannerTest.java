package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class StructuredPayloadScannerTest {

    @Test void findsExactlyOnePayloadInBareJson() {
        var scan = StructuredPayloadScanner.scan("{\"items\":[{\"name\":\"A\"}]}");
        assertThat(scan.payloads()).hasSize(1);
        assertThat(scan.payloads().getFirst().text()).isEqualTo("{\"items\":[{\"name\":\"A\"}]}");
        assertThat(scan.payloads().getFirst().fenced()).isFalse();
        assertThat(scan.unterminated()).isFalse();
    }

    @Test void ignoresBracesAndQuotesInsideStringLiterals() {
        var scan = StructuredPayloadScanner.scan("{\"text\":\"a } { [ tricky \\\" quote\",\"n\":1}");
        assertThat(scan.payloads()).hasSize(1);
        assertThat(scan.payloads().getFirst().text()).isEqualTo("{\"text\":\"a } { [ tricky \\\" quote\",\"n\":1}");
        assertThat(scan.unterminated()).isFalse();
    }

    @Test void skipsProseQuotesSoQuotedBracesDoNotStartPayloads() {
        var scan = StructuredPayloadScanner.scan("He said \"use {curly} braces\": {\"items\":[]}");
        assertThat(scan.payloads()).hasSize(1);
        assertThat(scan.payloads().getFirst().text()).isEqualTo("{\"items\":[]}");
    }

    @Test void recognizesFencedPayloadsAndIgnoresLanguageTags() {
        var scan = StructuredPayloadScanner.scan("```json\n{\"items\":[]}\n```");
        assertThat(scan.payloads()).hasSize(1);
        assertThat(scan.payloads().getFirst().text()).isEqualTo("{\"items\":[]}");
        assertThat(scan.payloads().getFirst().fenced()).isTrue();
    }

    @Test void findsPayloadBehindFenceInsideProse() {
        var scan = StructuredPayloadScanner.scan("Sure, here:\n```json\n{\"items\":[]}\n```\nDone.");
        assertThat(scan.payloads()).hasSize(1);
        assertThat(scan.payloads().getFirst().fenced()).isTrue();
    }

    @Test void countsTwoAdjacentPayloadsAsAmbiguous() {
        var scan = StructuredPayloadScanner.scan("{\"a\":1}{\"b\":2}");
        assertThat(scan.payloads()).hasSize(2);
    }

    @Test void countsPayloadsEitherSideOfProseAsAmbiguous() {
        var scan = StructuredPayloadScanner.scan("{\"a\":1} note {\"b\":2}");
        assertThat(scan.payloads()).hasSize(2);
    }

    @Test void reportsUnterminatedWhenADocumentNeverCloses() {
        var scan = StructuredPayloadScanner.scan("{\"items\":[{\"name\":\"A\"");
        assertThat(scan.payloads()).isEmpty();
        assertThat(scan.unterminated()).isTrue();
    }

    @Test void reportsUnterminatedInsideAString() {
        var scan = StructuredPayloadScanner.scan("{\"items\":[{\"name\":\"A");
        assertThat(scan.unterminated()).isTrue();
    }

    @Test void findsNothingInProseOnlyText() {
        var scan = StructuredPayloadScanner.scan("Here is your answer, in plain words only.");
        assertThat(scan.payloads()).isEmpty();
        assertThat(scan.unterminated()).isFalse();
    }

    @Test void stripsByteOrderMarkBeforeScanning() {
        var scan = StructuredPayloadScanner.scan("\uFEFF{\"items\":[]}");
        assertThat(scan.payloads()).hasSize(1);
    }

    @Test void emptyAndNullInputScanToNothing() {
        assertThat(StructuredPayloadScanner.scan("").payloads()).isEmpty();
        assertThat(StructuredPayloadScanner.scan(null).payloads()).isEmpty();
    }
}
