package com.studyos.chat;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import java.io.IOException;
import java.util.*;

/** Small semantic payload rendered by the application for backward-compatible chat text. */
public record SemanticAnswerPacket(String coreAnswer,List<Section> sections,List<SourceRef> sources,List<Expansion> expansions) {
    public SemanticAnswerPacket { sections=sections==null?List.of():List.copyOf(sections); sources=sources==null?List.of():List.copyOf(sources); expansions=expansions==null?List.of():List.copyOf(expansions); coreAnswer=coreAnswer==null?"":coreAnswer; }
    public static SemanticAnswerPacket fallback(String text){return new SemanticAnswerPacket(text,List.of(),List.of(),defaultExpansions());}
    public static List<Expansion> defaultExpansions(){return List.of(new Expansion("worked_example","Worked example"),new Expansion("deeper_explanation","Deeper explanation"),new Expansion("prerequisite_recap","Prerequisite recap"),new Expansion("exercise","Practice exercise"));}
    public static String contract(){return "Return a JSON object with coreAnswer (the useful concise answer), sections (array of {heading,body}), sources (array of {document,pages}), and expansions (array of {type,label}). pages must be a string such as 1-2. Do not generate expansion content now. Allowed expansion types: worked_example, deeper_explanation, prerequisite_recap, exercise.";}
    public record Section(String heading,String body) {}
    public record SourceRef(String document,@JsonDeserialize(using=PagesDeserializer.class) String pages) {}
    public record Expansion(String type,String label) {}

    public static final class PagesDeserializer extends JsonDeserializer<String> {
        @Override public String deserialize(JsonParser parser, DeserializationContext context) throws IOException {
            JsonNode value=parser.getCodec().readTree(parser);
            if(value.isTextual()||value.isNumber())return value.asText();
            if(value.isArray()){List<String> pages=new ArrayList<>();value.forEach(page->pages.add(page.asText()));return pages.size()==2?pages.get(0)+"-"+pages.get(1):String.join(", ",pages);}
            return value.toString();
        }
    }
}
