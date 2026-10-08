package com.studyos.verify;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Small English number words, so a claim written as "three 1-bits" can be checked against a count the same
 * way "3 1-bits" is. Words only, no domain terms: an answer that spells a number out is making exactly the
 * same arithmetic claim as one that writes the digit, and it should be just as checkable.
 */
public final class NumberWords {
    private static final Map<String,Integer> WORDS = new LinkedHashMap<>();
    static {
        String[] units = {"zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"};
        for (int i = 0; i < units.length; i++) WORDS.put(units[i], i);
        String[] tens = {"twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"};
        for (int i = 0; i < tens.length; i++) WORDS.put(tens[i], 20 + i * 10);
        WORDS.put("no", 0); WORDS.put("none", 0); WORDS.put("a single", 1); WORDS.put("one single", 1);
    }
    private NumberWords() {}

    /** The alternation this recognises, for embedding in a larger pattern. */
    public static String pattern() { return "\\d{1,4}|" + String.join("|", WORDS.keySet()); }

    /** Reads a digit string or a recognised word; {@code null} when the text is neither. */
    public static Integer valueOf(String text) {
        if (text == null) return null;
        String value = text.trim().toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
        if (value.matches("\\d{1,4}")) return Integer.parseInt(value);
        return WORDS.get(value);
    }
}
