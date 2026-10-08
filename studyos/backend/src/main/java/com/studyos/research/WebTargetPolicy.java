package com.studyos.research;

import java.net.InetAddress;
import java.net.URI;
import java.util.Locale;
import java.util.Set;

/**
 * Decides whether a web target may be fetched at all, before any network activity happens.
 *
 * <p>Fetched web content is untrusted data, and so is the URL that delivers it: a research query
 * can return, or be redirected to, an address that reaches the machine running StudyOS or its
 * database. This policy is the whole of that defence, and it is deliberately pure — it takes a
 * URL or a resolved address and answers, so every rule here is testable without a network.
 *
 * <p>Three layers, applied to every hop of a redirect chain:
 * <ol>
 *   <li>scheme — only HTTP and HTTPS exist; {@code file}, {@code ftp}, {@code javascript},
 *       {@code data} and everything else are refused before a socket is considered;</li>
 *   <li>host — a literal loopback, link-local or private address is refused, as is any name that
 *       smells like internal infrastructure ({@code localhost} and its sub-names);</li>
 *   <li>resolved address — every address a DNS name resolves to is checked against the same
 *       blocked ranges, so a public name that answers with a private record (DNS rebinding)
 *       cannot smuggle the fetch through.</li>
 * </ol>
 */
public final class WebTargetPolicy {
    private WebTargetPolicy() {}

    private static final Set<String> ALLOWED_SCHEMES = Set.of("http", "https");
    private static final int MAX_URL_LENGTH = 2048;
    private static final Set<Integer> ALLOWED_PORTS = Set.of(80, 443, -1);

    /** Why a target was refused, in words an operator can act on. */
    public enum Reason {
        MALFORMED_URL("The URL is malformed"),
        SCHEME_NOT_ALLOWED("Only HTTP and HTTPS URLs can be fetched"),
        URL_TOO_LONG("The URL is longer than accepted"),
        PORT_NOT_ALLOWED("Only standard web ports are fetched"),
        PRIVATE_ADDRESS("The target resolves to a private, loopback or link-local address"),
        RESOLVED_TO_PRIVATE_ADDRESS("The host resolved only to private, loopback or link-local addresses"),
        INTERNAL_HOST_NAME("The host name refers to internal infrastructure");

        private final String message;
        Reason(String message) { this.message = message; }
        public String message() { return message; }
    }

    /** The verdict for one target. {@link #allowed} carries the URL normalised for storage. */
    public record Verdict(boolean allowed, Reason reason, String normalizedUrl) {}

    /** Validates the URL itself, before and independently of DNS. */
    public static Verdict validate(String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) return refused(Reason.MALFORMED_URL);
        if (rawUrl.length() > MAX_URL_LENGTH) return refused(Reason.URL_TOO_LONG);
        URI uri;
        try { uri = URI.create(rawUrl.trim()); }
        catch (RuntimeException error) { return refused(Reason.MALFORMED_URL); }
        if (uri.getScheme() == null || uri.getHost() == null) return refused(Reason.MALFORMED_URL);
        if (!ALLOWED_SCHEMES.contains(uri.getScheme().toLowerCase(Locale.ROOT))) return refused(Reason.SCHEME_NOT_ALLOWED);
        int port = uri.getPort();
        if (!ALLOWED_PORTS.contains(port)) return refused(Reason.PORT_NOT_ALLOWED);
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        // IPv6 literals arrive from URI with their brackets on; the checks below want the bare address.
        String bareHost = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        if (bareHost.endsWith(".localhost") || bareHost.equals("localhost") || bareHost.equals("localhost.localdomain")) return refused(Reason.INTERNAL_HOST_NAME);
        if (literalAddress(bareHost) != null && !isPubliclyRoutable(literalAddress(bareHost))) return refused(Reason.PRIVATE_ADDRESS);
        String normalized = uri.getScheme().toLowerCase(Locale.ROOT) + "://" + host + (port == -1 ? "" : ":" + port)
                + (uri.getPath() == null ? "/" : uri.getPath()) + (uri.getQuery() == null ? "" : "?" + uri.getQuery())
                + (uri.getFragment() == null ? "" : "#" + uri.getFragment());
        return new Verdict(true, null, normalized);
    }

    /**
     * Validates an address the host resolved to. Applied to every address a DNS answer contains
     * and to every hop of a redirect, so a name that resolves into a private range is caught even
     * when the URL itself looked public.
     */
    public static boolean isPubliclyRoutable(InetAddress address) {
        if (address == null) return false;
        if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress()
                || address.isSiteLocalAddress() || address.isMulticastAddress()) return false;
        if (address.getAddress().length == 16) {
            // IPv4-mapped IPv6, and the whole fc00::/7 unique-local range that isSiteLocalAddress misses.
            byte[] bytes = address.getAddress();
            if ((bytes[0] & 0xff) == 0xfc || (bytes[0] & 0xff) == 0xfd) return false;
            boolean v4mapped = true;
            for (int i = 0; i < 10; i++) if (bytes[i] != 0) { v4mapped = false; break; }
            if (v4mapped && bytes[10] == (byte) 0xff && bytes[11] == (byte) 0xff) {
                byte[] v4 = new byte[] {bytes[12], bytes[13], bytes[14], bytes[15]};
                try { return isPubliclyRoutable(InetAddress.getByAddress(v4)); } catch (Exception ignored) { return false; }
            }
            // The documentation range is not routable either.
            if ((bytes[0] & 0xff) == 0x20 && (bytes[1] & 0xff) == 0x01 && (bytes[2] & 0xff) == 0x0d && (bytes[3] & 0xff) == 0xb8) return false;
        }
        byte[] bytes = address.getAddress();
        if (bytes.length == 4) {
            int first = bytes[0] & 0xff;
            int second = bytes[1] & 0xff;
            // 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16,
            // 198.18/15 (benchmarking), 198.51.100/24, 203.0.113/24, 224/4 and 240/4 are all unreachable
            // or reserved; a fetchable source lives in none of them.
            if (first == 0 || first == 10 || first == 127) return false;
            if (first == 169 && second == 254) return false;
            if (first == 172 && (second >= 16 && second <= 31)) return false;
            if (first == 192 && second == 0) return false;
            if (first == 192 && second == 168) return false;
            if (first == 198 && (second == 18 || second == 19)) return false;
            if (first == 198 && second == 51) return false;
            if (first == 203 && second == 0) return false;
            if (first >= 224) return false;
        }
        return true;
    }

    /** The address when the host is written as a literal, or null when it is a name. */
    private static InetAddress literalAddress(String host) {
        if (!host.matches("[0-9a-fA-F:.]+")) return null;
        try { return InetAddress.getByName(host); } catch (Exception error) { return null; }
    }

    private static Verdict refused(Reason reason) { return new Verdict(false, reason, null); }
}
