package com.studyos.retrieval;

import com.studyos.ai.AiGateway;
import com.studyos.ai.AiResult;
import com.studyos.ai.AiUsageService;
import com.studyos.ai.AiOperation;
import com.studyos.ai.EmbeddingInputType;
import java.util.UUID;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class EmbeddingService {
    private final AiGateway aiGateway; private final AiUsageService usage;
    public EmbeddingService(AiGateway aiGateway, AiUsageService usage) { this.aiGateway = aiGateway; this.usage = usage; }
    public float[] embed(String text) { return aiGateway.embedResult(text,EmbeddingInputType.QUERY).value(); }
    public float[] embed(UUID courseId, UUID documentId, String text) {
        return embed(courseId,documentId,text,EmbeddingInputType.QUERY);
    }
    public float[] embedPassage(UUID courseId,UUID documentId,String text) {
        return embed(courseId,documentId,text,EmbeddingInputType.PASSAGE);
    }
    private float[] embed(UUID courseId,UUID documentId,String text,EmbeddingInputType inputType) {
        long started=System.nanoTime(); AiResult<float[]> result=null; boolean success=false;
        try { result=aiGateway.embedResult(text,inputType); success=true; return result.value(); }
        finally { usage.record(AiOperation.EMBEDDING,result,courseId,null,documentId,(System.nanoTime()-started)/1_000_000,success); }
    }
    public List<float[]> embedBatch(List<String> texts) {
        if (texts == null || texts.isEmpty()) return List.of();
        List<float[]> result = new java.util.ArrayList<>();
        for (int start = 0; start < texts.size(); start += 32) {
            result.addAll(aiGateway.embedBatchResult(texts.subList(start,Math.min(start+32,texts.size())),EmbeddingInputType.PASSAGE).value());
        }
        return result;
    }
    public List<float[]> embedBatch(UUID courseId, UUID documentId, List<String> texts) {
        return embedBatch(courseId,documentId,texts,EmbeddingInputType.PASSAGE);
    }
    public List<float[]> embedQueries(UUID courseId, UUID documentId, List<String> texts) {
        return embedBatch(courseId,documentId,texts,EmbeddingInputType.QUERY);
    }
    private List<float[]> embedBatch(UUID courseId, UUID documentId, List<String> texts,EmbeddingInputType inputType) {
        if (texts == null || texts.isEmpty()) return List.of();
        List<float[]> result = new java.util.ArrayList<>();
        for (int start = 0; start < texts.size(); start += 32) {
            long started=System.nanoTime(); AiResult<List<float[]>> batch=null; boolean success=false;
            try { batch=aiGateway.embedBatchResult(texts.subList(start,Math.min(start+32,texts.size())),inputType); result.addAll(batch.value()); success=true; }
            finally { usage.record(AiOperation.EMBEDDING,batch,courseId,null,documentId,(System.nanoTime()-started)/1_000_000,success); }
        }
        return result;
    }
}
