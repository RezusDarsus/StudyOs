package com.studyos.retrieval;

import com.studyos.ai.AiUsageProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** Reuses vector computation by normalized content/model while leaving every source chunk intact. */
@Service
public class EmbeddingCacheService {
    private final JdbcTemplate jdbc; private final EmbeddingService embeddings; private final AiUsageProperties properties;
    public EmbeddingCacheService(JdbcTemplate jdbc, EmbeddingService embeddings, AiUsageProperties properties) { this.jdbc=jdbc; this.embeddings=embeddings; this.properties=properties; }

    public List<float[]> vectors(UUID courseId, UUID documentId, List<String> texts) {
        if (texts == null || texts.isEmpty()) return List.of();
        String model = properties.getEmbeddingModel();
        String version = properties.getEmbeddingModelVersion();
        Map<String,String> textByHash = new LinkedHashMap<>();
        for (String text : texts) textByHash.putIfAbsent(hash(text), text);
        Map<String,float[]> vectors = new HashMap<>();
        List<String> missing = new ArrayList<>();
        for (String hash : textByHash.keySet()) {
            String stored = jdbc.query("SELECT embedding::text FROM embedding_cache WHERE content_hash=? AND embedding_model=? AND model_version=?", rs -> rs.next() ? rs.getString(1) : null, hash, model,version);
            if (stored == null) missing.add(hash); else { vectors.put(hash, parseVector(stored)); jdbc.update("UPDATE embedding_cache SET hit_count=hit_count+1,last_hit_at=NOW() WHERE content_hash=? AND embedding_model=? AND model_version=?",hash,model,version); }
        }
        if (!missing.isEmpty()) {
            List<float[]> generated = embeddings.embedBatch(courseId, documentId, missing.stream().map(textByHash::get).toList());
            for (int i=0;i<missing.size();i++) {
                String hash=missing.get(i); float[] vector=generated.get(i); vectors.put(hash,vector);
                jdbc.update("INSERT INTO embedding_cache(content_hash,embedding_model,model_version,embedding) VALUES(?,?,?,CAST(? AS vector)) ON CONFLICT(content_hash,embedding_model,model_version) DO NOTHING", hash,model,version,literal(vector));
            }
        }
        return texts.stream().map(text -> vectors.get(hash(text))).toList();
    }

    public String hash(String text) {
        try { byte[] digest=MessageDigest.getInstance("SHA-256").digest(normalize(text).getBytes(StandardCharsets.UTF_8)); StringBuilder value=new StringBuilder(64); for(byte b:digest)value.append(String.format("%02x",b)); return value.toString(); }
        catch (Exception error) { throw new IllegalStateException("Cannot hash embedding content",error); }
    }
    private String normalize(String text) { return (text==null?"":text).replaceAll("\\s+"," ").trim(); }
    private float[] parseVector(String value) { String body=value==null?"":value.replace("[","").replace("]","").trim(); if(body.isBlank())return new float[0]; String[] parts=body.split(","); float[] result=new float[parts.length]; for(int i=0;i<parts.length;i++)result[i]=Float.parseFloat(parts[i].trim()); return result; }
    private String literal(float[] vector) { StringBuilder value=new StringBuilder("["); for(int i=0;i<vector.length;i++){if(i>0)value.append(',');value.append(vector[i]);} return value.append(']').toString(); }
    public BackfillResult backfillExistingChunks(){
        int inserted=jdbc.update("INSERT INTO embedding_cache(content_hash,embedding_model,model_version,embedding) SELECT DISTINCT ON (content_hash) content_hash,?,?,embedding FROM chunks WHERE content_hash IS NOT NULL AND embedding IS NOT NULL ORDER BY content_hash,created_at DESC ON CONFLICT(content_hash,embedding_model,model_version) DO NOTHING",properties.getEmbeddingModel(),properties.getEmbeddingModelVersion());
        return new BackfillResult(inserted,stats());
    }
    public Stats stats(){return jdbc.query("SELECT COUNT(*),COALESCE(SUM(hit_count),0) FROM embedding_cache WHERE embedding_model=? AND model_version=?",rs->{rs.next();long entries=rs.getLong(1),hits=rs.getLong(2);return new Stats(properties.getEmbeddingModel(),properties.getEmbeddingModelVersion(),entries,hits,entries+hits==0?0:(double)hits/(entries+hits));},properties.getEmbeddingModel(),properties.getEmbeddingModelVersion());}
    public record Stats(String model,String modelVersion,long entries,long hits,double hitRate){}
    public record BackfillResult(int inserted,Stats stats){}
}
