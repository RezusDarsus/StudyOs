package com.studyos.ai;

public record ContextTokenUsage(int courseSummary,int memory,int studentState,int chatHistory,int forecast,int evidence,int instructions) {
    public int total() { return courseSummary+memory+studentState+chatHistory+forecast+evidence+instructions; }
}
