package com.studyos.chat;

import java.util.*;
import java.util.regex.*;

/** Parsed before retrieval so constrained exercise generation has a closed evidence boundary. */
public record HardNewRequest(int requestedCount,List<Integer> requestedWeeks,Integer referenceExercise,String difficulty,boolean allowLaterWeeks,boolean requireReasoningNovelty,String rawQuery,String referenceText) {
    private static final Pattern WEEK=Pattern.compile("\\bweek\\s*(\\d+)\\b");
    private static final Pattern REFERENCE=Pattern.compile("\\b(homework|hw|assignment|exercise\\s+sheet|sheet|midterm|exam|quiz)\\s*(\\d{1,4})\\b");
    private static final Pattern COUNT=Pattern.compile("\\b(1[0-2]|[1-9])\\b(?:\\s+[a-z-]+){0,5}\\s+(?:exercises?|problems?|tasks?|questions?)\\b");
    private static final Pattern WORD_COUNT=Pattern.compile("\\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\b(?:\\s+[a-z-]+){0,5}\\s+(?:exercises?|problems?|tasks?|questions?)\\b");
    private static final Pattern CREATION=Pattern.compile("\\b(?:create|generate|give\\s+me|make|design|write|invent|produce|prepare|come\\s+up\\s+with)\\b");
    private static final Pattern DIFFICULTY=Pattern.compile("\\b(?:hard|harder|hardest|difficult|challenging|tough)\\b");
    private static final Pattern NOVELTY=Pattern.compile("\\b(?:new|not\\s+(?:the\\s+)?same|not\\s+like|not\\s+from|different\\s+from|unlike|other\\s+than|instead\\s+of)\\b");
    private static final Pattern EXPLANATORY=Pattern.compile("^\\s*(?:what|why|how|when|where|which|who|explain|describe|summari[sz]e|tell\\s+me\\s+about|help\\s+me\\s+solve|solve)\\b");
    private static final Pattern FROZEN_REFERENCE=Pattern.compile("\\b(?:not\\s+(?:the\\s+)?same\\s+as|not\\s+like)\\s+(?:homework|hw|assignment|exercise\\s+sheet|sheet)\\s*\\d+\\b|\\b(?:use|keep)\\s+(?:the\\s+)?(?:original\\s+)?(?:homework|hw|assignment|exercise)\\s*\\d+\\s+(?:model|system|setup)\\b");

    public HardNewRequest { requestedCount=Math.max(1,Math.min(12,requestedCount)); requestedWeeks=requestedWeeks==null?List.of():List.copyOf(requestedWeeks); difficulty=difficulty==null?"HARD":difficulty;rawQuery=rawQuery==null?"":rawQuery.trim();referenceText=referenceText==null?"":referenceText.trim(); }
    public HardNewRequest(int requestedCount,List<Integer> requestedWeeks,Integer referenceExercise,String difficulty,boolean allowLaterWeeks,boolean requireReasoningNovelty){this(requestedCount,requestedWeeks,referenceExercise,difficulty,allowLaterWeeks,requireReasoningNovelty,"",referenceExercise==null?"":"homework "+referenceExercise);}

    public static HardNewRequest parse(String query) {
        String value=normalize(query);
        List<Integer> weeks=new ArrayList<>(); Matcher week=WEEK.matcher(value); while(week.find()) { int parsed=number(week.group(1)); if(parsed>0&&!weeks.contains(parsed)) weeks.add(parsed); }
        Matcher reference=REFERENCE.matcher(value); Integer referenced=null; String referenceText=""; if(reference.find()){String kind=reference.group(1);int number=number(reference.group(2));referenceText=kind+" "+number;if(!kind.matches("midterm|exam|quiz")&&number>0)referenced=number;}
        Matcher count=COUNT.matcher(value);Matcher wordCount=WORD_COUNT.matcher(value);int requested=count.find()?number(count.group(1)):wordCount.find()?wordNumber(wordCount.group(1)):1;
        return new HardNewRequest(requested<1?1:requested,weeks,referenced,DIFFICULTY.matcher(value).find()?"HARD":"STANDARD",false,true,query,referenceText);
    }

    /** True when the current turn itself names a closed evidence boundary, so conversation history must not redirect it. */
    public boolean hasClosedScopeSignal() { return !requestedWeeks.isEmpty()||referenceExercise!=null||REFERENCE.matcher(normalize(rawQuery)).find()||Pattern.compile("\\b(?:source|document|file|pdf)\\b").matcher(normalize(rawQuery)).find(); }
    /** True only when wording binds generation to the referenced model; "unlike" is comparison-only. */
    public boolean freezesReferenceModel(){return FROZEN_REFERENCE.matcher(normalize(rawQuery)).find();}

    /**
     * True when this turn explicitly asks for a newly generated exercise inside a named scope.
     * A current-turn constraint like this outranks any exam wording carried over from earlier messages.
     */
    public static boolean requestsScopedNewExercise(String query) {
        String value=normalize(query); if(EXPLANATORY.matcher(value).find()) return false;
        if(!parse(query).hasClosedScopeSignal()) return false;
        return CREATION.matcher(value).find()||(DIFFICULTY.matcher(value).find()&&NOVELTY.matcher(value).find());
    }

    private static String normalize(String query) { return (query==null?"":query).toLowerCase(Locale.ROOT).replaceAll("\\s+"," ").trim(); }
    private static int number(String value) { try { return Integer.parseInt(value); } catch(NumberFormatException ignored) { return 0; } }
    private static int wordNumber(String value){return switch(value){case "one"->1;case "two"->2;case "three"->3;case "four"->4;case "five"->5;case "six"->6;case "seven"->7;case "eight"->8;case "nine"->9;case "ten"->10;case "eleven"->11;default->12;};}
}
