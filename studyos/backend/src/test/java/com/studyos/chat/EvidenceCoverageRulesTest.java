package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class EvidenceCoverageRulesTest {
    @Test void acceptsOnlyExactQuotesFromAuthoritativeEvidence(){
        var verification=verification(Map.of("relation is finite","The relation is finite","decompose relation","decompose relation R"));
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("The relation is finite. Use the dependency to decompose relation R.",verification)).isEmpty();
    }

    @Test void rejectsFabricatedOrMissingConceptEvidence(){
        var fabricated=verification(Map.of("relation is finite","The relation uses imaginary tuples","decompose relation","decompose relation R"));
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("The relation is finite. Use the dependency to decompose relation R.",fabricated)).anyMatch(issue->issue.contains("unverifiable"));
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("The relation is finite. Use the dependency to decompose relation R.",verification(Map.of()))).anyMatch(issue->issue.contains("missing exact evidence"));
    }

    @Test void rejectsARealButSemanticallyUnrelatedQuote(){
        var unrelated=verification(Map.of("relation is finite","The schema has attributes X and Y","decompose relation","decompose relation R"));
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("The schema has attributes X and Y. Use the dependency to decompose relation R.",unrelated)).anyMatch(issue->issue.contains("does not name"));
    }

    @Test void requiresExactEvidenceForCandidateAssumptions(){
        var profile=profile();
        var verification=new PredictionVerificationBatch.Verification("candidate-1",List.of("functional dependency"),List.of("functional dependency"),List.of(),List.of(),false,true,true,true,List.of(),List.of(),"NEW_REASONING",.8,false,"",.8,profile,List.of(),List.of(),List.of(),.2,.8,"deeper proof",Map.of());
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("A finite relation uses functional dependency X determines Y and normalization can decompose relation R.",verification))
            .containsExactly("missing exact evidence for relation is finite");
    }

    @Test void genericDefinitionDoesNotAuthorizeInventedConcreteValues(){
        var profile=new AcademicSemanticProfile(List.of("state set"),List.of("local state set Zp = {0, 1}"),List.of(),List.of(),List.of(),List.of(),List.of());
        var value=new PredictionVerificationBatch.Verification("candidate-1",List.of("state set"),List.of("state set"),List.of(),List.of(),false,true,true,true,List.of(),List.of(),"NEW_REASONING",.8,false,"",.8,profile,List.of(),List.of(),List.of(),.2,.8,"deeper proof",Map.of("local state set Zp = {0, 1}","Zp is the set of local configurations or states"));
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("Zp is the set of local configurations or states.",value)).anyMatch(issue->issue.contains("does not name"));
    }

    @Test void broadObjectDefinitionDoesNotAuthorizeAnInventedInstance(){
        var profile=new AcademicSemanticProfile(List.of("ring"),List.of("three processes in a ring"),List.of(),List.of(),List.of(),List.of(),List.of());
        var value=new PredictionVerificationBatch.Verification("candidate-1",List.of("ring"),List.of("ring"),List.of(),List.of(),false,true,true,true,List.of(),List.of(),"NEW_REASONING",.8,false,"",.8,profile,List.of(),List.of(),List.of(),.2,.8,"deeper proof",Map.of("three processes in a ring","Example: ring with nodes P = [0:n-1]"));
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("Example: ring with nodes P = [0:n-1].",value)).anyMatch(issue->issue.contains("does not name"));
    }

    @Test void acceptsConcreteValuesWhenTheSourceActuallyStatesThem(){
        var profile=new AcademicSemanticProfile(List.of("state set"),List.of("local state set Zp = {0, 1}"),List.of(),List.of(),List.of(),List.of(),List.of());
        var value=new PredictionVerificationBatch.Verification("candidate-1",List.of("state set"),List.of("state set"),List.of(),List.of(),false,true,true,true,List.of(),List.of(),"NEW_REASONING",.8,false,"",.8,profile,List.of(),List.of(),List.of(),.2,.8,"deeper proof",Map.of("local state set Zp = {0, 1}","The local state set is Zp = {0, 1}."));
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("The local state set is Zp = {0, 1}.",value)).isEmpty();
    }

    @Test void recoversWhenVerifierSelectedAWeakQuoteButSourceContainsTheExactAssumption(){
        var profile=new AcademicSemanticProfile(List.of("state space"),List.of("state space is Z = {S subset N | S finite} x N"),List.of(),List.of(),List.of(),List.of(),List.of());
        var value=new PredictionVerificationBatch.Verification("candidate-1",List.of("state space"),List.of("state space"),List.of(),List.of(),false,true,true,true,List.of(),List.of(),"NEW_REASONING",.8,false,"",.8,profile,List.of(),List.of(),List.of(),.2,.8,"deeper proof",Map.of("state space is Z = {S subset N | S finite} x N","use as your set of states"));
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("Hint: use as your state space Z = {S subset N | S finite} x N.",value)).isEmpty();
    }

    @Test void sourceBindingDirectiveIsNotMistakenForAnAcademicAssumption(){
        var profile=new AcademicSemanticProfile(List.of("relation"),List.of("use definitions, rules, and assumptions from the cited source unchanged"),List.of(),List.of(),List.of(),List.of("prove"),List.of());
        var value=new PredictionVerificationBatch.Verification("candidate-1",List.of("relation"),List.of("relation"),List.of(),List.of(),false,true,true,true,List.of(),List.of(),"NEW_REASONING",.8,false,"",.8,profile,List.of(),List.of(),List.of(),.2,.8,"deeper proof",Map.of());
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("The relation is finite.",value)).isEmpty();
    }

    @Test void summarizedInitialConfigurationCanBeRecoveredFromExactAtomicSourceFacts(){
        var profile=new AcademicSemanticProfile(List.of("configuration"),List.of("initial configuration ({0}, 0)"),List.of(),List.of(),List.of(),List.of(),List.of());
        var value=new PredictionVerificationBatch.Verification("candidate-1",List.of("configuration"),List.of("configuration"),List.of(),List.of(),false,true,true,true,List.of(),List.of(),"NEW_REASONING",.8,false,"",.8,profile,List.of(),List.of(),List.of(),.2,.8,"deeper proof",Map.of("initial configuration ({0}, 0)","Initially S contains only 0 and register R is initially 0"));
        assertThat(ExamPredictionVerificationService.evidenceCoverageIssues("Initially S contains only 0 and register R is initially 0.",value)).isEmpty();
    }

    private PredictionVerificationBatch.Verification verification(Map<String,String> evidence){
        return new PredictionVerificationBatch.Verification("candidate-1",List.of("functional dependency"),List.of("functional dependency"),List.of(),List.of(),false,true,true,true,List.of(),List.of(),"NEW_REASONING",.8,false,"",.8,profile(),List.of(),List.of(),List.of(),.2,.8,"deeper proof",evidence);
    }
    private AcademicSemanticProfile profile(){return new AcademicSemanticProfile(List.of("functional dependency"),List.of("relation is finite"),List.of("relations"),List.of("decompose relation"),List.of("normalization"),List.of(),List.of());}
}
