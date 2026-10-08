package com.studyos.integration;

import java.util.Locale;
import java.util.Set;

/** Conservative local detector used only to decide whether to offer optional StudyOS activation. */
public final class LearningGoalDetector {
    private static final Set<String> SIGNALS=Set.of("learn","study","prepare","exam","certification","course","language","practice","master","understand","interview","java","aws","ielts");
    private LearningGoalDetector(){}
    public static Result detect(String title,String description){String text=((title==null?"":title)+" "+(description==null?"":description)).toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+"," ");long matches=SIGNALS.stream().filter(signal->text.matches(".*\\b"+signal+"\\b.*")).count();boolean learning=matches>0;return new Result(learning,learning?Math.min(.95,.55+matches*.12):.1,learning?"Goal contains learning-oriented language":"No reliable learning signal was found",learning);}
    public record Result(boolean learningOriented,double confidence,String reason,boolean offerStudyOs){}
}
