package com.studyos.research;

import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * The bounds of one research run. No stage of research may run unbounded: the planner caps its
 * queries, the searcher caps results per query, the fetcher caps bytes per source, and the whole
 * run caps its total. Defaults are deliberately modest — research is meant to build a starter
 * knowledge base, not to crawl the web.
 */
@Component
public class ResearchProperties {
    private final boolean enabled;
    private final int maxQueries;
    private final int maxSourcesPerQuery;
    private final int maxTotalSources;
    private final long maxBytesPerSource;
    private final long maxTotalBytes;
    private final int maxRedirects;
    private final Duration fetchTimeout;
    private final int cacheDays;
    private final String searchApiUrl;
    private final int maxEnrichmentPasses;

    public ResearchProperties(
            @Value("${studyos.research.enabled:true}") boolean enabled,
            @Value("${studyos.research.max-queries:8}") int maxQueries,
            @Value("${studyos.research.max-sources-per-query:3}") int maxSourcesPerQuery,
            @Value("${studyos.research.max-total-sources:12}") int maxTotalSources,
            @Value("${studyos.research.max-bytes-per-source:524288}") long maxBytesPerSource,
            @Value("${studyos.research.max-total-bytes:6291456}") long maxTotalBytes,
            @Value("${studyos.research.max-redirects:3}") int maxRedirects,
            @Value("${studyos.research.fetch-timeout-seconds:20}") long fetchTimeoutSeconds,
            @Value("${studyos.research.cache-days:14}") int cacheDays,
            @Value("${studyos.research.search-api-url:https://en.wikipedia.org/w/api.php}") String searchApiUrl,
            @Value("${studyos.research.max-enrichment-passes:2}") int maxEnrichmentPasses) {
        this.enabled = enabled;
        this.maxQueries = Math.max(1, maxQueries);
        this.maxSourcesPerQuery = Math.max(1, maxSourcesPerQuery);
        this.maxTotalSources = Math.max(1, maxTotalSources);
        this.maxBytesPerSource = Math.max(4096, maxBytesPerSource);
        this.maxTotalBytes = Math.max(maxBytesPerSource, maxTotalBytes);
        this.maxRedirects = Math.max(0, maxRedirects);
        this.fetchTimeout = Duration.ofSeconds(Math.max(1, fetchTimeoutSeconds));
        this.cacheDays = Math.max(0, cacheDays);
        this.searchApiUrl = searchApiUrl;
        this.maxEnrichmentPasses = Math.max(1, maxEnrichmentPasses);
    }

    public boolean enabled() { return enabled; }
    public int maxQueries() { return maxQueries; }
    public int maxSourcesPerQuery() { return maxSourcesPerQuery; }
    public int maxTotalSources() { return maxTotalSources; }
    public long maxBytesPerSource() { return maxBytesPerSource; }
    public long maxTotalBytes() { return maxTotalBytes; }
    public int maxRedirects() { return maxRedirects; }
    public Duration fetchTimeout() { return fetchTimeout; }
    /** How old a fetched source may be before a re-run considers fetching it again. Zero disables reuse. */
    public int cacheDays() { return cacheDays; }
    public String searchApiUrl() { return searchApiUrl; }
    /**
     * How many completed research runs a gap may drive before enrichment stops. Without this bound,
     * a gap → research → new topic → new gap cycle never ends.
     */
    public int maxEnrichmentPasses() { return maxEnrichmentPasses; }
}
