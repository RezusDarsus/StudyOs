package com.studyos.chat;

import static org.assertj.core.api.Assertions.assertThat;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;

class SemanticAnswerServiceTest {
    @Test void rendersBackwardCompatibleMarkdownFromPacket(){var packet=new SemanticAnswerPacket("Core answer",List.of(new SemanticAnswerPacket.Section("Why","Because evidence supports it.")),List.of(new SemanticAnswerPacket.SourceRef("lecture.pdf","3-4")),SemanticAnswerPacket.defaultExpansions());String rendered=new SemanticAnswerService(null,null).render(packet);assertThat(rendered).contains("Core answer","## Why","[[Source: lecture.pdf; pages 3-4]]","worked_example");}
    @Test void initialPacketContainsDescriptorsButNoExpansionContent(){var expansions=SemanticAnswerPacket.defaultExpansions();assertThat(expansions).extracting(SemanticAnswerPacket.Expansion::type).containsExactly("worked_example","deeper_explanation","prerequisite_recap","exercise");assertThat(expansions).allMatch(value->value.label()!=null&&!value.label().isBlank());}
    @Test void acceptsProviderPageArrays() throws Exception {var packet=new ObjectMapper().readValue("{\"coreAnswer\":\"x\",\"sections\":[],\"sources\":[{\"document\":\"exam.pdf\",\"pages\":[1,2]}],\"expansions\":[]}",SemanticAnswerPacket.class);assertThat(packet.sources().getFirst().pages()).isEqualTo("1-2");}
}
