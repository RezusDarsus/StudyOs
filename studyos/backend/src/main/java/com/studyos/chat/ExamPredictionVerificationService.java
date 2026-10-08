package com.studyos.chat;

import com.studyos.ai.*;
import com.studyos.retrieval.EmbeddingService;
import java.sql.ResultSet;
import java.util.*;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Small, deliberately in-flow verification stage for generated exam predictions.
 * It uses assessment-item similarity as evidence, then asks one strict verifier per small batch.
 */
@Service
public class ExamPredictionVerificationService {
    private static final int VERIFIER_BATCH_SIZE=3;
    /**
     * Ceiling on verifier calls in one turn. Batches, the parse retry each batch may take, and the adversarial
     * audit over the survivors multiply together, and nothing bounded that product: the recorded run has a
     * prediction turn spending 21 upstream attempts over 271 seconds before answering. Past this many calls a
     * turn stops asking, keeps what it already has, and says in its diagnostics that it stopped — a cap that
     * silently shrinks an answer is indistinguishable from an answer that had nothing more to give.
     */
    static final int VERIFIER_CALL_CEILING=6;
    private final JdbcTemplate jdbc; private final EmbeddingService embeddings; private final AiGateway ai; private final AiUsageService usage; private final GenerationPolicyRegistry policies;
    public ExamPredictionVerificationService(JdbcTemplate jdbc,EmbeddingService embeddings,AiGateway ai,AiUsageService usage,GenerationPolicyRegistry policies) { this.jdbc=jdbc;this.embeddings=embeddings;this.ai=ai;this.usage=usage;this.policies=policies; }

    /**
     * Calls one turn may spend verifying: two per batch, which is one pass plus either its parse retry or its
     * adversarial audit, and never more than {@link #VERIFIER_CALL_CEILING}. Two is the floor because a single
     * call with no second opinion is not verification.
     */
    static int verifierCallBudget(int candidateCount) {
        int batches=(Math.max(0,candidateCount)+VERIFIER_BATCH_SIZE-1)/VERIFIER_BATCH_SIZE;
        return Math.min(VERIFIER_CALL_CEILING,Math.max(2,batches*2));
    }

    /** One turn's verifier-call allowance, shared by the primary and adversarial passes so they cannot double it. */
    private static final class CallBudget {
        private final int limit; private int used;
        private CallBudget(int limit){this.limit=Math.max(1,limit);}
        private boolean reserve(){ if(used>=limit)return false; used++; return true; }
        private int used(){return used;}
        private int limit(){return limit;}
    }

    public Outcome verify(UUID courseId,UUID chatId,List<PredictionCandidateBatch.PredictionCandidate> generated,int requestedCount,String selectedScope) { return verifyInternal(courseId,chatId,generated,requestedCount,selectedScope,null); }
    public Outcome verifyHardNew(UUID courseId,UUID chatId,List<PredictionCandidateBatch.PredictionCandidate> generated,int requestedCount,GenerationScope scope) { return verifyInternal(courseId,chatId,generated,requestedCount,scope.label(),scope); }
    private Outcome verifyInternal(UUID courseId,UUID chatId,List<PredictionCandidateBatch.PredictionCandidate> generated,int requestedCount,String selectedScope,GenerationScope hardScope) {
        int structuralRejected=0,scopeRejected=0,citationRejected=0,duplicateRejected=0,noveltyRejected=0,verifierRejected=0,unverified=0,unaudited=0; long started=System.nanoTime(); List<CandidateDebug> rejectedDebug=new ArrayList<>();
        List<Candidate> candidates=new ArrayList<>();
        for(int index=0;index<generated.size();index++) {
            var value=generated.get(index); String id="candidate-"+(index+1);
            if(!PredictionVerificationRules.structurallyUsable(value)) { structuralRejected++; rejectedDebug.add(new CandidateDebug(id,value.title(),List.of(),"structurallyUsable=false")); continue; }
            GenerationScopeRules.ScopeCheck scopeCheck=hardScope==null?null:GenerationScopeRules.check(hardScope,value);
            if(scopeCheck!=null&&!scopeCheck.allowed()){scopeRejected++;rejectedDebug.add(new CandidateDebug(id,value.title(),List.of(),scopeCheck.issue(),scopeCheck.requiredConcepts(),scopeCheck.supportedConcepts(),scopeCheck.unsupportedConcepts(),scopeCheck.unsupportedModelChanges(),scopeCheck.scopeViolation(),scopeCheck.noveltyType()));continue;}
            var citationCheck=validateCitations(courseId,value,hardScope);
            if(!citationCheck.valid()){citationRejected++;rejectedDebug.add(new CandidateDebug(id,value.title(),List.of(),"citationOk=false: "+String.join("; ",citationCheck.issues()),scopeCheck==null?List.of():scopeCheck.requiredConcepts(),scopeCheck==null?List.of():scopeCheck.supportedConcepts(),scopeCheck==null?List.of():scopeCheck.unsupportedConcepts(),scopeCheck==null?List.of():scopeCheck.unsupportedModelChanges(),hardScope!=null,"OUT_OF_SCOPE",citationCheck.issues()));continue;}
            candidates.add(new Candidate(id,value,List.of(),List.of(),0));
        }
        if(candidates.isEmpty()) return new Outcome(List.of(),new PredictionDiagnostics(generated.size(),structuralRejected,scopeRejected,0,0,0,elapsed(started),rejectedDebug,citationRejected,0,new GateExecution(true,hardScope!=null,true,false,false,false),0,0,null));

        // The stages below embed text and write vectors, which are provider calls, and a stage that starts with
        // no budget left produces nothing except a later answer. When the clock is already gone the candidates
        // are reported as never compared rather than passed through an unrun gate.
        if(RequestDeadline.spent()) return stoppedBeforeSimilarity(generated.size(),structuralRejected,scopeRejected,citationRejected,candidates.size(),started,rejectedDebug,hardScope,"assessment lookup");
        List<AssessmentItem> assessments=loadAssessmentItems(courseId);
        ensureAssessmentEmbeddings(courseId,assessments);
        if(RequestDeadline.spent()) return stoppedBeforeSimilarity(generated.size(),structuralRejected,scopeRejected,citationRejected,candidates.size(),started,rejectedDebug,hardScope,"candidate embedding");
        List<float[]> candidateVectors=embeddings.embedQueries(courseId,null,candidates.stream().map(candidate->candidate.value().title()+"\n"+candidate.value().exercise()).toList());
        List<Candidate> comparable=new ArrayList<>();
        for(int index=0;index<candidates.size();index++) {
            Candidate candidate=candidates.get(index); List<SimilarAssessment> similar=closest(assessments,candidateVectors.get(index));
            boolean duplicate=!similar.isEmpty()&&PredictionVerificationRules.obviousDuplicate(similar.getFirst().similarity(),similar.getFirst().prompt(),candidate.value().exercise());
            if(duplicate) { duplicateRejected++; rejectedDebug.add(new CandidateDebug(candidate.id(),candidate.value().title(),similar,"obviousDuplicate=true")); continue; }
            var shallow=PredictionVerificationRules.shallowAgainst(similar.stream().map(SimilarAssessment::prompt).toList(),candidate.value().exercise());
            if(shallow.isPresent()) { noveltyRejected++; rejectedDebug.add(new CandidateDebug(candidate.id(),candidate.value().title(),similar,"localNoveltyType="+shallow.get(),List.of(),List.of(),List.of(),List.of(),false,shallow.get(),List.of())); continue; }
            comparable.add(candidate.withSimilarity(similar,sourceEvidence(courseId,candidate.value())));
        }
        if(comparable.isEmpty()) return new Outcome(List.of(),new PredictionDiagnostics(generated.size(),structuralRejected,scopeRejected,duplicateRejected,0,0,elapsed(started),rejectedDebug,citationRejected,noveltyRejected,new GateExecution(true,hardScope!=null,true,true,hardScope!=null,false),0,0,null));

        CallBudget budget=new CallBudget(verifierCallBudget(comparable.size()));
        VerificationPass primaryPass=runVerificationPass(courseId,chatId,comparable,selectedScope,hardScope,false,budget);Map<String,PredictionVerificationBatch.Verification> decisions=new HashMap<>(primaryPass.decisions());String verifierFailure=primaryPass.failure();String budgetStop=primaryPass.stopped()?primaryPass.failure():null;
        Map<String,List<String>> evidenceCoverageIssues=new HashMap<>();
        for(Candidate candidate:comparable){List<String> issues=new ArrayList<>(evidenceCoverageIssues(candidate,decisions.get(candidate.id()),hardScope));issues.addAll(referenceModelCoverageIssues(decisions.get(candidate.id()),hardScope));double referenceStrategy=hardScope==null||decisions.get(candidate.id())==null?0:PredictionVerificationRules.semanticStrategySimilarity(decisions.get(candidate.id()).candidateSemantics(),hardScope.referenceAssessments().stream().map(GenerationScope.ReferenceAssessment::semantics).toList());if(referenceStrategy>=.55)issues.add("semantic task strategy duplicates an explicit reference assessment ("+String.format(Locale.ROOT,"%.2f",referenceStrategy)+")");evidenceCoverageIssues.put(candidate.id(),List.copyOf(issues));}
        List<VerifiedCandidate> strong=new ArrayList<>();
        for(Candidate candidate:comparable) {
            var verification=decisions.get(candidate.id());
            // No decision is not a rejection. A candidate whose batch was never sent, or whose verdict came back
            // unparseable, has not been judged unfit — it has not been judged. Counting the two together is what
            // let a turn report every candidate as rejected by a verifier that never ran.
            if(verification==null) { unverified++; continue; }
            boolean evidenceCovered=evidenceCoverageIssues.getOrDefault(candidate.id(),List.of()).isEmpty();
            boolean accepted=evidenceCovered&&(hardScope==null?PredictionVerificationRules.eligible(verification,false):PredictionVerificationRules.eligibleHardNew(verification));
            if(!accepted) {
                verifierRejected++;
                continue;
            }
            strong.add(toVerified(courseId,candidate,verification));
        }
        strong.sort(Comparator.comparingDouble(VerifiedCandidate::rankingScore).reversed());
        if(!strong.isEmpty()&&!RequestDeadline.spent()){
            Map<String,Candidate> byId=comparable.stream().collect(Collectors.toMap(Candidate::id,value->value));List<Candidate> finalists=strong.stream().map(value->byId.get(value.candidateId())).filter(Objects::nonNull).toList();VerificationPass auditPass=runVerificationPass(courseId,chatId,finalists,selectedScope,hardScope,true,budget);if(auditPass.failure()!=null)verifierFailure=auditPass.failure();if(auditPass.stopped()&&budgetStop==null)budgetStop=auditPass.failure();List<VerifiedCandidate> audited=new ArrayList<>();
            for(VerifiedCandidate value:strong){Candidate candidate=byId.get(value.candidateId());var audit=auditPass.decisions().get(value.candidateId());
                // Kept on its first verdict, which did check grounding, novelty and well-definedness, and counted
                // as unaudited so the reply can say the second opinion is missing instead of implying it agreed.
                if(audit==null){unaudited++;audited.add(value);continue;}
                List<String> auditIssues=new ArrayList<>(evidenceCoverageIssues(candidate,audit,hardScope));auditIssues.addAll(referenceModelCoverageIssues(audit,hardScope));double referenceStrategy=hardScope==null?0:PredictionVerificationRules.semanticStrategySimilarity(audit.candidateSemantics(),hardScope.referenceAssessments().stream().map(GenerationScope.ReferenceAssessment::semantics).toList());if(referenceStrategy>=.55)auditIssues.add("semantic task strategy duplicates an explicit reference assessment ("+String.format(Locale.ROOT,"%.2f",referenceStrategy)+")");boolean accepted=auditIssues.isEmpty()&&(hardScope==null?PredictionVerificationRules.eligible(audit,false):PredictionVerificationRules.eligibleHardNew(audit));if(!accepted){verifierRejected++;decisions.put(value.candidateId(),audit);evidenceCoverageIssues.put(value.candidateId(),List.copyOf(auditIssues));continue;}var conservative=conservative(value.verification(),audit);decisions.put(value.candidateId(),conservative);evidenceCoverageIssues.put(value.candidateId(),List.of());audited.add(toVerified(courseId,candidate,conservative));}
            strong=audited;strong.sort(Comparator.comparingDouble(VerifiedCandidate::rankingScore).reversed());
        }
        else if(!strong.isEmpty()) { unaudited+=strong.size(); if(budgetStop==null)budgetStop="DEADLINE: the final adversarial audit did not run for "+strong.size()+" candidate(s)"; }
        List<VerifiedCandidate> selectedValues=new ArrayList<>();for(VerifiedCandidate value:strong){boolean duplicateStrategy=selectedValues.stream().anyMatch(existing->sameGeneratedStrategy(existing.candidate().exercise(),value.candidate().exercise()));if(!duplicateStrategy)selectedValues.add(value);if(selectedValues.size()==requestedCount)break;}List<VerifiedCandidate> selected=List.copyOf(selectedValues);
        String finalVerifierFailure=verifierFailure; List<CandidateDebug> debug=new ArrayList<>(rejectedDebug);debug.addAll(comparable.stream().map(candidate->decisionDebug(candidate,decisions.get(candidate.id()),finalVerifierFailure,evidenceCoverageIssues.getOrDefault(candidate.id(),List.of()))).toList());
        return new Outcome(List.copyOf(selected),new PredictionDiagnostics(generated.size(),structuralRejected,scopeRejected,duplicateRejected,verifierRejected,budget.used(),elapsed(started),debug,citationRejected,noveltyRejected,new GateExecution(true,hardScope!=null,true,true,true,budget.used()>0),unverified,unaudited,budgetStop));
    }

    /**
     * Nothing selected because the turn ran out of time before the similarity gate could run. The candidates are
     * reported as unverified rather than rejected, and the gate as unrun rather than passed: a stage that never
     * executed must not read as a stage that found nothing wrong.
     */
    private Outcome stoppedBeforeSimilarity(int generatedCount,int structuralRejected,int scopeRejected,int citationRejected,int unverified,long started,List<CandidateDebug> rejectedDebug,GenerationScope hardScope,String stage) {
        return new Outcome(List.of(),new PredictionDiagnostics(generatedCount,structuralRejected,scopeRejected,0,0,0,elapsed(started),rejectedDebug,citationRejected,0,new GateExecution(true,hardScope!=null,true,false,false,false),unverified,0,
                "DEADLINE: verification stopped at "+stage+"; "+unverified+" candidate(s) were never compared with existing assessments or checked by a verifier"));
    }

    private VerificationPass runVerificationPass(UUID courseId,UUID chatId,List<Candidate> candidates,String selectedScope,GenerationScope hardScope,boolean adversarial,CallBudget budget) {
        Map<String,PredictionVerificationBatch.Verification> decisions=new HashMap<>();int calls=0;String failure=null;boolean stopped=false;
        for(int from=0;from<candidates.size();from+=VERIFIER_BATCH_SIZE) {
            if(RequestDeadline.spent()){failure="DEADLINE: verification stopped after "+calls+" batches";stopped=true;break;}
            if(!budget.reserve()){failure="BUDGET: verification stopped after "+budget.used()+" verifier calls (cap "+budget.limit()+")";stopped=true;break;}
            List<Candidate> batch=candidates.subList(from,Math.min(from+VERIFIER_BATCH_SIZE,candidates.size()));calls++;AiResult<PredictionVerificationBatch> result=null;boolean success=false;boolean recordedAlready=false;long callStarted=System.nanoTime();
            String prompt=verifierPrompt(batch,selectedScope,hardScope);String system=adversarial?adversarialVerifierSystemPrompt():verifierSystemPrompt();
            try {
                result=ai.generateStructuredResult(system,prompt,PredictionVerificationBatch.class,verifierPolicy());
                for(var decision:result.value().candidates())if(batch.stream().anyMatch(candidate->candidate.id().equals(decision.candidateId())))decisions.put(decision.candidateId(),decision);
                success=Boolean.TRUE.equals(result.structuredParseSuccess())||result.structuredParseSuccess()==null;
            } catch(StructuredGenerationException error) {
                failure="PARSE_ERROR: "+trim(error.rawText(),300);result=error.telemetryResult();
                usage.record(AiOperation.EXAM_PREDICTION_VERIFICATION,result,courseId,chatId,null,(System.nanoTime()-callStarted)/1_000_000,false);
                // The retry is a second provider call and comes out of the same allowance as everything else.
                // Without that, one unparseable batch doubled the turn's verifier spend for free.
                if(!budget.reserve()){failure="BUDGET: retry after an unparseable verdict was not affordable ("+budget.used()+" verifier calls, cap "+budget.limit()+")";stopped=true;recordedAlready=true;}
                else {
                    callStarted=System.nanoTime();calls++;
                    try {
                        result=ai.generateStructuredResult(system+" Your previous output was not parseable. Return exactly the required concise JSON object now.",prompt,PredictionVerificationBatch.class,verifierPolicy());
                        for(var decision:result.value().candidates())if(batch.stream().anyMatch(candidate->candidate.id().equals(decision.candidateId())))decisions.put(decision.candidateId(),decision);
                        success=Boolean.TRUE.equals(result.structuredParseSuccess())||result.structuredParseSuccess()==null;
                    } catch(StructuredGenerationException retryError){result=retryError.telemetryResult();failure="PARSE_ERROR: "+trim(retryError.rawText(),300);}
                }
            } finally {
                if(!recordedAlready)usage.record(AiOperation.EXAM_PREDICTION_VERIFICATION,result,courseId,chatId,null,(System.nanoTime()-callStarted)/1_000_000,success);
            }
            if(stopped)break;
        }
        return new VerificationPass(Map.copyOf(decisions),calls,failure,stopped);
    }

    private List<AssessmentItem> loadAssessmentItems(UUID courseId) {
        return jdbc.query("SELECT a.id,a.prompt,a.source_type,d.name,a.page_start,a.page_end,a.embedding::text FROM assessment_items a LEFT JOIN documents d ON d.id=a.document_id WHERE a.course_id=? AND COALESCE(a.source_type,'') IN ('HOMEWORK','PAST_EXAM','QUIZ','ASSIGNMENT')",(rs,row)->assessment(rs),courseId);
    }
    private AssessmentItem assessment(ResultSet rs) throws java.sql.SQLException { return new AssessmentItem(rs.getObject(1,UUID.class),rs.getString(2),rs.getString(3),rs.getString(4),number(rs,5),number(rs,6),parseVector(rs.getString(7))); }
    private Integer number(ResultSet rs,int column) throws java.sql.SQLException { int value=rs.getInt(column);return rs.wasNull()?null:value; }
    private void ensureAssessmentEmbeddings(UUID courseId,List<AssessmentItem> items) {
        List<AssessmentItem> missing=items.stream().filter(item->item.embedding.length==0).toList(); if(missing.isEmpty())return;
        List<float[]> values=embeddings.embedBatch(courseId,null,missing.stream().map(AssessmentItem::prompt).toList());
        for(int index=0;index<missing.size();index++) { AssessmentItem item=missing.get(index);float[] vector=values.get(index);item.embedding=vector;jdbc.update("UPDATE assessment_items SET embedding=?::vector WHERE id=?",vectorLiteral(vector),item.id()); }
    }
    private List<SimilarAssessment> closest(List<AssessmentItem> items,float[] candidate) {
        return items.stream().filter(item->item.embedding.length==candidate.length).map(item->new SimilarAssessment(item.id(),item.prompt(),item.sourceType,item.document,item.pageStart,item.pageEnd,cosine(candidate,item.embedding)))
                .sorted(Comparator.comparingDouble(SimilarAssessment::similarity).reversed()).limit(3).toList();
    }
    private List<SourceEvidence> sourceEvidence(UUID courseId,PredictionCandidateBatch.PredictionCandidate candidate) {
        List<SourceEvidence> evidence=new ArrayList<>();
        for(var source:candidate.sourceBasis()) {
            int[] pages=pages(source.pages());
            evidence.addAll(jdbc.query("SELECT d.name,a.page_start,a.page_end,a.prompt FROM assessment_items a JOIN documents d ON d.id=a.document_id WHERE a.course_id=? AND d.name=? AND (a.page_start IS NULL OR a.page_start<=?) AND (a.page_end IS NULL OR a.page_end>=?) ORDER BY a.question_number,a.created_at LIMIT 2",(rs,row)->new SourceEvidence(rs.getString(1),number(rs,2),number(rs,3),trim(rs.getString(4),3000)),courseId,source.document(),pages[1],pages[0]));
            evidence.addAll(jdbc.query("SELECT d.name,c.page_start,c.page_end,c.content FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.course_id=? AND d.name=? AND (c.page_start IS NULL OR c.page_start<=?) AND (c.page_end IS NULL OR c.page_end>=?) ORDER BY c.ordinal LIMIT 2",(rs,row)->new SourceEvidence(rs.getString(1),number(rs,2),number(rs,3),trim(rs.getString(4),2600)),courseId,source.document(),pages[1],pages[0]));
            if(evidence.size()>=4)break;
        }
        return evidence.subList(0,Math.min(4,evidence.size()));
    }
    /**
     * Every generated exercise must cite a document that exists and page numbers that exist inside it.
     * This runs for exam predictions too, because a fabricated page range is wrong in either mode.
     * The closed-scope membership test applies only when a HARD_NEW scope was resolved.
     */
    private CitationCheck validateCitations(UUID courseId,PredictionCandidateBatch.PredictionCandidate candidate,GenerationScope scope) {
        List<String> issues=new ArrayList<>();
        for(var source:candidate.sourceBasis()) {
            if(source.document()==null||source.document().isBlank()) { issues.add("citation is missing a document name"); continue; }
            if(scope!=null&&!scope.allowedDocuments().contains(source.document())) { issues.add("document is outside closed scope: "+source.document()); continue; }
            List<DocumentCitationMeta> documents=jdbc.query("SELECT page_count FROM documents WHERE course_id=? AND name=?",(rs,row)->new DocumentCitationMeta(number(rs,1)),courseId,source.document());
            if(documents.isEmpty()) { issues.add("document does not exist: "+source.document()); continue; }
            var parsed=CitationValidationRules.parse(source.pages());
            if(parsed.isEmpty()) { issues.add("invalid page range '"+source.pages()+"' for "+source.document()); continue; }
            var range=parsed.get(); Integer pageCount=documents.getFirst().pageCount();
            if(!CitationValidationRules.withinDocument(range,pageCount)) { issues.add("pages "+source.pages()+" exceed "+source.document()+" page count "+pageCount); continue; }
            Integer matchingChunks=jdbc.queryForObject("SELECT COUNT(*) FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.course_id=? AND d.name=? AND (c.page_start IS NULL OR c.page_start<=?) AND (c.page_end IS NULL OR c.page_end>=?)",Integer.class,courseId,source.document(),range.end(),range.start());
            if(matchingChunks==null||matchingChunks==0) issues.add("pages "+source.pages()+" have no supporting evidence chunks in "+source.document());
        }
        return new CitationCheck(issues.isEmpty(),List.copyOf(issues));
    }
    public List<SemanticAnswerPacket.SourceRef> safeScopeSources(UUID courseId,GenerationScope scope) {
        if(scope==null||!scope.hasEvidence())return List.of();
        for(String document:scope.allowedDocuments()) {
            List<Integer> pages=jdbc.query("SELECT COALESCE(MIN(COALESCE(c.page_start,c.page_end)),1) FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.course_id=? AND d.name=? HAVING COUNT(*)>0",(rs,row)->rs.getInt(1),courseId,document);
            if(!pages.isEmpty())return List.of(new SemanticAnswerPacket.SourceRef(document,Integer.toString(Math.max(1,pages.getFirst()))));
        }
        return List.of();
    }
    private VerifiedCandidate toVerified(UUID courseId,Candidate candidate,PredictionVerificationBatch.Verification verification) {
        double topicRelevance=topicRelevance(courseId,candidate.value().title()+" "+candidate.value().exercise()); double similarity=candidate.similarity().isEmpty()?0:candidate.similarity().getFirst().similarity();
        double score=.24*topicRelevance+.20*verification.confidence()+.17*(verification.groundingOk()?1:0)-.12*similarity-.14*verification.solutionStrategySimilarity()+.18*verification.reasoningNovelty()+.17*verification.reasoningDifficulty();
        return new VerifiedCandidate(candidate.id(),candidate.value(),verification,candidate.similarity(),score);
    }
    private double topicRelevance(UUID courseId,String text) {
        return jdbc.query("SELECT t.canonical_name,e.relevance FROM exam_topic_signals e JOIN topics t ON t.id=e.topic_id WHERE e.course_id=?",(rs,row)->new TopicSignal(rs.getString(1),rs.getDouble(2)),courseId).stream().mapToDouble(signal->PredictionVerificationRules.tokenOverlap(signal.name(),text)*signal.relevance()).max().orElse(.2);
    }
    private String verifierSystemPrompt() { return "You are a strict, domain-agnostic verifier for generated academic exercises. Do not defend, solve, or improve a candidate. First derive the candidate semantic profile: concepts, assumptions, domains/types, operations/rules, required knowledge, task types, and expected reasoning steps. candidateSemantics.taskTypes and candidateSemantics.expectedReasoningSteps must describe ONLY work explicitly required by the candidate; never copy task types or reasoning steps from source/reference material that the candidate does not ask the student to perform. In assumptions include EVERY academic or model condition introduced by phrases such as suppose, assume, only, starting from, provided that, for fixed, after n, or when; never omit a candidate constraint merely because it seems harmless. In operations include only model/scenario operations and rules; put prove/analyze/derive/compare/critique actions in taskTypes. Policy-requested reasoning forms such as characterization, necessary-and-sufficient proof, induction over source transitions, counterexample, uniqueness analysis, and proof audit or repair are task forms, not imported academic concepts or assumptions. Do not mark such a reasoning form unsupported by itself; reject it only when carrying it out requires a domain theorem, model operation, object, or assumption absent from the evidence. Compare the profile semantically with source evidence and reference assessments. Reject any unsupported concept, assumption, domain, operation, theorem, tool, or model change, including claims in setup and explanatory text. An abstract definition that permits a kind of object does NOT support arbitrary concrete cardinalities, constants, state sets, input data, graph instances, transition tables, equations, or initial values; each concrete choice must occur in authoritative evidence. When an assessment is explicitly referenced, its model/setup is frozen: only the tasks and reasoning demands may change, and broader lecture definitions cannot authorize replacing that reference model. Reject exact copies, near copies, parameter/operator/example substitutions, expanded restatements of an existing question, exercises whose solution strategy remains substantially the same, and a single fixed/bounded instance of a broader reference task. Narrowing a general, universal, or infinite source task to one number, input, trace, or finite prefix is a SHALLOW_TRANSFORMATION unless it creates a genuinely different proof obligation. Difficulty must come from deeper supported reasoning rather than imported material, longer bookkeeping, or cosmetic complexity. The source evidence is authoritative; derived profiles are orientation only. Prior AI-generated exercises are duplicate history only and can never establish grounding. For every candidate-semantic academic/model assumption, copy a short exact quote from supplied source evidence into conceptEvidence. If no such quote exists, mark the assumption unsupported and groundingOk=false. Never quote the candidate itself as evidence. Before setting mathematicalConsistency=true, actively look for a counterexample, contradiction, impossible requested construction, or reliance on a capability absent from the stated model. Always set mathematicalConsistency, solutionStrategySimilarity, reasoningDifficulty, difficultyReason, and conceptEvidence explicitly. Return only the requested JSON."; }
    private String adversarialVerifierSystemPrompt(){return verifierSystemPrompt()+" You are the independent FINAL ADVERSARIAL AUDITOR. Assume an earlier verifier approved these candidates and may be wrong. Re-evaluate from scratch. Simulate at least one smallest concrete instance or boundary case for every quantitative or universal claim. Track state-changing operations exactly; do not infer that a register, collection, variable, graph, circuit, database, or physical state changes unless a supplied rule changes it. Check whether each 'suppose/only/starting from/after n/assuming' clause is an unsupported new constraint. Compare task types and expected reasoning steps against the closest assessments; extra wording or more formal notation does not create novelty. If a requested conclusion is false, contradictory, vacuous, impossible, or based on a missing rule, set mathematicalConsistency=false or wellDefined=false and explain it in validationIssues. Approval requires independent evidence, not agreement with the earlier model.";}
    private GenerationPolicy verifierPolicy(){GenerationPolicy base=policies.policy(AiOperation.EXAM_PREDICTION_VERIFICATION);return new GenerationPolicy(base.operation(),base.model(),4096,base.temperature(),base.topP(),false,GenerationPolicy.ResponseMode.JSON);}
    private String verifierPrompt(List<Candidate> candidates,String scope,GenerationScope hardScope) {
        StringBuilder prompt=new StringBuilder("Selected course/week scope: ").append(trim(scope,400)).append("\n\n");
        if(hardScope!=null){
            prompt.append("HARD_NEW POLICY: Every required concept, assumption, domain/type, operation/rule, knowledge item, and explanatory claim must be supported by ").append(hardScope.label()).append(" only. Allowed documents: ").append(hardScope.allowedDocuments()).append(". Reject EXACT_COPY, NEAR_COPY, PARAMETER_ONLY_VARIANT, and SHALLOW_TRANSFORMATION. Required reasoningNovelty is at least 0.60, required reasoningDifficulty at least 0.72, and solutionStrategySimilarity must not exceed 0.68. ").append(hardScope.referenceModelFrozen()?"The explicit reference assessment below is a frozen model boundary: a candidate may ask different deeper tasks but may not replace or instantiate a different model using broader source definitions.":"Any explicit reference assessment below is comparison material for novelty and strategy; it does not freeze the model unless the candidate claims to reuse it.").append("\n\nDERIVED SOURCE SEMANTICS (orientation, not authority):\n").append(hardScope.sourceSemantics()).append("\n\nCLOSED SOURCE EVIDENCE (authority):\n").append(trim(hardScope.evidence(),7000)).append("\n\nEXPLICIT REFERENCE ASSESSMENTS (comparison").append(hardScope.referenceModelFrozen()?" and frozen-model authority":" only").append("):\n");
            for(var reference:hardScope.referenceAssessments())prompt.append("- ").append(reference.id()).append("; ").append(reference.document()).append(" pages ").append(pageText(reference.pageStart(),reference.pageEnd())).append("; semantics=").append(reference.semantics()).append("; prompt=").append(trim(reference.prompt(),650)).append("\n");
            prompt.append("\nPRIOR AI-GENERATED EXERCISES (duplicate detection only; NEVER evidence):\n");for(String historical:hardScope.historicalGeneratedExercises())prompt.append("- ").append(trim(historical,450)).append("\n");prompt.append("\n");
        }
        else prompt.append("EXAM PREDICTION POLICY: Supporting course chunks below are the only authority for each candidate. Check every concept, assumption, domain/type, operation, failure mode, theorem, numerical rule, and explanatory claim. Standard background knowledge is not automatically course evidence. A citation alone is insufficient. Every supported required concept needs a short exact quote from those chunks in conceptEvidence.\n\n");
        for(Candidate candidate:candidates) {
            prompt.append("CANDIDATE ").append(candidate.id()).append("\nTitle: ").append(candidate.value().title()).append("\nExercise:\n").append(candidate.value().exercise()).append("\nClaimed source basis: ").append(candidate.value().sourceBasis()).append("\nSupporting course chunks:\n");
            for(SourceEvidence source:candidate.evidence())prompt.append("- ").append(source.document()).append(" pages ").append(pageText(source.pageStart(),source.pageEnd())).append(": ").append(source.content()).append("\n");
            prompt.append("Closest existing assessments:\n");
            for(SimilarAssessment similar:candidate.similarity())prompt.append("- similarity ").append(String.format(Locale.ROOT,"%.3f",similar.similarity())).append("; ").append(similar.sourceType()).append("; ").append(similar.document()).append(" pages ").append(pageText(similar.pageStart(),similar.pageEnd())).append(": ").append(trim(similar.prompt(),700)).append("\n");
            prompt.append("\n");
        }
        return prompt.append(PredictionVerificationBatch.contract()).toString();
    }
    private String decisionSummary(PredictionVerificationBatch.Verification value,List<String> evidenceIssues) { return value==null?"NO_VERIFIER_RESULT":value.noveltyType()+", grounding="+value.groundingOk()+", wellDefined="+value.wellDefined()+", strategySimilarity="+String.format(Locale.ROOT,"%.2f",value.solutionStrategySimilarity())+", difficulty="+String.format(Locale.ROOT,"%.2f",value.reasoningDifficulty())+(evidenceIssues.isEmpty()?"":"; evidenceCoverage="+String.join("; ",evidenceIssues)); }
    private CandidateDebug decisionDebug(Candidate candidate,PredictionVerificationBatch.Verification verification,String verifierFailure,List<String> evidenceIssues) {
        if(verification==null)return new CandidateDebug(candidate.id(),candidate.value().title(),candidate.similarity(),verifierFailure==null?"NO_VERIFIER_RESULT":verifierFailure);
        return new CandidateDebug(candidate.id(),candidate.value().title(),candidate.value().exercise(),candidate.similarity(),decisionSummary(verification,evidenceIssues),verification.requiredConcepts(),verification.supportedConcepts(),verification.unsupportedConcepts(),verification.unsupportedModelChanges(),verification.scopeViolation(),verification.noveltyType(),List.of(),verification.candidateSemantics(),verification.unsupportedAssumptions(),verification.unsupportedDomains(),verification.unsupportedOperations(),verification.reasoningNovelty(),verification.solutionStrategySimilarity(),verification.reasoningDifficulty(),verification.difficultyReason());
    }
    private List<String> evidenceCoverageIssues(Candidate candidate,PredictionVerificationBatch.Verification verification,GenerationScope hardScope){
        String corpus=hardScope==null?candidate.evidence().stream().map(SourceEvidence::content).collect(Collectors.joining(" ")):hardScope.evidence();
        return evidenceCoverageIssues(corpus,verification,candidate.value().exercise());
    }
    static List<String> evidenceCoverageIssues(String authoritativeEvidence,PredictionVerificationBatch.Verification verification){
        return evidenceCoverageIssues(authoritativeEvidence,verification,null);
    }
    private static List<String> evidenceCoverageIssues(String authoritativeEvidence,PredictionVerificationBatch.Verification verification,String candidateText){
        if(verification==null)return List.of("missing verifier result");
        String rawCorpus=authoritativeEvidence==null?"":authoritativeEvidence;String corpus=normalizeEvidence(rawCorpus);
        List<String> issues=new ArrayList<>();Map<String,String> evidence=verification.conceptEvidence();LinkedHashSet<String> requiredItems=verification.candidateSemantics().assumptions().stream().filter(required->!sourceBindingDirective(required)).collect(Collectors.toCollection(LinkedHashSet::new));
        for(String required:requiredItems){
            if(candidateText!=null&&!conceptAnchored(required,candidateText))continue;
            String key=evidence.keySet().stream().filter(value->sameConcept(value,required)).findFirst().orElse(null);
            if(key==null){issues.add("missing exact evidence for "+required);continue;}
            String rawQuote=evidence.get(key),quote=normalizeEvidence(rawQuote);
            boolean quoteUsable=quote.length()>=8&&quote.split(" ").length>=2&&quoteVerifiable(corpus,rawQuote);
            boolean recoverableWeakQuote=!quoteUsable&&hasSoftQuotePassage(rawCorpus,rawQuote)&&hasAnchoredPassage(rawCorpus,required);
            if(!quoteUsable&&!recoverableWeakQuote)issues.add("unverifiable evidence quote for "+required);
            else if(!conceptAnchored(required,quote)&&!hasAnchoredPassage(rawCorpus,required))issues.add("evidence quote does not name "+required);
            if(issues.size()>=6)break;
        }
        return List.copyOf(issues);
    }
    private static List<String> referenceModelCoverageIssues(PredictionVerificationBatch.Verification verification,GenerationScope hardScope){
        if(verification==null||hardScope==null||!hardScope.referenceModelFrozen()||hardScope.referenceAssessments().isEmpty()||verification.candidateSemantics().assumptions().isEmpty())return List.of();
        String referenceEvidence=hardScope.referenceAssessments().stream().map(GenerationScope.ReferenceAssessment::prompt).collect(Collectors.joining(" "));
        return evidenceCoverageIssues(referenceEvidence,verification).stream().map(issue->"reference model: "+issue).toList();
    }
    private static boolean sameConcept(String left,String right){String a=normalizeEvidence(left),b=normalizeEvidence(right);return a.equals(b)||(a.length()>=5&&b.contains(a))||(b.length()>=5&&a.contains(b));}
    private static boolean sourceBindingDirective(String value){String normalized=normalizeEvidence(value);return normalized.contains("source unchanged")||(normalized.contains("definitions")&&normalized.contains("rules")&&normalized.contains("assumptions")&&normalized.contains("unchanged"));}
    private static boolean conceptAnchored(String concept,String quote){
        Set<String> required=meaningfulTokens(normalizeEvidence(concept)),quoteTokens=meaningfulTokens(quote);Set<String> shared=new LinkedHashSet<>(required);shared.retainAll(quoteTokens);
        int minimum=required.size()<=2?required.size():(int)Math.ceil(required.size()*.60);
        if(required.isEmpty()||shared.size()<minimum)return false;
        Set<String> quoteAtoms=atomicLiterals(quote);return quoteAtoms.containsAll(atomicLiterals(concept));
    }
    private static boolean quoteVerifiable(String corpus,String rawQuote){String[] segments=(rawQuote==null?"":rawQuote).split("(?:\\[?\\.{3,}\\]?|…)+");boolean found=false;for(String segment:segments){String normalized=normalizeEvidence(segment);if(normalized.split(" ").length<2)continue;found=true;if(!corpus.contains(normalized))return false;}return found;}
    private static Set<String> meaningfulTokens(String value){Set<String> result=Arrays.stream(value.split(" ")).map(ExamPredictionVerificationService::stem).collect(Collectors.toCollection(LinkedHashSet::new));result.removeIf(token->token.length()<3||Set.of("the","and","for","with","from","into","that","this","every","using").contains(token));return result;}
    private static Set<String> atomicLiterals(String value){
        Set<String> atoms=new LinkedHashSet<>();String raw=value==null?"":value.toLowerCase(Locale.ROOT);var numbers=java.util.regex.Pattern.compile("(?<![\\p{L}\\p{N}_])[-+]?\\d+(?:\\.\\d+)?").matcher(raw);while(numbers.find())atoms.add(numbers.group().replaceFirst("^\\+", ""));
        var braces=java.util.regex.Pattern.compile("\\{([^{}]{1,160})}").matcher(raw);while(braces.find()){var values=java.util.regex.Pattern.compile("[\\p{L}\\p{N}_]+(?:[.-][\\p{L}\\p{N}_]+)*").matcher(braces.group(1));while(values.find())atoms.add(values.group());}
        return atoms;
    }
    private static boolean hasAnchoredPassage(String corpus,String required){if(corpus==null||corpus.isBlank())return false;int window=260,step=110;for(int start=0;start<corpus.length();start+=step){String passage=corpus.substring(start,Math.min(corpus.length(),start+window));if(softConceptAnchored(required,passage))return true;}return false;}
    private static boolean hasSoftQuotePassage(String corpus,String quote){
        if(corpus==null||corpus.isBlank()||quote==null||quote.isBlank())return false;
        Set<String> expected=meaningfulTokens(normalizeEvidence(quote));if(expected.size()<2)return false;
        int window=260,step=110,minimum=(int)Math.ceil(expected.size()*.65);
        for(int start=0;start<corpus.length();start+=step){String passage=corpus.substring(start,Math.min(corpus.length(),start+window));Set<String> actual=meaningfulTokens(normalizeEvidence(passage)),shared=new LinkedHashSet<>(expected);shared.retainAll(actual);if(shared.size()>=minimum&&atomicLiterals(passage).containsAll(atomicLiterals(quote)))return true;}
        return false;
    }
    private static boolean softConceptAnchored(String concept,String passage){Set<String> required=meaningfulTokens(normalizeEvidence(concept)),actual=meaningfulTokens(normalizeEvidence(passage));Set<String> shared=new LinkedHashSet<>(required);shared.retainAll(actual);Set<String> atoms=atomicLiterals(concept);int minimum=required.size()<=2?(atoms.isEmpty()?required.size():1):(int)Math.ceil(required.size()*.45);return !required.isEmpty()&&shared.size()>=minimum&&atomicLiterals(passage).containsAll(atoms);}
    private static String stem(String token){if(token.equals("itself"))return "self";if(token.equals("initially"))return "initial";if(token.endsWith("ization")&&token.length()>10)return token.substring(0,token.length()-7);if(token.endsWith("ized")&&token.length()>7)return token.substring(0,token.length()-4);if(token.endsWith("ize")&&token.length()>6)return token.substring(0,token.length()-3);if(token.endsWith("ally")&&token.length()>6)return token.substring(0,token.length()-4);if(token.length()>5&&token.endsWith("ing"))return token.substring(0,token.length()-3);if(token.length()>4&&token.endsWith("ed"))return token.substring(0,token.length()-2);if(token.length()>5&&(token.endsWith("sses")||token.endsWith("shes")||token.endsWith("ches")||token.endsWith("xes")||token.endsWith("zes")))return token.substring(0,token.length()-2);if(token.length()>3&&token.endsWith("s"))return token.substring(0,token.length()-1);return token;}
    private static String normalizeEvidence(String value){return (value==null?"":value.toLowerCase(Locale.ROOT)).replaceAll("[^\\p{L}\\p{N}]+"," ").replaceAll("\\s+"," ").trim();}
    private static long elapsed(long started){return (System.nanoTime()-started)/1_000_000;}
    private static String trim(String value,int max){String clean=value==null?"":value.replaceAll("\\s+"," ").trim();return clean.length()<=max?clean:clean.substring(0,max)+"…";}
    private static int[] pages(String text){var parsed=CitationValidationRules.parse(text);if(parsed.isPresent())return new int[]{parsed.get().start(),parsed.get().end()};var matcher=java.util.regex.Pattern.compile("(\\d+)").matcher(text==null?"":""+text);int first=1,last=Integer.MAX_VALUE;if(matcher.find()){first=Integer.parseInt(matcher.group());last=first;if(matcher.find())last=Integer.parseInt(matcher.group());}return new int[]{Math.min(first,last),Math.max(first,last)};}
    private static String pageText(Integer start,Integer end){return start==null?"?":end==null||Objects.equals(start,end)?start.toString():start+"-"+end;}
    private static PredictionVerificationBatch.Verification conservative(PredictionVerificationBatch.Verification first,PredictionVerificationBatch.Verification audit){Map<String,String> evidence=new LinkedHashMap<>(first.conceptEvidence());evidence.putAll(audit.conceptEvidence());return new PredictionVerificationBatch.Verification(first.candidateId(),union(first.requiredConcepts(),audit.requiredConcepts()),union(first.supportedConcepts(),audit.supportedConcepts()),union(first.unsupportedConcepts(),audit.unsupportedConcepts()),union(first.unsupportedModelChanges(),audit.unsupportedModelChanges()),first.scopeViolation()||audit.scopeViolation(),first.groundingOk()&&audit.groundingOk(),first.wellDefined()&&audit.wellDefined(),first.mathematicalConsistency()&&audit.mathematicalConsistency(),union(first.missingSpecification(),audit.missingSpecification()),union(first.validationIssues(),audit.validationIssues()),weakerNovelty(first.noveltyType(),audit.noveltyType()),Math.min(first.reasoningNovelty(),audit.reasoningNovelty()),first.nearCopy()||audit.nearCopy(),audit.plausibilityReasoning().isBlank()?first.plausibilityReasoning():audit.plausibilityReasoning(),Math.min(first.confidence(),audit.confidence()),audit.candidateSemantics().isEmpty()?first.candidateSemantics():audit.candidateSemantics(),union(first.unsupportedAssumptions(),audit.unsupportedAssumptions()),union(first.unsupportedDomains(),audit.unsupportedDomains()),union(first.unsupportedOperations(),audit.unsupportedOperations()),Math.max(first.solutionStrategySimilarity(),audit.solutionStrategySimilarity()),Math.min(first.reasoningDifficulty(),audit.reasoningDifficulty()),audit.difficultyReason().isBlank()?first.difficultyReason():audit.difficultyReason(),evidence);}
    private static List<String> union(List<String> left,List<String> right){LinkedHashSet<String> values=new LinkedHashSet<>();if(left!=null)values.addAll(left);if(right!=null)values.addAll(right);return List.copyOf(values);}
    private static String weakerNovelty(String left,String right){List<String> order=List.of("EXACT_COPY","NEAR_COPY","PARAMETER_ONLY_VARIANT","SHALLOW_OPERATOR_VARIANT","SHALLOW_TRANSFORMATION","MEANINGFUL_TRANSFORMATION","NEW_REASONING");String a=left==null?"NEAR_COPY":left.toUpperCase(Locale.ROOT),b=right==null?"NEAR_COPY":right.toUpperCase(Locale.ROOT);int ai=order.indexOf(a),bi=order.indexOf(b);if(ai<0)ai=1;if(bi<0)bi=1;return order.get(Math.min(ai,bi));}
    private static double cosine(float[] left,float[] right){double dot=0,a=0,b=0;for(int i=0;i<left.length;i++){dot+=left[i]*right[i];a+=left[i]*left[i];b+=right[i]*right[i];}return a==0||b==0?0:dot/Math.sqrt(a*b);}
    private static boolean sameGeneratedStrategy(String left,String right){String novelty=PredictionVerificationRules.localNoveltyType(left,right);return !"UNDECIDED".equals(novelty)||PredictionVerificationRules.tokenOverlap(left,right)>=.78;}
    private static String vectorLiteral(float[] vector){return "["+java.util.stream.IntStream.range(0,vector.length).mapToObj(index->Float.toString(vector[index])).collect(Collectors.joining(","))+"]";}
    private static float[] parseVector(String value){if(value==null||value.length()<3)return new float[0];String[] parts=value.replace("[","").replace("]","").split(",");float[] result=new float[parts.length];try{for(int index=0;index<parts.length;index++)result[index]=Float.parseFloat(parts[index]);return result;}catch(NumberFormatException ignored){return new float[0];}}

    private static final class Candidate { private final String id; private final PredictionCandidateBatch.PredictionCandidate value; private final List<SimilarAssessment> similarity; private final List<SourceEvidence> evidence; private Candidate(String id,PredictionCandidateBatch.PredictionCandidate value,List<SimilarAssessment> similarity,List<SourceEvidence> evidence,double ignored){this.id=id;this.value=value;this.similarity=similarity;this.evidence=evidence;} private Candidate withSimilarity(List<SimilarAssessment> similarity,List<SourceEvidence> evidence){return new Candidate(id,value,similarity,evidence,0);} String id(){return id;} PredictionCandidateBatch.PredictionCandidate value(){return value;} List<SimilarAssessment> similarity(){return similarity;} List<SourceEvidence> evidence(){return evidence;} }
    private record DocumentCitationMeta(Integer pageCount) {}
    private record CitationCheck(boolean valid,List<String> issues) {}
    private static final class AssessmentItem { private final UUID id; private final String prompt,sourceType,document; private final Integer pageStart,pageEnd; private float[] embedding; private AssessmentItem(UUID id,String prompt,String sourceType,String document,Integer pageStart,Integer pageEnd,float[] embedding){this.id=id;this.prompt=prompt==null?"":prompt;this.sourceType=sourceType==null?"ASSESSMENT":sourceType;this.document=document==null?"Unknown document":document;this.pageStart=pageStart;this.pageEnd=pageEnd;this.embedding=embedding;} UUID id(){return id;} String prompt(){return prompt;} }
    private record TopicSignal(String name,double relevance) {}
    private record SourceEvidence(String document,Integer pageStart,Integer pageEnd,String content) {}
    private record VerificationPass(Map<String,PredictionVerificationBatch.Verification> decisions,int calls,String failure,boolean stopped){}
    public record SimilarAssessment(UUID itemId,String prompt,String sourceType,String document,Integer pageStart,Integer pageEnd,double similarity) {}
    public record VerifiedCandidate(String candidateId,PredictionCandidateBatch.PredictionCandidate candidate,PredictionVerificationBatch.Verification verification,List<SimilarAssessment> closestAssessments,double rankingScore) {}
    public record CandidateDebug(String candidateId,String title,String exercise,List<SimilarAssessment> closestAssessments,String verifierDecision,List<String> requiredConcepts,List<String> supportedConcepts,List<String> unsupportedConcepts,List<String> unsupportedModelChanges,boolean scopeViolation,String noveltyType,List<String> citationIssues,AcademicSemanticProfile candidateSemantics,List<String> unsupportedAssumptions,List<String> unsupportedDomains,List<String> unsupportedOperations,Double reasoningNovelty,Double solutionStrategySimilarity,Double reasoningDifficulty,String difficultyReason) {
        public CandidateDebug(String candidateId,String title,List<SimilarAssessment> closestAssessments,String verifierDecision){this(candidateId,title,"",closestAssessments,verifierDecision,List.of(),List.of(),List.of(),List.of(),false,"",List.of(),AcademicSemanticProfile.empty(),List.of(),List.of(),List.of(),0d,0d,0d,"");}
        public CandidateDebug(String candidateId,String title,List<SimilarAssessment> closestAssessments,String verifierDecision,List<String> requiredConcepts,List<String> supportedConcepts,List<String> unsupportedConcepts,List<String> unsupportedModelChanges,boolean scopeViolation,String noveltyType){this(candidateId,title,"",closestAssessments,verifierDecision,requiredConcepts,supportedConcepts,unsupportedConcepts,unsupportedModelChanges,scopeViolation,noveltyType,List.of(),AcademicSemanticProfile.empty(),List.of(),List.of(),List.of(),0d,0d,0d,"");}
        public CandidateDebug(String candidateId,String title,List<SimilarAssessment> closestAssessments,String verifierDecision,List<String> requiredConcepts,List<String> supportedConcepts,List<String> unsupportedConcepts,List<String> unsupportedModelChanges,boolean scopeViolation,String noveltyType,List<String> citationIssues){this(candidateId,title,"",closestAssessments,verifierDecision,requiredConcepts,supportedConcepts,unsupportedConcepts,unsupportedModelChanges,scopeViolation,noveltyType,citationIssues,AcademicSemanticProfile.empty(),List.of(),List.of(),List.of(),0d,0d,0d,"");}
        public CandidateDebug { exercise=exercise==null?"":exercise;closestAssessments=closestAssessments==null?List.of():List.copyOf(closestAssessments);requiredConcepts=requiredConcepts==null?List.of():List.copyOf(requiredConcepts);supportedConcepts=supportedConcepts==null?List.of():List.copyOf(supportedConcepts);unsupportedConcepts=unsupportedConcepts==null?List.of():List.copyOf(unsupportedConcepts);unsupportedModelChanges=unsupportedModelChanges==null?List.of():List.copyOf(unsupportedModelChanges);noveltyType=noveltyType==null?"":noveltyType;citationIssues=citationIssues==null?List.of():List.copyOf(citationIssues);candidateSemantics=candidateSemantics==null?AcademicSemanticProfile.empty():candidateSemantics;unsupportedAssumptions=unsupportedAssumptions==null?List.of():List.copyOf(unsupportedAssumptions);unsupportedDomains=unsupportedDomains==null?List.of():List.copyOf(unsupportedDomains);unsupportedOperations=unsupportedOperations==null?List.of():List.copyOf(unsupportedOperations);reasoningNovelty=reasoningNovelty==null?0d:reasoningNovelty;solutionStrategySimilarity=solutionStrategySimilarity==null?0d:solutionStrategySimilarity;reasoningDifficulty=reasoningDifficulty==null?0d:reasoningDifficulty;difficultyReason=difficultyReason==null?"":difficultyReason; }
    }
    /**
     * What verification did, kept in terms that separate a judgement from an absence of one.
     *
     * <p>{@code verifierRejects} counts candidates a verifier looked at and refused. {@code unverifiedCandidates}
     * counts candidates no verifier ever decided on, and {@code unauditedCandidates} counts accepted candidates
     * the final adversarial pass never re-checked. {@code budgetStop} is non-null exactly when a pass ended
     * early, and names the clock or the call cap. Folding any of these into the reject count would make a turn
     * that ran out of time look like a turn whose candidates were all bad.
     */
    public record PredictionDiagnostics(int candidateCount,int structuralRejects,int scopeRejects,int obviousDuplicateRejects,int verifierRejects,int verifierCalls,long totalLatencyMs,List<CandidateDebug> candidates,int citationRejects,int localNoveltyRejects,GateExecution gates,int unverifiedCandidates,int unauditedCandidates,String budgetStop) {
        public PredictionDiagnostics { candidates=candidates==null?List.of():List.copyOf(candidates); gates=gates==null?GateExecution.none():gates; }
        /** True when this turn stopped verifying before it was finished, for any reason. */
        public boolean truncated(){ return budgetStop!=null||unverifiedCandidates>0||unauditedCandidates>0; }
        /** Records a stop that happened outside verification, such as the generation stage running out of clock. */
        public PredictionDiagnostics withBudgetStop(String reason){ return budgetStop!=null||reason==null?this:new PredictionDiagnostics(candidateCount,structuralRejects,scopeRejects,obviousDuplicateRejects,verifierRejects,verifierCalls,totalLatencyMs,candidates,citationRejects,localNoveltyRejects,gates,unverifiedCandidates,unauditedCandidates,reason); }
    }
    /** Which deterministic stages actually ran, so a bypassed pipeline is visible instead of assumed. */
    public record GateExecution(boolean structural,boolean scope,boolean citation,boolean similarity,boolean localNovelty,boolean verifier) {
        static GateExecution none(){return new GateExecution(false,false,false,false,false,false);}
        static GateExecution merge(GateExecution left,GateExecution right){return new GateExecution(left.structural()||right.structural(),left.scope()||right.scope(),left.citation()||right.citation(),left.similarity()||right.similarity(),left.localNovelty()||right.localNovelty(),left.verifier()||right.verifier());}
    }
    public record Outcome(List<VerifiedCandidate> selected,PredictionDiagnostics diagnostics) { public Outcome { selected=selected==null?List.of():List.copyOf(selected); } }
}
