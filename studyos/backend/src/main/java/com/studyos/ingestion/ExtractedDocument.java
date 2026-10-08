package com.studyos.ingestion;

import java.util.List;

public record ExtractedDocument(List<ParsedPage> pages) {
    public int pageCount() { return pages.size(); }
    public int characterCount() { return pages.stream().mapToInt(page -> page.text().length()).sum(); }
}
