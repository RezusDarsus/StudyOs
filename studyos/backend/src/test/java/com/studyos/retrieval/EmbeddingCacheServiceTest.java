package com.studyos.retrieval;

import static org.assertj.core.api.Assertions.assertThat;
import com.studyos.ai.AiUsageProperties;
import org.junit.jupiter.api.Test;

class EmbeddingCacheServiceTest {
    @Test void normalizedWhitespaceProducesSameStableHash(){EmbeddingCacheService cache=new EmbeddingCacheService(null,null,new AiUsageProperties());assertThat(cache.hash("edge   relaxation\nexample")).isEqualTo(cache.hash("edge relaxation example"));assertThat(cache.hash("edge relaxation example")).hasSize(64);}
}
