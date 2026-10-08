package com.studyos.research;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * The default search provider, speaking the MediaWiki search API through the same safe fetcher
 * every other fetch goes through.
 *
 * <p>Wikipedia is the shipped default because it needs no key, answers over HTTPS with JSON, is
 * a recognised educational reference, and exposes full plain-text extracts. One generator query
 * returns the hits together with their complete article text, so the fetched material needs no
 * HTML scraping at all and the per-source byte ceiling applies to the text itself. It is a
 * default, not a monopoly: any other provider plugs in behind {@link ResearchSearchProvider}
 * without the pipeline noticing.
 */
@Component
public class WikipediaSearchProvider implements ResearchSearchProvider {
    private final SafeFetchClient fetcher;
    private final ResearchProperties properties;
    private final ObjectMapper mapper = new ObjectMapper();

    public WikipediaSearchProvider(SafeFetchClient fetcher, ResearchProperties properties) {
        this.fetcher = fetcher;
        this.properties = properties;
    }

    @Override public String name() { return "WIKIPEDIA"; }

    @Override
    public SearchResultPage search(ResearchQuery query) {
        String endpoint = properties.searchApiUrl()
                + "?action=query&format=json&generator=search&gsrlimit=" + Math.max(1, query.maxResults())
                + "&prop=extracts&explaintext=1&gsrsearch=" + java.net.URLEncoder.encode(query.text(), java.nio.charset.StandardCharsets.UTF_8);
        SafeFetchClient.Fetched response = fetcher.fetch(endpoint, SafeFetchClient.Kind.JSON_API);
        JsonNode pages;
        try { pages = mapper.readTree(response.text()).path("query").path("pages"); }
        catch (Exception error) { throw new SafeFetchClient.FetchRefused("The search response was not readable JSON"); }
        String host = java.net.URI.create(properties.searchApiUrl()).getHost();
        String articleBase = host == null ? "https://en.wikipedia.org/wiki/" : "https://" + host.replaceFirst("^www\\.", "") + "/wiki/";
        // The generator answer is a map keyed by page id; the index field restores the search ranking.
        List<JsonNode> ordered = new ArrayList<>();
        pages.forEach(ordered::add);
        ordered.sort(java.util.Comparator.comparingInt(page -> page.path("index").asInt(Integer.MAX_VALUE)));
        List<SearchResult> results = new ArrayList<>();
        for (JsonNode page : ordered) {
            String title = page.path("title").asText("");
            String extract = page.path("extract").asText("");
            if (title.isBlank() || extract.isBlank()) continue;
            String url = articleBase + java.net.URLEncoder.encode(title.replace(' ', '_'), java.nio.charset.StandardCharsets.UTF_8);
            results.add(new SearchResult(title, url, extract, name()));
        }
        return new SearchResultPage(results, ordered.size() >= query.maxResults());
    }
}
