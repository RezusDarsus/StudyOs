package com.studyos.chat;

import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

@RestController
@RequestMapping({"/api/courses/{courseId}/chats", "/api/workspaces/{courseId}/chats"})
public class ChatController {
    private final ChatService chats;
    public ChatController(ChatService chats) { this.chats = chats; }
    @GetMapping public ResponseEntity<java.util.List<ChatService.Chat>> list(@PathVariable UUID courseId) { return ResponseEntity.ok(chats.list(courseId)); }
    /** The purposes a chat can be created with, so a client offers exactly what the router understands. */
    @GetMapping("/purposes") public ResponseEntity<java.util.List<Purpose>> purposes(@PathVariable UUID courseId) { return ResponseEntity.ok(java.util.Arrays.stream(ChatPurpose.values()).filter(purpose->purpose!=ChatPurpose.GENERAL).map(purpose->new Purpose(purpose.name(),purpose.label(),purpose.defaultTitle(),purpose.hint())).toList()); }
    @PostMapping public ResponseEntity<ChatService.Chat> create(@PathVariable UUID courseId, @Valid @RequestBody CreateChat request) { return ResponseEntity.ok(chats.create(courseId, request.title(), ChatPurpose.of(request.purpose()))); }
    @GetMapping("/{chatId}/messages") public ResponseEntity<java.util.List<ChatService.Message>> messages(@PathVariable UUID courseId, @PathVariable UUID chatId) { return ResponseEntity.ok(chats.messages(courseId, chatId)); }
    @PostMapping("/{chatId}/messages") public ResponseEntity<ChatService.ChatReply> message(@PathVariable UUID courseId, @PathVariable UUID chatId, @Valid @RequestBody SendMessage request) { return ResponseEntity.ok(chats.reply(courseId, chatId, request.content())); }
    @PostMapping("/{chatId}/messages/{assistantMessageId}/expansions/{type}") public ResponseEntity<ChatService.ExpansionReply> expansion(@PathVariable UUID courseId,@PathVariable UUID chatId,@PathVariable UUID assistantMessageId,@PathVariable String type){return ResponseEntity.ok(chats.expand(courseId,chatId,assistantMessageId,type));}
    /** Where one answer came from: each claim it made, its class, and the chunks recorded behind it. */
    @GetMapping("/{chatId}/messages/{assistantMessageId}/provenance") public ResponseEntity<com.studyos.verify.ClaimProvenanceService.View> provenance(@PathVariable UUID courseId,@PathVariable UUID chatId,@PathVariable UUID assistantMessageId){return ResponseEntity.ok(chats.provenance(courseId,chatId,assistantMessageId));}
    public record CreateChat(@Size(max=500) String title, @Size(max=40) String purpose) {}
    public record SendMessage(@NotBlank @Size(max=20000) String content) {}
    public record Purpose(String value,String label,String defaultTitle,String hint) {}
}
