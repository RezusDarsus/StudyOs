package com.studyos;

import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

@Configuration
@EnableAsync
public class IngestionAsyncConfig {
    @Bean(name = "ingestionExecutor")
    public Executor ingestionExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(1);
        executor.setMaxPoolSize(2);
        executor.setQueueCapacity(50);
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.setThreadNamePrefix("studyos-ingestion-");
        executor.initialize();
        return executor;
    }

    /**
     * The research runner's own thread. It orchestrates a whole run and then waits for the ingestion
     * jobs it submitted to finish; on the ingestion executor it would hold that executor's only core
     * thread while the very jobs it waits for sit queued behind it. A separate single thread keeps
     * the orchestration off the ingestion path entirely.
     */
    @Bean(name = "researchExecutor")
    public Executor researchExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(1);
        executor.setMaxPoolSize(1);
        executor.setQueueCapacity(5);
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.setThreadNamePrefix("studyos-research-");
        executor.initialize();
        return executor;
    }
}
