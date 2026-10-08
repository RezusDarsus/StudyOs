package com.studyos.chat;

import java.util.Optional;
import java.util.regex.Pattern;

/** Strict parsing and bounds checks for model-produced source page citations. */
final class CitationValidationRules {
    private static final Pattern PAGE_RANGE = Pattern.compile("(?i)^\\s*(?:pages?\\s*)?(\\d+)\\s*(?:[-–—]\\s*(\\d+))?\\s*$");
    private static final Pattern PAGE_LIST = Pattern.compile("(?i)^\\s*(?:pages?\\s*)?\\d+(?:\\s*,\\s*\\d+)+\\s*$");

    private CitationValidationRules() {}

    static Optional<PageRange> parse(String pages) {
        var matcher = PAGE_RANGE.matcher(pages == null ? "" : pages);
        if (!matcher.matches()) {
            if(!PAGE_LIST.matcher(pages==null?"":pages).matches())return Optional.empty();
            try{String cleaned=pages.replaceFirst("(?i)^\\s*pages?\\s*","");String[] values=cleaned.split("\\s*,\\s*");int start=Integer.parseInt(values[0]),previous=start;for(int index=1;index<values.length;index++){int current=Integer.parseInt(values[index]);if(current!=previous+1)return Optional.empty();previous=current;}return start<1?Optional.empty():Optional.of(new PageRange(start,previous));}catch(NumberFormatException ignored){return Optional.empty();}
        }
        try {
            int start = Integer.parseInt(matcher.group(1));
            int end = matcher.group(2) == null ? start : Integer.parseInt(matcher.group(2));
            if (start < 1 || end < start) return Optional.empty();
            return Optional.of(new PageRange(start, end));
        } catch (NumberFormatException ignored) {
            return Optional.empty();
        }
    }

    static boolean withinDocument(PageRange range, Integer pageCount) {
        return range != null && (pageCount == null || pageCount < 1 || range.end() <= pageCount);
    }

    record PageRange(int start, int end) {}
}
