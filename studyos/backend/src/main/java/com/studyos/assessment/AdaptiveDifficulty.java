package com.studyos.assessment;

import java.util.List;

final class AdaptiveDifficulty {
    private AdaptiveDifficulty(){}
    static double adjust(double requested,List<Double> recentScores){double value=Math.max(.1,Math.min(1,requested));if(recentScores!=null&&recentScores.size()>=3&&recentScores.subList(0,3).stream().allMatch(score->score>=.85))value+=.1;else if(recentScores!=null&&recentScores.size()>=2&&recentScores.subList(0,2).stream().allMatch(score->score<.35))value-=.15;return Math.max(.1,Math.min(1,value));}
}
