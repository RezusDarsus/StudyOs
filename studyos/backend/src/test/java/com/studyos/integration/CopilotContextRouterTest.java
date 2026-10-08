package com.studyos.integration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class CopilotContextRouterTest {
    @Test void isolatesStudyAndGeneralBackends(){assertEquals("STUDYOS",CopilotContextRouter.route(UUID.randomUUID(),null).context());assertEquals("GENERAL_GOAL",CopilotContextRouter.route(null,"FITNESS").context());}
}
