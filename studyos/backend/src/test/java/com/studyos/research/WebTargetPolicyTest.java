package com.studyos.research;

import org.junit.jupiter.api.Test;

import java.net.InetAddress;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The SSRF gate. Every refused target here is a real attack shape: a research query that returns a
 * URL pointing at the machine itself, at the cloud metadata service, or at a scheme that never
 * should have reached the network layer.
 */
class WebTargetPolicyTest {

    @Test
    void ordinaryPublicWebPagesAreAllowed() {
        assertTrue(WebTargetPolicy.validate("https://en.wikipedia.org/wiki/Kubernetes").allowed());
        assertTrue(WebTargetPolicy.validate("http://example.com/docs?tutorial=1#intro").allowed());
    }

    @Test
    void loopbackTargetsAreRefused() {
        assertRefused(WebTargetPolicy.validate("http://localhost/secret"), WebTargetPolicy.Reason.INTERNAL_HOST_NAME);
        assertFalse(WebTargetPolicy.validate("http://localhost:8081/api").allowed());
        assertRefused(WebTargetPolicy.validate("http://127.0.0.1/"), WebTargetPolicy.Reason.PRIVATE_ADDRESS);
        assertFalse(WebTargetPolicy.validate("https://127.0.0.1:5432/").allowed());
        assertRefused(WebTargetPolicy.validate("http://app.localhost/"), WebTargetPolicy.Reason.INTERNAL_HOST_NAME);
    }

    @Test
    void cloudMetadataAndLinkLocalTargetsAreRefused() {
        assertRefused(WebTargetPolicy.validate("http://169.254.169.254/latest/meta-data/"), WebTargetPolicy.Reason.PRIVATE_ADDRESS);
        assertRefused(WebTargetPolicy.validate("http://[::1]/"), WebTargetPolicy.Reason.PRIVATE_ADDRESS);
        assertRefused(WebTargetPolicy.validate("http://[fe80::1]/"), WebTargetPolicy.Reason.PRIVATE_ADDRESS);
    }

    @Test
    void privateNetworkTargetsAreRefused() {
        assertRefused(WebTargetPolicy.validate("http://10.0.0.5/"), WebTargetPolicy.Reason.PRIVATE_ADDRESS);
        assertRefused(WebTargetPolicy.validate("http://192.168.1.1/"), WebTargetPolicy.Reason.PRIVATE_ADDRESS);
        assertRefused(WebTargetPolicy.validate("http://172.16.0.9/"), WebTargetPolicy.Reason.PRIVATE_ADDRESS);
        assertRefused(WebTargetPolicy.validate("http://172.31.255.255/"), WebTargetPolicy.Reason.PRIVATE_ADDRESS);
        assertRefused(WebTargetPolicy.validate("http://[fc00::1]/"), WebTargetPolicy.Reason.PRIVATE_ADDRESS);
    }

    @Test
    void dangerousSchemesAreRefused() {
        // file:// and data:// carry no host, so they are refused as malformed before the scheme check;
        // schemes with a host are refused by name. The refusal itself is the contract.
        assertFalse(WebTargetPolicy.validate("file:///etc/passwd").allowed());
        assertFalse(WebTargetPolicy.validate("data:text/html,hello").allowed());
        assertFalse(WebTargetPolicy.validate("javascript:alert(1)").allowed());
        assertRefused(WebTargetPolicy.validate("ftp://example.com/pub/notes.txt"), WebTargetPolicy.Reason.SCHEME_NOT_ALLOWED);
        assertRefused(WebTargetPolicy.validate("gopher://example.com/"), WebTargetPolicy.Reason.SCHEME_NOT_ALLOWED);
    }

    @Test
    void malformedAndOversizedUrlsAreRefused() {
        assertRefused(WebTargetPolicy.validate(""), WebTargetPolicy.Reason.MALFORMED_URL);
        assertRefused(WebTargetPolicy.validate(null), WebTargetPolicy.Reason.MALFORMED_URL);
        assertRefused(WebTargetPolicy.validate("not a url"), WebTargetPolicy.Reason.MALFORMED_URL);
        assertRefused(WebTargetPolicy.validate("http://example.com/" + "a".repeat(3000)), WebTargetPolicy.Reason.URL_TOO_LONG);
    }

    @Test
    void unusualPortsAreRefusedButStandardOnesPass() {
        // localhost on an odd port is refused for two reasons at once; which one fires first is not
        // the contract — the refusal is.
        assertFalse(WebTargetPolicy.validate("http://localhost:8081/").allowed());
        assertRefused(WebTargetPolicy.validate("http://example.com:8081/"), WebTargetPolicy.Reason.PORT_NOT_ALLOWED);
        assertRefused(WebTargetPolicy.validate("http://example.com:22/"), WebTargetPolicy.Reason.PORT_NOT_ALLOWED);
        assertTrue(WebTargetPolicy.validate("https://example.com:443/").allowed());
        assertTrue(WebTargetPolicy.validate("http://example.com:80/").allowed());
    }

    @Test
    void resolvedPrivateAddressesAreNotRoutable() {
        assertFalse(WebTargetPolicy.isPubliclyRoutable(address("127.0.0.1")));
        assertFalse(WebTargetPolicy.isPubliclyRoutable(address("10.1.2.3")));
        assertFalse(WebTargetPolicy.isPubliclyRoutable(address("169.254.169.254")));
        assertFalse(WebTargetPolicy.isPubliclyRoutable(address("0.0.0.0")));
        assertTrue(WebTargetPolicy.isPubliclyRoutable(address("93.184.216.34")));
    }

    private static InetAddress address(String literal) {
        try { return InetAddress.getByName(literal); }
        catch (Exception error) { throw new AssertionError(error); }
    }

    private static void assertRefused(WebTargetPolicy.Verdict verdict, WebTargetPolicy.Reason reason) {
        assertFalse(verdict.allowed(), "expected refusal, got allowed: " + verdict);
        assertEquals(reason, verdict.reason());
    }
}
