package com.studyos;

import org.springframework.context.annotation.Configuration;
import org.springframework.beans.factory.annotation.Value;
import java.nio.file.Path;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;

@Configuration
public class WebConfig implements WebMvcConfigurer {
    private final String uiRoot;
    public WebConfig(@Value("${studyos.ui-root:./}") String uiRoot) { this.uiRoot = uiRoot; }
    @Override public void addCorsMappings(CorsRegistry registry) { registry.addMapping("/api/**").allowedOriginPatterns("http://localhost:*", "http://127.0.0.1:*").allowedMethods("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"); }
    @Override public void addResourceHandlers(ResourceHandlerRegistry registry) { registry.addResourceHandler("/ui/**").addResourceLocations(Path.of(uiRoot).toAbsolutePath().toUri().toString()).setCachePeriod(0); }
}
