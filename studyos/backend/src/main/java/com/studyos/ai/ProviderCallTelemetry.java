package com.studyos.ai;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Per-request upstream counters. The active gateway records every distinct provider call, every HTTP
 * attempt those calls needed, and every transient failure it retried through, so a benchmark run can
 * report what a single turn actually cost upstream instead of inferring it from the final HTTP status.
 *
 * <p>Calls and attempts are counted separately on purpose: one turn legitimately makes several calls
 * (retrieval embeddings, then chat completion), so a raw attempt count alone reads like a retry storm
 * when nothing was retried. Retries are exactly {@code attempts - calls}.
 *
 * <p>Structured-response counters live here too, so a request can report how its structured answers
 * fared: how many parsed exactly as asked, how many needed a local structural repair (and which
 * kind), how many failed (and why), and whether a truncation continuation was spent. The split
 * between exact and repaired is the honest signal that prompts or providers still need work — a
 * high repair rate means the model is not following the shape, even when the answer is usable.
 */
public final class ProviderCallTelemetry {
    private static final ThreadLocal<State> STATE = new ThreadLocal<>();
    private static final int MAX_RECORDED_REASONS = 12;
    private static final int MAX_RECORDED_KINDS = 8;
    private ProviderCallTelemetry() {}
    public static void reset() { STATE.set(new State()); }
    public static void clear() { STATE.remove(); }
    /** One distinct upstream call is starting; {@code kind} separates chat completions from embeddings. */
    public static void call(Kind kind) { State state=STATE.get(); if(state==null) return; state.calls++; if(kind==Kind.CHAT) state.chatCalls++; else state.embeddingCalls++; }
    public static void attempt() { State state=STATE.get(); if(state!=null) state.attempts++; }
    public static void transientFailure(Integer upstreamStatus,String reason) { State state=STATE.get(); if(state==null) return; state.transientFailures++; if(state.reasons.size()<MAX_RECORDED_REASONS) state.reasons.add(upstreamStatus==null?reason:upstreamStatus+":"+reason); }

    /** One structured response was deserialized successfully; exact means no repair touched it. */
    public static void structuredParse(StructuredRepairKind repairKind, boolean exact) {
        State state=STATE.get(); if(state==null) return;
        state.structuredRequests++;
        if (exact) state.exactParses++; else state.localRepairs++;
        if (repairKind != null && repairKind != StructuredRepairKind.NONE) state.repairKinds.merge(repairKind.name(), 1, Integer::sum);
    }

    /** One structured response could not be deserialized at all, classified by why. */
    public static void structuredFailure(StructuredOutputFailure failure) {
        State state=STATE.get(); if(state==null) return;
        state.structuredRequests++;
        if (failure != null) state.structuredFailures.merge(failure.name(), 1, Integer::sum);
    }

    public static void continuationAttempt() { State state=STATE.get(); if(state!=null) state.continuationAttempts++; }
    public static void continuationSuccess() { State state=STATE.get(); if(state!=null) state.continuationSuccesses++; }

    public static Snapshot snapshot() {
        State state=STATE.get();
        return state==null?Snapshot.empty():new Snapshot(state.calls,state.chatCalls,state.embeddingCalls,state.attempts,state.transientFailures,String.join(" ",state.reasons),
                state.structuredRequests,state.exactParses,state.localRepairs,state.continuationAttempts,state.continuationSuccesses,
                summarize(state.repairKinds),summarize(state.structuredFailures));
    }
    public enum Kind { CHAT, EMBEDDING }
    private static final class State {
        private int calls; private int chatCalls; private int embeddingCalls; private int attempts; private int transientFailures; private final List<String> reasons=new ArrayList<>();
        private int structuredRequests; private int exactParses; private int localRepairs; private int continuationAttempts; private int continuationSuccesses;
        private final Map<String,Integer> repairKinds=new LinkedHashMap<>(); private final Map<String,Integer> structuredFailures=new LinkedHashMap<>();
    }
    private static String summarize(Map<String,Integer> counts) {
        List<String> entries=new ArrayList<>();
        counts.entrySet().stream().limit(MAX_RECORDED_KINDS).forEach(entry -> entries.add(entry.getKey().toLowerCase(java.util.Locale.ROOT)+":"+entry.getValue()));
        return String.join(" ", entries);
    }
    public record Snapshot(int upstreamCalls,int chatCalls,int embeddingCalls,int upstreamAttempts,int transientFailures,String transientDetail,
                           int structuredRequests,int structuredExactParses,int structuredLocalRepairs,int continuationAttempts,int continuationSuccesses,
                           String repairKinds,String structuredFailures) {
        public static Snapshot empty() { return new Snapshot(0,0,0,0,0,"",0,0,0,0,0,"",""); }
        /** Attempts beyond one per call, i.e. what the gateway actually retried. */
        public int retries() { return Math.max(0,upstreamAttempts-upstreamCalls); }
        /** Repairs over usable structured responses; high values mean prompts need work, not celebration. */
        public double repairRate() { return structuredRequests == 0 ? 0 : (double) structuredLocalRepairs / structuredRequests; }
    }
}
