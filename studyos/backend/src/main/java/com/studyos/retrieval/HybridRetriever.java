package com.studyos.retrieval;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.*;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class HybridRetriever {
    private final NamedParameterJdbcTemplate jdbc; private final EmbeddingService embeddings; private final RerankerProvider reranker;
    public HybridRetriever(NamedParameterJdbcTemplate jdbc, EmbeddingService embeddings,RerankerProvider reranker) { this.jdbc=jdbc; this.embeddings=embeddings;this.reranker=reranker; }

    public List<RetrievedChunk> retrieve(UUID courseId, String query, int limit) { return debug(courseId, query, limit).selected(); }

    /**
     * Whether a workspace's uploaded material outranks researched web material in the final selection.
     *
     * <p>SOURCE_PLUS_RESEARCH is the one mode where both kinds exist and differ in authority: the
     * learner's own material is primary, and researched pages fill what the uploads do not cover. The
     * preference is a stable partition, not a score penalty — an uploaded passage that matched at all
     * is kept ahead of any external one, while a topic the uploads never mention still surfaces its
     * external matches. RESEARCH_ONLY has nothing to prefer over, and SOURCE_ONLY never holds web
     * material at all, so in both modes the selection is left exactly as ranking produced it.
     */
    static List<RetrievedChunk> preferUploaded(List<RetrievedChunk> selected, boolean preferUploaded) {
        if (!preferUploaded) return selected;
        List<RetrievedChunk> uploaded = selected.stream().filter(chunk -> !chunk.external()).toList();
        List<RetrievedChunk> external = selected.stream().filter(RetrievedChunk::external).toList();
        if (uploaded.isEmpty() || external.isEmpty()) return selected;
        List<RetrievedChunk> result = new ArrayList<>(selected.size());
        result.addAll(uploaded);
        result.addAll(external);
        return List.copyOf(result);
    }

    /**
     * The same retrieval, delivered as passages rather than windows: each hit expanded to its neighbours, the hits
     * within one section consolidated, and the result selected whole against {@code tokenBudget}.
     *
     * <p>Ranking is untouched — this calls {@link #retrieve} and works on what it returns. What changes is only
     * what happens to the chunks afterwards, which is where the evidence block was losing the end of an argument,
     * repeating a section header per chunk, and citing pages whose text the budget had cut off.
     */
    public PassageAssembler.Assembly assemble(UUID courseId, String query, int limit, int tokenBudget) {
        List<RetrievedChunk> matched = retrieve(courseId, query, limit);
        if (matched.isEmpty()) return new PassageAssembler.Assembly(List.of(), 0, 0, 0);
        return PassageAssembler.assemble(candidates(courseId, matched), tokenBudget * 4);
    }

    /**
     * The matched chunks and the rows within {@link PassageAssembler#NEIGHBOUR_RADIUS} of them, one query for all
     * of them. A window per hit rather than one shared ordinal range, so a hit at the start of a long document and
     * one at the end do not drag the whole document in between them.
     */
    private List<PassageAssembler.Candidate> candidates(UUID courseId, List<RetrievedChunk> matched) {
        Map<UUID, Double> scores = new LinkedHashMap<>();
        for (RetrievedChunk chunk : matched) scores.merge(chunk.id(), chunk.score(), Math::max);
        var params = new MapSqlParameterSource().addValue("courseId", courseId);
        StringBuilder windows = new StringBuilder();
        for (int i = 0; i < matched.size(); i++) {
            params.addValue("document" + i, matched.get(i).documentId()).addValue("id" + i, matched.get(i).id());
            if (i > 0) windows.append(" OR ");
            windows.append("(c.document_id=:document").append(i).append(" AND c.ordinal BETWEEN (SELECT ordinal-").append(PassageAssembler.NEIGHBOUR_RADIUS).append(" FROM chunks WHERE id=:id").append(i).append(") AND (SELECT ordinal+").append(PassageAssembler.NEIGHBOUR_RADIUS).append(" FROM chunks WHERE id=:id").append(i).append("))");
        }
        return jdbc.query("SELECT c.id,c.ordinal,c.section_id,s.path AS section_path,c.context_header,c.document_id,d.name,c.page_start,c.page_end,c.content,(d.document_type='WEB_SOURCE' OR COALESCE(d.source_metadata->>'origin','')='RESEARCH') AS external FROM chunks c JOIN documents d ON d.id=c.document_id LEFT JOIN document_sections s ON s.id=c.section_id WHERE c.course_id=:courseId" + SOURCE_ONLY + " AND (" + windows + ") ORDER BY c.document_id,c.ordinal", params, (rs, row) -> {
            UUID id = rs.getObject("id", UUID.class);
            String documentName = rs.getString("name");
            String path = rs.getString("section_path");
            // A document structured before sections were a tree has no stored path, so the trail folded into its
            // chunks' context header is the only record of where the passage sits. Same string, older source.
            String sectionPath = path != null && !path.isBlank() ? path : com.studyos.ingestion.ChunkContext.section(rs.getString("context_header"), documentName);
            Double score = scores.get(id);
            return new PassageAssembler.Candidate(id, rs.getInt("ordinal"), rs.getObject("section_id", UUID.class), sectionPath, rs.getObject("document_id", UUID.class), documentName, rs.getInt("page_start"), rs.getInt("page_end"), rs.getString("content"), score == null ? 0 : score, score != null, rs.getBoolean("external"));
        });
    }

    public RetrievalDebug debug(UUID courseId, String query, int limit) {
        int candidateLimit = 30;
        List<RetrievedChunk> lexical = lexical(courseId, query, candidateLimit);
        List<RetrievedChunk> dense = List.of();
        String vectorError = null;
        try { dense = dense(courseId, embeddings.embed(courseId, null, query), candidateLimit); }
        catch (RuntimeException error) { vectorError = error.getMessage(); }
        List<RetrievedChunk> fused = RankFusion.fuseWithScores(lexical,dense,RetrievedChunk::id).stream().limit(20).map(ranked->withScore(ranked.value(),ranked.score())).toList();
        List<RetrievedChunk> selected = reranker.rerank(query,fused).stream().limit(limit).toList();
        // The workspace's source mode is read once per retrieval: a two-token query on the primary
        // key, and the only place the uploaded-first preference is allowed to reorder anything.
        String mode = jdbc.query("SELECT research_mode FROM courses WHERE id=:courseId", courseParams(courseId), rs -> rs.next() ? rs.getString(1) : null);
        selected = preferUploaded(selected, "SOURCE_PLUS_RESEARCH".equals(mode));
        return new RetrievalDebug(lexical, dense, fused, selected, vectorError);
    }

    private MapSqlParameterSource courseParams(UUID courseId) { return new MapSqlParameterSource().addValue("courseId", courseId); }

    /**
     * Only the student's own material can ground an answer. Lessons StudyOS generated are stored as
     * documents so they can be read again, but retrieving them as evidence would let the system cite
     * itself — and each generation would drift a little further from the course.
     */
    private static final String SOURCE_ONLY = " AND d.document_type<>'GENERATED_LESSON'";
    /**
     * Must stay {@code 'simple'}: {@code chunks.search_vector} is generated with that configuration, and a
     * query parsed under any other one stems its terms into lexemes the stored vector does not contain. It is
     * also the only configuration that treats every language alike, which a course in German needs as much as
     * one in English.
     */
    private static final String TEXT_CONFIG = "'simple'";
    /** Quoted phrases and {@code -exclusions} are honoured, and unparseable input yields an empty query rather than an error. */
    private static final String STRICT_QUERY = "websearch_to_tsquery(" + TEXT_CONFIG + ", :query)";
    /**
     * The same query with its conjunctions relaxed to disjunctions. Every full-text query form in Postgres ANDs
     * bare terms, so a retrieval query built from a turn plus its recent context asks for a chunk containing all
     * forty of its words and matches nothing at all — lexical retrieval silently drops out and the answer rests
     * on the dense half alone. Relaxing happens in the database on an already-parsed query, so no user text is
     * ever concatenated into SQL, and ranking still rewards chunks that match more of the terms.
     */
    private static final String RELAXED_QUERY = "CAST(replace(" + STRICT_QUERY + "::text, ' & ', ' | ') AS tsquery)";
    private static final String EXTERNAL_FLAG = "(d.document_type='WEB_SOURCE' OR COALESCE(d.source_metadata->>'origin','')='RESEARCH') AS external";
    private static final String LEXICAL_SQL = "SELECT c.id,c.content,c.context_header,c.page_start,c.page_end,d.id AS document_id,d.name," + EXTERNAL_FLAG + ",ts_rank_cd(c.search_vector, %1$s) AS score FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.course_id=:courseId AND c.search_vector @@ %1$s" + SOURCE_ONLY + " ORDER BY score DESC LIMIT :limit";

    /**
     * Lexical candidates, strictest first: an exact all-terms match is the better signal when there is one, and
     * the relaxed query only runs when there is not.
     */
    private List<RetrievedChunk> lexical(UUID courseId, String query, int limit) {
        List<RetrievedChunk> strict = lexical(courseId, query, limit, false);
        return strict.isEmpty() ? lexical(courseId, query, limit, true) : strict;
    }

    private List<RetrievedChunk> lexical(UUID courseId, String query, int limit, boolean relaxed) {
        var params = new MapSqlParameterSource().addValue("courseId",courseId).addValue("query",query).addValue("limit",limit);
        return jdbc.query(lexicalSql(relaxed),params,this::map);
    }

    static String lexicalSql(boolean relaxed) { return String.format(LEXICAL_SQL, relaxed ? RELAXED_QUERY : STRICT_QUERY); }
    private List<RetrievedChunk> dense(UUID courseId, float[] vector, int limit) {
        var params = new MapSqlParameterSource().addValue("courseId",courseId).addValue("vector",vectorLiteral(vector)).addValue("limit",limit);
        return jdbc.query("SELECT c.id,c.content,c.context_header,c.page_start,c.page_end,d.id AS document_id,d.name,"+EXTERNAL_FLAG+",(1-(c.embedding <=> CAST(:vector AS vector))) AS score FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.course_id=:courseId AND c.embedding IS NOT NULL"+SOURCE_ONLY+" ORDER BY c.embedding <=> CAST(:vector AS vector) LIMIT :limit",params,this::map);
    }
    private RetrievedChunk map(ResultSet rs,int row) throws SQLException { return new RetrievedChunk(rs.getObject("id",UUID.class),rs.getString("content"),rs.getDouble("score"),rs.getInt("page_start"),rs.getInt("page_end"),rs.getObject("document_id",UUID.class),rs.getString("name"),rs.getString("context_header"),rs.getBoolean("external")); }
    private RetrievedChunk withScore(RetrievedChunk chunk,double score){return new RetrievedChunk(chunk.id(),chunk.content(),score,chunk.pageStart(),chunk.pageEnd(),chunk.documentId(),chunk.documentName(),chunk.contextHeader(),chunk.external());}
    private String vectorLiteral(float[] vector) { return "["+Arrays.stream(toDouble(vector)).mapToObj(Double::toString).collect(Collectors.joining(","))+"]"; }
    private double[] toDouble(float[] values) { double[] result=new double[values.length]; for(int i=0;i<values.length;i++) result[i]=values[i]; return result; }
    /**
     * @param contextHeader the document and section this chunk belongs to, which is indexed and embedded with
     *     it. It is provenance, not source text, so rankers may score against it while {@code content} stays
     *     the only thing an answer quotes.
     */
    public record RetrievedChunk(UUID id,String content,double score,int pageStart,int pageEnd,UUID documentId,String documentName,String contextHeader,boolean external) {
        public RetrievedChunk { contextHeader = contextHeader == null ? "" : contextHeader; }
        /** Callers without a provenance flag treat the chunk as the learner's own material. */
        public RetrievedChunk(UUID id,String content,double score,int pageStart,int pageEnd,UUID documentId,String documentName,String contextHeader) {
            this(id, content, score, pageStart, pageEnd, documentId, documentName, contextHeader, false);
        }
        /** The chunk as retrieval matched it: what it is part of, then what it says. */
        public String contextualContent() { return contextHeader.isBlank() ? content : contextHeader + "\n\n" + content; }
    }
    public record RetrievalDebug(List<RetrievedChunk> lexical,List<RetrievedChunk> vector,List<RetrievedChunk> fused,List<RetrievedChunk> selected,String vectorError) {}
}
