package com.studyos.chat;

import java.util.List;

/** Deliberately small generator contract; novelty is judged later by a separate verifier. */
public record PredictionCandidateBatch(List<PredictionCandidate> candidates) {
    public PredictionCandidateBatch { candidates=candidates==null?List.of():List.copyOf(candidates); }
    public static String contract() { return "Return JSON {candidates:[{title,exercise,sourceBasis:[{document,pages}],transformationType}]}. sourceBasis must cite only supplied retrieved documents. transformationType is one of PARAMETER_ONLY_VARIANT, CHANGED_ASSUMPTION, PROVE_TO_DISPROVE, COUNTEREXAMPLE, INVARIANT_REPAIR, CONCEPT_COMBINATION, DERIVE_CONDITION, ALGORITHM_DESIGN, OTHER."; }
    public record PredictionCandidate(String title,String exercise,List<SemanticAnswerPacket.SourceRef> sourceBasis,String transformationType) {
        public PredictionCandidate { title=title==null?"":title.trim(); exercise=exercise==null?"":exercise.trim(); sourceBasis=sourceBasis==null?List.of():List.copyOf(sourceBasis); transformationType=transformationType==null?"OTHER":transformationType.trim(); }
    }
}
