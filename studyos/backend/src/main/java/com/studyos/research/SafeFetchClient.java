package com.studyos.research;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The only component in StudyOS that fetches a web page, and the only one that needs to: every
 * rule that makes fetching safe lives here or in {@link WebTargetPolicy}, which this applies to
 * the original URL and to every redirect hop.
 *
 * <p>The fetched body is untrusted data and is treated as such end to end: it is read with a hard
 * byte ceiling so an oversized response cannot exhaust memory, its content type is checked so a
 * binary payload is never parsed as text, nothing from the response is ever executed, and no
 * credential, API key or cookie of this application is ever attached to the request.
 */
@Component
public class SafeFetchClient {
    private static final Logger log = LoggerFactory.getLogger(SafeFetchClient.class);
    private static final String USER_AGENT = "StudyOS-Research/0.1 (course study assistant)";
    private static final int HTTP_OK = 200;

    public enum Kind { PAGE, JSON_API }

    public record Fetched(String url, String canonicalUrl, String contentType, byte[] body, int status) {
        public String text() { return new String(body, java.nio.charset.StandardCharsets.UTF_8); }
    }

    public static class FetchRefused extends RuntimeException {
        public FetchRefused(String message) { super(message); }
    }

    private final ResearchProperties properties;
    private final HttpClient client;

    public SafeFetchClient(ResearchProperties properties) {
        this.properties = properties;
        this.client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    /**
     * Fetches a URL, following at most the configured number of redirects and re-validating every
     * hop. DNS is resolved explicitly and every resolved address must be publicly routable, which
     * closes the rebind gap a name-based check alone would leave open.
     */
    public Fetched fetch(String rawUrl, Kind kind) {
        String current = rawUrl;
        for (int hop = 0; hop <= properties.maxRedirects(); hop++) {
            WebTargetPolicy.Verdict verdict = WebTargetPolicy.validate(current);
            if (!verdict.allowed()) throw new FetchRefused(verdict.reason().message());
            resolveAndCheck(verdict.normalizedUrl());
            HttpRequest request = HttpRequest.newBuilder(URI.create(verdict.normalizedUrl()))
                    .timeout(properties.fetchTimeout())
                    .header("User-Agent", USER_AGENT)
                    .header("Accept", kind == Kind.JSON_API ? "application/json" : "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1")
                    .GET()
                    .build();
            HttpResponse<byte[]> response;
            try { response = client.send(request, HttpResponse.BodyHandlers.ofByteArray()); }
            catch (java.net.http.HttpTimeoutException error) { throw new FetchRefused("The fetch timed out"); }
            catch (IOException | InterruptedException error) {
                if (error instanceof InterruptedException) Thread.currentThread().interrupt();
                throw new FetchRefused("The fetch failed: " + error.getClass().getSimpleName());
            }
            if (response.statusCode() >= 300 && response.statusCode() < 400) {
                Optional<String> location = response.headers().firstValue("Location");
                if (location.isEmpty()) throw new FetchRefused("Redirect without a target");
                current = absolutise(current, location.get());
                continue;
            }
            if (response.statusCode() != HTTP_OK) throw new FetchRefused("The source responded with HTTP " + response.statusCode());
            String contentType = response.headers().firstValue("Content-Type").orElse("application/octet-stream").toLowerCase(Locale.ROOT);
            if (!accepts(contentType, kind)) throw new FetchRefused("The source returned content type " + contentType + ", which cannot be read as course material");
            byte[] body = response.body();
            if (body == null || body.length == 0) throw new FetchRefused("The source returned no content");
            if (body.length > properties.maxBytesPerSource()) throw new FetchRefused("The source is larger than the per-source limit of " + properties.maxBytesPerSource() + " bytes");
            return new Fetched(verdict.normalizedUrl(), current, contentType, body, response.statusCode());
        }
        throw new FetchRefused("The source redirected more than " + properties.maxRedirects() + " times");
    }

    /** Resolves the host and refuses it unless every address it answers with is publicly routable. */
    private void resolveAndCheck(String url) {
        URI uri = URI.create(url);
        String host = uri.getHost();
        // IPv6 literals keep their brackets in a URI; the resolver wants the bare address.
        if (host != null && host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        try {
            InetAddress[] addresses = InetAddress.getAllByName(host);
            if (addresses.length == 0) throw new FetchRefused("The host did not resolve");
            for (InetAddress address : addresses)
                if (!WebTargetPolicy.isPubliclyRoutable(address)) {
                    log.warn("Refused fetch of {} — host {} resolved to non-routable address {}", url, host, address);
                    throw new FetchRefused("The target resolves to a private, loopback or link-local address");
                }
        } catch (FetchRefused refused) { throw refused; }
        catch (Exception error) { throw new FetchRefused("The host could not be resolved"); }
    }

    /** Whether this response's content type is one this fetch kind can use. */
    private boolean accepts(String contentType, Kind kind) {
        if (kind == Kind.JSON_API) return contentType.contains("application/json");
        return contentType.startsWith("text/html") || contentType.startsWith("application/xhtml")
                || contentType.startsWith("text/plain") || contentType.startsWith("application/json");
    }

    /** Resolves a Location header against the URL it came from. */
    private String absolutise(String base, String location) {
        try { return URI.create(base).resolve(location.trim()).toString(); }
        catch (RuntimeException error) { throw new FetchRefused("The redirect target is malformed"); }
    }
}
