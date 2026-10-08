package com.studyos.memory;

import org.springframework.stereotype.Component;

@Component
public class TokenBudgetManager {
    public String limit(String text, int maxTokens) {
        if (text == null || text.length() <= maxTokens * 4) return text == null ? "" : text;
        return text.substring(0, Math.max(0, maxTokens * 4)) + "\n[context truncated by budget]";
    }
    public int estimate(String text) { return text == null ? 0 : Math.max(1, text.length() / 4); }
}
