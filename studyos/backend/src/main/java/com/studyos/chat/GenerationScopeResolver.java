package com.studyos.chat;

import com.studyos.ai.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.time.LocalDate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Resolves a closed generation scope from the current course's own documents, topics, and assessments. */
@Service
public class GenerationScopeResolver {
    private static final int MAX_SCOPE_CHUNKS=12;
    private static final Logger log=LoggerFactory.getLogger(GenerationScopeResolver.class);
    private final JdbcTemplate jdbc; private final AiGateway ai; private final AiUsageService usage; private final GenerationPolicyRegistry policies;
    private final Map<String,ScopeSemantics> semanticCache=new ConcurrentHashMap<>();

    public GenerationScopeResolver(JdbcTemplate jdbc,AiGateway ai,AiUsageService usage,GenerationPolicyRegistry policies){this.jdbc=jdbc;this.ai=ai;this.usage=usage;this.policies=policies;}

    public GenerationScope resolve(UUID courseId,UUID chatId,HardNewRequest request){
        String query=normalize(request.rawQuery()); List<TopicTerm> topicTerms=topicTerms(courseId);
        List<String> requestedTopics=topicTerms.stream().filter(term->matchesTopic(query,term.term())).map(TopicTerm::canonical).distinct().toList();
        Set<UUID> requestedTopicIds=topicTerms.stream().filter(term->requestedTopics.contains(term.canonical())).map(TopicTerm::id).collect(Collectors.toCollection(LinkedHashSet::new));
        List<DocumentRow> documents=documents(courseId); Set<UUID> explicitDocuments=documents.stream().filter(document->mentionsDocument(query,document.name())).map(DocumentRow::id).collect(Collectors.toCollection(LinkedHashSet::new));
        Set<UUID> weekAnchors=documents.stream().filter(document->request.requestedWeeks().stream().anyMatch(week->matchesExplicitWeek(document,week))).map(DocumentRow::id).collect(Collectors.toCollection(LinkedHashSet::new));
        Set<UUID> weekDocuments=new LinkedHashSet<>(weekAnchors);Set<UUID> alignedLectures=relatedLectureDocuments(courseId,weekAnchors);weekDocuments.addAll(alignedLectures);if(weekDocuments.isEmpty())weekDocuments.addAll(documents.stream().filter(document->request.requestedWeeks().stream().anyMatch(week->Objects.equals(document.inferredWeek(),week))).map(DocumentRow::id).toList());
        Set<UUID> topicDocuments=documentsForTopics(courseId,requestedTopicIds);
        Set<UUID> referenceDocuments=documents.stream().filter(document->matchesReference(document,request)).map(DocumentRow::id).collect(Collectors.toCollection(LinkedHashSet::new));

        List<Set<UUID>> primaryConstraints=new ArrayList<>();
        if(!explicitDocuments.isEmpty())primaryConstraints.add(explicitDocuments);
        if(!request.requestedWeeks().isEmpty())primaryConstraints.add(weekDocuments);
        // A named week/document is the hard evidence boundary. Topic links only choose documents
        // when no harder boundary was supplied; sparse ingestion metadata must never widen or erase
        // an otherwise valid closed week/document scope.
        if(explicitDocuments.isEmpty()&&request.requestedWeeks().isEmpty()&&!requestedTopics.isEmpty())primaryConstraints.add(topicDocuments);
        Set<UUID> selected=new LinkedHashSet<>();
        if(!primaryConstraints.isEmpty()){
            selected.addAll(primaryConstraints.getFirst());
            for(int index=1;index<primaryConstraints.size();index++)selected.retainAll(primaryConstraints.get(index));
        }else if(!referenceDocuments.isEmpty())selected.addAll(referenceDocuments);

        String label=scopeLabel(request,requestedTopics,explicitDocuments,documents);
        if(selected.isEmpty())return empty(courseId,label,request,requestedTopics,topicTerms);
        List<DocumentRow> allowedRows=documents.stream().filter(document->selected.contains(document.id())).toList();
        List<ChunkRow> chunks=chunks(courseId,selected); Set<UUID> relevantChunkIds=chunksForTopics(courseId,requestedTopicIds);
        List<ChunkRow> scopedChunks=requestedTopics.isEmpty()?balanced(chunks):balanced(chunks.stream().filter(chunk->relevantChunkIds.contains(chunk.id())||requestedTopics.stream().anyMatch(topic->containsPhrase(normalize(chunk.content()),normalize(topic)))).toList());
        // If precomputed topic links are incomplete, keep the user's closed week/document boundary
        // and let semantic verification decide support from its evidence. Never retrieve outside it.
        if(scopedChunks.isEmpty()&&(!request.requestedWeeks().isEmpty()||!explicitDocuments.isEmpty()))scopedChunks=balanced(chunks);
        List<String> scopeTerms=requestedTopics.isEmpty()?List.of():topicTerms.stream().filter(term->requestedTopics.contains(term.canonical())).flatMap(term->topicSearchTerms(term.term()).stream()).distinct().toList();
        String evidence=renderEvidence(scopedChunks,scopeTerms);
        if(evidence.isBlank())return empty(courseId,label,request,requestedTopics,topicTerms);

        List<GenerationScope.ReferenceAssessment> references=references(courseId,referenceDocuments,request.referenceExercise(),requestedTopics);
        List<String> historical=historicalGeneratedExercises(courseId);
        String cacheKey=courseId+"|"+selected+"|"+requestedTopics+"|"+references.stream().map(GenerationScope.ReferenceAssessment::id).toList()+"|"+evidence.hashCode();
        ScopeSemantics semantics=semanticCache.get(cacheKey);
        if(semantics==null){
            semantics=extractSemantics(courseId,chatId,evidence,references,requestedTopics);
            if(semantics.source().isEmpty())semantics=fallbackSemantics(evidence,references,requestedTopics);
            // A provider timeout or malformed JSON must not poison this scope for the life of the server.
            if(!semantics.source().isEmpty())semanticCache.put(cacheKey,semantics);
        }
        Map<String,AcademicSemanticProfile> referenceProfiles=semantics.references().stream().collect(Collectors.toMap(SemanticProfileExtraction.ReferenceProfile::referenceId,SemanticProfileExtraction.ReferenceProfile::profile,(left,right)->left));
        List<GenerationScope.ReferenceAssessment> enriched=references.stream().map(reference->reference.withSemantics(referenceProfiles.getOrDefault(reference.id(),AcademicSemanticProfile.empty()))).toList();
        return new GenerationScope(courseId,label,request.requestedWeeks(),requestedTopics,allowedRows.stream().map(DocumentRow::id).toList(),allowedRows.stream().map(DocumentRow::name).toList(),request.referenceExercise(),request.referenceText(),request.freezesReferenceModel(),enriched,evidence,topicTerms.stream().map(TopicTerm::canonical).distinct().toList(),semantics.source(),historical);
    }

    private GenerationScope empty(UUID courseId,String label,HardNewRequest request,List<String> topics,List<TopicTerm> terms){return new GenerationScope(courseId,label,request.requestedWeeks(),topics,List.of(),List.of(),request.referenceExercise(),request.referenceText(),request.freezesReferenceModel(),List.of(),"",terms.stream().map(TopicTerm::canonical).distinct().toList(),AcademicSemanticProfile.empty(),historicalGeneratedExercises(courseId));}

    private ScopeSemantics extractSemantics(UUID courseId,UUID chatId,String evidence,List<GenerationScope.ReferenceAssessment> references,List<String> requestedTopics){
        for(int attempt=1;attempt<=2;attempt++){
            int evidenceLimit=attempt==1?6500:4200,referenceLimit=attempt==1?700:420;
            StringBuilder prompt=new StringBuilder("REQUESTED TOPIC BOUNDARY: ").append(requestedTopics==null||requestedTopics.isEmpty()?"all material in the closed evidence":requestedTopics).append(". Extract only semantics relevant to this boundary; nearby unrelated worksheet sections are outside the semantic scope.\n\nCLOSED SOURCE EVIDENCE:\n").append(trim(evidence,evidenceLimit)).append("\n\nREFERENCE ASSESSMENTS (comparison only):\n");
            for(var reference:references)prompt.append("[").append(reference.id()).append("] ").append(trim(reference.prompt(),referenceLimit)).append("\n");
            prompt.append("\nUse at most four short phrases in each semantic list. ").append(SemanticProfileExtraction.contract());
            AiResult<SemanticProfileExtraction> result=null;boolean success=false;long started=System.nanoTime();
            try{
                result=ai.generateStructuredResult("You extract domain-agnostic academic semantics from supplied text. Never add background knowledge. Describe concepts, assumptions, domains or types, operations or rules, required knowledge, task types, and expected reasoning steps. Reference assessments are comparison material, not authority for source grounding. Keep every list concise. Return only JSON.",prompt.toString(),SemanticProfileExtraction.class,policies.policy(AiOperation.EXAM_PREDICTION_VERIFICATION));
                success=Boolean.TRUE.equals(result.structuredParseSuccess())||result.structuredParseSuccess()==null;
                ScopeSemantics extracted=new ScopeSemantics(result.value().source(),result.value().references());
                if(!extracted.source().isEmpty())return extracted;
                log.warn("Semantic scope extraction returned an empty source profile for course {} (attempt {})",courseId,attempt);
            }catch(StructuredGenerationException error){result=error.telemetryResult();log.warn("Semantic scope extraction JSON failed for course {} (attempt {}): {}",courseId,attempt,trim(error.rawText(),180));}
            catch(RuntimeException error){log.warn("Semantic scope extraction failed for course {} (attempt {}): {}",courseId,attempt,error.toString());}
            finally{usage.record(AiOperation.EXAM_PREDICTION_VERIFICATION,result,courseId,chatId,null,(System.nanoTime()-started)/1_000_000,success);}
        }
        return ScopeSemantics.empty();
    }

    /** Evidence-only fallback for a structurally valid but schema-wrong provider response. It uses
     * source phrases verbatim and is orientation metadata; the raw evidence remains authoritative. */
    private static ScopeSemantics fallbackSemantics(String evidence,List<GenerationScope.ReferenceAssessment> references,List<String> requestedTopics){
        List<String> seeds=new ArrayList<>(requestedTopics==null?List.of():requestedTopics);
        for(var reference:references){String title=assessmentTitle(reference.prompt());if(!title.isBlank())seeds.add(title);}
        AcademicSemanticProfile source=fallbackProfile(evidence,seeds);
        List<SemanticProfileExtraction.ReferenceProfile> profiles=references.stream().map(reference->new SemanticProfileExtraction.ReferenceProfile(reference.id(),fallbackProfile(reference.prompt(),List.of(assessmentTitle(reference.prompt()))))).toList();
        return new ScopeSemantics(source,profiles);
    }
    private static AcademicSemanticProfile fallbackProfile(String text,List<String> conceptSeeds){
        List<String> concepts=conceptSeeds.stream().filter(value->value!=null&&!value.isBlank()).map(String::trim).distinct().limit(4).toList();
        List<String> assumptions=sourceFragments(text,Pattern.compile("(?i)\\b(?:assume|assuming|initially|given|where|contains|stores|parameters?|inputs?)\\b"),4);
        List<String> operations=sourceFragments(text,Pattern.compile("(?i)\\b(?:step|transition|algorithm|compute|construct|decompose|route|send|receive|increment|determine|define|apply|compare)\\w*\\b"),4);
        List<String> taskTypes=sourceFragments(text,Pattern.compile("(?i)^(?:show|prove|determine|define|construct|specify|compare|derive|analy[sz]e|give|find|calculate)\\b"),4);
        List<String> reasoning=sourceFragments(text,Pattern.compile("(?i)\\b(?:hint|proof|induction|contradiction|counterexample|recursively|decomposition|invariant)\\b"),4);
        List<String> knowledge=new ArrayList<>(concepts);if(knowledge.isEmpty())knowledge.addAll(operations.stream().limit(2).toList());
        return new AcademicSemanticProfile(concepts,assumptions,List.of(),operations,knowledge,taskTypes,reasoning);
    }
    private static List<String> sourceFragments(String text,Pattern selector,int limit){
        if(text==null||text.isBlank())return List.of();List<String> values=new ArrayList<>();
        for(String raw:text.replaceAll("(?i)\\[Source:[^]]+]"," ").split("(?<=[.!?])\\s+|[•\\n\\r]+")){String fragment=raw.replaceAll("\\s+"," ").trim();if(fragment.length()<8||!selector.matcher(fragment).find())continue;values.add(trim(fragment,180));if(values.size()==limit)break;}
        return List.copyOf(values);
    }
    private static String assessmentTitle(String prompt){if(prompt==null)return "";String value=prompt.replaceAll("\\s+"," ").trim();int points=value.toLowerCase(Locale.ROOT).indexOf("credit point");if(points>0)value=value.substring(0,points);int paren=value.indexOf('(');if(paren>3)value=value.substring(0,paren);return trim(value,90);}

    private List<TopicTerm> topicTerms(UUID courseId){return jdbc.query("SELECT t.id,t.canonical_name,t.canonical_name FROM topics t WHERE t.course_id=? UNION ALL SELECT t.id,t.canonical_name,a.alias FROM topic_aliases a JOIN topics t ON t.id=a.topic_id WHERE t.course_id=?",(rs,row)->new TopicTerm(rs.getObject(1,UUID.class),rs.getString(2),rs.getString(3)),courseId,courseId).stream().filter(term->term.term()!=null&&normalize(term.term()).length()>=3).toList();}
    private List<DocumentRow> documents(UUID courseId){
        List<DocumentRow> rows=jdbc.query("SELECT d.id,d.name,d.document_type,COALESCE((SELECT LEFT(c.content,2500) FROM chunks c WHERE c.document_id=d.id ORDER BY c.ordinal LIMIT 1),'') FROM documents d WHERE d.course_id=? AND d.status IN ('PROCESSED','COMPLETED') ORDER BY d.name",(rs,row)->new DocumentRow(rs.getObject(1,UUID.class),rs.getString(2),rs.getString(3),rs.getString(4),null),courseId);
        Map<String,Integer> lectureWeeks=inferInstructionSequence(rows.stream().filter(row->"LECTURE".equalsIgnoreCase(row.type())).map(DocumentRow::name).toList());
        return rows.stream().map(row->new DocumentRow(row.id(),row.name(),row.type(),row.preview(),lectureWeeks.get(row.name()))).toList();
    }
    private Set<UUID> documentsForTopics(UUID courseId,Set<UUID> topicIds){if(topicIds.isEmpty())return Set.of();String placeholders=topicIds.stream().map(ignored->"?").collect(Collectors.joining(","));List<Object> args=new ArrayList<>();args.add(courseId);args.addAll(topicIds);return new LinkedHashSet<>(jdbc.query("SELECT DISTINCT c.document_id FROM chunk_topics ct JOIN chunks c ON c.id=ct.chunk_id WHERE c.course_id=? AND ct.topic_id IN ("+placeholders+")",(rs,row)->rs.getObject(1,UUID.class),args.toArray()));}
    private Set<UUID> chunksForTopics(UUID courseId,Set<UUID> topicIds){if(topicIds.isEmpty())return Set.of();String placeholders=topicIds.stream().map(ignored->"?").collect(Collectors.joining(","));List<Object> args=new ArrayList<>();args.add(courseId);args.addAll(topicIds);return new LinkedHashSet<>(jdbc.query("SELECT DISTINCT ct.chunk_id FROM chunk_topics ct JOIN chunks c ON c.id=ct.chunk_id WHERE c.course_id=? AND ct.topic_id IN ("+placeholders+")",(rs,row)->rs.getObject(1,UUID.class),args.toArray()));}
    private Set<UUID> relatedLectureDocuments(UUID courseId,Set<UUID> anchors){if(anchors.isEmpty())return Set.of();String placeholders=anchors.stream().map(ignored->"?").collect(Collectors.joining(","));List<Object> args=new ArrayList<>();args.add(courseId);args.addAll(anchors);List<UUID> matches=jdbc.query("WITH anchor_embeddings AS (SELECT c.embedding FROM chunks c WHERE c.course_id=? AND c.document_id IN ("+placeholders+") AND c.embedding IS NOT NULL) SELECT d.id FROM documents d JOIN chunks c ON c.document_id=d.id CROSS JOIN anchor_embeddings a WHERE d.course_id=? AND d.document_type='LECTURE' AND d.status IN ('PROCESSED','COMPLETED') AND c.embedding IS NOT NULL GROUP BY d.id ORDER BY MAX(1-(c.embedding <=> a.embedding)) DESC LIMIT 1",(rs,row)->rs.getObject(1,UUID.class),append(args,courseId));return new LinkedHashSet<>(matches);}
    private List<ChunkRow> chunks(UUID courseId,Set<UUID> documentIds){String placeholders=documentIds.stream().map(ignored->"?").collect(Collectors.joining(","));List<Object> args=new ArrayList<>();args.add(courseId);args.addAll(documentIds);return jdbc.query("SELECT c.id,d.name,c.page_start,c.page_end,c.content,c.ordinal FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.course_id=? AND c.document_id IN ("+placeholders+") ORDER BY d.name,c.ordinal LIMIT 160",(rs,row)->new ChunkRow(rs.getObject(1,UUID.class),rs.getString(2),nullableInt(rs,3),nullableInt(rs,4),rs.getString(5),rs.getInt(6)),args.toArray());}
    private List<GenerationScope.ReferenceAssessment> references(UUID courseId,Set<UUID> referenceDocuments,Integer referenceExercise,List<String> requestedTopics){
        List<GenerationScope.ReferenceAssessment> values=new ArrayList<>();
        if(!referenceDocuments.isEmpty()){String placeholders=referenceDocuments.stream().map(ignored->"?").collect(Collectors.joining(","));List<Object> args=new ArrayList<>();args.add(courseId);args.addAll(referenceDocuments);String questionFilter="";if(referenceExercise!=null&&(requestedTopics==null||requestedTopics.isEmpty())){questionFilter=" AND a.question_number=?";args.add(referenceExercise);}values.addAll(jdbc.query("SELECT a.id,a.prompt,a.source_type,d.name,a.page_start,a.page_end FROM assessment_items a LEFT JOIN documents d ON d.id=a.document_id WHERE a.course_id=? AND a.document_id IN ("+placeholders+")"+questionFilter+" ORDER BY a.question_number,a.created_at LIMIT 12",(rs,row)->reference(rs),args.toArray()));if(requestedTopics!=null&&!requestedTopics.isEmpty()){List<GenerationScope.ReferenceAssessment> topical=values.stream().filter(value->requestedTopics.stream().anyMatch(topic->matchesTopic(normalize(value.prompt()),topic))).limit(6).toList();if(!topical.isEmpty())values=new ArrayList<>(topical);else if(values.size()>6)values=new ArrayList<>(values.subList(0,6));}}
        if(values.isEmpty()&&referenceExercise!=null)values.addAll(jdbc.query("SELECT a.id,a.prompt,a.source_type,d.name,a.page_start,a.page_end FROM assessment_items a LEFT JOIN documents d ON d.id=a.document_id WHERE a.course_id=? AND a.question_number=? AND COALESCE(a.source_type,'') IN ('HOMEWORK','ASSIGNMENT') ORDER BY a.created_at LIMIT 6",(rs,row)->reference(rs),courseId,referenceExercise));
        return values;
    }
    private GenerationScope.ReferenceAssessment reference(java.sql.ResultSet rs) throws java.sql.SQLException{return new GenerationScope.ReferenceAssessment(rs.getObject(1,UUID.class).toString(),rs.getString(2),rs.getString(3),rs.getString(4),nullableInt(rs,5),nullableInt(rs,6),AcademicSemanticProfile.empty());}
    private List<String> historicalGeneratedExercises(UUID courseId){try{return jdbc.query("SELECT summary FROM memory_episodes WHERE course_id=? AND provenance='AI_GENERATED_EXERCISE' ORDER BY created_at DESC LIMIT 8",(rs,row)->trim(rs.getString(1),700),courseId);}catch(RuntimeException ignored){return List.of();}}

    private boolean matchesExplicitWeek(DocumentRow document,int week){String name=normalize(document.name());String preview=normalize(document.preview());return Pattern.compile("(?:^|[^0-9])(?:week|lecture|ex|exercise|sheet|hw|homework)\\s*0?"+week+"(?:[^0-9]|$)").matcher(name).find()||containsPhrase(preview,"week "+week);}
    private boolean matchesReference(DocumentRow document,HardNewRequest request){String name=normalize(document.name());if(request.referenceExercise()!=null){int value=request.referenceExercise();return Pattern.compile("(?:^|[^0-9])(?:ex|exercise|sheet|hw|homework)\\s*0?"+value+"(?:[^0-9]|$)").matcher(name).find();}String reference=normalize(request.referenceText());if(reference.isBlank())return false;String[] parts=reference.split(" ");for(String part:parts)if(part.length()>2&&!name.contains(part))return false;return true;}
    private boolean mentionsDocument(String query,String filename){String full=normalize(filename);String base=normalize(filename.replaceFirst("(?i)\\.[a-z0-9]+$","").replaceFirst("(?i)^[0-9a-f]{10,}_",""));return full.length()>=5&&query.contains(full)||base.length()>=5&&query.contains(base);}
    private String scopeLabel(HardNewRequest request,List<String> topics,Set<UUID> explicit,List<DocumentRow> documents){List<String> parts=new ArrayList<>();if(!request.requestedWeeks().isEmpty())parts.add("Week "+request.requestedWeeks().stream().map(String::valueOf).collect(Collectors.joining(", ")));if(!topics.isEmpty())parts.add(String.join(", ",topics));if(!explicit.isEmpty())parts.add(documents.stream().filter(document->explicit.contains(document.id())).map(DocumentRow::name).collect(Collectors.joining(", ")));if(parts.isEmpty()&&!request.referenceText().isBlank())parts.add(request.referenceText());return parts.isEmpty()?"requested source scope":String.join(" · ",parts);}
    private String renderEvidence(List<ChunkRow> chunks,List<String> scopeTerms){StringBuilder value=new StringBuilder();for(ChunkRow chunk:chunks){String content=topicExcerpt(chunk.content(),scopeTerms);value.append("[Source: ").append(chunk.document()).append("; pages ").append(pageText(chunk.pageStart(),chunk.pageEnd())).append("]\n").append(trim(content,scopeTerms.isEmpty()?3200:2200)).append("\n\n");if(value.length()>=7500)break;}return trim(value.toString(),7500);}
    /** Coarse PDF chunks can contain a whole worksheet. A requested topic still forms a closed
     * semantic boundary, so retain windows around its canonical name or aliases before generation. */
    static String topicExcerpt(String content,List<String> terms){
        if(content==null||content.isBlank()||terms==null||terms.isEmpty())return content==null?"":content;
        String lower=content.toLowerCase(Locale.ROOT);List<int[]> ranges=new ArrayList<>();
        for(String term:terms){String needle=term==null?"":term.toLowerCase(Locale.ROOT).trim();if(needle.length()<2)continue;int from=0;while((from=lower.indexOf(needle,from))>=0){ranges.add(new int[]{Math.max(0,from-220),Math.min(content.length(),from+needle.length()+720)});from+=needle.length();}}
        if(ranges.isEmpty())return content;
        ranges.sort(Comparator.comparingInt(value->value[0]));StringBuilder selected=new StringBuilder();int start=ranges.getFirst()[0],end=ranges.getFirst()[1];
        for(int index=1;index<ranges.size();index++){int[] range=ranges.get(index);if(range[0]<=end+80)end=Math.max(end,range[1]);else{if(selected.length()>0)selected.append(" … ");selected.append(content,start,end);start=range[0];end=range[1];}}
        if(selected.length()>0)selected.append(" … ");selected.append(content,start,end);return selected.toString();
    }
    private static boolean containsPhrase(String text,String phrase){return TopicMentions.containsPhrase(text,phrase);}
    private static boolean matchesTopic(String query,String term){return TopicMentions.matches(query,term);}
    private static List<String> topicSearchTerms(String term){String normalized=normalize(term);if(normalized.isBlank())return List.of();List<String> values=new ArrayList<>();values.add(term);String[] words=normalized.split(" ");if(words.length>=2){String acronym=Arrays.stream(words).filter(word->!word.isBlank()).map(word->word.substring(0,1)).collect(Collectors.joining());if(acronym.length()>=2)values.add(acronym);}return List.copyOf(values);}
    private static String normalize(String value){return TopicMentions.normalize(value);}
    static Map<String,Integer> inferInstructionSequence(List<String> names){
        record DatedName(String name,LocalDate date){}
        List<DatedName> dated=new ArrayList<>();
        Pattern date=Pattern.compile("(20\\d{2})[-_](\\d{2})[-_](\\d{2})");
        for(String name:names==null?List.<String>of():names){var matcher=date.matcher(name==null?"":name);if(!matcher.find())continue;try{dated.add(new DatedName(name,LocalDate.of(Integer.parseInt(matcher.group(1)),Integer.parseInt(matcher.group(2)),Integer.parseInt(matcher.group(3)))));}catch(RuntimeException ignored){}}
        dated.sort(Comparator.comparing(DatedName::date).thenComparing(DatedName::name));Map<String,Integer> result=new LinkedHashMap<>();LocalDate previous=null;int week=0;for(DatedName value:dated){if(!value.date().equals(previous)){week++;previous=value.date();}result.put(value.name(),week);}return Map.copyOf(result);
    }
    private static List<ChunkRow> balanced(List<ChunkRow> chunks){
        if(chunks==null||chunks.isEmpty())return List.of();Map<String,List<ChunkRow>> byDocument=chunks.stream().collect(Collectors.groupingBy(ChunkRow::document,LinkedHashMap::new,Collectors.toList()));List<ChunkRow> result=new ArrayList<>();for(int round=0;result.size()<MAX_SCOPE_CHUNKS;round++){boolean added=false;for(List<ChunkRow> values:byDocument.values()){if(round<values.size()){result.add(values.get(round));added=true;if(result.size()==MAX_SCOPE_CHUNKS)break;}}if(!added)break;}return List.copyOf(result);
    }
    private static String trim(String value,int max){String clean=value==null?"":value.replaceAll("\\s+"," ").trim();return clean.length()<=max?clean:clean.substring(0,max)+"…";}
    private static Object[] append(List<Object> values,Object tail){List<Object> copy=new ArrayList<>(values);copy.add(tail);return copy.toArray();}
    private static Integer nullableInt(java.sql.ResultSet rs,int column)throws java.sql.SQLException{int value=rs.getInt(column);return rs.wasNull()?null:value;}
    private static String pageText(Integer start,Integer end){return start==null?"?":end==null||Objects.equals(start,end)?start.toString():start+"-"+end;}

    private record TopicTerm(UUID id,String canonical,String term){}
    private record DocumentRow(UUID id,String name,String type,String preview,Integer inferredWeek){}
    private record ChunkRow(UUID id,String document,Integer pageStart,Integer pageEnd,String content,int ordinal){}
    private record ScopeSemantics(AcademicSemanticProfile source,List<SemanticProfileExtraction.ReferenceProfile> references){private ScopeSemantics{source=source==null?AcademicSemanticProfile.empty():source;references=references==null?List.of():List.copyOf(references);}static ScopeSemantics empty(){return new ScopeSemantics(AcademicSemanticProfile.empty(),List.of());}}
}
