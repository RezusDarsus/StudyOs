package com.studyos.knowledge;

import java.util.Locale;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Single place where a topic name becomes a topic row. Every subsystem that needs a topic — topic
 * extraction, the curriculum graph, the tutor — resolves through here so aliases keep working and
 * one concept never ends up stored twice under two spellings.
 */
@Component
public class TopicRegistry {
    private final JdbcTemplate jdbc;
    public TopicRegistry(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    /** Case, punctuation and spacing folded away, so "Vector Clocks" and "vector-clocks" agree. */
    public static String normalize(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", " ").trim().replaceAll("\\s+", " ");
    }

    /**
     * The safe lexical normalisation applied after exact matching: a regular plural folds to its
     * singular, so "Lamport clocks" and "Lamport clock" resolve to one topic without an alias
     * having to be registered first.
     *
     * <p>The rules are deliberately narrow, because over-merging is worse than a duplicate: only a
     * trailing "s" / "es" on a word longer than three letters folds, and words ending in "ss", "us",
     * "is" or a digit never do — "analysis", "class" and "Riemann sum" (singular already) keep their
     * spellings. Irregular plurals ("matrix"/"matrices") are not attempted here; they belong to an
     * alias, which a human or the extraction layer can register, and which the identity ladder treats
     * before this fallback.
     */
    public static String singularForm(String normalized) {
        if (normalized == null) return "";
        String folded = normalize(normalized);
        if (folded.isBlank()) return folded;
        StringBuilder result = new StringBuilder();
        for (String word : folded.split(" ")) {
            if (result.length() > 0) result.append(' ');
            result.append(singularWord(word));
        }
        return result.toString();
    }

    private static String singularWord(String word) {
        if (word.length() <= 3 || !word.endsWith("s")) return word;
        if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
        if (word.length() > 4 && word.endsWith("ies")) return word.substring(0, word.length() - 3) + "y";
        if (word.length() > 4 && (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes") || word.endsWith("ches") || word.endsWith("shes"))) return word.substring(0, word.length() - 2);
        return word.substring(0, word.length() - 1);
    }

    /** The existing topic for this name or alias, or null when the workspace has never seen it. */
    public UUID find(UUID courseId, String name) {
        String normalized = normalize(name);
        if (normalized.isBlank()) return null;
        UUID exact = jdbc.query("SELECT id FROM topics WHERE course_id=? AND normalized_name=? UNION SELECT topic_id AS id FROM topic_aliases WHERE course_id=? AND normalized_alias=? LIMIT 1",
                rs -> rs.next() ? rs.getObject("id", UUID.class) : null, courseId, normalized, courseId, normalized);
        if (exact != null) return canonical(courseId, exact);
        // Safe lexical fallback: the same noun in its singular form, matched only when the exact
        // spelling has never been seen. A plural never shadows a distinct topic that owns the
        // singular spelling — the exact match above always wins when both exist.
        String singular = singularForm(normalized);
        if (singular.equals(normalized) || singular.isBlank()) return null;
        UUID folded = jdbc.query("SELECT id FROM topics WHERE course_id=? AND normalized_name=? UNION SELECT topic_id AS id FROM topic_aliases WHERE course_id=? AND normalized_alias=? LIMIT 1",
                rs -> rs.next() ? rs.getObject("id", UUID.class) : null, courseId, singular, courseId, singular);
        return folded == null ? null : canonical(courseId, folded);
    }

    /**
     * Follows a merge redirect to the canonical topic. Merged rows keep their names for audit, so a
     * stored reference to a folded-away topic must resolve to what replaced it. Chains converge in a
     * bounded number of hops; a defensive cap keeps a malformed redirect loop from hanging a request.
     */
    public UUID canonical(UUID courseId, UUID topicId) {
        UUID current = topicId;
        for (int hop = 0; hop < 5 && current != null; hop++) {
            UUID target = jdbc.query("SELECT canonical_topic_id FROM topics WHERE id=? AND course_id=?", rs -> rs.next() ? rs.getObject(1, UUID.class) : null, current, courseId);
            if (target == null) return current;
            current = target;
        }
        return current;
    }

    /** Resolves the name to a topic, creating one when this is the first time it appears. */
    public UUID resolveOrCreate(UUID courseId, String name, String description) {
        String normalized = normalize(name);
        if (normalized.isBlank()) return null;
        UUID existing = find(courseId, name);
        if (existing != null) {
            if (description != null && !description.isBlank())
                jdbc.update("UPDATE topics SET description=COALESCE(description,?) WHERE id=?", description, existing);
            // The spelling this caller used becomes an alias when it differs from the stored name, so
            // the alternate form resolves exactly from now on and the lexical fallback never runs for it.
            String storedName = jdbc.query("SELECT normalized_name FROM topics WHERE id=?", rs -> rs.next() ? rs.getString(1) : null, existing);
            if (storedName != null && !storedName.equals(normalized)) alias(courseId, existing, name);
            return existing;
        }
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO topics(id,course_id,canonical_name,normalized_name,description) VALUES(?,?,?,?,?) ON CONFLICT(course_id,normalized_name) DO NOTHING",
                id, courseId, name.trim(), normalized, description);
        UUID stored = find(courseId, name);
        return stored == null ? id : stored;
    }

    /** Records an alternative spelling for a topic. Ignores aliases that collide with the name. */
    public void alias(UUID courseId, UUID topicId, String alias) {
        String normalized = normalize(alias);
        if (topicId == null || normalized.isBlank()) return;
        jdbc.update("INSERT INTO topic_aliases(id,course_id,topic_id,alias,normalized_alias) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM topics WHERE course_id=? AND normalized_name=?) ON CONFLICT(course_id,normalized_alias) DO NOTHING",
                UUID.randomUUID(), courseId, topicId, alias.trim(), normalized, courseId, normalized);
    }
}
