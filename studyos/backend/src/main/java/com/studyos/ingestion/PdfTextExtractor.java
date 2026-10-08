package com.studyos.ingestion;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.nio.file.Path;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.springframework.stereotype.Component;

@Component
public class PdfTextExtractor implements DocumentTextExtractor {
    @Override public ExtractedDocument extract(byte[] content) {
        try (PDDocument document = Loader.loadPDF(content)) {
            return extractDocument(document);
        } catch (IOException exception) { throw new IllegalArgumentException("Could not extract PDF text", exception); }
    }
    @Override public ExtractedDocument extract(Path path) {
        String filename = path.getFileName().toString().toLowerCase(Locale.ROOT);
        try {
            if (filename.endsWith(".txt") || filename.endsWith(".md") || filename.endsWith(".markdown")) {
                return singlePage(normalize(Files.readString(path, StandardCharsets.UTF_8)));
            }
            if (filename.endsWith(".html") || filename.endsWith(".htm")) {
                // HTML arrives as untrusted data; the research extractor strips script, style, tags and
                // handlers, leaving only readable text that downstream stages keep treating as data.
                return singlePage(normalize(com.studyos.research.HtmlTextExtractor.text(Files.readString(path, StandardCharsets.UTF_8))));
            }
            if (filename.endsWith(".srt") || filename.endsWith(".vtt")) {
                return singlePage(normalize(transcriptText(Files.readString(path, StandardCharsets.UTF_8))));
            }
        } catch (IOException exception) {
            throw new IllegalArgumentException("Could not extract text source", exception);
        }
        try (PDDocument document = Loader.loadPDF(path.toFile())) {
            return extractDocument(document);
        } catch (IOException exception) { throw new IllegalArgumentException("Could not extract PDF text", exception); }
    }

    private ExtractedDocument singlePage(String text) { return new ExtractedDocument(List.of(new ParsedPage(1, text))); }

    /**
     * Subtitle and caption tracks (SRT, WebVTT) reduce to spoken text: sequence numbers, cue
     * identifiers, timecode arrows, cue settings and block headers carry no study content.
     */
    static String transcriptText(String raw) {
        if (raw == null) return "";
        String[] lines = raw.split("\\R");
        StringBuilder text = new StringBuilder();
        for (int index = 0; index < lines.length; index++) {
            String value = lines[index].strip();
            if (value.isEmpty()) continue;
            if (value.startsWith("WEBVTT") || value.startsWith("NOTE") || value.startsWith("STYLE") || value.startsWith("REGION")) continue;
            if (value.chars().allMatch(Character::isDigit)) continue;
            if (value.contains("-->")) continue;
            // A WebVTT cue identifier is the arbitrary line directly above the timecode line.
            if (index + 1 < lines.length && lines[index + 1].contains("-->")) continue;
            text.append(value).append('\n');
        }
        return text.toString().trim();
    }
    private ExtractedDocument extractDocument(PDDocument document) throws IOException {
            PDFTextStripper stripper = new PDFTextStripper();
            stripper.setSortByPosition(true);
            List<ParsedPage> pages = new ArrayList<>();
            for (int page = 1; page <= document.getNumberOfPages(); page++) {
                stripper.setStartPage(page); stripper.setEndPage(page);
                pages.add(new ParsedPage(page, normalize(stripper.getText(document))));
            }
            return new ExtractedDocument(pages);
    }
    private String normalize(String text) { return text.replace("\u0000", "").replaceAll("[ \\t]+", " ").replaceAll("\\n{3,}", "\n\n").trim(); }
}
