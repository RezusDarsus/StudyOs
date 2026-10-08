package com.studyos.research;

import java.util.Locale;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * A retrieval-quality heuristic for candidate sources — and nothing more than that.
 *
 * <p>The score says which candidate is most worth ingesting first: whether the domain has a
 * record of authority, whether the candidate actually matches what was searched, and whether the
 * content has enough of it to be worth a slot in the knowledge base. It does not say the source
 * is true, and nothing downstream may treat it as a truth judgement. Scores are computed
 * deterministically from the URL and the text, so the same candidate always scores the same.
 */
@Component
public class SourceRanker {

    public record Score(double total, double authority, double relevance, double depth, double freshness) {}

    /** Domains whose material is a recognised reference in some field. Matched on the registrable domain. */
    private static final Set<String> AUTHORITATIVE_DOMAINS = Set.of(
            "wikipedia.org", "edu", "ac.uk", "edu.au", "edu.ca", // recognised educational references and institutions
            "ietf.org", "w3.org", "iso.org", "whatwg.org", "rfc-editor.org", // standards bodies
            "arxiv.org", "pmc.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov", // research repositories
            "nist.gov", "noaa.gov", "nasa.gov", "who.int", "un.org", "europa.eu", // government and intergovernmental primary sources
            "britannica.com", "stanford.edu", "plato.stanford.edu", "openstax.org", "khanacademy.org", "mit.edu");

    /** Official project documentation: not neutral references, but exactly what a practical goal needs. */
    private static final Set<String> DOCUMENTATION_DOMAINS = Set.of(
            "spring.io", "oracle.com", "postgresql.org", "junit.org", "docker.com", "python.org",
            "mozilla.org", "kubernetes.io", "go.dev", "golang.org", "rust-lang.org", "kotlinlang.org",
            "hibernate.org", "apache.org", "owasp.org", "redis.io", "mongodb.com", "nodejs.org",
            "jenkins.io", "grpc.io", "devdocs.io", "nuget.org", "docs.rs", "cran.r-project.org");

    public Score score(String url, String title, String content, String query) {
        double authority = authority(url);
        double relevance = relevance(title, content, query);
        double depth = depth(content);
        double freshness = freshness(title, content);
        // Authority leads because retrieval quality is the point of the ranking: a highly relevant
        // page on a spam domain is exactly what this score exists to demote. Freshness is a small
        // nudge, never a substitute for authority or relevance.
        double total = .40 * authority + .30 * relevance + .18 * depth + .12 * freshness;
        return new Score(Math.max(0, Math.min(1, total)), authority, relevance, depth, freshness);
    }

    /** Whether this domain counts as authoritative, and by how much: exact matches beat suffix matches. */
    private double authority(String url) {
        String host = host(url);
        if (host == null) return 0;
        String registrable = registrableDomain(host);
        if (AUTHORITATIVE_DOMAINS.contains(registrable)) return 1;
        for (String known : AUTHORITATIVE_DOMAINS)
            if (registrable.endsWith("." + known)) return .95;
        // Academic and governmental hosts outside the exact table are still preferred over unknowns.
        if (registrable.endsWith(".edu") || registrable.endsWith(".gov") || registrable.endsWith(".ac.uk") || registrable.endsWith(".gov.uk")) return .85;
        // Official project documentation ranks clearly above unknown sites, just below primary references.
        if (DOCUMENTATION_DOMAINS.contains(registrable)) return .8;
        // Documentation hosts of software projects are useful technical references, ranked below primaries.
        String first = host.substring(0, host.indexOf('.'));
        if (first.equals("docs") || first.equals("developer") || first.equals("developers")) return .55;
        return .25;
    }

    /**
     * A weak freshness signal: explicit recent years in title or the head of the content lift the
     * page slightly. It is a heuristic for currency, not a claim about quality.
     */
    private double freshness(String title, String content) {
        String head = (title == null ? "" : title) + " " + (content == null ? "" : content.substring(0, Math.min(content.length(), 2000)));
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("\\b20([1-2]\\d)\\b").matcher(head);
        int newest = -1;
        while (matcher.find() && newest < 0) {
            try {
                int year = 2000 + Integer.parseInt(matcher.group(1));
                if (year >= 2010 && year <= 2035) newest = year;
            } catch (NumberFormatException ignored) {}
        }
        if (newest < 0) return 0;
        return newest >= 2022 ? .8 : newest >= 2018 ? .5 : .25;
    }

    /** How much of what was searched for is actually in the candidate, on folded words. */
    private double relevance(String title, String content, String query) {
        String foldedTitle = fold(title);
        String foldedContent = fold(content);
        String[] terms = fold(query).split("\\s+");
        if (terms.length == 0) return 0;
        double hits = 0;
        for (String term : terms) {
            if (term.length() < 3) continue;
            if (foldedTitle.contains(term)) hits += 1;
            else if (foldedContent.contains(term)) hits += .5;
        }
        return Math.min(1, hits / Math.max(1, terms.length));
    }

    /** A band, not a virtue: very thin and very long pages are both worse to ingest than a solid middle. */
    private double depth(String content) {
        int words = content == null ? 0 : content.split("\\s+").length;
        if (words < 150) return .1;
        if (words < 400) return .6;
        if (words <= 6000) return 1;
        if (words <= 15000) return .8;
        return .6;
    }

    private String host(String url) {
        try {
            String host = java.net.URI.create(url).getHost();
            return host == null ? null : host.toLowerCase(Locale.ROOT);
        } catch (RuntimeException error) { return null; }
    }

    /** The domain that actually registered the name, so en.wikipedia.org and wikipedia.org agree. */
    private String registrableDomain(String host) {
        String[] parts = host.split("\\.");
        if (parts.length <= 2) return host;
        return parts[parts.length - 2] + "." + parts[parts.length - 1];
    }

    private String fold(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}\\s]+", " ").replaceAll("\\s+", " ").trim();
    }
}
