package com.studyos.prediction;

import java.util.List;

/** Explainable, deterministic readiness aggregation. */
public final class ReadinessCalculator {
    private ReadinessCalculator() {}
    public static Result calculate(List<Topic> topics,int openMisconceptions){
        if(topics==null||topics.isEmpty())return new Result(0,0,0,0,0,openMisconceptions);
        double weight=topics.stream().mapToDouble(topic->Math.max(.05,topic.relevance())).sum();
        double mastery=topics.stream().mapToDouble(topic->topic.effectiveMastery()*Math.max(.05,topic.relevance())).sum()/weight;
        List<Topic> important=topics.stream().filter(topic->topic.relevance()>=.65).toList();
        double highPriority=important.isEmpty()?mastery:important.stream().mapToDouble(Topic::effectiveMastery).average().orElse(mastery);
        double coverage=topics.stream().mapToDouble(topic->Math.min(1,topic.attemptCount()/3d)).average().orElse(0);
        double retention=topics.stream().mapToDouble(Topic::retention).average().orElse(0);
        double penalty=Math.min(.20,openMisconceptions*.04);
        double readiness=clamp(.40*mastery+.25*highPriority+.20*coverage+.15*retention-penalty);
        return new Result(readiness,mastery,highPriority,coverage,retention,openMisconceptions);
    }
    private static double clamp(double value){return Math.max(0,Math.min(1,value));}
    public record Topic(double effectiveMastery,double relevance,double retention,int attemptCount){}
    public record Result(double readiness,double conceptMastery,double highPriorityTopics,double practiceCoverage,double retention,int openMisconceptions){}
}
