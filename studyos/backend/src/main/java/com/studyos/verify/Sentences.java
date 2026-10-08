package com.studyos.verify;

import java.util.ArrayList;
import java.util.List;

/**
 * Splits an answer into the statements the audits check one at a time.
 *
 * <p>Bracketed text is treated as opaque, which is the whole reason this is not a one-line regex. A reference
 * carries a period and a semicolon of its own — {@code [Source: lecture-03.pdf; pages 12-18]} — so an ordinary
 * sentence split cuts the reference away from the claim it belongs to, and every audit that pairs a claim with
 * its attribution then sees two fragments where the answer wrote one statement.
 *
 * <p>Shared by every audit in this package on purpose: they must agree on what one claim is, or the same answer
 * will be counted differently depending on which check is reading it.
 */
final class Sentences {
    private Sentences() {}

    static List<String> of(String answer) {
        List<String> values = new ArrayList<>();
        if (answer == null) return values;
        StringBuilder current = new StringBuilder();
        int depth = 0;
        for (int index = 0; index < answer.length(); index++) {
            char character = answer.charAt(index);
            if (character == '[') depth++;
            else if (character == ']' && depth > 0) depth--;
            current.append(character);
            boolean punctuation = character == '.' || character == ';' || character == '!' || character == '?' || character == '\n';
            if (depth == 0 && punctuation && (index + 1 >= answer.length() || Character.isWhitespace(answer.charAt(index + 1)))) { values.add(current.toString()); current.setLength(0); }
        }
        if (current.length() > 0) values.add(current.toString());
        return values;
    }
}
