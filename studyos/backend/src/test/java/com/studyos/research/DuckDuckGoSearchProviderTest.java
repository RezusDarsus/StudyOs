package com.studyos.research;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

class DuckDuckGoSearchProviderTest {

    private static final String FIXTURE = """
            <html><body>
            <div class="result">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.spring.io%2Fspring-security%2Freference%2F&amp;rut=abc">Spring Security Reference</a>
            <a class="result__snippet" href="#">Official documentation on authentication and authorization.</a>
            </div>
            <div class="result">
            <a rel="nofollow" class="result__a" href="https://spring.io/guides/topicals/spring-security-architecture">Spring Security Architecture</a>
            <a class="result__snippet" href="#">A guide to the architecture.</a>
            </div>
            </body></html>
            """;

    @Test
    void parsesResultsAndUnwrapsRedirectTargets() {
        SafeFetchClient fetcher = Mockito.mock(SafeFetchClient.class);
        when(fetcher.fetch(anyString(), Mockito.any(SafeFetchClient.Kind.class)))
                .thenReturn(new SafeFetchClient.Fetched("https://html.duckduckgo.com/html/?q=x", "https://html.duckduckgo.com/html/?q=x", "text/html", FIXTURE.getBytes(), 200));
        var provider = new DuckDuckGoSearchProvider(fetcher);
        var page = provider.search(new ResearchSearchProvider.ResearchQuery("spring security reference", 5));
        assertThat(page.results()).hasSize(2);
        assertThat(page.results().get(0).url()).isEqualTo("https://docs.spring.io/spring-security/reference/");
        assertThat(page.results().get(0).title()).isEqualTo("Spring Security Reference");
        assertThat(page.results().get(0).snippet()).contains("authentication");
        assertThat(page.results().get(1).url()).isEqualTo("https://spring.io/guides/topicals/spring-security-architecture");
        assertThat(page.results()).allSatisfy(result -> assertThat(result.provider()).isEqualTo("DUCKDUCKGO"));
    }

    @Test
    void respectsMaxResultsBound() {
        SafeFetchClient fetcher = Mockito.mock(SafeFetchClient.class);
        when(fetcher.fetch(anyString(), Mockito.any(SafeFetchClient.Kind.class)))
                .thenReturn(new SafeFetchClient.Fetched("u", "u", "text/html", FIXTURE.getBytes(), 200));
        var provider = new DuckDuckGoSearchProvider(fetcher);
        var page = provider.search(new ResearchSearchProvider.ResearchQuery("spring security", 1));
        assertThat(page.results()).hasSize(1);
    }

    @Test
    void emptyOrBlockedPageYieldsNoResults() {
        SafeFetchClient fetcher = Mockito.mock(SafeFetchClient.class);
        when(fetcher.fetch(anyString(), Mockito.any(SafeFetchClient.Kind.class)))
                .thenReturn(new SafeFetchClient.Fetched("u", "u", "text/html", "<html><body>Anomaly detected</body></html>".getBytes(), 200));
        var provider = new DuckDuckGoSearchProvider(fetcher);
        var page = provider.search(new ResearchSearchProvider.ResearchQuery("anything", 5));
        assertThat(page.results()).isEmpty();
    }

    @Test
    void providerKeepsItsBoundaryName() {
        var provider = new DuckDuckGoSearchProvider(Mockito.mock(SafeFetchClient.class));
        assertThat(provider.name()).isEqualTo("DUCKDUCKGO");
    }

    @Test
    void wikipediaProviderTagsItsResults() {
        WikipediaSearchProvider provider = new WikipediaSearchProvider(Mockito.mock(SafeFetchClient.class), Mockito.mock(ResearchProperties.class));
        assertThat(provider.name()).isEqualTo("WIKIPEDIA");
    }
}
