package com.studyos.chat;

/** Intent-specific context budget. Grounding stays enabled while irrelevant state is omitted. */
public record ContextProfile(boolean courseSummary, boolean crossChatMemory, boolean forecast,
                             boolean topicState, boolean misconceptions, boolean learnerProfile,
                             int recentMessages, int evidenceChunks, int evidenceTokenBudget) {}
