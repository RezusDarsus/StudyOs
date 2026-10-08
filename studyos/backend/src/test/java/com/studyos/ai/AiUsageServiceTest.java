package com.studyos.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class AiUsageServiceTest {
    @Test void persistsProviderTokenUsageInsteadOfDiscardingIt() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        AiUsageProperties properties = new AiUsageProperties(); properties.setProvider("nvidia"); properties.setChatModel("nvidia/nemotron-3-super-120b-a12b");
        AiUsageService service = new AiUsageService(jdbc, properties);
        service.record(AiOperation.CHAT, new AiResult<>("answer", 120, 45, 165, "nvidia/nemotron-3-super-120b-a12b"), UUID.randomUUID(), UUID.randomUUID(), null, 80, true);
        verify(jdbc).update(contains("input_tokens"), any(), eq("CHAT"), eq("nvidia/nemotron-3-super-120b-a12b"), eq(120), eq(45), isNull(), isNull(), isNull(), isNull(), isNull(), eq(80L), any(), any(), isNull(), eq("nvidia"), eq(true),isNull(),isNull(),isNull(),isNull(),isNull(),isNull(),isNull(),isNull());
    }
}
