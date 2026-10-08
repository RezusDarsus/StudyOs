package com.studyos.verify;

import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Writes and reads the provenance record {@link ClaimProvenance} decides.
 *
 * <p>All of the deciding is in the pure class; this does the I/O and one translation — from the passages retrieval
 * assembled to the passages the classifier judges against. That translation is the point at which the chunk ids
 * become trustworthy: they come from {@link com.studyos.retrieval.PassageAssembler.Passage#chunkIds()}, which is
 * StudyOS's own record of what it put in the prompt, so nothing a model said about which chunk it read can reach
 * these tables.
 *
 * <p>A failure here must not lose the turn. The answer is already written and already sent; provenance is a record
 * about it, and an answer the learner never receives because bookkeeping about it failed is a worse outcome than a
 * missing row. So recording logs and returns rather than throwing.
 */
@Service
public class ClaimProvenanceService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(ClaimProvenanceService.class);

    private final JdbcTemplate jdbc;

    public ClaimProvenanceService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /**
     * Records what one assistant turn asserted and what it rested on.
     *
     * @param supplied the passages this answer was written from, or null when the answer was not written from a
     *     block this service can see — a turn whose profile retrieves nothing, or a generated-exercise turn that
     *     resolves its own closed source scope. The header row is still written, with the counts absent, because
     *     "not measured" is a fact about the turn and dropping the row entirely would make it indistinguishable
     *     from a turn that was never attempted.
     */
    public ClaimProvenance.Ledger record(UUID courseId, UUID chatId, UUID messageId, String intent, String answer, List<com.studyos.retrieval.PassageAssembler.Passage> supplied) {
        ClaimProvenance.Ledger ledger = supplied == null ? ClaimProvenance.Ledger.unmeasured() : ClaimProvenance.of(answer, supplied.stream().map(ClaimProvenanceService::asSupplied).toList());
        try { persist(courseId, chatId, messageId, intent, ledger); }
        catch (RuntimeException error) { log.warn("Could not record answer provenance for message {}: {}", messageId, error.toString()); }
        return ledger;
    }

    private void persist(UUID courseId, UUID chatId, UUID messageId, String intent, ClaimProvenance.Ledger ledger) {
        boolean measured = ledger.measured();
        jdbc.update("INSERT INTO answer_provenance(message_id,course_id,chat_id,intent,passages_supplied,chunks_supplied,claims_classified,claims_source,claims_derived,claims_external,claims_unjudged,claims_about_learner) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (message_id) DO NOTHING",
                messageId, courseId, chatId, intent,
                measured ? ledger.passagesSupplied() : null, measured ? ledger.chunksSupplied() : null,
                measured ? ledger.classified() : null,
                measured ? (int) ledger.count(ClaimProvenance.Origin.SOURCE) : null,
                measured ? (int) ledger.count(ClaimProvenance.Origin.DERIVED) : null,
                measured ? (int) ledger.count(ClaimProvenance.Origin.EXTERNAL) : null,
                measured ? ledger.unjudged() : null, measured ? ledger.aboutLearner() : null);
        for (ClaimProvenance.Claim claim : ledger.claims()) {
            UUID claimId = UUID.randomUUID();
            // A support figure of -1 is the classifier saying it could not measure one, and it is stored as absent
            // rather than as a number, so no average taken over this column can be dragged down by a non-figure.
            Double support = claim.support() == ClaimProvenance.UNMEASURED ? null : claim.support();
            jdbc.update("INSERT INTO answer_claims(id,message_id,course_id,ordinal,claim,provenance_class,cited,support) VALUES(?,?,?,?,?,?,?,?)",
                    claimId, messageId, courseId, claim.ordinal(), claim.text(), claim.origin().name(), claim.cited(), support);
            for (ClaimProvenance.EvidenceLink link : claim.evidence())
                jdbc.update("INSERT INTO claim_evidence(id,claim_id,chunk_id,document_id,document_name,section_path,page_start,page_end,link_type) VALUES(?,?,?,?,?,?,?,?,?)",
                        UUID.randomUUID(), claimId, link.chunkId(), link.documentId(), link.documentName(), link.sectionPath().isBlank() ? null : link.sectionPath(), link.pageStart(), link.pageEnd(), link.linkType().name());
        }
    }

    private static ClaimProvenance.SuppliedPassage asSupplied(com.studyos.retrieval.PassageAssembler.Passage passage) {
        return new ClaimProvenance.SuppliedPassage(passage.documentId(), passage.documentName(), passage.sectionPath(), passage.pageStart(), passage.pageEnd(), passage.content(), passage.chunkIds());
    }

    /**
     * One answer's provenance as stored, for a reader that wants to see where a reply came from. Absent counts
     * stay absent: a turn whose evidence was never checkable reads as unmeasured rather than as ungrounded.
     */
    public View view(UUID courseId, UUID messageId) {
        Header header = jdbc.query("SELECT intent,passages_supplied,chunks_supplied,claims_classified,claims_source,claims_derived,claims_external,claims_unjudged,claims_about_learner,created_at FROM answer_provenance WHERE course_id=? AND message_id=?",
                rs -> rs.next() ? new Header(rs.getString("intent"), (Integer) rs.getObject("passages_supplied"), (Integer) rs.getObject("chunks_supplied"), (Integer) rs.getObject("claims_classified"), (Integer) rs.getObject("claims_source"), (Integer) rs.getObject("claims_derived"), (Integer) rs.getObject("claims_external"), (Integer) rs.getObject("claims_unjudged"), (Integer) rs.getObject("claims_about_learner"), rs.getTimestamp("created_at")) : null,
                courseId, messageId);
        if (header == null) return new View(null, List.of());
        List<StoredClaim> claims = jdbc.query("SELECT id,ordinal,claim,provenance_class,cited,support FROM answer_claims WHERE course_id=? AND message_id=? ORDER BY ordinal",
                (rs, row) -> new StoredClaim(rs.getObject("id", UUID.class), rs.getInt("ordinal"), rs.getString("claim"), rs.getString("provenance_class"), rs.getBoolean("cited"), (Double) rs.getObject("support"), List.of()),
                courseId, messageId);
        List<StoredClaim> withEvidence = claims.stream().map(claim -> new StoredClaim(claim.id(), claim.ordinal(), claim.claim(), claim.provenanceClass(), claim.cited(), claim.support(), evidence(claim.id()))).toList();
        return new View(header, withEvidence);
    }

    private List<StoredEvidence> evidence(UUID claimId) {
        return jdbc.query("SELECT chunk_id,document_id,document_name,section_path,page_start,page_end,link_type FROM claim_evidence WHERE claim_id=? ORDER BY link_type,page_start,page_end",
                (rs, row) -> new StoredEvidence(rs.getObject("chunk_id", UUID.class), rs.getObject("document_id", UUID.class), rs.getString("document_name"), rs.getString("section_path"), (Integer) rs.getObject("page_start"), (Integer) rs.getObject("page_end"), rs.getString("link_type")), claimId);
    }

    /** Null counts mean the turn's provenance was not measurable, which is different from having measured none. */
    public record Header(String intent, Integer passagesSupplied, Integer chunksSupplied, Integer claimsClassified, Integer claimsSource, Integer claimsDerived, Integer claimsExternal, Integer claimsUnjudged, Integer claimsAboutLearner, java.sql.Timestamp createdAt) {}
    /** @param chunkId null once the chunk has been re-ingested under a new id; the pages beside it still locate it. */
    public record StoredEvidence(UUID chunkId, UUID documentId, String documentName, String sectionPath, Integer pageStart, Integer pageEnd, String linkType) {}
    public record StoredClaim(UUID id, int ordinal, String claim, String provenanceClass, boolean cited, Double support, List<StoredEvidence> evidence) {}
    /** @param header null when nothing was recorded for that message — an answer written before provenance existed. */
    public record View(Header header, List<StoredClaim> claims) {}
}
