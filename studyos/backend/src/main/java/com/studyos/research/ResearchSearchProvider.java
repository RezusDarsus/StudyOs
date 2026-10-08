package com.studyos.research;

import java.util.List;

/**
 * Where candidate sources come from. The research pipeline is written against this seam, not
 * against any search vendor, so the learning engine neither knows nor cares which provider found
 * a page — that is provenance metadata, recorded on the source row.
 */
public interface ResearchSearchProvider {
    /** A name that identifies the provider on every source row it produces. */
    String name();

    /** One bounded search. Implementations must not page beyond the requested result count. */
    SearchResultPage search(ResearchQuery query);

    /** What the caller asked for, with its bound already applied. */
    record ResearchQuery(String text, int maxResults) {}

    /**
     * One candidate. The URL is untrusted input and is validated again before any fetch. The
     * snippet is the provider's summary, or its full plain text when the provider retrieves
     * content directly — whichever it is, it is untrusted data and stays data.
     */
    record SearchResult(String title, String url, String snippet, String provider) {
        public SearchResult(String title, String url, String snippet) { this(title, url, snippet, null); }
    }

    /**
     * @param results the candidates, best first as the provider ranked them
     * @param truncated whether the provider had more results than the bound allowed
     */
    record SearchResultPage(List<SearchResult> results, boolean truncated) {}
}
