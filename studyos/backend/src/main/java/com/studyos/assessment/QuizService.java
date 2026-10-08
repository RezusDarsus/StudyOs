package com.studyos.assessment;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.adaptive.CognitiveLadderService;
import com.studyos.adaptive.CognitiveLevel;
import com.studyos.ai.AiGateway;
import com.studyos.ai.AiResult;
import com.studyos.ai.AiUsageService;
import com.studyos.ai.AiOperation;
import com.studyos.ai.GenerationPolicyRegistry;
import com.studyos.ai.StructuredGenerationException;
import com.studyos.mastery.MasteryService;
import com.studyos.retrieval.HybridRetriever;
import com.studyos.chat.ExerciseNoveltyEvaluator;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class QuizService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(QuizService.class);
    private final JdbcTemplate jdbc; private final AiGateway ai; private final HybridRetriever retriever; private final MasteryService mastery; private final MisconceptionService misconceptions; private final AiUsageService usage; private final GenerationPolicyRegistry policies; private final ObjectMapper mapper; private final CognitiveLadderService ladder;
    public QuizService(JdbcTemplate jdbc, AiGateway ai, HybridRetriever retriever, MasteryService mastery, MisconceptionService misconceptions, AiUsageService usage, GenerationPolicyRegistry policies, ObjectMapper mapper, CognitiveLadderService ladder) { this.jdbc=jdbc;this.ai=ai;this.retriever=retriever;this.mastery=mastery;this.misconceptions=misconceptions;this.usage=usage;this.policies=policies;this.mapper=mapper;this.ladder=ladder; }

    public List<Question> generate(UUID courseId, UUID topicId, int count, double difficulty) {
        return generate(courseId, topicId, count, difficulty, "PRACTICE");
    }

    public List<Question> generate(UUID courseId, UUID topicId, int count, double difficulty, String mode) {
        return generate(courseId, topicId, count, difficulty, mode, null, null);
    }

    /**
     * Generates verified exercises. The cognitive level decides the difficulty band: an explicit
     * level positions the item inside that band, otherwise the topic's ladder state decides both.
     */
    public List<Question> generate(UUID courseId, UUID topicId, int count, double difficulty, String mode, String activityKind, Integer requestedLevel) {
        return generate(courseId,topicId,count,difficulty,mode,activityKind,requestedLevel,null);
    }

    /**
     * As above, with the learner's own wording carried through. A quiz asked for in chat has to come back in
     * the language it was asked in, and the request itself often narrows what the learner wants tested.
     */
    public List<Question> generate(UUID courseId, UUID topicId, int count, double difficulty, String mode, String activityKind, Integer requestedLevel, String learnerRequest) {
        int safeCount=Math.max(1,Math.min(count,10)); String topic=topicId==null?"the course material":jdbc.query("SELECT canonical_name FROM topics WHERE id=? AND course_id=?",rs->{if(!rs.next())return "the course material";return rs.getString(1);},topicId,courseId);
        ActivityKind kind=ActivityKind.of(activityKind,ActivityKind.PRACTICE);
        // Rejection funnel: an empty list must be explainable (NO_ELIGIBLE_TOPIC, novelty/verification
        // rejections, provider failure) rather than an unexplained [].
        Map<String,Integer> funnel=new LinkedHashMap<>();
        funnel.put("REQUESTED",safeCount);
        CognitiveLadderService.Plan plan=topicId==null?null:ladder.plan(courseId,topicId);
        CognitiveLevel level; double bandDifficulty; boolean diagnostic=false;
        if(requestedLevel!=null){level=CognitiveLevel.ofRank(requestedLevel);bandDifficulty=level.difficultyFor(Math.max(0,Math.min(1,difficulty)));}
        else if(plan!=null){level=plan.level();bandDifficulty=plan.difficulty();diagnostic=plan.diagnostic();}
        else {List<Double> recentScores=jdbc.query("SELECT score FROM assessment_attempts WHERE course_id=? AND topic_id IS NULL ORDER BY created_at DESC LIMIT 3",(rs,row)->rs.getDouble(1),courseId);bandDifficulty=AdaptiveDifficulty.adjust(difficulty,recentScores);level=CognitiveLevel.ofDifficulty(bandDifficulty);}
        String safeMode=normalizeMode(mode);

        // Exercise inventory first: a validated stored exercise the learner has not already answered
        // well beats generating a new one — less provider dependence, less latency, no empty risk.
        if (!diagnostic) {
            List<Question> pooled=reuseFromPool(courseId,topicId,safeCount,level,kind);
            if(!pooled.isEmpty()){funnel.put("SOURCE_POOL",1);funnel.put("RETURNED",pooled.size());recordOutcome(courseId,topicId,"POOL_REUSE",funnel);return pooled;}
        }

        // With no topic to name, the retrieval query would be the placeholder "the course material", which
        // matches nothing in particular; the learner's own words are the better query in that case.
        String retrievalQuery=topicId==null&&learnerRequest!=null&&!learnerRequest.isBlank()?learnerRequest:topic;
        var chunks=retriever.retrieve(courseId,retrievalQuery,Math.max(4,safeCount*2));
        funnel.put("EVIDENCE_CHUNKS",chunks.size());
        if(chunks.isEmpty()) funnel.put("INSUFFICIENT_EVIDENCE",1);
        StringBuilder evidence=new StringBuilder(); for (var chunk:chunks) evidence.append("SOURCE: ").append(chunk.documentName()).append(" pages ").append(chunk.pageStart()).append('-').append(chunk.pageEnd()).append("\n").append(chunk.content()).append("\n\n");
        List<Map<String,Object>> sourceBasis=chunks.stream().limit(4).map(chunk->Map.<String,Object>of("document",chunk.documentName(),"pages",chunk.pageStart()==chunk.pageEnd()?String.valueOf(chunk.pageStart()):chunk.pageStart()+"-"+chunk.pageEnd())).distinct().toList();
        String misconception=topicId==null?null:jdbc.query("SELECT label FROM misconceptions WHERE course_id=? AND topic_id=? AND status<>'RESOLVED' ORDER BY severity DESC,last_seen_at DESC LIMIT 1",rs->rs.next()?rs.getString(1):null,courseId,topicId);
        String prompt=generationPrompt(safeCount,safeMode,topic,level,bandDifficulty,kind,diagnostic,misconception,learnerRequest)
                // The wrapper shape must be stated explicitly: without it a single-question request
                // comes back as a bare object, which cannot parse into the questions array.
                +"Return JSON only, exactly this shape: {\"questions\": [ {\"prompt\": \"...\", \"answer\": \"...\", \"explanation\": \"...\", \"difficulty\": 0.0-1.0, \"answerType\": \"TEXT|MULTIPLE_CHOICE|NUMERIC|CODE|EQUATION|PROOF\", \"hints\": [four strings, progressively stronger, the fourth most of the way to the answer without stating the final result] } ] } with "+safeCount+" question object"+(safeCount==1?"":"s")+" in the questions array. "
                +"Questions must be solvable, use source notation, and must not be parameter-only rewrites of supplied homework.\n"
                +evidence;
        List<Question> result=attemptGeneration(courseId,topicId,safeCount,kind,level,bandDifficulty,diagnostic,safeMode,prompt,evidence.toString(),sourceBasis,funnel);

        // Bounded fallback ladder, rung two of two: when every candidate died at the novelty gate, one
        // regeneration with stronger novelty constraints — the task is made harder, never the gate looser.
        // Hard cap: two generation attempts, then whatever the funnel says is the final answer.
        if(result.isEmpty()&&funnel.containsKey("NOVELTY_REJECTED")&&!chunks.isEmpty()){
            funnel.merge("FALLBACK_RETRY",1,Integer::sum);
            String stricterPrompt=generationPrompt(safeCount,safeMode,topic,level,bandDifficulty,kind,diagnostic,misconception,learnerRequest)
                    +"NOVELTY CONSTRAINTS: the learner has already seen the reference items in spirit. Change the problem SETUP, not just the numbers: a different scenario, a different starting point, or a different direction of reasoning. Do not reuse any scenario, object or figure set from the references.\n"
                    +"Return JSON only, exactly this shape: {\"questions\": [ {\"prompt\": \"...\", \"answer\": \"...\", \"explanation\": \"...\", \"difficulty\": 0.0-1.0, \"answerType\": \"TEXT|MULTIPLE_CHOICE|NUMERIC|CODE|EQUATION|PROOF\", \"hints\": [four strings, progressively stronger, the fourth most of the way to the answer without stating the final result] } ] } with "+safeCount+" question object"+(safeCount==1?"":"s")+" in the questions array. "
                    +"Questions must be solvable, use source notation, and must not be parameter-only rewrites of supplied homework.\n"
                    +evidence;
            result=attemptGeneration(courseId,topicId,safeCount,kind,level,bandDifficulty,diagnostic,safeMode,stricterPrompt,evidence.toString(),sourceBasis,funnel);
        }

        funnel.put("RETURNED",result.size());
        recordOutcome(courseId,topicId,result.isEmpty()?"ALL_CANDIDATES_REJECTED":"RETURNED",funnel);
        return result;
    }

    private String generationPrompt(int count,String mode,String topic,CognitiveLevel level,double bandDifficulty,ActivityKind kind,boolean diagnostic,String misconception,String learnerRequest){
        return "Create "+count+" genuinely useful "+mode+" assessment questions about "+topic+" using only this evidence. "
                +"Cognitive level: "+level.label()+" — "+level.demand()+" Target difficulty is "+round(bandDifficulty)+". Activity kind: "+kind.label()+". "
                +(diagnostic?"These are diagnostic questions: each must isolate the single earlier step the harder work depends on, using only the rules and definitions in the evidence. ":"")
                +(misconception==null?"":"At least one question should diagnose this prior misconception without revealing it: "+misconception+". ")
                +(learnerRequest==null||learnerRequest.isBlank()?"":"The learner asked for this in their own words: \""+trim(learnerRequest,600)+"\". Write every question in the language they used, and respect anything they specified about form or focus.\n");
    }

    /** One bounded generation attempt: generate → novelty gate → adversarial verification → persist. */
    private List<Question> attemptGeneration(UUID courseId,UUID topicId,int safeCount,ActivityKind kind,CognitiveLevel level,double bandDifficulty,boolean diagnostic,String safeMode,String prompt,String evidenceText,List<Map<String,Object>> sourceBasis,Map<String,Integer> funnel){
        long started=System.nanoTime(); AiResult<QuestionBatch> aiResult=null; boolean success=false; QuestionBatch batch;
        try { aiResult=ai.generateStructuredResult("You are a careful university tutor. Do not invent facts outside the provided course evidence.",prompt,QuestionBatch.class,policies.policy(AiOperation.QUIZ_GENERATION)); batch=aiResult.value(); success=true; funnel.merge("GENERATION_ATTEMPT",1,Integer::sum); }
        catch (StructuredGenerationException error) {
            aiResult=error.telemetryResult();
            // Provider failure is a funnel outcome, not a silent crash: the learner gets a clean empty
            // result and the diagnostics surface records exactly why nothing came back. Structured
            // parse failures get their own counter so gateway repair work can be measured without
            // conflating them with transport outages.
            funnel.merge(error.failure()==null?"STRUCTURED_PARSE_FAILURE":"STRUCTURED_PARSE_FAILURE:"+error.failure().name(),1,Integer::sum);
            funnel.merge("PROVIDER_FAILURE",1,Integer::sum);
            recordOutcome(courseId,topicId,"PROVIDER_FAILURE",funnel);
            return List.of();
        } finally { usage.record(AiOperation.QUIZ_GENERATION,aiResult,courseId,null,null,(System.nanoTime()-started)/1_000_000,success); }
        List<String> references=jdbc.query("SELECT prompt FROM assessment_items WHERE course_id=? AND COALESCE(source_type,'') IN ('HOMEWORK','PAST_EXAM','ASSIGNMENT','QUIZ') ORDER BY created_at DESC LIMIT 80",(rs,row)->rs.getString(1),courseId);
        List<DraftCandidate> localCandidates=new ArrayList<>();int draftIndex=0;int noveltyRejected=0;
        for(QuestionDraft draft:batch.questions()){if(draft.prompt()==null||draft.prompt().isBlank()||draft.answer()==null||draft.answer().isBlank()){funnel.merge("DRAFT_INCOMPLETE",1,Integer::sum);continue;}var novelty=ExerciseNoveltyEvaluator.evaluate(references,draft.prompt());if(!novelty.passesLocalNoveltyGate()){noveltyRejected++;funnel.merge("NOVELTY_REJECTED:"+novelty.classification(),1,Integer::sum);continue;}localCandidates.add(new DraftCandidate("candidate-"+(++draftIndex),draft,novelty.maximumTokenOverlap()));}
        funnel.put("NOVELTY_REJECTED",noveltyRejected);funnel.put("CANDIDATES",localCandidates.size());
        Map<String,ExerciseVerification> verified=verifyExercises(courseId,localCandidates,evidenceText,references);
        List<Question> result=new ArrayList<>(); int verificationRejected=0;
        for (DraftCandidate candidate:localCandidates) { ExerciseVerification verification=verified.get(candidate.id());if(verification==null||!verification.grounded()||!verification.solvable()||verification.nearCopy()||verification.noveltyScore()<.45||verification.similarityScore()>.8){verificationRejected++;funnel.merge("VERIFICATION_REJECTED:"+(verification==null?"MISSING":Objects.toString(verification.reason(),"UNSPECIFIED")),1,Integer::sum);continue;}QuestionDraft draft=candidate.draft(); UUID id=UUID.randomUUID(); double itemDifficulty=Math.max(.1,Math.min(1,bandDifficulty)); double similarity=Math.max(0,Math.min(1,verification.similarityScore()));double novelty=Math.max(0,Math.min(1,verification.noveltyScore()));List<String> hints=normalizeHints(draft.hints(),draft.explanation()); String answerType=normalizeAnswerType(draft.answerType()); jdbc.update("INSERT INTO assessment_items(id,course_id,topic_id,type,prompt,answer,difficulty,explanation,metadata,answer_type,hints,source_basis,transformation_type,similarity_score,novelty_score,verification_status,cognitive_level,activity_kind) VALUES(?,?,?,?,?,?,?,?,CAST(? AS jsonb),?,CAST(? AS jsonb),CAST(? AS jsonb),?,?,?,?,?,?)",id,courseId,topicId,"OPEN_ANSWER",draft.prompt(),draft.answer(),itemDifficulty,draft.explanation(),json(Map.of("generated",true,"mode",safeMode,"diagnostic",diagnostic,"verificationReason",Objects.toString(verification.reason(),""))),answerType,json(hints),json(sourceBasis),safeMode,similarity,novelty,"VERIFIED",level.rank(),kind.name()); result.add(new Question(id,courseId,topicId,draft.prompt(),itemDifficulty,answerType,hints.size(),sourceBasis,level.rank(),level.label(),kind.name(),kind.supportAllowed(),diagnostic));if(result.size()==safeCount)break; }
        funnel.put("VERIFICATION_REJECTED",verificationRejected);
        return result;
    }

    /**
     * The exercise inventory: previously validated exercises for this topic at an adjacent cognitive
     * level, excluding ones the learner has already answered well, least-used and least-recently-used
     * first, with a per-item reuse cap so nothing is drilled into the ground.
     */
    private List<Question> reuseFromPool(UUID courseId,UUID topicId,int count,CognitiveLevel level,ActivityKind kind){
        if(topicId==null)return List.of();
        int lower=Math.max(1,level.rank()-1);int upper=Math.min(6,level.rank()+1);
        record PoolRow(UUID id,UUID topicId,String prompt,double difficulty,String answerType,String hints,int rank,String activityKind,String sourceBasis){};
        List<PoolRow> rows=jdbc.query("""
                SELECT id,topic_id,prompt,difficulty,answer_type,hints::text AS hints,cognitive_level,activity_kind,source_basis::text AS source_basis
                FROM assessment_items
                WHERE course_id=? AND topic_id=? AND verification_status='VERIFIED' AND times_used < 4
                  AND cognitive_level BETWEEN ? AND ?
                  AND (activity_kind IS NULL OR activity_kind=?)
                  AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '24 hours')
                  AND NOT EXISTS (SELECT 1 FROM assessment_attempts a WHERE a.item_id=assessment_items.id AND a.score >= 0.8)
                ORDER BY times_used ASC, last_used_at ASC NULLS FIRST
                LIMIT ?
                """,(rs,row)->new PoolRow(rs.getObject("id",UUID.class),rs.getObject("topic_id",UUID.class),rs.getString("prompt"),rs.getDouble("difficulty"),rs.getString("answer_type"),rs.getString("hints"),rs.getInt("cognitive_level"),rs.getString("activity_kind"),rs.getString("source_basis")),courseId,topicId,lower,upper,kind.name(),count);
        if(rows.isEmpty())return List.of();
        jdbc.update("UPDATE assessment_items SET times_used=times_used+1,last_used_at=NOW() WHERE id IN ("+rows.stream().map(r->"?").collect(java.util.stream.Collectors.joining(","))+")",rows.stream().map(PoolRow::id).toArray());
        List<Question> result=new ArrayList<>();
        for(PoolRow poolRow:rows){
            List<String> hints=parseHints(poolRow.hints(),null);
            ActivityKind itemKind=ActivityKind.of(poolRow.activityKind(),kind);
            result.add(new Question(poolRow.id(),courseId,poolRow.topicId(),poolRow.prompt(),poolRow.difficulty(),normalizeAnswerType(poolRow.answerType()),hints.size(),parseSourceBasis(poolRow.sourceBasis()),poolRow.rank(),CognitiveLevel.ofRank(poolRow.rank()).label(),itemKind.name(),itemKind.supportAllowed(),false));
            if(result.size()>=count)break;
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String,Object>> parseSourceBasis(String json){
        if(json==null||json.isBlank())return List.of();
        try { return mapper.readValue(json, List.class); } catch (Exception error) { return List.of(); }
    }

    /**
     * Durable explanation for every generation: one learning event per generate() call with the
     * outcome (POOL_REUSE / RETURNED / ALL_CANDIDATES_REJECTED / PROVIDER_FAILURE) and the funnel,
     * so the diagnostics surface can answer "why []?" without loosening any verification gate.
     */
    private void recordOutcome(UUID courseId, UUID topicId, String outcome, Map<String, Integer> funnel) {
        try {
            Map<String, Object> payload = new LinkedHashMap<>(funnel);
            payload.put("outcome", outcome);
            payload.put("topicId", topicId == null ? null : topicId.toString());
            jdbc.update("INSERT INTO learning_events(id,course_id,topic_id,event_type,payload) VALUES(?,?,?,?,CAST(? AS jsonb))",
                    UUID.randomUUID(), courseId, topicId, "QUIZ_GENERATION_OUTCOME", json(payload));
        } catch (RuntimeException error) { log.warn("Could not record quiz generation outcome: {}", error.getMessage()); }
    }

    private Map<String,ExerciseVerification> verifyExercises(UUID courseId,List<DraftCandidate> candidates,String evidence,List<String> references){if(candidates.isEmpty())return Map.of();String candidateText=String.join("\n",candidates.stream().map(candidate->candidate.id()+": "+candidate.draft().prompt()).toList());String referenceText=String.join("\n",references.stream().limit(12).map(value->"- "+value).toList());String prompt="Independently verify generated exercises against source evidence and reference assessments. Return JSON {candidates:[{candidateId,grounded,solvable,nearCopy,similarityScore,noveltyScore,reason}]}. Reject unsupported assumptions, missing information, and copied solution strategies. Scores are 0 to 1.\nSOURCE EVIDENCE:\n"+trim(evidence,7000)+"\nREFERENCE ASSESSMENTS:\n"+trim(referenceText,4000)+"\nCANDIDATES:\n"+candidateText;long started=System.nanoTime();AiResult<ExerciseVerificationBatch> aiResult=null;boolean success=false;try{aiResult=ai.generateStructuredResult("You are an adversarial exercise-quality verifier. You did not create these candidates. Approve only grounded, solvable, meaningfully novel exercises.",prompt,ExerciseVerificationBatch.class,policies.policy(AiOperation.EXAM_PREDICTION_VERIFICATION));success=true;Map<String,ExerciseVerification> result=new HashMap<>();for(ExerciseVerification value:aiResult.value().candidates())if(candidates.stream().anyMatch(candidate->candidate.id().equals(value.candidateId())))result.put(value.candidateId(),value);return result;}catch(StructuredGenerationException error){aiResult=error.telemetryResult();throw error;}finally{usage.record(AiOperation.EXAM_PREDICTION_VERIFICATION,aiResult,courseId,null,null,(System.nanoTime()-started)/1_000_000,success);}}

    public Grade submit(UUID courseId, UUID itemId, String answer) {
        Item item=jdbc.query("SELECT id,topic_id,prompt,answer,difficulty,cognitive_level,activity_kind,answer_type FROM assessment_items WHERE id=? AND course_id=?",rs->{if(!rs.next())return null;return new Item(rs.getObject("id",UUID.class),rs.getObject("topic_id",UUID.class),rs.getString("prompt"),rs.getString("answer"),rs.getObject("difficulty",Double.class),rs.getObject("cognitive_level",Integer.class),rs.getString("activity_kind"),rs.getString("answer_type"));},itemId,courseId);
        if (item==null) throw new IllegalArgumentException("Assessment item was not found");
        ActivityKind kind=ActivityKind.of(item.activityKind(),ActivityKind.PRACTICE);
        // A blank answer is a lapse, not something a grader should be asked to score: it is recorded
        // deterministically as zero, which no model call could honestly raise.
        boolean blank=answer==null||answer.isBlank();
        CognitiveLevel level=item.cognitiveLevel()==null?CognitiveLevel.ofDifficulty(item.difficulty()==null?.5:item.difficulty()):CognitiveLevel.ofRank(item.cognitiveLevel());
        double itemDifficulty=item.difficulty()==null?level.difficulty():item.difficulty();
        // Support released since the learner's previous graded attempt on this item — not their lifetime
        // history. Once the solution has been seen the ladder keeps it revealed, but a later independent
        // attempt is still independent evidence, and weighting it as if it were assisted forever would
        // make honest repeat practice meaningless.
        int supportUsed=highestSupportSinceLastAttempt(itemId);
        double score;
        AiResult<GradeResult> aiResult=null; long started=System.nanoTime(); boolean success=false;
        GradeResult result;
        if (blank) { result=new GradeResult(0,"No answer was submitted. Answer with what you know before asking for a grade.","BLANK",null,List.of(),List.of()); score=0; }
        else {
            String prompt="Grade the student's answer. Return JSON only, exactly this shape: {\"score\": 0.0-1.0, \"feedback\": \"...\", \"errorType\": \"CONCISE_UPPERCASE_CODE\", \"misconception\": \"\" , \"conceptScores\": [{\"concept\": \"...\", \"score\": 0.0}], \"mistakes\": [{\"concept\": \"...\", \"severity\": 0.0, \"description\": \"...\"}]}. Give partial credit for valid reasoning and use UNSUPPORTED when the expected answer is insufficient to judge.\nQuestion: "+item.prompt()+"\nExpected answer: "+item.expected()+"\nStudent answer: "+answer;
            try { aiResult=ai.generateStructuredResult("You grade fairly. Give partial credit when the reasoning is partly correct.",prompt,GradeResult.class,policies.policy(AiOperation.GRADING)); result=aiResult.value(); success=true; }
            catch (StructuredGenerationException error) {
                aiResult=error.telemetryResult();
                if (DeterministicAnswerCheck.objectivelyGradable(item.answerType())) {
                    // The grader is down, but a multiple-choice or numeric answer needs no opinion:
                    // the deterministic comparison is the authority, so the loop keeps working.
                    boolean matches=DeterministicAnswerCheck.matches(answer,item.expected());
                    result=new GradeResult(matches?1:0, matches?"Correct. (Graded by the deterministic check; the model grader was unavailable.)":"Incorrect. (Graded by the deterministic check; the model grader was unavailable.)", matches?"CORRECT":"INCORRECT",null,List.of(),List.of());
                } else {
                    throw error;
                }
            }
            finally { usage.record(AiOperation.GRADING,aiResult,courseId,null,null,(System.nanoTime()-started)/1_000_000,success); }
            // For objectively gradable answer types the recorded score is bounded by the deterministic
            // comparison, so a model's opinion of a wrong multiple-choice selection can never move
            // durable mastery the way a right answer would.
            score=DeterministicAnswerCheck.objectivelyGradable(item.answerType())
                    ?DeterministicAnswerCheck.bound(result.score(),DeterministicAnswerCheck.matches(answer,item.expected()))
                    :Math.max(0,Math.min(1,result.score()));
        }
        String boundedFeedback=result.feedback();
        String correctness=AssessmentOutcomeRules.correctness(score,item.expected());
        String finalErrorType=AssessmentOutcomeRules.errorType(blank?"BLANK":result.errorType(),correctness);
        double evidenceWeight=HintLadder.evidenceWeight(supportUsed)*kind.evidenceMultiplier();
        MasteryService.AttemptContext context=new MasteryService.AttemptContext(level.rank(),kind.name(),supportUsed,evidenceWeight);
        MasteryService.EvidenceImpact impact=item.topicId()==null?null:mastery.recordAssessmentResult(courseId,item.topicId(),score,itemDifficulty,item.id(),answer,boundedFeedback,correctness,finalErrorType,json(result),context);
        // Judged before the event is written, because the payload's misconception is what the learner profiler reads
        // back as "the student's own recorded misconception text". Only a label their answer actually carried may
        // reach it; a candidate the grader invented is recorded in misconception_evidence and goes no further.
        MisconceptionEvidence.Finding misconception=blank?null:misconceptions.observe(courseId,item.topicId(),result.misconception(),new MisconceptionEvidence.Attempt(score,item.prompt(),item.expected(),answer),new MisconceptionService.Origin(impact==null?null:impact.attemptId(),item.id(),finalErrorType));
        // Exercise inventory upkeep: usage counters, and after enough graded attempts the item's
        // observed difficulty (1 - mean score) is computed separately from its authored difficulty.
        jdbc.update("UPDATE assessment_items SET times_used=times_used+1,last_used_at=NOW(),calibration_attempts=calibration_attempts+1 WHERE id=?", item.id());
        jdbc.update("UPDATE assessment_items SET observed_difficulty=1-(SELECT AVG(score) FROM assessment_attempts WHERE item_id=?) WHERE id=? AND calibration_attempts>=3", item.id(), item.id());
        String recordedMisconception=misconception==null||misconception.action()==MisconceptionEvidence.Action.REJECTED?null:misconception.label();
        jdbc.update("INSERT INTO learning_events(id,course_id,topic_id,event_type,payload) VALUES(?,?,?,?,CAST(? AS jsonb))",UUID.randomUUID(),courseId,item.topicId(),AssessmentOutcomeRules.eventType(correctness),json(Map.of("score",score,"difficulty",itemDifficulty,"correctness",correctness,"errorType",finalErrorType,"cognitiveLevel",level.rank(),"activityKind",kind.name(),"supportLevelUsed",supportUsed,"misconception",Objects.toString(recordedMisconception,""),"misconceptionVerdict",misconception==null?"":misconception.verdict().name(),"attemptId",impact==null?"":impact.attemptId().toString())));
        CognitiveLadderService.Advance advance=item.topicId()==null?null:ladder.record(courseId,item.topicId(),score,supportUsed);
        return new Grade(item.id(),score,"CORRECT".equals(correctness),correctness,finalErrorType,boundedFeedback,recordedMisconception,misconception==null?null:misconception.verdict().name(),result.conceptScores()==null?List.of():result.conceptScores(),result.mistakes()==null?List.of():result.mistakes(),impact==null?0:impact.masteryImpact(),impact==null?null:impact.masteryBefore(),impact==null?null:impact.masteryAfter(),level.rank(),level.label(),kind.name(),supportUsed,round(evidenceWeight),advance==null?null:advance.action().name(),advance==null?null:advance.level().rank(),advance==null?null:advance.level().label(),advance==null?null:advance.reason(),advance==null?null:advance.remediationTopic(),impact==null?null:round(impact.learnedProbability()),impact==null?null:impact.reviewInDays());
    }

    /** Releases the next rung of support. The full solution stays locked until it is earned. */
    public Support support(UUID courseId,UUID itemId,int level) {
        SupportData item=jdbc.query("SELECT hints::text,explanation,answer,activity_kind FROM assessment_items WHERE id=? AND course_id=?",rs->rs.next()?new SupportData(parseHints(rs.getString(1),rs.getString(2)),rs.getString(2),rs.getString(3),rs.getString(4)):null,itemId,courseId);
        if(item==null)throw new IllegalArgumentException("Assessment item was not found");
        ActivityKind kind=ActivityKind.of(item.activityKind(),ActivityKind.PRACTICE);
        if(!kind.supportAllowed())throw new IllegalArgumentException("Hints are not available during a "+kind.label().toLowerCase(Locale.ROOT)+". Answer with what you know, then review the feedback.");
        int revealed=highestSupport(itemId);int attempts=gradedAttempts(itemId);
        HintLadder.Release release=HintLadder.release(level,revealed,attempts);
        String content=release.rung()==HintLadder.Rung.SOLUTION?Objects.toString(item.answer(),"No reference answer is available.")
                :item.hints().get(Math.min(release.level()-1,item.hints().size()-1));
        if(release.level()>revealed)jdbc.update("INSERT INTO exercise_support_events(id,course_id,item_id,level,support_type,revealed_solution) VALUES(?,?,?,?,?,?)",UUID.randomUUID(),courseId,itemId,release.level(),release.rung().name(),release.revealsSolution());
        int highest=Math.max(revealed,release.level());
        return new Support(release.level(),release.rung().name(),release.rung().label(),content,release.revealsSolution(),release.gated(),release.gateReason(),highest>=HintLadder.RUNGS?null:highest+1,HintLadder.RUNGS,round(HintLadder.evidenceWeight(highest)));
    }

    private int highestSupport(UUID itemId){Integer value=jdbc.queryForObject("SELECT COALESCE(MAX(level),0) FROM exercise_support_events WHERE item_id=?",Integer.class,itemId);return value==null?0:value;}
    /**
     * The strongest support released since the learner's previous graded attempt on this item, or
     * since forever when this is the first attempt. Support released after the last attempt belongs
     * to the next one; support released during this one discounts this attempt only.
     */
    private int highestSupportSinceLastAttempt(UUID itemId){
        Integer value=jdbc.queryForObject("SELECT COALESCE(MAX(s.level),0) FROM exercise_support_events s WHERE s.item_id=? AND s.created_at > COALESCE((SELECT MAX(a.created_at) FROM assessment_attempts a WHERE a.item_id=?),'-infinity'::timestamptz)",Integer.class,itemId,itemId);
        return value==null?0:value;
    }
    private int gradedAttempts(UUID itemId){Integer value=jdbc.queryForObject("SELECT COUNT(*) FROM assessment_attempts WHERE item_id=?",Integer.class,itemId);return value==null?0:value;}
    private String normalizeMode(String value){String mode=Objects.toString(value,"PRACTICE").toUpperCase(Locale.ROOT).replace(' ','_');return Set.of("PRACTICE","EXAM_STYLE","HARDER","EASIER","NEW_VARIANT","MIXED_TOPICS","CHALLENGE","MISCONCEPTION_FOLLOW_UP","DIAGNOSTIC").contains(mode)?mode:"PRACTICE";}
    private String normalizeAnswerType(String value){String type=Objects.toString(value,"TEXT").toUpperCase(Locale.ROOT);return Set.of("TEXT","MULTIPLE_CHOICE","NUMERIC","CODE","EQUATION","PROOF").contains(type)?type:"TEXT";}
    private List<String> normalizeHints(List<String> hints,String explanation){List<String> values=hints==null?new ArrayList<>():new ArrayList<>(hints.stream().filter(value->value!=null&&!value.isBlank()).limit(HintLadder.HINT_RUNGS).toList());while(values.size()<HintLadder.HINT_RUNGS)values.add(defaultHint(values.size(),explanation));return List.copyOf(values);}
    private String defaultHint(int index,String explanation){return switch(index){case 0->"Identify which idea from the source material this question belongs to.";case 1->"State the rule, definition or relationship in the evidence that connects what you are given to what is asked.";case 2->"Write down the first step you can justify from the givens, without finishing the problem.";default->Objects.toString(explanation,"Carry the first step through and say what still has to be shown.");};}
    private List<String> parseHints(String value,String explanation){try{List<String> hints=mapper.readValue(value==null?"[]":value,new TypeReference<List<String>>(){});return normalizeHints(hints,explanation);}catch(Exception ignored){return normalizeHints(List.of(),explanation);}}
    private String json(Object value){try{return mapper.writeValueAsString(value);}catch(Exception ignored){return "{}";}}
    private String trim(String value,int max){String clean=Objects.toString(value,"");return clean.length()<=max?clean:clean.substring(0,max)+"…";}
    private double round(double value){return Math.round(value*1000)/1000.0;}
    public record Question(UUID id,UUID courseId,UUID topicId,String prompt,double difficulty,String answerType,int hintsAvailable,List<Map<String,Object>> sourceBasis,int cognitiveLevel,String levelLabel,String activityKind,boolean supportAllowed,boolean diagnostic) {}
    /**
     * @param misconception     the misconception StudyOS actually recorded, or null when the grader's candidate was
     *                          not evidenced by this attempt and nothing durable was written
     * @param misconceptionVerdict why, from {@link MisconceptionEvidence.Verdict} — so a rejected candidate is still
     *                          visible with its reason instead of silently disappearing
     * @param recallProbability the knowledge-tracing estimate that the learner could answer this topic now,
     *                          which discounts a guessable item and forgives one slip, unlike the counted mastery
     * @param reviewInDays      when the scheduler will bring the topic back, derived from its own stability
     */
    public record Grade(UUID itemId,double score,boolean correct,String correctness,String errorType,String feedback,String misconception,String misconceptionVerdict,List<ConceptScore> conceptScores,List<Mistake> mistakes,double masteryImpact,Double masteryBefore,Double masteryAfter,int cognitiveLevel,String levelLabel,String activityKind,int supportLevelUsed,double evidenceWeight,String ladderAction,Integer nextLevel,String nextLevelLabel,String ladderReason,String remediationTopic,Double recallProbability,Integer reviewInDays) {}
    public record Support(int level,String type,String label,String content,boolean revealsSolution,boolean gated,String gateReason,Integer nextLevel,int totalLevels,double evidenceWeight) {}
    private record Item(UUID id,UUID topicId,String prompt,String expected,Double difficulty,Integer cognitiveLevel,String activityKind,String answerType) {}
    private record SupportData(List<String> hints,String explanation,String answer,String activityKind) {}
    private record DraftCandidate(String id,QuestionDraft draft,double localSimilarity){}
    public record QuestionBatch(List<QuestionDraft> questions) { @JsonCreator public QuestionBatch(@JsonProperty("questions") List<QuestionDraft> questions){this.questions=questions==null?List.of():questions;} }
    public record QuestionDraft(String prompt,String answer,String explanation,double difficulty,String answerType,List<String> hints) {}
    public record GradeResult(double score,String feedback,String errorType,String misconception,List<ConceptScore> conceptScores,List<Mistake> mistakes) {}
    public record ExerciseVerificationBatch(List<ExerciseVerification> candidates){@JsonCreator public ExerciseVerificationBatch(@JsonProperty("candidates") List<ExerciseVerification> candidates){this.candidates=candidates==null?List.of():candidates;}}
    public record ExerciseVerification(String candidateId,boolean grounded,boolean solvable,boolean nearCopy,double similarityScore,double noveltyScore,String reason){}
    public record ConceptScore(String concept,double score) {}
    public record Mistake(String concept,double severity,String description) {}
}
