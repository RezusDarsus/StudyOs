package com.studyos.research;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * A general web search provider over DuckDuckGo's HTML endpoint, so practical learning goals can
 * reach official documentation rather than only encyclopedic pages. Requires no API key and goes
 * through the same SSRF-safe fetch client as every other retrieval; the endpoint URL stays inside
 * the provider, and every result URL is still untrusted input re-validated before any fetch.
 *
 * <p>Result pages are parsed with deliberately tolerant extraction: an unparseable or blocked
 * result page returns an empty page, which the runner records as a failed query and moves on from.
 */
@Component
public class DuckDuckGoSearchProvider implements ResearchSearchProvider {
    private static final String ENDPOINT = "https://html.duckduckgo.com/html/?q=";
    private static final Pattern RESULT = Pattern.compile(
            "<a[^>]+class=\"[^\"]*result__a[^\"]*\"[^>]+href=\"([^\"]+)\"[^>]*>(.*?)</a>", Pattern.DOTALL);
    private static final Pattern SNIPPET = Pattern.compile(
            "<a[^>]+class=\"[^\"]*result__snippet[^\"]*\"[^>]*>(.*?)</a>", Pattern.DOTALL);
    private static final Pattern TAG = Pattern.compile("<[^>]+>");
    private static final Pattern REDIRECT = Pattern.compile("[?&]uddg=([^&]+)");

    private final SafeFetchClient fetcher;

    public DuckDuckGoSearchProvider(SafeFetchClient fetcher) { this.fetcher = fetcher; }

    @Override public String name() { return "DUCKDUCKGO"; }

    @Override public SearchResultPage search(ResearchQuery query) {
        String url = ENDPOINT + URLEncoder.encode(query.text(), StandardCharsets.UTF_8);
        SafeFetchClient.Fetched fetched = fetcher.fetch(url, SafeFetchClient.Kind.PAGE);
        String html = fetched.text();
        List<SearchResult> results = new ArrayList<>();
        Matcher anchors = RESULT.matcher(html);
        Matcher snippets = SNIPPET.matcher(html);
        while (anchors.find() && results.size() < query.maxResults()) {
            String target = unwrap(anchors.group(1));
            if (target == null) continue;
            String title = strip(anchors.group(2));
            String snippet = snippets.find() ? strip(snippets.group(1)) : "";
            if (title.isBlank() || target.isBlank()) continue;
            results.add(new SearchResult(title, target, snippet, name()));
        }
        return new SearchResultPage(List.copyOf(results), results.size() >= query.maxResults());
    }

    /** DuckDuckGo wraps results in a redirect link; the real target rides in the uddg parameter. */
    private String unwrap(String href) {
        String decoded = href.replace("&amp;", "&");
        Matcher redirect = REDIRECT.matcher(decoded);
        if (redirect.find()) {
            try {
                return java.net.URLDecoder.decode(redirect.group(1), StandardCharsets.UTF_8);
            } catch (RuntimeException error) {
                return null;
            }
        }
        if (decoded.startsWith("//")) return "https:" + decoded;
        return decoded.startsWith("http") ? decoded : null;
    }

    private String strip(String value) {
        return value == null ? "" : TAG.matcher(value).replaceAll("").trim();
    }
}
