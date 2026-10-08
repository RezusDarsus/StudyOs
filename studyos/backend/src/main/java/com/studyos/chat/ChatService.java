package com.studyos.chat;

import com.studyos.ai.AiGateway;
import com.studyos.ai.AiResult;
import com.studyos.ai.DeadlineExceededException;
import java.sql.Timestamp;
import java.util.*;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import com.studyos.memory.MemoryEpisodeService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.ai.AiUsageService;
import com.studyos.ai.AiOperation;
import com.studyos.ai.GenerationPolicyRegistry;
import com.studyos.ai.GenerationPolicy;
import com.studyos.ai.ProviderCallTelemetry;
import com.studyos.ai.RequestDeadline;
import com.studyos.ai.StructuredGenerationException;

@Service
public class ChatService {
    private static final org.slf4j.Logger log=org.slf4j.LoggerFactory.getLogger(ChatService.class);
    /**
     * Wall-clock budget one turn may spend. Set by configuration in a running application; the initialiser is
     * what unit tests that construct this service directly get, so they are bounded the same way.
     */
    @org.springframework.beans.factory.annotation.Value("${studyos.chat.request-budget-seconds:240}") private int requestBudgetSeconds = 240;
    /**
     * Held back from the caller's declared wait for what happens after the last provider call — rendering, the
     * audits, and writing the message. Spending the whole declared wait upstream produces a good answer that
     * arrives after the caller has stopped listening, which is the same as no answer and costs more.
     */
    private static final java.time.Duration POST_GENERATION_RESERVE = java.time.Duration.ofSeconds(5);
    private final JdbcTemplate jdbc; private final QueryRouter router; private final ContextBuilder context; private final AiGateway ai; private final MemoryEpisodeService memory; private final AiUsageService usage; private final ObjectMapper mapper; private final GenerationPolicyRegistry policies; private final SemanticAnswerService semanticAnswers; private final SemanticAnswerCacheService answerCache; private final ExamPredictionVerificationService predictionVerifier; private final GenerationScopeResolver scopeResolver; private final QuizTurnService quizTurns; private final com.studyos.verify.ClaimProvenanceService claimProvenance;
    public ChatService(JdbcTemplate jdbc, QueryRouter router, ContextBuilder context, AiGateway ai, MemoryEpisodeService memory, AiUsageService usage, ObjectMapper mapper, GenerationPolicyRegistry policies,SemanticAnswerService semanticAnswers,SemanticAnswerCacheService answerCache,ExamPredictionVerificationService predictionVerifier,GenerationScopeResolver scopeResolver,QuizTurnService quizTurns,com.studyos.verify.ClaimProvenanceService claimProvenance) { this.jdbc=jdbc; this.router=router; this.context=context; this.ai=ai; this.memory=memory; this.usage=usage;this.mapper=mapper;this.policies=policies;this.semanticAnswers=semanticAnswers;this.answerCache=answerCache;this.predictionVerifier=predictionVerifier;this.scopeResolver=scopeResolver;this.quizTurns=quizTurns;this.claimProvenance=claimProvenance; }
    public Chat create(UUID courseId, String title) { return create(courseId,title,ChatPurpose.GENERAL); }
    /** A chat is created with what it is for, so an untitled one still says something and its unspecific turns can be read. */
    public Chat create(UUID courseId, String title, ChatPurpose purpose) {
        UUID id=UUID.randomUUID(); ChatPurpose safePurpose=ChatPurpose.orGeneral(purpose); String safeTitle=title==null||title.isBlank()?safePurpose.defaultTitle():title.trim();
        Timestamp updatedAt=jdbc.queryForObject("INSERT INTO chats(id,course_id,title,purpose) VALUES(?,?,?,?) RETURNING updated_at",Timestamp.class,id,courseId,safeTitle,safePurpose.name());
        return new Chat(id,courseId,safeTitle,safePurpose.name(),safePurpose.label(),updatedAt,0);
    }
    public ChatReply reply(UUID courseId, UUID chatId, String content) {
        if (content == null || content.isBlank()) throw new IllegalArgumentException("Message content is required");
        ChatPurpose purpose=requireChat(courseId, chatId);
        String recentUserContext=recentUserContext(chatId);
        UUID userMessageId=UUID.randomUUID(); jdbc.update("INSERT INTO messages(id,chat_id,role,content) VALUES(?,?,?,?)",userMessageId,chatId,"USER",content);
        QueryIntent intent=router.classify(content,recentUserContext,purpose,previousIntent(chatId)); boolean continuation=router.continues(content); String normalized=content.trim().toLowerCase(); ProviderCallTelemetry.reset(); RequestDeadline.start(RequestDeadline.turnBudget(java.time.Duration.ofSeconds(requestBudgetSeconds),POST_GENERATION_RESERVE)); long started=System.nanoTime(); boolean success=false; boolean usable=true; AiResult<?> result=null; ContextBuilder.BuildResult built=null; SemanticAnswerCacheService.Lookup cacheLookup=null; Boolean cacheHit=null; SemanticAnswerPacket packet; String answer; ExamPredictionVerificationService.PredictionDiagnostics predictionDiagnostics=null; HardNewDebug hardNewDebug=null; List<com.studyos.verify.ComputationAudit.Finding> computationFindings=List.of(); List<com.studyos.verify.CitationAudit.Finding> citationFindings=List.of(); List<com.studyos.verify.GroundingAudit.Finding> groundingFindings=List.of(); com.studyos.verify.CitationAudit.Coverage citationCoverage=null; List<com.studyos.verify.ProvenanceAudit.Finding> provenanceFindings=List.of(); com.studyos.verify.ProvenanceAudit.Coverage provenanceCoverage=null; List<com.studyos.verify.LearnerStateAudit.Finding> learnerFindings=List.of(); com.studyos.verify.LearnerStateAudit.Coverage learnerCoverage=null; String citedEvidence=null; List<com.studyos.retrieval.PassageAssembler.Passage> citedPassages=null; String written=null; QuizTurnService.Issued quizIssued=null; List<com.studyos.verify.QuizContractAudit.Finding> quizFindings=List.of();
        try {
            if(normalized.matches("(hi|hello|hey|good morning|good afternoon|good evening)[!.?]*")) { packet=SemanticAnswerPacket.fallback("Hello! What would you like to study?"); result=AiResult.withoutUsage(packet,"local"); }
            else if(intent==QueryIntent.QUIZ_GENERATION&&(quizIssued=issueQuizItems(courseId,chatId,content,recentUserContext))!=null) { packet=quizIssued.packet(); result=AiResult.withoutUsage(packet,"quiz-items"); }
            else {
                boolean prediction=isPredictionIntent(intent);boolean hardNew=intent==QueryIntent.HARD_NEW;HardNewRequest hardRequest=hardNew?HardNewRequest.parse(content):null;GenerationScope resolvedScope=hardNew?scopeResolver.resolve(courseId,chatId,hardRequest):null;boolean generatedExercise=prediction||hardNew;boolean detailedPrediction=generatedExercise&&requestsDetailedAnswer(content);int requestedCount=hardNew?hardRequest.requestedCount():requestedPredictionCount(content,recentUserContext);String retrievalQuery=prediction||continuation?content+"\n"+recentUserContext:content;
                built=context.buildDetailed(courseId,chatId,retrievalQuery,intent);
                if(answerCache.eligible(intent)){cacheLookup=answerCache.lookup(courseId,intent,content,built.evidenceFingerprint(),built.sourceVersion(),built.studentStateFingerprint());cacheHit=cacheLookup.hit();}
                GenerationPolicy base=policies.policy(AiOperation.CHAT); GenerationPolicy packetPolicy=new GenerationPolicy(base.operation(),base.model(),base.maxOutputTokens(),Math.min(.2,base.temperature()),base.topP(),base.thinking(),GenerationPolicy.ResponseMode.JSON);
                if(generatedExercise) {
                    int candidateCount=predictionCandidateCount(requestedCount); GenerationScope hardScope=resolvedScope; String userPrompt=hardNew?"STRICT CLOSED GENERATION SCOPE:\n"+hardScope.evidence()+"\n\nDERIVED SOURCE SEMANTICS (orientation only):\n"+hardScope.sourceSemantics()+"\n\nCurrent student request: "+content:""+built.context()+"\nRecent user requests:\n"+recentUserContext+"\nCurrent student question: "+content;
                    if(hardNew&&!hardScope.hasEvidence()){
                        var empty=predictionVerifier.verifyHardNew(courseId,chatId,List.of(),requestedCount,hardScope);predictionDiagnostics=empty.diagnostics();var gates=predictionDiagnostics.gates();packet=hardNewFailurePacket(requestedCount);result=AiResult.withoutUsage(packet,"local-scope-gate");usable=false;hardNewDebug=new HardNewDebug("HARD_NEW",intent.name(),hardRequest,hardScope.summary(),hardScope.documentIds(),hardScope.allowedDocuments(),0,true,true,gates.structural(),gates.scope(),gates.citation(),gates.similarity(),gates.localNovelty(),gates.verifier(),predictionDiagnostics.candidates(),List.of(),List.of(),List.of(),0);
                    }
                    else {
                        // Whatever verification has already produced is held outside the try, because a stop must
                        // not destroy it. A deadline or an unparseable repair batch used to discard every exercise
                        // that had already passed every check: the recorded run spent four and a half minutes and
                        // answered "please retry once" while holding verified work it threw away.
                        ExamPredictionVerificationService.Outcome verified=null; int totalCandidates=0; String deadlineStage=null;
                        try {
                        String requirements=hardNew?hardNewCandidateRequirements(candidateCount,detailedPrediction,hardScope):predictionCandidateRequirements(candidateCount,detailedPrediction); AiResult<PredictionCandidateBatch> generated=ai.generateStructuredResult(systemPrompt(intent)+requirements+"\n"+PredictionCandidateBatch.contract(),userPrompt,PredictionCandidateBatch.class,policies.predictionPolicy(candidateCount,detailedPrediction));
                        if(generated.value().candidates().size()<candidateCount){usage.record(AiOperation.CHAT,generated,courseId,chatId,null,(System.nanoTime()-started)/1_000_000,false,built.tokens());generated=ai.generateStructuredResult(systemPrompt(intent)+requirements+"\nCORRECTION: Return exactly "+candidateCount+" complete candidate objects in the candidates array, even though the user requested fewer final exercises.\n"+PredictionCandidateBatch.contract(),userPrompt,PredictionCandidateBatch.class,policies.predictionPolicy(candidateCount,detailedPrediction));}
                        result=generated;List<PredictionCandidateBatch.PredictionCandidate> generatedCandidates=hardNew?withReferenceReasoningCandidate(generated.value().candidates(),hardScope):withPredictionReasoningCandidates(generated.value().candidates(),courseId,requestedCount,0);
                        verified=hardNew?predictionVerifier.verifyHardNew(courseId,chatId,generatedCandidates,requestedCount,hardScope):predictionVerifier.verify(courseId,chatId,generatedCandidates,requestedCount,content);totalCandidates=generatedCandidates.size();
                        // A repair pass only starts if the turn can still afford what this turn has already spent
                        // getting here. Two passes that each burn the rest of the budget and then get discarded is
                        // how a request took four and a half minutes and returned a retry message.
                        for(int repairPass=1;repairPass<=2&&verified.selected().size()<requestedCount&&RequestDeadline.allows(java.time.Duration.ofNanos(System.nanoTime()-started));repairPass++){
                            int missing=requestedCount-verified.selected().size();int repairCount=predictionCandidateCount(missing);String feedback=repairFeedback(verified.diagnostics());String selectedText=verified.selected().stream().map(value->value.candidate().title()+": "+value.candidate().exercise()).collect(java.util.stream.Collectors.joining("\n"));
                            usage.record(AiOperation.CHAT,result,courseId,chatId,null,(System.nanoTime()-started)/1_000_000,true,built.tokens());
                            String repairRequirements=hardNew?hardNewCandidateRequirements(repairCount,detailedPrediction,hardScope):predictionCandidateRequirements(repairCount,detailedPrediction);
                            AiResult<PredictionCandidateBatch> repaired=ai.generateStructuredResult(systemPrompt(intent)+repairRequirements+"\nREPAIR PASS "+repairPass+": Earlier candidates did not fill the requested verified output count. Create genuinely different candidates. Do not repeat any selected or rejected structure, unsupported extension, assumption, or solution strategy.\n"+PredictionCandidateBatch.contract(),userPrompt+"\n\nALREADY SELECTED (do not duplicate):\n"+(selectedText.isBlank()?"None":selectedText)+"\n\nACCUMULATED REJECTION SUMMARY:\n"+feedback,PredictionCandidateBatch.class,policies.predictionPolicy(repairCount,detailedPrediction));
                            result=repaired;List<PredictionCandidateBatch.PredictionCandidate> repairCandidates=hardNew?withReferenceReasoningCandidate(repaired.value().candidates(),hardScope):withPredictionReasoningCandidates(repaired.value().candidates(),courseId,missing,repairPass*3);var secondary=hardNew?predictionVerifier.verifyHardNew(courseId,chatId,repairCandidates,missing,hardScope):predictionVerifier.verify(courseId,chatId,repairCandidates,missing,content);verified=mergeOutcomes(verified,secondary,requestedCount);totalCandidates+=repairCandidates.size();
                        }
                        } catch(StructuredGenerationException error) { result=error.telemetryResult(); }
                        catch(DeadlineExceededException error) { deadlineStage=error.stage(); log.warn("Generated-exercise turn stopped at {} holding {} verified exercise(s)",error.stage(),verified==null?0:verified.selected().size()); }
                        if(verified!=null)predictionDiagnostics=deadlineStage==null?verified.diagnostics():verified.diagnostics().withBudgetStop("DEADLINE: generation stopped at "+deadlineStage);
                        var gates=predictionDiagnostics==null?ExamPredictionVerificationService.GateExecution.none():predictionDiagnostics.gates();
                        if(verified==null||verified.selected().isEmpty()) {
                            packet=hardNew?hardNewFailurePacket(requestedCount):predictionFailurePacket(requestedCount); usable=false;
                            hardNewDebug=new HardNewDebug(hardNew?"HARD_NEW":"EXAM_PREDICTION",intent.name(),hardRequest,hardNew?hardScope.summary():null,hardNew?hardScope.documentIds():List.of(),hardNew?hardScope.allowedDocuments():List.of(),totalCandidates,true,hardNew,gates.structural(),gates.scope(),gates.citation(),gates.similarity(),gates.localNovelty(),gates.verifier(),predictionDiagnostics==null?List.of():predictionDiagnostics.candidates(),List.of(),List.of(),List.of(),0);
                        }
                        else {
                        var finalCitations=verified.selected().stream().flatMap(value->value.candidate().sourceBasis().stream()).distinct().toList();
                        hardNewDebug=new HardNewDebug(hardNew?"HARD_NEW":"EXAM_PREDICTION",intent.name(),hardRequest,hardNew?hardScope.summary():null,hardNew?hardScope.documentIds():List.of(),hardNew?hardScope.allowedDocuments():List.of(),totalCandidates,true,hardNew,gates.structural(),gates.scope(),gates.citation(),gates.similarity(),gates.localNovelty(),gates.verifier(),predictionDiagnostics.candidates(),verified.selected().stream().map(ExamPredictionVerificationService.VerifiedCandidate::candidateId).toList(),verified.selected().stream().map(ExamPredictionVerificationService.VerifiedCandidate::verification).toList(),finalCitations,verified.selected().size());
                        packet=hardNew?hardNewPacket(verified.selected(),requestedCount,hardScope,predictionDiagnostics):predictionPacket(verified.selected(),requestedCount,predictionDiagnostics); usable=verified.selected().size()>=requestedCount;
                        }
                    }
                }
                else if(cacheLookup!=null&&cacheLookup.hit()){packet=cacheLookup.packet();result=AiResult.withoutUsage(packet,"semantic-cache");citedEvidence=built.evidence();citedPassages=built.passages();}
                else {
                    citedEvidence=built.evidence(); citedPassages=built.passages();
                    String requirements=predictionRequirements(intent,requestedCount,detailedPrediction); String userPrompt=built.context()+"\nRecent user requests:\n"+recentUserContext+"\nCurrent student question: "+content; boolean retried=false;
                    try {
                        AiResult<SemanticAnswerPacket> generated=ai.generateStructuredResult(systemPrompt(intent)+requirements+"\n"+SemanticAnswerPacket.contract(),userPrompt,SemanticAnswerPacket.class,packetPolicy); packet=generated.value(); result=generated;
                        if(cacheLookup!=null&&Boolean.TRUE.equals(generated.structuredParseSuccess()))answerCache.store(courseId,intent,content,built.evidenceFingerprint(),built.sourceVersion(),built.studentStateFingerprint(),cacheLookup.queryVector(),packet);
                    } catch(StructuredGenerationException error){
                        packet=SemanticAnswerPacket.fallback("I could not format a reliable answer from the available evidence. Please retry the question.");result=error.telemetryResult();usable=false;
                    }
                }
            }
            answer=semanticAnswers.render(packet);
            // A turn that asked to be tested is checked before anything else reads the answer, and its failures are
            // repaired rather than annotated. Every other audit below appends a note, which is the right shape for a
            // claim the learner should treat as unverified; it is the wrong shape for a disclosed answer, because a
            // warning printed under the answers arrives after they have been read. The generated-items path cannot
            // fail this way — a question record has no field that holds an answer — so what this governs is the
            // prose fallback, which is where all six measured quiz failures happened.
            if(intent==QueryIntent.QUIZ_GENERATION) {
                int askedFor=namedQuestionCount(content,recentUserContext);
                quizFindings=com.studyos.verify.QuizContractAudit.findings(answer,askedFor);
                if(quizFindings.stream().anyMatch(finding->!"question count".equals(finding.kind()))) {
                    String withheld=com.studyos.verify.QuizContractAudit.withoutRevealedAnswers(answer);
                    // Cutting the disclosure leaves a quiz; cutting everything leaves nothing to answer, and an
                    // empty reply is worse than the defect. In that case the turn is not usable and says so.
                    if(com.studyos.verify.QuizContractAudit.questionsAsked(withheld)>0) answer=withheld;
                    else { packet=SemanticAnswerPacket.fallback("I could not put together a quiz that keeps its answers to itself. Ask again and I will set the questions only."); answer=semanticAnswers.render(packet); usable=false; }
                }
            }
            // Every audit reads the answer as the model wrote it. Each one appends a note, and a note names the
            // reference or figure it is warning about, so auditing an already-annotated answer would let one
            // check's prose be read as a claim of the answer's by the next. The provenance record is written from
            // the same string for the same reason: a note is StudyOS's own warning, not a claim of the answer's,
            // and storing it as one would put the system's prose into the record of what the tutor asserted.
            written=answer; computationFindings=com.studyos.verify.ComputationAudit.findings(written); if(!computationFindings.isEmpty())answer=answer+"\n\n"+com.studyos.verify.ComputationAudit.note(computationFindings);
            // Citations are only checkable against the evidence the answer was written from, which is this turn's
            // retrieved block on the ordinary path. Generated exercises cite a separately resolved closed scope and
            // are gated by the prediction verifier instead, so auditing them against this block would misreport them.
            if(citedEvidence!=null){citationFindings=com.studyos.verify.CitationAudit.findings(written,citedEvidence);if(!citationFindings.isEmpty())answer=answer+"\n\n"+com.studyos.verify.CitationAudit.note(citationFindings);
                // Faithfulness is the question the citation audit deliberately leaves open: that audit settles
                // whether a reference points at a page that was retrieved, this one whether the sentence holding
                // the reference says what that page says.
                groundingFindings=com.studyos.verify.GroundingAudit.findings(written,citedEvidence);String groundingNote=com.studyos.verify.GroundingAudit.note(groundingFindings);if(!groundingNote.isBlank())answer=answer+"\n\n"+groundingNote;
                // And the question both of those leave open: not whether the page was retrieved, and not whether the
                // figure was retrieved somewhere, but whether it is on the page the sentence sends the learner to.
                // A figure cited to page 5 that lives on page 20 satisfies the two checks above and still fails the
                // only test the learner applies, which is to turn to the page and look.
                provenanceFindings=com.studyos.verify.ProvenanceAudit.findings(written,citedEvidence);String provenanceNote=com.studyos.verify.ProvenanceAudit.note(provenanceFindings);if(!provenanceNote.isBlank())answer=answer+"\n\n"+provenanceNote;
                citationCoverage=com.studyos.verify.CitationAudit.coverage(written,citedEvidence);provenanceCoverage=com.studyos.verify.ProvenanceAudit.coverage(written,citedEvidence);}
            // The other kind of evidence. A claim about the learner is a measurement, and it is checkable against
            // the recorded-attempt block the prompt carried — which is also what keeps this system's own earlier
            // answers out of the learner's record, since the tutor's prose was never issued a handle.
            if(built!=null){learnerFindings=com.studyos.verify.LearnerStateAudit.findings(written,built.learnerRecord());if(!learnerFindings.isEmpty())answer=answer+"\n\n"+com.studyos.verify.LearnerStateAudit.note(learnerFindings);
                learnerCoverage=com.studyos.verify.LearnerStateAudit.coverage(written,built.learnerRecord());}
            success=usable;
        } finally { usage.record(AiOperation.CHAT,result,courseId,chatId,null,(System.nanoTime()-started)/1_000_000,success,built==null?null:built.tokens(),cacheHit); }
        UUID assistantMessageId=UUID.randomUUID(); ReplyTelemetry replyTelemetry=ReplyTelemetry.of(ProviderCallTelemetry.snapshot(),(System.nanoTime()-started)/1_000_000,!usable,Boolean.TRUE.equals(cacheHit),computationFindings.size(),citationFindings.size(),groundingFindings,citationCoverage,provenanceFindings,provenanceCoverage,learnerFindings,learnerCoverage,quizFindings,answer,intent==QueryIntent.QUIZ_GENERATION,predictionDiagnostics); jdbc.update("INSERT INTO messages(id,chat_id,role,content) VALUES(?,?,?,?)",assistantMessageId,chatId,"ASSISTANT",answer);
        // What this answer asserted and which chunks it rested on, recorded now that the message it belongs to
        // exists. The passages are StudyOS's own record of what went into the prompt, so a chunk id lands behind a
        // sentence by having been supplied to write it. A turn with none — a greeting, issued quiz items, a
        // generated exercise working from a separately resolved scope — records the turn as unmeasured rather than
        // as an answer whose every claim came from nowhere.
        claimProvenance.record(courseId,chatId,assistantMessageId,intent.name(),written==null?answer:written,citedPassages); semanticAnswers.store(courseId,chatId,assistantMessageId,packet,built==null?null:built.evidenceFingerprint(),built==null?null:built.sourceVersion(),intent.name()); jdbc.update("UPDATE chats SET updated_at=NOW() WHERE id=? AND course_id=?",chatId,courseId); memory.recordQuestionAnswer(courseId,chatId,userMessageId,assistantMessageId,content,answer,provenance(intent)); recordLearningEvent(courseId, intent, content,predictionDiagnostics); return new ChatReply(answer,intent.name(),assistantMessageId,packet,predictionDiagnostics,hardNewDebug,replyTelemetry,quizIssued==null?List.of():quizIssued.itemIds());
    }
    /**
     * What the previous turn in this chat was served as, or {@code null} for a chat's first turn. A follow-up
     * that says only "another one" has to inherit it; the alternative is guessing from history wording, which
     * is what lost the thread five turns into the recorded benchmark conversation.
     */
    private QueryIntent previousIntent(UUID chatId) {
        String name=jdbc.query("SELECT intent FROM semantic_answer_packets WHERE chat_id=? AND intent IS NOT NULL ORDER BY created_at DESC LIMIT 1",rs->rs.next()?rs.getString(1):null,chatId);
        if(name==null||name.isBlank())return null;
        try { return QueryIntent.valueOf(name); } catch(IllegalArgumentException ignored){ return null; }
    }
    /**
     * Issues real assessment items for a turn that asked to be tested, or {@code null} when none could be
     * verified — in which case the caller answers the turn the ordinary way rather than showing an empty quiz.
     * A generator failure must not lose the turn, so it degrades the same way.
     */
    private QuizTurnService.Issued issueQuizItems(UUID courseId,UUID chatId,String content,String recentContext) {
        if(quizTurns==null)return null;
        try { return quizTurns.issue(courseId,chatId,content,requestedPredictionCount(content,recentContext)); }
        catch(RuntimeException error){ log.warn("Could not issue quiz items for chat {}; answering the turn instead: {}",chatId,error.toString()); return null; }
    }
    private String systemPrompt(QueryIntent intent) { return "You are a careful, source-grounded university tutor for StudyOS. Intent: " + intent + ". Use only retrieved course evidence for factual course claims and say when evidence is missing. Structure substantial answers with short Markdown headings, concise paragraphs, and real Markdown lists or tables. Do not print Markdown table rows on one line and never use HTML tags. Clearly separate source facts from inference. Format citations exactly as [[Source: filename; pages 3-4]]. Never invent a filename, page, exercise number, or question number. Passages marked \"Origin: external web source\" come from online research, not from the learner's uploaded material: keep citing them by their given source name, say in the answer when a claim rests on such a source, and never present researched material as the learner's own course document. Never invent URLs. Write formulas for humans: use simple Unicode when possible (for example y = x²) and use $...$ only for complex formulas. Never output raw LaTeX delimiters such as \\( ... \\), \\[ ... \\], or raw exponent text such as x^{2} outside a rendered formula. For concept maps, networks, routes, algorithms, and processes, prefer one compact ```mermaid diagram rather than ASCII art. For a 2D mathematical function graph, use a ```plot block with title, function, xMin, and xMax; never draw a coordinate plot with ASCII. Keep every figure focused and explain it in plain language." + IntentContract.forIntent(intent); }
    private String recentUserContext(UUID chatId){return jdbc.query("SELECT content FROM messages WHERE chat_id=? AND role='USER' ORDER BY created_at DESC LIMIT 6",rs->{StringBuilder value=new StringBuilder();while(rs.next())value.append(rs.getString(1)).append('\n');return value.toString();},chatId);}
    int requestedPredictionCount(String query,String recentContext){Integer current=predictionCount(query);if(current!=null)return current;Integer recent=predictionCount(recentContext);return recent==null?4:recent;}
    /**
     * How many questions the learner actually named, or zero when they named none. Deliberately not
     * {@link #requestedPredictionCount}, whose default of four is the system's choice: holding a reply to a count
     * nobody asked for would report a defect against the learner's own silence.
     */
    int namedQuestionCount(String query,String recentContext){Integer current=predictionCount(query);if(current!=null)return current;Integer recent=predictionCount(recentContext);return recent==null?0:recent;}
    private Integer predictionCount(String value){String text=value==null?"":value;var numeric=Pattern.compile("(?i)\\b(1[0-2]|[1-9])\\b(?:\\s+[a-z-]+){0,5}\\s+(?:exercises?|problems?|tasks?|questions?)\\b").matcher(text);if(numeric.find())return Integer.parseInt(numeric.group(1));var words=Pattern.compile("(?i)\\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\b(?:\\s+[a-z-]+){0,5}\\s+(?:exercises?|problems?|tasks?|questions?)\\b").matcher(text);if(!words.find())return null;return switch(words.group(1).toLowerCase()){case "one"->1;case "two"->2;case "three"->3;case "four"->4;case "five"->5;case "six"->6;case "seven"->7;case "eight"->8;case "nine"->9;case "ten"->10;case "eleven"->11;default->12;};}
    private boolean isPredictionIntent(QueryIntent intent){return intent==QueryIntent.EXAM_PREDICTION;}
    /** Model-invented exercises are tagged so later chats never recall them as if they were course evidence. */
    private String provenance(QueryIntent intent){return intent==QueryIntent.HARD_NEW||intent==QueryIntent.EXAM_PREDICTION||intent==QueryIntent.QUIZ_GENERATION?"AI_GENERATED_EXERCISE":"CHAT_TURN";}
    private boolean requestsDetailedAnswer(String value){String q=value==null?"":value.toLowerCase();return q.contains("detailed")||q.contains("long answer")||q.contains("full exercise")||q.contains("more detail");}
    private int predictionCandidateCount(int requestedCount){return Math.min(Math.max(requestedCount*2,requestedCount+2),18);}
    private List<PredictionCandidateBatch.PredictionCandidate> withReferenceReasoningCandidate(List<PredictionCandidateBatch.PredictionCandidate> generated,GenerationScope scope){
        if(scope==null)return generated;GenerationScope.ReferenceAssessment reference=scope.referenceAssessments().isEmpty()?null:scope.referenceAssessments().getFirst();SemanticAnswerPacket.SourceRef source=reference==null?scopeScaffoldSource(scope):new SemanticAnswerPacket.SourceRef(reference.document(),reference.pageStart()==null?"1":reference.pageEnd()==null||Objects.equals(reference.pageStart(),reference.pageEnd())?reference.pageStart().toString():reference.pageStart()+"-"+reference.pageEnd());var scaffold=HardNewScaffoldFactory.create(scope,source);List<PredictionCandidateBatch.PredictionCandidate> values=new ArrayList<>(generated==null?List.of():generated);if(values.isEmpty())values.add(scaffold);else values.set(values.size()-1,scaffold);return List.copyOf(values);
    }
    private String firstOr(List<String> values,String fallback){return values==null||values.isEmpty()?fallback:values.getFirst();}
    private String bestOperation(List<String> operations,List<String> topics){if(operations==null||operations.isEmpty())return "";if(topics!=null&&!topics.isEmpty())for(String operation:operations)if(topics.stream().anyMatch(topic->PredictionVerificationRules.tokenOverlap(operation,topic)>.0))return operation;return operations.getFirst();}
    private List<PredictionCandidateBatch.PredictionCandidate> withPredictionReasoningCandidates(List<PredictionCandidateBatch.PredictionCandidate> generated,UUID courseId,int requestedCount,int offset){
        List<PredictionScaffoldSource> sources=predictionScaffoldSources(courseId,Math.max(8,offset+requestedCount));if(sources.isEmpty())return generated;
        List<PredictionCandidateBatch.PredictionCandidate> values=new ArrayList<>(generated==null?List.of():generated);int replacements=Math.min(Math.min(requestedCount,3),Math.min(values.size(),Math.max(0,sources.size()-offset)));
        for(int index=0;index<replacements;index++){PredictionScaffoldSource source=sources.get(offset+index);values.set(values.size()-replacements+index,predictionScaffold(source,offset+index));}
        return List.copyOf(values);
    }
    private List<PredictionScaffoldSource> predictionScaffoldSources(UUID courseId,int limit){
        String sql="SELECT a.prompt,d.name,a.page_start,a.page_end,CASE WHEN a.embedding IS NULL THEN 0 ELSE COALESCE((SELECT MAX(1-(a.embedding <=> p.embedding)) FROM assessment_items p WHERE p.course_id=a.course_id AND p.source_type='PAST_EXAM' AND p.embedding IS NOT NULL),0) END AS recurrence FROM assessment_items a JOIN documents d ON d.id=a.document_id WHERE a.course_id=? AND COALESCE(a.source_type,'') IN ('HOMEWORK','ASSIGNMENT') ORDER BY recurrence DESC,a.created_at LIMIT ?";
        List<PredictionScaffoldSource> raw=jdbc.query(sql,(rs,row)->new PredictionScaffoldSource(rs.getString(1),rs.getString(2),rs.getObject(3)==null?1:rs.getInt(3),rs.getObject(4)==null?(rs.getObject(3)==null?1:rs.getInt(3)):rs.getInt(4)),courseId,Math.max(12,limit*2));LinkedHashMap<String,PredictionScaffoldSource> distinct=new LinkedHashMap<>();for(var value:raw){String key=value.document()+"|"+predictionSourceTitle(value.prompt());distinct.putIfAbsent(key,value);}return distinct.values().stream().limit(limit).toList();
    }
    private PredictionCandidateBatch.PredictionCandidate predictionScaffold(PredictionScaffoldSource source,int variant){
        String focus=predictionSourceTitle(source.prompt());String prefix="Use the definitions, rules, domains, assumptions, and data from the cited source unchanged. ";String exercise;String title;String type;
        switch(Math.floorMod(variant,3)){
            case 0->{title="Necessary-and-sufficient correctness criterion — "+focus;type="DERIVE_CONDITION";exercise=prefix+"For the source task “"+focus+"”, derive a correctness criterion for an arbitrary proposed answer using only the source-defined notation, objects, and permitted operations. State the criterion as necessary and sufficient conditions. Prove necessity by showing that every valid answer satisfies each condition, then prove sufficiency by showing that any answer satisfying all conditions fulfills the complete source specification. Apply the criterion to the smallest or boundary case already allowed by the source. Finally, identify a plausible incomplete argument that proves only one direction, explain exactly why it is insufficient, and repair it without changing the source model.";}
            case 1->{title="Exhaustive case analysis and proof repair — "+focus;type="INVARIANT_REPAIR";exercise=prefix+"For the source task “"+focus+"”, classify all materially different cases already permitted by the source assumptions. Prove that your classification is exhaustive and that the cases do not overlap except where the source definitions allow it. Solve or establish the required conclusion separately in every case using only source-defined rules. Then critique the claim that checking one representative case is enough: either give a counterexample obtainable under the unchanged source model or prove the claim, and provide a corrected general argument. Do not introduce new values, domains, operations, failure modes, or assumptions.";}
            default->{title="Uniqueness versus multiple valid outcomes — "+focus;type="PROVE_TO_DISPROVE";exercise=prefix+"For the source task “"+focus+"”, determine whether the source-defined inputs and rules uniquely determine the required result. Prove uniqueness if they do. If they do not, construct two distinct valid outcomes using only choices already permitted by the source and prove that both satisfy the specification. Then derive necessary and sufficient conditions, stated entirely in source terminology, for uniqueness to hold. Check every smallest or boundary case already admitted by the source, and explain which exact source rule creates or removes non-uniqueness. Do not modify any parameter, operator, datum, domain, or model assumption.";}
        }
        String pages=source.pageStart()==source.pageEnd()?Integer.toString(source.pageStart()):source.pageStart()+"-"+source.pageEnd();return new PredictionCandidateBatch.PredictionCandidate(title,exercise,List.of(new SemanticAnswerPacket.SourceRef(source.document(),pages)),type);
    }
    private String predictionSourceTitle(String prompt){String value=prompt==null?"Source-defined problem":prompt.replaceAll("\\s+"," ").trim();int points=value.toLowerCase(Locale.ROOT).indexOf("credit point");if(points>3)value=value.substring(0,points);int paren=value.indexOf('(');if(paren>3)value=value.substring(0,paren);return value.substring(0,Math.min(90,value.length())).trim();}
    private SemanticAnswerPacket.SourceRef scopeScaffoldSource(GenerationScope scope){String evidence=scope.evidence();for(String document:scope.allowedDocuments()){var matcher=Pattern.compile("(?is)\\[Source:\\s*"+Pattern.quote(document)+";\\s*pages\\s*([^\\]]+)](.*?)(?=\\[Source:|$)").matcher(evidence);while(matcher.find()){String passage=matcher.group(2).toLowerCase(Locale.ROOT);if(scope.requestedTopics().isEmpty()||scope.requestedTopics().stream().anyMatch(topic->passage.contains(topic.toLowerCase(Locale.ROOT))))return new SemanticAnswerPacket.SourceRef(document,matcher.group(1).trim());}}return new SemanticAnswerPacket.SourceRef(scope.allowedDocuments().getFirst(),"1");}
    private String predictionCandidateRequirements(int count,boolean detailed){String size=detailed?"Each candidate must have a 220-320 word, directly solvable scenario with 3-4 explicit tasks.":"Each candidate must have a directly solvable scenario of at least 140 words with 2-4 explicit tasks.";return "\nEXAM PREDICTION CANDIDATE REQUIREMENTS: Generate exactly "+count+" candidate midterm exercises based only on retrieved course evidence. Do not write topics or exercise locations. Do not claim that a candidate is new, novel, likely, valid, or grounded: a separate verifier judges that. Anchor each candidate to exactly one complete model, procedure, theorem, or scenario that is fully present in its cited evidence. Begin every exercise with: 'Use the definitions, rules, domains, assumptions, and data from the cited source unchanged.' After that sentence, ask only new tasks about that unchanged source material; do not restate or modify its setup. Begin tasks directly with verbs such as Characterize, Prove, Derive, Compare, Critique, Repair, Determine, or Construct. Every concept, assumption, domain/type, operation, failure mode, theorem, numerical rule, and explanatory claim required by a candidate must be present in its cited retrieved evidence. Do not invent extensions such as new devices, fault models, constraints, protocols, mathematical machinery, initial values, schedules, cost units, or performance formulas. Create novelty through deeper reasoning over supported material: exact characterization, both directions of a criterion, proof critique and repair, or synthesis of ideas that BOTH occur in the cited evidence. Treat homework and past exams as style, recurrence, and comparison evidence; do not reproduce their task sequence. Before returning a candidate, identify every clause introduced by words such as suppose, assume, only, starting from, provided that, for fixed, after n, or when; discard the candidate unless each such condition is explicitly supported by its cited evidence. Test the smallest concrete or boundary case of every quantitative claim. Prefer prove-or-disprove wording when the evidence does not establish the requested conclusion. Include exactly one actual retrieved source citation in each sourceBasis unless two sources are materially necessary. "+size+" transformationType is descriptive metadata only.";}
    private String hardNewCandidateRequirements(int count,boolean detailed,GenerationScope scope){String size=detailed?"Each candidate must have a 220-320 word directly solvable scenario with 3-4 explicit tasks.":"Each candidate must have a directly solvable scenario of at least 140 words with 2-4 explicit tasks.";String referenceAnchor=scope.referenceAssessments().isEmpty()?"":scope.referenceModelFrozen()?" EXPLICIT REFERENCE-ANCHORED MODE: The user named an existing assessment as the model to preserve. Its complete setup/model is frozen. Ask new, deeper tasks about that exact model. After the required first sentence, do not use setup-introducing language such as Consider, Suppose, Assume, Let, Take, Given, Define a/the, or 'as follows'. Do not restate the setup. Begin directly with task verbs such as Characterize, Prove, Derive, Compare, Critique, Repair, or Determine. REFERENCE MODEL TO PRESERVE: "+scope.referenceAssessments().stream().map(reference->reference.document()+" pages "+reference.pageStart()+"-"+reference.pageEnd()+": "+reference.prompt()).collect(java.util.stream.Collectors.joining(" | ")):" REFERENCE COMPARISON MODE: The named assessment is for duplicate/strategy comparison only. You may use any model or example explicitly present elsewhere in the closed evidence, but may not invent unsupported setup details.";return "\nHARD_NEW EXERCISE REQUIREMENTS: Generate exactly "+count+" internal candidates using only the closed "+scope.label()+" evidence and only these documents: "+scope.allowedDocuments()+". Use the derived source semantic profile as orientation, but treat source evidence as authority. Preserve every definition, assumption, domain/type, operation/rule, theorem condition, and procedure that the evidence fixes. Do not import outside knowledge. Every candidate must begin with the sentence 'Use the definitions, rules, and assumptions from the cited source unchanged.' After that sentence, state only new TASKS about that unchanged material. Do not restate, rewrite, extend, condition, guard, replace, or invent the source model or scenario. Do not introduce additional state, data, actors, cases, constraints, failure modes, APIs, theorems, initial values, execution schedules, cost units, delay formulas, or operations."+referenceAnchor+" Before returning a candidate, identify every clause introduced by words such as suppose, assume, only, starting from, provided that, for fixed, after n, or when; discard the candidate unless each such condition is copied from the closed evidence. Test the smallest concrete or boundary case of every quantitative or universal claim; prefer prove-or-disprove wording when the evidence does not establish the conclusion. Do not ask only about one fixed number, input, trace, data row, graph instance, or bounded prefix when a reference already asks a broader general task; that is easier, not hard. Do not create a variant by merely changing parameters, constants, operators, examples, names, data values, or surface story while retaining the same solution strategy as a reference assessment. Increase difficulty only through deeper supported reasoning such as synthesis, exact characterization, necessary and sufficient conditions with both directions proved, counterexample and proof repair, proof critique, design using already-defined operations, multi-step derivation, comparison of supported cases, or error analysis—as appropriate to this subject. These generic reasoning forms are task scaffolding, not permission to add new subject concepts or assumptions. Prefer asking a new theorem or exact characterization about the full unchanged model, recombining two source-supported operations or tasks, or critiquing and repairing reasoning about an evidence-supported claim. A HARD candidate must plausibly deserve reasoningDifficulty at least 0.72 and reasoningNovelty at least 0.60 under the verifier rubric. Do not claim novelty or grounding. Include sourceBasis citations only from allowed documents and real pages present in the evidence. "+size+" transformationType is descriptive metadata only.";}
    private String predictionRequirements(QueryIntent intent,int count,boolean detailed){return "";}
    boolean usableExamPacket(SemanticAnswerPacket packet,int count){return packet!=null&&packet.sections().size()==count&&packet.sections().stream().allMatch(section->section.heading()!=null&&section.heading().toLowerCase().contains("exercise")&&section.body()!=null&&section.body().length()>=140&&section.body().contains("[[Source:"));}
    private SemanticAnswerPacket predictionFailurePacket(int count){return SemanticAnswerPacket.fallback("I could not produce "+count+" complete, evidence-grounded exercise predictions in the required format. No partial topic-only prediction was shown. Please retry once.");}
    private SemanticAnswerPacket hardNewFailurePacket(int count){return SemanticAnswerPacket.fallback("I could not produce "+count+" hard, source-scoped exercise"+(count==1?"":"s")+" without copying homework or importing unsupported concepts. No unsafe variant was shown.");}
    private String repairFeedback(ExamPredictionVerificationService.PredictionDiagnostics diagnostics){StringBuilder value=new StringBuilder();for(var candidate:diagnostics.candidates()){value.append("- ").append(candidate.title()).append(": ").append(candidate.verifierDecision());if(!candidate.unsupportedConcepts().isEmpty())value.append("; unsupported concepts=").append(candidate.unsupportedConcepts());if(!candidate.unsupportedAssumptions().isEmpty())value.append("; unsupported assumptions=").append(candidate.unsupportedAssumptions());if(!candidate.unsupportedDomains().isEmpty())value.append("; unsupported domains=").append(candidate.unsupportedDomains());if(!candidate.unsupportedOperations().isEmpty())value.append("; unsupported operations=").append(candidate.unsupportedOperations());value.append('\n');if(value.length()>3000)break;}return value.isEmpty()?"No candidate passed all structural, citation, grounding, novelty, strategy-difference, and difficulty checks.":value.toString();}
    private ExamPredictionVerificationService.Outcome mergeOutcomes(ExamPredictionVerificationService.Outcome first,ExamPredictionVerificationService.Outcome second,int requestedCount){
        List<ExamPredictionVerificationService.VerifiedCandidate> selected=new ArrayList<>(first.selected());for(var value:second.selected())if(selected.size()<requestedCount&&selected.stream().noneMatch(existing->sameGeneratedStrategy(existing.candidate().exercise(),value.candidate().exercise())))selected.add(value);
        var a=first.diagnostics();var b=second.diagnostics();List<ExamPredictionVerificationService.CandidateDebug> debug=new ArrayList<>(a.candidates());debug.addAll(b.candidates());
        return new ExamPredictionVerificationService.Outcome(selected,new ExamPredictionVerificationService.PredictionDiagnostics(a.candidateCount()+b.candidateCount(),a.structuralRejects()+b.structuralRejects(),a.scopeRejects()+b.scopeRejects(),a.obviousDuplicateRejects()+b.obviousDuplicateRejects(),a.verifierRejects()+b.verifierRejects(),a.verifierCalls()+b.verifierCalls(),a.totalLatencyMs()+b.totalLatencyMs(),debug,a.citationRejects()+b.citationRejects(),a.localNoveltyRejects()+b.localNoveltyRejects(),ExamPredictionVerificationService.GateExecution.merge(a.gates(),b.gates()),a.unverifiedCandidates()+b.unverifiedCandidates(),a.unauditedCandidates()+b.unauditedCandidates(),a.budgetStop()!=null?a.budgetStop():b.budgetStop()));
    }
    private boolean sameGeneratedStrategy(String left,String right){String novelty=PredictionVerificationRules.localNoveltyType(left,right);return !"UNDECIDED".equals(novelty)||PredictionVerificationRules.tokenOverlap(left,right)>=.78;}
    public List<Chat> list(UUID courseId) { return jdbc.query("SELECT c.id,c.course_id,c.title,c.purpose,c.updated_at,(SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id) AS message_count FROM chats c WHERE c.course_id=? ORDER BY c.updated_at DESC,c.created_at DESC", (rs,row) -> { ChatPurpose purpose=ChatPurpose.of(rs.getString("purpose")); return new Chat(rs.getObject("id",UUID.class),rs.getObject("course_id",UUID.class),rs.getString("title"),purpose.name(),purpose.label(),rs.getTimestamp("updated_at"),rs.getInt("message_count")); }, courseId); }
    public List<Message> messages(UUID courseId, UUID chatId) { requireChat(courseId, chatId); return jdbc.query("SELECT id,role,content,created_at FROM messages WHERE chat_id=? ORDER BY created_at", (rs,row) -> new Message(rs.getObject("id",UUID.class),rs.getString("role"),rs.getString("content"),rs.getTimestamp("created_at")), chatId); }
    /**
     * Where one answer came from, sentence by sentence. Read rather than recomputed: the evidence a past turn was
     * given is not stored, so classifying its claims again now would be a judgement against whatever the course
     * happens to contain today, presented as a record of what the answer was written from.
     */
    public com.studyos.verify.ClaimProvenanceService.View provenance(UUID courseId,UUID chatId,UUID assistantMessageId){
        requireChat(courseId,chatId);
        Integer belongs=jdbc.query("SELECT 1 FROM messages WHERE id=? AND chat_id=?",rs->rs.next()?1:null,assistantMessageId,chatId);
        if(belongs==null)throw new IllegalArgumentException("That message is not in this chat");
        return claimProvenance.view(courseId,assistantMessageId);
    }
    public ExpansionReply expand(UUID courseId,UUID chatId,UUID assistantMessageId,String type){
        ChatPurpose purpose=requireChat(courseId,chatId); if(SemanticAnswerPacket.defaultExpansions().stream().noneMatch(value->value.type().equals(type)))throw new IllegalArgumentException("Unsupported expansion type");
        SemanticAnswerService.PacketRow row=semanticAnswers.row(courseId,chatId,assistantMessageId); if(row==null)throw new IllegalArgumentException("Answer packet was not found");
        String question=jdbc.query("SELECT content FROM messages WHERE chat_id=? AND role='USER' AND created_at<(SELECT created_at FROM messages WHERE id=?) ORDER BY created_at DESC LIMIT 1",rs->rs.next()?rs.getString(1):"",chatId,assistantMessageId);
        boolean hardNew=row.intent().isBlank()?router.classify(question,"",purpose)==QueryIntent.HARD_NEW:QueryIntent.HARD_NEW.name().equals(row.intent()); String cached=semanticAnswers.cachedExpansion(row.id(),type); if(cached!=null&&!hardNew)return new ExpansionReply(type,cached,true);
        GenerationScope hardScope=hardNew?scopeResolver.resolve(courseId,chatId,HardNewRequest.parse(question)):null; List<SemanticAnswerPacket.SourceRef> safeSources=hardNew?predictionVerifier.safeScopeSources(courseId,hardScope):List.of();
        if(hardNew){String content=scopedHardNewExpansion(type,hardScope,safeSources);semanticAnswers.storeExpansion(row.id(),type,content);return new ExpansionReply(type,content,false);}
        ContextBuilder.BuildResult built=context.buildDetailed(courseId,chatId,question,QueryIntent.EXPLAIN_TOPIC); GenerationPolicy base=policies.policy(AiOperation.CHAT); int cap=switch(type){case "worked_example"->1600;case "exercise"->1000;case "prerequisite_recap"->900;default->1400;}; GenerationPolicy expansionPolicy=new GenerationPolicy(base.operation(),base.model(),cap,.2,1,false,GenerationPolicy.ResponseMode.TEXT);
        long started=System.nanoTime();AiResult<String> result=null;boolean success=false;String content;
        try{
            String prompt=built.context()+"\nOriginal answer core: "+row.packet().coreAnswer()+"\nGenerate only the requested "+type+" expansion. Do not repeat the core answer.";
            result=ai.generateResult(systemPrompt(QueryIntent.EXPLAIN_TOPIC),prompt,expansionPolicy);content=result.value().trim();
            success=true;
        }finally{usage.record(AiOperation.CHAT,result,courseId,chatId,null,(System.nanoTime()-started)/1_000_000,success,built.tokens());}
        semanticAnswers.storeExpansion(row.id(),type,content);return new ExpansionReply(type,content,false);
    }
    private String scopedHardNewExpansion(String type,GenerationScope scope,List<SemanticAnswerPacket.SourceRef> sources){
        if(scope==null||!scope.hasEvidence()||sources.isEmpty())return "This expansion was blocked because no valid evidence remains inside the requested closed source scope.";
        String content=switch(type){
            case "worked_example"->"### Worked approach\n\n1. List the exercise's givens, target, and constraints using only the cited definitions.\n2. Choose the first supported rule, method, or principle that advances the target.\n3. Show the intermediate result and explain why the cited material permits that step.\n4. Continue until every requested task is addressed.\n5. Check the result against the original domains, assumptions, and edge cases. Do not silently introduce a new theorem, API, model, or convention.";
            case "prerequisite_recap"->"### Prerequisite recap\n\nThe closed source profile identifies these concepts: "+list(scope.sourceSemantics().concepts())+". Relevant domains or types: "+list(scope.sourceSemantics().domains())+". Relevant rules or operations: "+list(scope.sourceSemantics().operations())+". Review only these source-supported items before attempting the exercise; outside course knowledge is not assumed.";
            case "exercise"->"### Focused practice\n\nBefore solving the full exercise, write a short solution plan. For every planned step, name the cited definition, operation, rule, or method that authorizes it. Mark any step that cannot be justified from the closed source scope. Then revise the plan so every required step is grounded and the reasoning—not a cosmetic parameter change—provides the difficulty.";
            default->"### Deeper explanation\n\nSeparate the task into four layers: source givens, required result, permitted operations or methods, and reasoning steps. The exercise is genuinely harder only when it demands a deeper chain or synthesis of supported ideas. Changing a number, type name, example, operator, or story while preserving the same solution path does not create meaningful novelty.";
        };
        return content+renderSources(sources);
    }
    private String list(List<String> values){return values==null||values.isEmpty()?"the definitions stated in the cited source":String.join(", ",values.subList(0,Math.min(6,values.size())));}
    private String renderSources(List<SemanticAnswerPacket.SourceRef> sources){StringBuilder value=new StringBuilder("\n\nSources:");for(var source:sources)value.append("\n- [[Source: ").append(source.document()).append("; pages ").append(source.pages()).append("]] ");return value.toString();}
    /** Ownership check and the chat's purpose in one read, because every turn needs both. */
    private ChatPurpose requireChat(UUID courseId, UUID chatId) { List<String> purposes=jdbc.queryForList("SELECT purpose FROM chats WHERE id=? AND course_id=?",String.class,chatId,courseId); if (purposes.isEmpty()) throw new IllegalArgumentException("Chat does not belong to this project"); return ChatPurpose.of(purposes.getFirst()); }
    private SemanticAnswerPacket predictionPacket(List<ExamPredictionVerificationService.VerifiedCandidate> candidates,int requestedCount,ExamPredictionVerificationService.PredictionDiagnostics diagnostics) { if(candidates.isEmpty())return predictionFailurePacket(requestedCount); List<SemanticAnswerPacket.Section> sections=new java.util.ArrayList<>(); java.util.LinkedHashMap<String,SemanticAnswerPacket.SourceRef> sources=new java.util.LinkedHashMap<>(); for(int index=0;index<candidates.size();index++){var value=candidates.get(index);var verification=value.verification();StringBuilder body=new StringBuilder(value.candidate().exercise()).append("\n\nExam plausibility: ").append(label(verification.confidence())).append("\nReasoning novelty: ").append(label(verification.reasoningNovelty())).append("\n\nWhy it may appear:\n").append(verification.plausibilityReasoning());body.append("\n\nSources:");for(var source:value.candidate().sourceBasis()){body.append("\n- [[Source: ").append(source.document()).append("; pages ").append(source.pages()).append("]] ");sources.putIfAbsent(source.document()+"|"+source.pages(),source);}sections.add(new SemanticAnswerPacket.Section("Exercise "+(index+1)+" — "+value.candidate().title(),body.toString()));}return new SemanticAnswerPacket("These are evidence-grounded exercise predictions, not guarantees. Each survived structural, similarity, grounding, well-definedness, and novelty checks."+shortfallNote(candidates.size(),requestedCount,diagnostics),sections,List.copyOf(sources.values()),SemanticAnswerPacket.defaultExpansions()); }
    private SemanticAnswerPacket hardNewPacket(List<ExamPredictionVerificationService.VerifiedCandidate> candidates,int requestedCount,GenerationScope scope,ExamPredictionVerificationService.PredictionDiagnostics diagnostics) { if(candidates.isEmpty())return hardNewFailurePacket(requestedCount); List<SemanticAnswerPacket.Section> sections=new ArrayList<>(); LinkedHashMap<String,SemanticAnswerPacket.SourceRef> sources=new LinkedHashMap<>(); for(int index=0;index<candidates.size();index++){var value=candidates.get(index);for(var source:value.candidate().sourceBasis())sources.putIfAbsent(source.document()+"|"+source.pages(),source);sections.add(new SemanticAnswerPacket.Section("Exercise "+(index+1)+" — "+value.candidate().title(),value.candidate().exercise()));}String countText=candidates.size()==1?"Here is one hard new exercise":"Here are "+candidates.size()+" hard new exercises";return new SemanticAnswerPacket(countText+" using only the closed "+scope.label()+" source material."+shortfallNote(candidates.size(),requestedCount,diagnostics),sections,List.copyOf(sources.values()),SemanticAnswerPacket.defaultExpansions()); }
    /**
     * Said out loud when fewer exercises survived verification than were asked for. Everything that passed is
     * still shown: throwing away four verified exercises because a fifth failed, after spending the whole
     * request budget getting them, is the worst of both outcomes — the recorded run did exactly that twice.
     * The count has to be stated, because an answer that quietly returns three of five reads as a complete one.
     * Callers show the failure packet when nothing passed, so this never has to describe an empty set.
     */
    String shortfallNote(int verified,int requestedCount){ return verified>=requestedCount?"":" You asked for "+requestedCount+"; "+verified+" passed every check within the time available and "+(requestedCount-verified)+" did not, so "+(verified==1?"only this one is":"only these are")+" shown. Ask again for the rest."; }
    /**
     * The same note, told correctly when verification stopped early rather than finished. "Did not pass" is a
     * claim about the exercises; "was not checked" is a claim about this turn, and a turn that ran out of clock
     * or hit its verifier-call cap has no basis for the first. The distinction also tells the learner which
     * action helps: asking again is worth it when nothing was wrong with the missing exercises.
     */
    String shortfallNote(int verified,int requestedCount,ExamPredictionVerificationService.PredictionDiagnostics diagnostics) {
        if(diagnostics==null||!diagnostics.truncated())return shortfallNote(verified,requestedCount);
        StringBuilder note=new StringBuilder();
        if(verified<requestedCount) {
            int missing=requestedCount-verified;int unchecked=diagnostics.unverifiedCandidates();
            note.append(" You asked for ").append(requestedCount).append("; ").append(verified).append(verified==1?" is shown":" are shown").append(". Verification stopped before finishing, so the remaining ").append(missing==1?"one is":missing+" are").append(" missing because ").append(missing==1?"it was":"they were").append(" not checked, not because ").append(missing==1?"it failed":"they failed").append(" a check");
            if(unchecked>0)note.append(" (").append(unchecked).append(unchecked==1?" candidate was":" candidates were").append(" never checked at all)");
            note.append(". Ask again for the rest.");
        }
        int unaudited=Math.min(diagnostics.unauditedCandidates(),verified);
        if(unaudited>0)note.append(" The final independent re-check did not run in the time available, so up to ").append(unaudited).append(unaudited==1?" of the exercises shown rests":" of the exercises shown rest").append(" on a single verifier's judgement.");
        return note.toString();
    }
    private String label(Double score){return score>=.72?"High":score>=.42?"Medium":"Low";}
    private String similarityLabel(Double score){return score<=.35?"Low":score<=.65?"Medium":"High";}
    private void recordLearningEvent(UUID courseId, QueryIntent intent, String question,ExamPredictionVerificationService.PredictionDiagnostics diagnostics) { try { var payload=mapper.createObjectNode().put("question",question.substring(0,Math.min(500,question.length()))).put("intent",intent.name());if(diagnostics!=null)payload.set("predictionVerification",mapper.valueToTree(diagnostics));jdbc.update("INSERT INTO learning_events(id,course_id,event_type,payload) VALUES(?,?,?,?::jsonb)",UUID.randomUUID(),courseId,"QUESTION_ANSWERED",payload.toString()); } catch (Exception ignored) {} }
    /** A chat as a sidebar needs it: what it is called, what it is for, when it was last used, and how much is in it. */
    public record Chat(UUID id,UUID courseId,String title,String purpose,String purposeLabel,Timestamp updatedAt,int messageCount) {}
    public record Message(UUID id,String role,String content,Timestamp createdAt) {}
    private record PredictionScaffoldSource(String prompt,String document,int pageStart,int pageEnd) {}
    public record ChatReply(String content,String intent,UUID assistantMessageId,SemanticAnswerPacket packet,ExamPredictionVerificationService.PredictionDiagnostics predictionDiagnostics,HardNewDebug hardNewDebug,ReplyTelemetry replyTelemetry,List<UUID> quizItemIds) {
        /** Identifiers of the questions this turn issued, in the order they were asked; empty for every other turn. */
        public ChatReply { quizItemIds=quizItemIds==null?List.of():List.copyOf(quizItemIds); }
    }
    /**
     * What one turn actually cost upstream and how well it attributed what it said, so provider reliability,
     * answer faithfulness, and citation quality can each be measured separately.
     *
     * <p>Citation precision and recall are carried as counts rather than ratios because a harness aggregating
     * across turns has to sum them: averaging per-turn ratios gives a one-citation turn the same weight as a
     * twenty-citation one, and the resulting figure is not any answer's precision.
     *
     * @param ungroundedClaims cited sentences asserting a figure the evidence does not contain
     * @param unsupportedWording cited sentences whose distinctive terms the evidence never uses — a signal about
     *     this answer, which is why it is recorded here and not shown to the learner
     */
    /**
     * What one reply cost and what the audits found in it. The counts are raw rather than pre-divided so a
     * harness can pool across turns — summing then dividing once, instead of averaging per-turn ratios, which
     * would weight a one-claim answer the same as a twenty-claim one.
     *
     * <p>The learner-record figures sit beside the citation ones rather than folded into them because the two
     * kinds of evidence fail independently: an answer can cite a real page for a mastery figure nobody measured.
     *
     * <p>The page-attribution figures are {@code -1} rather than {@code 0} on a turn that retrieved nothing to
     * cite. Zero misattributed figures out of zero checked claims reads as perfect attribution, and a turn whose
     * attribution was never examined is not the same as a turn that got it right.
     */
    public record ReplyTelemetry(int upstreamCalls,int chatCalls,int embeddingCalls,int upstreamAttempts,int retries,int transientFailures,String transientDetail,long latencyMs,boolean fallbackUsed,boolean cacheHit,int contradictedComputations,int unverifiableCitations,int ungroundedClaims,int unsupportedWording,int citations,int attestedCitations,int subjectClaims,int citedClaims,
            int misattributedFigures,int claimsTracedElsewhere,int pageCheckedClaims,int pageTracedClaims,
            int unanchoredLearnerClaims,int unrecordedLearnerReferences,int learnerFiguresNotRecorded,int learnerClaims,int anchoredLearnerClaims,int learnerReferences,int recordedLearnerReferences,
            int revealedQuizAnswers,int quizContractViolations,int questionsAsked,
            int predictionVerifierCalls,int unverifiedPredictionCandidates,int unauditedPredictionCandidates,String predictionBudgetStop) {
        static ReplyTelemetry of(ProviderCallTelemetry.Snapshot snapshot,long latencyMs,boolean fallbackUsed,boolean cacheHit,int contradictedComputations,int unverifiableCitations,List<com.studyos.verify.GroundingAudit.Finding> groundingFindings,com.studyos.verify.CitationAudit.Coverage coverage,List<com.studyos.verify.ProvenanceAudit.Finding> provenanceFindings,com.studyos.verify.ProvenanceAudit.Coverage provenanceCoverage,List<com.studyos.verify.LearnerStateAudit.Finding> learnerFindings,com.studyos.verify.LearnerStateAudit.Coverage learnerCoverage,List<com.studyos.verify.QuizContractAudit.Finding> quizFindings,String answer,boolean quizTurn,ExamPredictionVerificationService.PredictionDiagnostics prediction) {
            com.studyos.verify.CitationAudit.Coverage counted=coverage==null?new com.studyos.verify.CitationAudit.Coverage(0,0,0,0):coverage;
            com.studyos.verify.LearnerStateAudit.Coverage learner=learnerCoverage==null?new com.studyos.verify.LearnerStateAudit.Coverage(0,0,0,0):learnerCoverage;
            List<com.studyos.verify.QuizContractAudit.Finding> quiz=quizFindings==null?List.of():quizFindings;
            List<com.studyos.verify.ProvenanceAudit.Finding> pages=provenanceFindings==null?List.of():provenanceFindings;
            boolean pagesChecked=provenanceCoverage!=null;
            return new ReplyTelemetry(snapshot.upstreamCalls(),snapshot.chatCalls(),snapshot.embeddingCalls(),snapshot.upstreamAttempts(),snapshot.retries(),snapshot.transientFailures(),snapshot.transientDetail(),latencyMs,fallbackUsed,cacheHit,contradictedComputations,unverifiableCitations,
                    (int)groundingFindings.stream().filter(com.studyos.verify.GroundingAudit.Finding::reportable).count(),(int)groundingFindings.stream().filter(finding->!finding.reportable()).count(),
                    counted.citations(),counted.attested(),counted.subjectClaims(),counted.citedClaims(),
                    // The reportable half is the figures the learner was sent to the wrong page for; the other half is
                    // vocabulary landing elsewhere, which is a reading about this answer rather than a warning.
                    pagesChecked?(int)pages.stream().filter(com.studyos.verify.ProvenanceAudit.Finding::reportable).count():-1,
                    pagesChecked?(int)pages.stream().filter(finding->!finding.reportable()).count():-1,
                    pagesChecked?provenanceCoverage.checkedClaims():-1,pagesChecked?provenanceCoverage.tracedClaims():-1,
                    kind(learnerFindings,"learner claim with nothing recorded behind it"),kind(learnerFindings,"unrecorded learner reference"),kind(learnerFindings,"figure not in the learner's record"),
                    learner.learnerClaims(),learner.anchoredClaims(),learner.references(),learner.recordedReferences(),
                    (int)quiz.stream().filter(finding->"answer key section".equals(finding.kind())||"answer revealed".equals(finding.kind())).count(),quiz.size(),
                    quizTurn?com.studyos.verify.QuizContractAudit.questionsAsked(answer):-1,
                    // Negative one, not zero, on a turn that generated no exercises: a turn with nothing to verify
                    // and a turn whose verification was complete are different, and only one of them is a clean run.
                    prediction==null?-1:prediction.verifierCalls(),prediction==null?-1:prediction.unverifiedCandidates(),prediction==null?-1:prediction.unauditedCandidates(),prediction==null?null:prediction.budgetStop());
        }
        private static int kind(List<com.studyos.verify.LearnerStateAudit.Finding> findings,String kind) {
            return findings==null?0:(int)findings.stream().filter(finding->kind.equals(finding.kind())).count();
        }
        /** Of the references this turn made, the share the retrieved evidence supports. */
        public double citationPrecision() { return citations==0?1:(double)attestedCitations/citations; }
        /** Of the claims this turn made about retrieved material, the share carrying a reference. */
        public double citationRecall() { return subjectClaims==0?1:(double)citedClaims/subjectClaims; }
        /** Whether per-page attribution was examined at all. False on a turn that retrieved nothing to cite. */
        public boolean pageAttributionChecked() { return pageCheckedClaims>=0; }
        /**
         * Of the cited claims whose page could be checked, the share supported by the page they name. One when
         * none could be checked, which is why {@link #pageAttributionChecked()} has to be read alongside it.
         */
        public double pageTraceability() { return pageCheckedClaims<=0?1:(double)pageTracedClaims/pageCheckedClaims; }
        /** Of the learner handles this turn cited, the share the recorded-attempt block really issued. */
        public double learnerPrecision() { return learnerReferences==0?1:(double)recordedLearnerReferences/learnerReferences; }
        /** Of the things this turn said about the learner, the share pointing at a recorded attempt. */
        public double learnerRecall() { return learnerClaims==0?1:(double)anchoredLearnerClaims/learnerClaims; }
        /** Whether this reply obeyed the contract of the turn that asked to be tested; {@code true} for any other turn. */
        public boolean quizContractHonoured() { return quizContractViolations==0; }
        /** Whether exercise verification stopped short on this turn. False on turns that generated no exercises. */
        public boolean predictionTruncated() { return predictionBudgetStop!=null||unverifiedPredictionCandidates>0||unauditedPredictionCandidates>0; }
    }
    /** End-to-end trace of a generated-exercise request, so a bypassed or partially executed pipeline is observable. */
    public record HardNewDebug(String mode,String intent,HardNewRequest constraints,GenerationScope.ScopeSummary generationScope,List<UUID> retrievedDocumentIds,List<String> retrievedDocuments,int generatedCandidateCount,boolean pipelineExecuted,boolean closedScopeApplied,boolean structuralGateExecuted,boolean scopeGateExecuted,boolean citationGateExecuted,boolean similarityGateExecuted,boolean localNoveltyGateExecuted,boolean verifierExecuted,List<ExamPredictionVerificationService.CandidateDebug> candidateRejections,List<String> selectedCandidates,List<PredictionVerificationBatch.Verification> selectedVerifierResults,List<SemanticAnswerPacket.SourceRef> finalSourceCitations,int finalOutputCount) { public HardNewDebug { mode=mode==null?"HARD_NEW":mode;intent=intent==null?"":intent;retrievedDocumentIds=retrievedDocumentIds==null?List.of():List.copyOf(retrievedDocumentIds);retrievedDocuments=retrievedDocuments==null?List.of():List.copyOf(retrievedDocuments);candidateRejections=candidateRejections==null?List.of():List.copyOf(candidateRejections);selectedCandidates=selectedCandidates==null?List.of():List.copyOf(selectedCandidates);selectedVerifierResults=selectedVerifierResults==null?List.of():List.copyOf(selectedVerifierResults);finalSourceCitations=finalSourceCitations==null?List.of():List.copyOf(finalSourceCitations); } }
    public record ExpansionReply(String type,String content,boolean cached) {}
}
