import json, io, re

chunks = json.load(io.open("/tmp/chunks.json", encoding="utf-8"))
qs = json.load(io.open("/tmp/questions.json", encoding="utf-8"))

def sq(s):
    return "'" + s.replace("'", "''") + "'"

# tokens exactly as plainto_tsquery('simple') sees them: postgres default parser on words.
def simple_tokens(q):
    return [t for t in re.findall(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", q.lower()) if t]

lines = [r"\pset pager off"]
lines.append("DROP TABLE IF EXISTS probe;")
lines.append("CREATE TABLE probe (n int, mode text, tsq text);")
for i, q in enumerate(qs):
    toks = simple_tokens(q)
    if not toks:
        continue
    lines.append("INSERT INTO probe VALUES(%d,'A_and_simple',%s);" % (i + 1, sq(" & ".join(toks))))
    lines.append("INSERT INTO probe VALUES(%d,'C_or_simple',%s);" % (i + 1, sq(" | ".join(toks))))

lines.append(r"""
\echo === A: AND over simple tokens (what HybridRetriever actually does) vs C: OR over the same tokens ===
SELECT mode,
       count(*) AS questions,
       count(*) FILTER (WHERE hits = 0) AS zero_row_questions,
       round(100.0*count(*) FILTER (WHERE hits=0)/count(*),1) AS pct_zero,
       round(avg(hits),2) AS avg_rows_returned
FROM (SELECT p.n, p.mode,
             (SELECT count(*) FROM chunks c WHERE c.sv_simple @@ to_tsquery('simple', p.tsq)) AS hits
      FROM probe p) t
GROUP BY mode ORDER BY mode;

\echo === how close does the AND get? max query-terms co-present in a single chunk ===
WITH t AS (
  SELECT p.n,
         array_length(regexp_split_to_array(p.tsq,' & '),1) AS n_terms,
         (SELECT max(m.hit) FROM (
             SELECT c.id, count(*) FILTER (WHERE c.sv_simple @@ to_tsquery('simple', tok)) AS hit
             FROM chunks c, unnest(regexp_split_to_array(p.tsq,' & ')) AS tok
             GROUP BY c.id) m) AS best_terms_present
  FROM probe p WHERE p.mode='A_and_simple')
SELECT round(avg(n_terms),2) AS avg_terms_required_ALL,
       round(avg(best_terms_present),2) AS avg_terms_present_in_BEST_chunk,
       round(avg(best_terms_present::numeric/n_terms)*100,1) AS pct_of_required_terms_the_best_chunk_has,
       count(*) FILTER (WHERE best_terms_present = n_terms) AS questions_where_ALL_terms_co_occur
FROM t;
""")
io.open("/tmp/probe.sql", "w", encoding="utf-8").write("\n".join(lines))
print("wrote probe.sql")

# ---- substring false positives against the REAL corpus, using LexicalRerankerProvider's exact tokenizer
def reranker_terms(query):
    # LexicalRerankerProvider.java:8
    lowered = query.lower()
    lowered = re.sub(r"[^a-z0-9-]", " ", lowered)
    return set(t for t in re.split(r"\s+", lowered) if len(t) >= 3)

corpus_words = {}
for c in chunks:
    for w in re.findall(r"[a-z0-9-]+", c["content"].lower()):
        corpus_words[w] = corpus_words.get(w, 0) + 1

print("\n=== REAL substring false positives (term matches only inside a LARGER word) ===")
found = 0
for i, q in enumerate(qs):
    for term in sorted(reranker_terms(q)):
        if term in corpus_words:
            continue  # appears as a standalone token somewhere -> not purely a false positive
        hosts = sorted({w for w in corpus_words if term in w})
        if hosts:
            nchunks = sum(1 for c in chunks if term in c["content"].lower())
            print("  Q%-3d term=%-12r standalone_token=NO  matches %d/%d chunks  only inside: %s"
                  % (i + 1, term, nchunks, len(chunks), hosts[:6]))
            found += 1
print("total purely-substring-matching query terms found:", found)
