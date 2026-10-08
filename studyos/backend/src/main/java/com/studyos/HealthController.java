package com.studyos;

import java.time.Instant;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
    private final JdbcTemplate jdbc;
    private final String provider;
    public HealthController(JdbcTemplate jdbc, @Value("${studyos.ai.provider:stub}") String provider) { this.jdbc = jdbc; this.provider = provider; }
    @GetMapping("/api/health") public Map<String,Object> health(){return Map.of("status","ok","service","studyos-backend","time",Instant.now().toString());}
    @GetMapping("/api/health/readiness") public ResponseEntity<Map<String,Object>> readiness() {
        boolean database = true;
        try { jdbc.queryForObject("SELECT 1", Integer.class); } catch (Exception ignored) { database = false; }
        boolean aiConfigured = switch (provider.toLowerCase()) { case "nvidia" -> hasEnv("NVIDIA_API_KEY"); case "openai" -> hasEnv("OPENAI_API_KEY"); default -> true; };
        boolean ready = database && aiConfigured;
        Map<String,Object> body = Map.of("status", ready ? "ready" : "not_ready", "database", database ? "up" : "down", "aiProvider", provider, "aiConfiguration", aiConfigured ? "configured" : "missing");
        return ResponseEntity.status(ready ? 200 : 503).body(body);
    }
    private boolean hasEnv(String name) { String value = System.getenv(name); return value != null && !value.isBlank(); }
}
