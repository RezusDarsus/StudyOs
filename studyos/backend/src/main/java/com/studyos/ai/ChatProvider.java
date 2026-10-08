package com.studyos.ai;

public interface ChatProvider {
    <T> AiResult<T> generateStructuredResult(String systemPrompt,String userPrompt,Class<T> responseType);
    default <T> AiResult<T> generateStructuredResult(String systemPrompt,String userPrompt,Class<T> responseType,GenerationPolicy policy){return generateStructuredResult(systemPrompt,userPrompt,responseType);}
    AiResult<String> generateResult(String systemPrompt,String userPrompt);
    default AiResult<String> generateResult(String systemPrompt,String userPrompt,GenerationPolicy policy){return generateResult(systemPrompt,userPrompt);}
}
