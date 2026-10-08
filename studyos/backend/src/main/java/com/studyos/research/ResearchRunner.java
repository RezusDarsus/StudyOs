package com.studyos.research;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studyos.curriculum.CurriculumService;
import com.studyos.documents.DocumentService;
import com.studyos.ingestion.IngestionService;
import com.studyos.knowledge.TopicObjectiveService;
import com.studyos.knowledge.TopicRelationService;
import com.studyos.storage.FileStorageService;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;

/**
 * Runs one bounded research pass from a goal to ingested, provenance-tagged course material.
 *
 * <p>The pipeline is: plan queries → search → rank candidates → safe fetch → extract text →
 * deduplicate → persist as a course document with its provenance row → ingest through the
 * ordinary pipeline (structure, chunks, embeddings, topics, objectives). Researched material
 * therefore flows through exactly the knowledge base uploaded material does; the only difference
 * is that its origin is recorded, visibly, in {@code research_sources} and in the document's
 * source metadata. Nothing here trusts the web: URLs are validated before every fetch, sizes are
 * capped, and a candidate that fails any check is skipped and counted, never fatal.
 *
 * <p>Every limit comes from {@link ResearchProperties}. There is no unbounded crawl: when the
 * source budget is spent the run stops, and the run row says what it did.
 */
@Component
public class ResearchRunner {
    private static final Logger log = LoggerFactory.getLogger(ResearchRunner.class);
    /** Candidates scoring below this are not worth a slot in the knowledge base. */
    private static final double MIN_QUALITY = .3;
    /** How long the runner waits for ingested documents to finish processing before giving up on them. */
    private static final long INGESTION_WAIT_MILLIS = 1_200_000;
    private static final long INGESTION_POLL_MILLIS = 2_000;

    private final ResearchProperties properties;
    private final ResearchQueryPlanner planner;
    private final SourceRanker ranker;
    private final SafeFetchClient fetcher;
    private final DocumentService documents;
    private final FileStorageService storage;
    private final IngestionService ingestion;
    private final TopicRelationService relations;
    private final TopicObjectiveService objectives;
    private final com.studyos.knowledge.TopicReconciliationService reconciliation;
    private final CurriculumService curricula;
    private final ResearchGoalDecomposer decomposer;
    private final ObjectMapper mapper;
    private final JdbcTemplate jdbc;
    private final org.springframework.transaction.support.TransactionTemplate transaction;
    private final List<ResearchSearchProvider> providers;

    public ResearchRunner(ResearchProperties properties, ResearchQueryPlanner planner, List<ResearchSearchProvider> providers,
                          SourceRanker ranker, SafeFetchClient fetcher, DocumentService documents, FileStorageService storage,
                          IngestionService ingestion, TopicRelationService relations, TopicObjectiveService objectives,
                          com.studyos.knowledge.TopicReconciliationService reconciliation, CurriculumService curricula,
                          ResearchGoalDecomposer decomposer, ObjectMapper mapper, JdbcTemplate jdbc,
                          org.springframework.transaction.PlatformTransactionManager transactionManager) {
        this.properties = properties;
        this.planner = planner;
        this.providers = providers;
        this.ranker = ranker;
        this.fetcher = fetcher;
        this.documents = documents;
        this.storage = storage;
        this.ingestion = ingestion;
        this.relations = relations;
        this.objectives = objectives;
        this.reconciliation = reconciliation;
        this.curricula = curricula;
        this.decomposer = decomposer;
        this.mapper = mapper;
        this.jdbc = jdbc;
        this.transaction = new org.springframework.transaction.support.TransactionTemplate(transactionManager);
    }

    @Async("researchExecutor")
    public void run(UUID courseId, UUID runId, String goal, String mode) {
        markStatus(runId, "RUNNING", null);
        List<String> queries = plannedQueries(courseId, goal);
        jdbc.update("UPDATE research_runs SET planned_queries=? WHERE id=?", queries.size(), runId);
        long bytesSpent = 0;
        int ingested = 0;
        int skipped = 0;
        int failed = 0;
        int candidates = 0;
        int queriesRun = 0;
        List<QueryOutcome> outcomes = new ArrayList<>();
        Set<String> seenUrls = new HashSet<>();
        List<UUID> ingestedDocuments = new ArrayList<>();
        try {
            for (String query : queries) {
                if (ingested >= properties.maxTotalSources() || bytesSpent >= properties.maxTotalBytes()) break;
                QueryOutcome outcome = new QueryOutcome(query);
                List<ResearchSearchProvider.SearchResult> candidatesFromQuery;
                try {
                    candidatesFromQuery = searchAll(query, properties.maxSourcesPerQuery());
                } catch (RuntimeException error) {
                    // One query failing (a provider hiccup, a refused search) does not end the run.
                    log.warn("Research query '{}' failed: {}", query, safeMessage(error));
                    failed++;
                    queriesRun++;
                    outcome.failed++;
                    outcomes.add(outcome);
                    persistOutcomes(runId, outcomes);
                    continue;
                }
                queriesRun++;
                outcome.candidates = candidatesFromQuery.size();
                candidates += candidatesFromQuery.size();
                for (ResearchSearchProvider.SearchResult candidate : rank(candidatesFromQuery, query)) {
                    if (ingested >= properties.maxTotalSources() || bytesSpent >= properties.maxTotalBytes()) break;
                    String canonical = canonicalKey(candidate.url());
                    if (!seenUrls.add(canonical)) { outcome.duplicates++; continue; }
                    // Cache: an already-researched page fetched within the freshness window stays as it is,
                    // whether a chat message or a re-run would otherwise refetch it.
                    Cached cached = cached(courseId, canonical);
                    if (cached != null && fresh(cached)) { skipped++; outcome.cached++; continue; }
                    Ingested ingestedSource;
                    try { ingestedSource = ingest(courseId, runId, candidate, query, mode, cached); }
                    catch (RuntimeException error) {
                        failed++;
                        outcome.failed++;
                        log.warn("Research source {} was refused or unreadable: {}", candidate.url(), safeMessage(error));
                        continue;
                    }
                    if (ingestedSource == null) { skipped++; outcome.skipped++; continue; }
                    ingested++;
                    outcome.ingested++;
                    bytesSpent += ingestedSource.bytes();
                    ingestedDocuments.add(ingestedSource.documentId());
                }
                outcomes.add(outcome);
            }
            jdbc.update("UPDATE research_runs SET queries_run=?,candidates_found=?,sources_ingested=?,sources_skipped=?,sources_failed=?,bytes_fetched=?,status='COMPLETED',completed_at=NOW() WHERE id=?",
                    queriesRun, candidates, ingested, skipped, failed, bytesSpent, runId);
            persistOutcomes(runId, outcomes);
        } catch (RuntimeException error) {
            log.error("Research run {} failed", runId, error);
            jdbc.update("UPDATE research_runs SET status='FAILED',error=?,completed_at=NOW() WHERE id=?", safeMessage(error), runId);
            return;
        }
        // The knowledge base is only settled once every ingested source has been processed, and the
        // relation and objective passes read the whole workspace — so they wait for the documents,
        // then run once, exactly as a topic rebuild does.
        boolean processed = awaitProcessing(ingestedDocuments);
        if (processed) {
            try {
                relations.rebuild(courseId);
                objectives.rebuild(courseId);
                // Freshly researched sources can name known concepts differently; fold duplicates
                // in now, before coverage, curriculum or exam signals read the split identity.
                reconciliation.reconcile(courseId);
            } catch (RuntimeException error) {
                log.warn("Post-research knowledge rebuild incomplete for course {}: {}", courseId, safeMessage(error));
            }
            // A research-only course has nothing else to build from, so its curriculum is generated
            // against the goal the moment the researched knowledge base is ready. Mixed-mode workspaces
            // keep control of when their curriculum is built.
            if (ResearchMode.RESEARCH_ONLY.name().equals(mode)) {
                try { curricula.generate(courseId, goal); }
                catch (RuntimeException error) { log.warn("Curriculum generation after research failed for course {}: {}", courseId, safeMessage(error)); }
            }
        } else {
            log.warn("Research run {} ended before its documents finished processing; knowledge rebuild deferred", runId);
        }
    }

    /**
     * The bounded query plan: decomposition-derived queries first (gap-targeted), then the
     * deterministic aspect templates as backfill, deduplicated and capped at the query budget.
     */
    private List<String> plannedQueries(UUID courseId, String goal) {
        Set<String> seen = new java.util.LinkedHashSet<>();
        List<String> queries = new ArrayList<>();
        try {
            ResearchGoalDecomposer.Decomposition decomposition = decomposer.decompose(courseId, goal);
            for (ResearchGoalDecomposer.ResearchNeed need : decomposition.needs()) {
                for (String query : need.researchQueries()) {
                    if (queries.size() >= properties.maxQueries()) return List.copyOf(queries);
                    if (seen.add(query.toLowerCase(java.util.Locale.ROOT))) queries.add(query);
                }
            }
        } catch (RuntimeException error) {
            log.warn("Goal decomposition failed for course {}; falling back to aspect templates: {}", courseId, safeMessage(error));
        }
        for (String query : planner.plan(goal, properties.maxQueries())) {
            if (queries.size() >= properties.maxQueries()) break;
            if (seen.add(query.toLowerCase(java.util.Locale.ROOT))) queries.add(query);
        }
        return List.copyOf(queries);
    }

    /** Per-query feedback: which queries produced value, and where the budget was wasted. */
    private static final class QueryOutcome {
        final String query;
        int candidates;
        int ingested;
        int skipped;
        int cached;
        int duplicates;
        int failed;
        QueryOutcome(String query) { this.query = query; }
        String query() { return query; }
        double yield() { return candidates == 0 ? 0 : (double) (ingested) / candidates; }
        int candidates() { return candidates; }
        int ingested() { return ingested; }
        int skipped() { return skipped; }
        int cached() { return cached; }
        int duplicates() { return duplicates; }
        int failed() { return failed; }
    }

    private void persistOutcomes(UUID runId, List<QueryOutcome> outcomes) {
        try {
            for (QueryOutcome outcome : outcomes) {
                jdbc.update("INSERT INTO research_query_outcomes(id,run_id,query,candidates,ingested,skipped,cached,duplicates,failed,yield) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        UUID.randomUUID(), runId, outcome.query(), outcome.candidates(), outcome.ingested(), outcome.skipped(), outcome.cached(), outcome.duplicates(), outcome.failed(), outcome.yield());
            }
        } catch (RuntimeException error) {
            log.warn("Research query feedback could not be stored for run {}: {}", runId, safeMessage(error));
        }
    }

    /**
     * Asks every configured provider and interleaves the results so no single vendor dominates the
     * candidate pool. A provider that fails or is unreachable only shrinks the pool — the runner
     * already counts per-query failures, and one blocked provider must not end the run.
     */
    private List<ResearchSearchProvider.SearchResult> searchAll(String query, int maxPerProvider) {
        if (providers.size() == 1) {
            return providers.get(0).search(new ResearchSearchProvider.ResearchQuery(query, maxPerProvider)).results();
        }
        List<List<ResearchSearchProvider.SearchResult>> perProvider = new ArrayList<>();
        for (ResearchSearchProvider candidate : providers) {
            try {
                perProvider.add(candidate.search(new ResearchSearchProvider.ResearchQuery(query, maxPerProvider)).results());
            } catch (RuntimeException error) {
                log.warn("Research provider {} failed for query '{}': {}", candidate.name(), query, safeMessage(error));
            }
        }
        List<ResearchSearchProvider.SearchResult> merged = new ArrayList<>();
        for (int index = 0; index < maxPerProvider; index++) {
            for (List<ResearchSearchProvider.SearchResult> results : perProvider) {
                if (index < results.size()) merged.add(results.get(index));
            }
        }
        return merged;
    }

    /** Ranks one query's candidates best-first, so the source budget is spent on the strongest pages. */
    private List<ResearchSearchProvider.SearchResult> rank(List<ResearchSearchProvider.SearchResult> results, String query) {
        record Ranked(ResearchSearchProvider.SearchResult result, double score) {}
        return results.stream()
                .map(result -> new Ranked(result, ranker.score(result.url(), result.title(), result.snippet(), query).total()))
                .filter(ranked -> ranked.score() >= MIN_QUALITY)
                .sorted((left, right) -> Double.compare(right.score(), left.score()))
                .limit(properties.maxSourcesPerQuery())
                .map(Ranked::result)
                .collect(Collectors.toList());
    }

    private record Ingested(UUID documentId, long bytes) {}

    /** Persists one candidate as a provenance-tagged document and hands it to the ingestion pipeline. */
    private Ingested ingest(UUID courseId, UUID runId, ResearchSearchProvider.SearchResult candidate, String query, String mode, Cached cached) {
        String url = candidate.url();
        // The URL comes from search results and is untrusted input; this is where it is refused if it points anywhere internal.
        SafeFetchClient.Fetched fetched = fetcher.fetch(url, SafeFetchClient.Kind.PAGE);
        String html = fetched.text();
        String title = firstNonBlank(cleanTitle(candidate.title()), cleanTitle(HtmlTextExtractor.title(html)), "Researched source");
        String text = HtmlTextExtractor.text(html);
        if (text.length() < 200) throw new SafeFetchClient.FetchRefused("The page has too little readable text to study from");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        String contentHash = sha256(bytes);
        if (cached != null && cached.contentHash().equals(contentHash)) {
            jdbc.update("UPDATE research_sources SET retrieved_at=NOW(),run_id=? WHERE id=?", runId, cached.id());
            return null; // unchanged page, already ingested: nothing to do
        }
        if (cached != null && cached.documentId() != null) {
            // The page changed since it was last ingested. The new fetch replaces it: the old
            // document's chunks would otherwise stay in the knowledge base as a stale copy of a
            // source the provenance row no longer points at.
            documents.delete(courseId, cached.documentId());
        }
        UUID documentId = UUID.randomUUID();
        String filename = slug(title) + "-" + documentId + ".txt";
        String path;
        try { path = storage.save(courseId, documentId, filename, bytes); }
        catch (Exception error) { throw new SafeFetchClient.FetchRefused("The researched text could not be stored"); }
        Map<String, Object> provenance = new LinkedHashMap<>();
        provenance.put("origin", "RESEARCH");
        provenance.put("url", fetched.url());
        provenance.put("canonicalUrl", fetched.canonicalUrl());
        provenance.put("domain", domain(fetched.canonicalUrl()));
        provenance.put("provider", candidate.provider() == null ? "UNKNOWN" : candidate.provider());
        provenance.put("query", query);
        provenance.put("researchMode", mode);
        provenance.put("contentHash", contentHash);
        provenance.put("retrievedAt", java.time.Instant.now().toString());
        SourceRanker.Score score = ranker.score(fetched.canonicalUrl(), title, text, query);
        provenance.put("qualityScore", score.total());
        provenance.put("qualitySignals", Map.of("authority", score.authority(), "relevance", score.relevance(), "depth", score.depth()));
        // The document row and its provenance row are one fact: they persist together or not at all,
        // so a failure here can never leave an unprocessed document with no recorded origin.
        transaction.executeWithoutResult(status -> {
            jdbc.update("INSERT INTO documents(id,course_id,name,document_type,storage_path,status,processing_stage,processing_progress,content_hash,media_type,source_metadata) VALUES (?,?,?,?,?,?,?,?,?,?,CAST(? AS jsonb))",
                    documentId, courseId, title, "WEB_SOURCE", path, "UPLOADED", "QUEUED", 0, contentHash, "text/plain", json(provenance));
            upsertSource(courseId, runId, documentId, fetched, title, query, contentHash, bytes.length, score, candidate.provider());
        });
        ingestion.process(documentId);
        return new Ingested(documentId, bytes.length);
    }

    /** One row per canonical URL per course: a changed page updates its row instead of shadowing it. */
    private void upsertSource(UUID courseId, UUID runId, UUID documentId, SafeFetchClient.Fetched fetched, String title,
                              String query, String contentHash, int byteSize, SourceRanker.Score score, String providerName) {
        jdbc.update("""
                INSERT INTO research_sources(id,course_id,run_id,document_id,url,canonical_url,domain,title,provider,query,quality_score,quality_signals,content_hash,byte_size,content_type,retrieved_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,CAST(? AS jsonb),?,?,?,NOW())
                ON CONFLICT (course_id, md5(COALESCE(canonical_url, url))) DO UPDATE SET
                    run_id=EXCLUDED.run_id, document_id=EXCLUDED.document_id, url=EXCLUDED.url,
                    canonical_url=EXCLUDED.canonical_url, domain=EXCLUDED.domain, title=EXCLUDED.title,
                    provider=EXCLUDED.provider, query=EXCLUDED.query, quality_score=EXCLUDED.quality_score,
                    quality_signals=EXCLUDED.quality_signals, content_hash=EXCLUDED.content_hash,
                    byte_size=EXCLUDED.byte_size, content_type=EXCLUDED.content_type, retrieved_at=NOW()
                """,
                UUID.randomUUID(), courseId, runId, documentId, fetched.url(), fetched.canonicalUrl(), domain(fetched.canonicalUrl()),
                title, providerName == null ? "UNKNOWN" : providerName, query, score.total(), qualitySignals(score),
                contentHash, byteSize, fetched.contentType());
    }

    private static String qualitySignals(SourceRanker.Score score) {
        return "{\"authority\":" + score.authority() + ",\"relevance\":" + score.relevance() + ",\"depth\":" + score.depth() + ",\"freshness\":" + score.freshness() + "}";
    }

    /** Waits until every ingested document finished processing, or the deadline passes. */
    private boolean awaitProcessing(List<UUID> documentIds) {
        if (documentIds.isEmpty()) return true;
        long deadline = System.currentTimeMillis() + INGESTION_WAIT_MILLIS;
        while (System.currentTimeMillis() < deadline) {
            var pending = documentIds.stream().filter(id -> !finished(id)).toList();
            if (pending.isEmpty()) return true;
            try { Thread.sleep(INGESTION_POLL_MILLIS); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); return false; }
        }
        return documentIds.stream().allMatch(this::finished);
    }

    private boolean finished(UUID documentId) {
        String status = jdbc.query("SELECT status FROM documents WHERE id=?", rs -> rs.next() ? rs.getString(1) : null, documentId);
        return "COMPLETED".equals(status) || "FAILED".equals(status) || "NEEDS_OCR".equals(status);
    }

    private record Cached(UUID id, String contentHash, java.sql.Timestamp retrievedAt, UUID documentId) {}

    private Cached cached(UUID courseId, String canonicalKey) {
        return jdbc.query("SELECT id,content_hash,retrieved_at,document_id FROM research_sources WHERE course_id=? AND md5(COALESCE(canonical_url,url))=?",
                rs -> rs.next() ? new Cached(rs.getObject("id", UUID.class), rs.getString("content_hash"), rs.getTimestamp("retrieved_at"), rs.getObject("document_id", UUID.class)) : null,
                courseId, canonicalKey);
    }

    private boolean fresh(Cached cached) {
        if (properties.cacheDays() <= 0 || cached.retrievedAt() == null) return false;
        return cached.retrievedAt().toInstant().isAfter(java.time.Instant.now().minus(java.time.Duration.ofDays(properties.cacheDays())));
    }

    private void markStatus(UUID runId, String status, String error) {
        jdbc.update("UPDATE research_runs SET status=?,error=? WHERE id=?", status, error, runId);
    }

    /**
     * The deduplication key for a candidate URL: scheme and host are case-insensitive, the path is
     * not — Wikipedia's /wiki/GraalVM and /wiki/graalvm are different pages — and it must fold the
     * URL exactly the way the stored canonical URL was folded, or the cache lookup never hits and
     * every re-run re-ingests the same pages.
     */
    private String canonicalKey(String url) {
        try {
            URI uri = URI.create(url.trim());
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            String key = uri.getScheme().toLowerCase(Locale.ROOT) + "://" + host
                    + (uri.getPath() == null ? "/" : uri.getPath())
                    + (uri.getQuery() == null ? "" : "?" + uri.getQuery());
            return md5(key);
        } catch (RuntimeException error) {
            return md5(url.trim());
        }
    }

    private String domain(String url) {
        try { return java.net.URI.create(url).getHost() == null ? "" : java.net.URI.create(url).getHost(); }
        catch (RuntimeException error) { return ""; }
    }

    private String cleanTitle(String value) {
        return value == null ? "" : value.replaceAll("[\\p{Cntrl}]", " ").replaceAll("\\s+", " ").trim();
    }

    private String slug(String title) {
        String cleaned = title.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        return cleaned.length() > 60 ? cleaned.substring(0, 60) : (cleaned.isEmpty() ? "research" : cleaned);
    }

    private String firstNonBlank(String... values) {
        for (String value : values) if (value != null && !value.isBlank()) return value;
        return "";
    }

    private String sha256(String value) {
        return sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    private String sha256(byte[] value) {
        try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }

    private String json(Object value) {
        try { return mapper.writeValueAsString(value); }
        catch (Exception error) { return "{}"; }
    }

    private String md5(String value) {
        try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception error) { throw new IllegalStateException(error); }
    }

    private String safeMessage(Throwable error) {
        Throwable cause = error;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        String message = cause.getMessage() == null ? cause.getClass().getSimpleName() : cause.getMessage();
        return message.substring(0, Math.min(500, message.length()));
    }
}
