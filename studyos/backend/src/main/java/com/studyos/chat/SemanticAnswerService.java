package com.studyos.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class SemanticAnswerService {
    private final JdbcTemplate jdbc; private final ObjectMapper mapper;
    public SemanticAnswerService(JdbcTemplate jdbc,ObjectMapper mapper){this.jdbc=jdbc;this.mapper=mapper;}
    public String render(SemanticAnswerPacket packet){ StringBuilder value=new StringBuilder(packet.coreAnswer().trim()); for(var section:packet.sections()){if(section.body()==null||section.body().isBlank())continue; value.append("\n\n## ").append(section.heading()==null?"Details":section.heading()).append("\n\n").append(section.body().trim());} if(!packet.sources().isEmpty()){value.append("\n\n### Sources\n"); for(var source:packet.sources())value.append("\n- [[Source: ").append(source.document()).append("; pages ").append(source.pages()).append("]] ");} if(!packet.expansions().isEmpty()){value.append("\n\n### Continue deeper\n"); for(var expansion:packet.expansions())value.append("\n- ").append(expansion.label()).append(" (`").append(expansion.type()).append("`)");} return value.toString().trim(); }
    public UUID store(UUID courseId,UUID chatId,UUID assistantMessageId,SemanticAnswerPacket packet,String evidenceFingerprint,String sourceVersion,String intent){try{UUID id=UUID.randomUUID();jdbc.update("INSERT INTO semantic_answer_packets(id,course_id,chat_id,assistant_message_id,packet,evidence_fingerprint,source_version,intent) VALUES(?,?,?,?,?::jsonb,?,?,?)",id,courseId,chatId,assistantMessageId,mapper.writeValueAsString(packet),evidenceFingerprint,sourceVersion,intent);return id;}catch(Exception error){throw new IllegalStateException("Cannot store semantic answer packet",error);}}
    public SemanticAnswerPacket get(UUID courseId,UUID chatId,UUID assistantMessageId){return jdbc.query("SELECT packet::text FROM semantic_answer_packets WHERE course_id=? AND chat_id=? AND assistant_message_id=?",rs->{if(!rs.next())return null;try{return mapper.readValue(rs.getString(1),SemanticAnswerPacket.class);}catch(Exception e){throw new IllegalStateException(e);}},courseId,chatId,assistantMessageId);}
    public PacketRow row(UUID courseId,UUID chatId,UUID assistantMessageId){return jdbc.query("SELECT id,packet::text,COALESCE(intent,'') FROM semantic_answer_packets WHERE course_id=? AND chat_id=? AND assistant_message_id=?",rs->{if(!rs.next())return null;try{return new PacketRow(rs.getObject(1,UUID.class),mapper.readValue(rs.getString(2),SemanticAnswerPacket.class),rs.getString(3));}catch(Exception e){throw new IllegalStateException(e);}},courseId,chatId,assistantMessageId);}
    public String cachedExpansion(UUID packetId,String type){return jdbc.query("SELECT content FROM answer_expansions WHERE packet_id=? AND expansion_type=?",rs->rs.next()?rs.getString(1):null,packetId,type);}
    public void storeExpansion(UUID packetId,String type,String content){jdbc.update("INSERT INTO answer_expansions(id,packet_id,expansion_type,content) VALUES(?,?,?,?) ON CONFLICT(packet_id,expansion_type) DO UPDATE SET content=EXCLUDED.content",UUID.randomUUID(),packetId,type,content);}
    public record PacketRow(UUID id,SemanticAnswerPacket packet,String intent) { public PacketRow { intent=intent==null?"":intent; } }
}
