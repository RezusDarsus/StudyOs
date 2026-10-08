package com.studyos.retrieval;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class HybridRetrieverLexicalSqlTest {
    /**
     * The coupling that silently breaks matching: {@code chunks.search_vector} is generated with the
     * {@code simple} configuration, so a query parsed with any other one stems terms into lexemes the stored
     * vector cannot contain and every lexical search returns nothing.
     */
    @Test void parsesTheQueryWithTheSameConfigurationTheStoredVectorUses() {
        for (boolean relaxed : new boolean[] {false, true}) {
            assertThat(HybridRetriever.lexicalSql(relaxed)).contains("websearch_to_tsquery('simple'");
            assertThat(HybridRetriever.lexicalSql(relaxed)).doesNotContain("'english'").doesNotContain("plainto_tsquery");
        }
    }

    /** A long retrieval query cannot be an all-terms conjunction, or it matches nothing whatsoever. */
    @Test void relaxesConjunctionsToDisjunctionsInsideTheDatabase() {
        assertThat(HybridRetriever.lexicalSql(true)).contains("replace(", "' & '", "' | '", "AS tsquery");
        assertThat(HybridRetriever.lexicalSql(false)).doesNotContain("replace(");
    }

    /** Ranking, filtering, and the generated-lesson exclusion must hold for both forms of the query. */
    @Test void ranksAndFiltersIdenticallyWhicheverQueryFormIsUsed() {
        for (boolean relaxed : new boolean[] {false, true}) {
            String sql = HybridRetriever.lexicalSql(relaxed);
            assertThat(sql).contains("ts_rank_cd(c.search_vector", "c.search_vector @@", "c.course_id=:courseId",
                    "d.document_type<>'GENERATED_LESSON'", "ORDER BY score DESC LIMIT :limit");
            assertThat(sql).contains(":query");
        }
    }

    /** Only bound parameters carry user text; the query itself is never concatenated into the statement. */
    @Test void buildsTheStatementFromLiteralsAlone() {
        for (boolean relaxed : new boolean[] {false, true}) {
            String sql = HybridRetriever.lexicalSql(relaxed);
            assertThat(sql.split(":query", -1)).as("bound once for matching and once for ranking").hasSize(3);
            assertThat(sql).doesNotContain("||");
        }
    }
}
