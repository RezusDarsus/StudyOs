package com.studyos.ingestion;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Text-bearing source formats beyond PDF: HTML pages and caption tracks reduce to readable text. */
class DocumentTextFormatsTest {
    private final PdfTextExtractor extractor = new PdfTextExtractor();

    @TempDir Path temp;

    @Test void htmlPageIsReducedToReadableTextWithoutScriptsOrTags() throws Exception {
        Path file = temp.resolve("syllabus.html");
        Files.writeString(file, """
                <html><head><title>OS Course</title><style>body{color:red}</style>
                <script>alert('never executed, never ingested');</script></head>
                <body><h1>Operating System Engineering</h1>
                <p>Week 1: introduction, history, and abstraction.</p></body></html>
                """);
        ExtractedDocument document = extractor.extract(file);
        assertThat(document.pages()).hasSize(1);
        String text = document.pages().getFirst().text();
        assertThat(text).contains("Operating System Engineering").contains("Week 1: introduction");
        assertThat(text).doesNotContain("alert").doesNotContain("script").doesNotContain("<h1>");
    }

    @Test void srtCaptionsReduceToSpokenText() throws Exception {
        Path file = temp.resolve("lecture.srt");
        Files.writeString(file, """
                1
                00:00:01,000 --> 00:00:04,000
                Today we look at virtual memory.

                2
                00:00:04,500 --> 00:00:07,000
                Address translation is the core idea.
                """);
        ExtractedDocument document = extractor.extract(file);
        String text = document.pages().getFirst().text();
        assertThat(text).contains("Today we look at virtual memory.").contains("Address translation is the core idea.");
        assertThat(text).doesNotContain("-->").doesNotContain("00:00");
    }

    @Test void webVttHeadersAndCueSettingsAreDropped() throws Exception {
        Path file = temp.resolve("lecture.vtt");
        Files.writeString(file, """
                WEBVTT - Kind: captions

                NOTE this block is a comment

                intro-cue
                00:00:01.000 --> 00:00:03.000 position:10%
                Interrupts and traps.
                """);
        String text = PdfTextExtractor.transcriptText(Files.readString(file));
        assertThat(text).isEqualTo("Interrupts and traps.");
    }

    @Test void emptyTranscriptReducesToEmptyText() {
        assertThat(PdfTextExtractor.transcriptText(null)).isEmpty();
        assertThat(PdfTextExtractor.transcriptText("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\n")).isEmpty();
    }
}
