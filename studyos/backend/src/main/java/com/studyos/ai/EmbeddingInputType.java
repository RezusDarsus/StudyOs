package com.studyos.ai;

/** Asymmetric embedding role: searches are queries; indexed source content is passage material. */
public enum EmbeddingInputType {
    QUERY("query"), PASSAGE("passage");

    private final String providerValue;
    EmbeddingInputType(String providerValue) { this.providerValue=providerValue; }
    public String providerValue() { return providerValue; }
}
