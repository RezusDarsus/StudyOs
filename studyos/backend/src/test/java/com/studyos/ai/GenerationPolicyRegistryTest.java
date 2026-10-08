package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;
import org.junit.jupiter.api.Test;

class GenerationPolicyRegistryTest {
    @Test void givesLargePredictionSetsEnoughButBoundedOutputCapacity(){AiUsageProperties properties=new AiUsageProperties();properties.setChatModel("primary");GenerationPolicyRegistry registry=new GenerationPolicyRegistry(properties);assertThat(registry.predictionPolicy(10).maxOutputTokens()).isEqualTo(6300);assertThat(registry.predictionPolicy(10,true).maxOutputTokens()).isEqualTo(8192);assertThat(registry.predictionPolicy(20).maxOutputTokens()).isEqualTo(8192);assertThat(registry.predictionPolicy(10).thinking()).isFalse();assertThat(registry.predictionPolicy(10).responseMode()).isEqualTo(GenerationPolicy.ResponseMode.JSON);}
}
