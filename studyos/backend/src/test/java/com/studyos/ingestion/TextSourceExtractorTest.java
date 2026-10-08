package com.studyos.ingestion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TextSourceExtractorTest {
    @TempDir Path temporaryDirectory;

    @Test
    void extractsUtf8TextAsOneProvenancePage() throws Exception {
        Path source = temporaryDirectory.resolve("notes.txt");
        Files.writeString(source, "CRC detects burst errors.\n\nGenerator division matters.");

        ExtractedDocument extracted = new PdfTextExtractor().extract(source);

        assertEquals(1, extracted.pageCount());
        assertEquals(1, extracted.pages().getFirst().pageNumber());
        assertTrue(extracted.pages().getFirst().text().contains("Generator division"));
    }

    @Test
    void extractsMarkdownWithoutDiscardingStructure() throws Exception {
        Path source = temporaryDirectory.resolve("week-one.md");
        Files.writeString(source, "# Week 1\n\n## Fairness\n\nWeak fairness is not immediate execution.");

        ExtractedDocument extracted = new PdfTextExtractor().extract(source);

        assertEquals(1, extracted.pageCount());
        assertTrue(extracted.pages().getFirst().text().startsWith("# Week 1"));
        assertTrue(extracted.pages().getFirst().text().contains("## Fairness"));
    }
}
