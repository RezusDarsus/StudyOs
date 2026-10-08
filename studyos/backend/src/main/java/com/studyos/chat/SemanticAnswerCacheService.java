package com.studyos.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.retrieval.EmbeddingService;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class SemanticAnswerCacheService {
    private static final double MIN_SIMILARITY=.92;
    private final JdbcTemplate jdbc; private final ObjectMapper mapper; private final EmbeddingService embeddings; private final boolean enabled;
    public SemanticAnswerCacheService(JdbcTemplate jdbc,ObjectMapper mapper,EmbeddingService embeddings,@Value("${studyos.ai.answer-cache-enabled:true}") boolean enabled){this.jdbc=jdbc;this.mapper=mapper;this.embeddings=embeddings;this.enabled=enabled;}
    public boolean eligible(QueryIntent intent){return enabled&&(intent==QueryIntent.FACTUAL_QA||intent==QueryIntent.EXPLAIN_TOPIC);}
    public Lookup lookup(UUID courseId,QueryIntent intent,String query,String evidenceFingerprint,String sourceVersion,String studentStateFingerprint){if(!eligible(intent))return new Lookup(null,null,false);String normalized=normalize(query);Cached exact=findExact(courseId,intent,normalized,evidenceFingerprint,sourceVersion,studentStateFingerprint);if(exact!=null){hit(exact.id());return new Lookup(exact.packet(),null,true);}float[] vector=embeddings.embed(courseId,null,query);String literal=literal(vector);Cached semantic=jdbc.query("SELECT id,packet::text,1-(query_embedding::halfvec(2048) <=> CAST(? AS halfvec(2048))) AS similarity FROM semantic_answer_cache WHERE course_id=? AND intent=? AND evidence_fingerprint=? AND source_version=? AND student_state_fingerprint=? AND query_embedding IS NOT NULL ORDER BY query_embedding::halfvec(2048) <=> CAST(? AS halfvec(2048)) LIMIT 1",rs->{if(!rs.next()||rs.getDouble(3)<MIN_SIMILARITY)return null;try{return new Cached(rs.getObject(1,UUID.class),mapper.readValue(rs.getString(2),SemanticAnswerPacket.class));}catch(Exception e){throw new IllegalStateException(e);}},literal,courseId,intent.name(),evidenceFingerprint,sourceVersion,studentStateFingerprint,literal);if(semantic!=null){hit(semantic.id());return new Lookup(semantic.packet(),vector,true);}return new Lookup(null,vector,false);}
    public void store(UUID courseId,QueryIntent intent,String query,String evidenceFingerprint,String sourceVersion,String studentStateFingerprint,float[] queryVector,SemanticAnswerPacket packet){if(!eligible(intent)||queryVector==null)return;try{jdbc.update("INSERT INTO semantic_answer_cache(id,course_id,intent,normalized_query,query_embedding,evidence_fingerprint,source_version,student_state_fingerprint,packet) VALUES(?,?,?,?,CAST(? AS vector),?,?,?,?::jsonb) ON CONFLICT(course_id,intent,normalized_query,evidence_fingerprint,source_version,student_state_fingerprint) DO UPDATE SET query_embedding=EXCLUDED.query_embedding,packet=EXCLUDED.packet",UUID.randomUUID(),courseId,intent.name(),normalize(query),literal(queryVector),evidenceFingerprint,sourceVersion,studentStateFingerprint,mapper.writeValueAsString(packet));}catch(Exception e){throw new IllegalStateException("Cannot store semantic answer cache entry",e);}}
    private Cached findExact(UUID courseId,QueryIntent intent,String query,String evidence,String version,String studentStateFingerprint){return jdbc.query("SELECT id,packet::text FROM semantic_answer_cache WHERE course_id=? AND intent=? AND normalized_query=? AND evidence_fingerprint=? AND source_version=? AND student_state_fingerprint=?",rs->{if(!rs.next())return null;try{return new Cached(rs.getObject(1,UUID.class),mapper.readValue(rs.getString(2),SemanticAnswerPacket.class));}catch(Exception e){throw new IllegalStateException(e);}},courseId,intent.name(),query,evidence,version,studentStateFingerprint);}
    private void hit(UUID id){jdbc.update("UPDATE semantic_answer_cache SET hit_count=hit_count+1,last_hit_at=NOW() WHERE id=?",id);}
    private String normalize(String value){return (value==null?"":value).toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9 ]"," ").replaceAll("\\s+"," ").trim();}
    private String literal(float[] vector){StringBuilder value=new StringBuilder("[");for(int i=0;i<vector.length;i++){if(i>0)value.append(',');value.append(vector[i]);}return value.append(']').toString();}
    private record Cached(UUID id,SemanticAnswerPacket packet){}
    public record Lookup(SemanticAnswerPacket packet,float[] queryVector,boolean hit){}
}
