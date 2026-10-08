package com.studyos.ingestion;

import org.springframework.stereotype.Component;

@Component
public class ExtractionValidator {
    public Validation validate(ExtractedDocument document) {
        int pages = document.pageCount();
        int characters = document.characterCount();
        long nonEmptyPages = document.pages().stream().filter(page -> !page.text().isBlank()).count();
        double average = pages == 0 ? 0 : (double) characters / pages;
        if (pages == 0) return new Validation(false, "PDF has no readable pages", pages, characters, 1.0);
        if (characters < 200 || nonEmptyPages == 0 || average < 5) return new Validation(false, "PDF appears scanned or contains too little extractable text", pages, characters, 1.0 - ((double) nonEmptyPages / pages));
        return new Validation(true, null, pages, characters, 1.0 - ((double) nonEmptyPages / pages));
    }
    public record Validation(boolean valid, String error, int pages, int characters, double emptyPageRatio) {}
}
