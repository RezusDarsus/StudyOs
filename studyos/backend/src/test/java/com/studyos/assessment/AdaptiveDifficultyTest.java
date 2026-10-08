package com.studyos.assessment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import java.util.List;
import org.junit.jupiter.api.Test;

class AdaptiveDifficultyTest {
    @Test void increasesAfterRepeatedSuccess(){assertEquals(.6,AdaptiveDifficulty.adjust(.5,List.of(.9,.9,1.0)),.0001);}
    @Test void reducesAndTeachesAfterRepeatedFailure(){assertEquals(.35,AdaptiveDifficulty.adjust(.5,List.of(.1,.3)),.0001);}
}
