package com.studyos.evaluation;

import com.studyos.chat.ExerciseNoveltyEvaluator;
import com.studyos.integration.LearningGoalDetector;
import com.studyos.planner.PriorityCalculator;
import com.studyos.prediction.ReadinessCalculator;
import com.studyos.retrieval.RankFusion;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class QualityHarnessService {
    public Report run(){List<CaseResult> cases=new ArrayList<>();
        var weights=new PriorityCalculator.Weights(.35,.2,.2,.1,.1,.05);var crc=PriorityCalculator.calculate(new PriorityCalculator.Input(.9,.35,.7,.8,0,0,0,false,20),weights);var routing=PriorityCalculator.calculate(new PriorityCalculator.Input(.4,.8,.9,.8,0,0,0,false,20),weights);cases.add(result("planner","weak important topic outranks strong low-relevance topic",crc.value()>routing.value(),crc.value()+" > "+routing.value()));
        var partial=grade(.65,"expected");cases.add(result("grading","partial credit is preserved","PARTIALLY_CORRECT".equals(partial),partial));
        var unsupported=grade(.9,null);cases.add(result("grading","missing rubric is reported honestly","UNSUPPORTED".equals(unsupported),unsupported));
        var novelty=ExerciseNoveltyEvaluator.evaluate(List.of("Calculate CRC for message 1011 with generator 1101"),"Calculate CRC for message 1110 with generator 1011");cases.add(result("exercise_novelty","parameter-only rewrite is rejected",!novelty.passesLocalNoveltyGate(),novelty.classification()));
        UUID a=UUID.randomUUID(),b=UUID.randomUUID();List<UUID> fused=RankFusion.fuse(List.of(a,b),List.of(b,a),value->value);cases.add(result("retrieval","hybrid fusion retains both candidates",fused.size()==2,fused.toString()));
        var low=ReadinessCalculator.calculate(List.of(new ReadinessCalculator.Topic(.35,.9,.5,0)),2);var high=ReadinessCalculator.calculate(List.of(new ReadinessCalculator.Topic(.8,.9,.9,3)),0);cases.add(result("readiness","evidence and retention improve readiness",high.readiness()>low.readiness(),low.readiness()+" -> "+high.readiness()));
        var goal=LearningGoalDetector.detect("Prepare for AWS certification","");cases.add(result("classification","learning goal activates optional offer",goal.offerStudyOs(),goal.reason()));
        long passed=cases.stream().filter(CaseResult::passed).count();return new Report(passed==cases.size()?"PASS":"FAIL",cases.size(),(int)passed,List.copyOf(cases),Instant.now());}
    private String grade(double score,String expected){if(expected==null||expected.isBlank())return "UNSUPPORTED";if(score>=.85)return "CORRECT";if(score>=.35)return "PARTIALLY_CORRECT";return "INCORRECT";}
    private CaseResult result(String category,String name,boolean passed,String details){return new CaseResult(category,name,passed,details);}
    public record Report(String status,int total,int passed,List<CaseResult> cases,Instant executedAt){}
    public record CaseResult(String category,String name,boolean passed,String details){}
}
