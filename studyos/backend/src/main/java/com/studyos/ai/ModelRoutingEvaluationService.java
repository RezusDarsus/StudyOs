package com.studyos.ai;

import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class ModelRoutingEvaluationService {
    private final AiUsageProperties properties; private final ModelRoutingFixtures fixtures; private final JdbcTemplate jdbc;
    public ModelRoutingEvaluationService(AiUsageProperties properties,ModelRoutingFixtures fixtures,JdbcTemplate jdbc){this.properties=properties;this.fixtures=fixtures;this.jdbc=jdbc;}

    public Status status(){
        List<String> concepts=evaluationConcepts();
        Map<String,Integer> counts=new LinkedHashMap<>();
        for(AiOperation operation:List.of(AiOperation.GRADING,AiOperation.TOPIC_EXTRACTION,AiOperation.MEMORY_EXTRACTION,AiOperation.SUMMARY,AiOperation.ASSESSMENT_EXTRACTION))counts.put(operation.name(),fixtures.fixtures(operation,concepts).size());
        boolean same=Objects.equals(properties.getPrimaryModel(),properties.resolvedInternalModel());
        String decision=same?"INTERNAL_EQUALS_PRIMARY":concepts.isEmpty()?"NO_EVALUATION_MATERIAL":"EVALUATION_REQUIRED";
        return new Status(properties.getPrimaryModel(),properties.resolvedInternalModel(),same,false,decision,counts,concepts.size());
    }

    /**
     * The concepts a cheaper model would be judged on: the topics this installation's own material covers
     * most, widest first. Drawn from the corpus rather than written down here, because a fixed list would
     * certify the model against one subject and then route every other subject through it.
     */
    private List<String> evaluationConcepts(){
        String sql="SELECT t.canonical_name FROM topics t JOIN chunk_topics ct ON ct.topic_id=t.id GROUP BY t.id,t.canonical_name ORDER BY COUNT(DISTINCT ct.chunk_id) DESC,t.canonical_name LIMIT ?";
        try { return jdbc.query(sql,(rs,row)->rs.getString(1),ModelRoutingFixtures.FIXTURES_PER_OPERATION); }
        catch(org.springframework.dao.DataAccessException error){ return List.of(); }
    }

    /** {@code conceptsAvailable} says how much material the decision rests on, so an empty verdict is readable. */
    public record Status(String primaryModel,String internalModel,boolean sameModel,boolean smallerModelEnabled,String decision,Map<String,Integer> fixturesPerOperation,int conceptsAvailable) {}
}
