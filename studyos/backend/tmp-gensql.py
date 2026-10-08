import json, io, subprocess, os

chunks = json.load(io.open("/tmp/chunks.json", encoding="utf-8"))
qs = json.load(io.open("/tmp/questions.json", encoding="utf-8"))

def sq(s):
    return "'" + s.replace("'", "''") + "'"

lines = []
lines.append("DROP TABLE IF EXISTS chunks;")
lines.append("CREATE TABLE chunks (id serial primary key, doc text, page_start int, page_end int, content text, "
             "sv_simple tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content,''))) STORED, "
             "sv_english tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content,''))) STORED);")
for c in chunks:
    lines.append("INSERT INTO chunks(doc,page_start,page_end,content) VALUES(%s,%d,%d,%s);"
                 % (sq(c["doc"]), c["page_start"], c["page_end"], sq(c["content"])))

lines.append("DROP TABLE IF EXISTS q;")
lines.append("CREATE TABLE q (n int, text text);")
for i, qq in enumerate(qs):
    lines.append("INSERT INTO q VALUES(%d,%s);" % (i + 1, sq(qq)))

lines.append(r"""
\pset pager off
\echo === PER-QUESTION LEXICAL ARM (exact SQL from HybridRetriever.lexical, line 32) ===
SELECT q.n,
       (SELECT count(*) FROM chunks c WHERE c.sv_simple  @@ plainto_tsquery('simple',  q.text)) AS rows_simple,
       (SELECT count(*) FROM chunks c WHERE c.sv_english @@ plainto_tsquery('english', q.text)) AS rows_english,
       numnode(plainto_tsquery('simple', q.text)) AS anded_nodes_simple,
       left(q.text,58) AS question
FROM q ORDER BY q.n;

\echo === AGGREGATE: zero-row rate for the lexical arm ===
SELECT count(*) AS total_questions,
       count(*) FILTER (WHERE s = 0) AS zero_rows_simple,
       round(100.0*count(*) FILTER (WHERE s = 0)/count(*),1) AS pct_zero_simple,
       count(*) FILTER (WHERE e = 0) AS zero_rows_english,
       round(100.0*count(*) FILTER (WHERE e = 0)/count(*),1) AS pct_zero_english
FROM (SELECT (SELECT count(*) FROM chunks c WHERE c.sv_simple  @@ plainto_tsquery('simple',  q.text)) AS s,
             (SELECT count(*) FROM chunks c WHERE c.sv_english @@ plainto_tsquery('english', q.text)) AS e
      FROM q) t;

\echo === AGGREGATE: by question length (whitespace words) ===
SELECT bucket, count(*) AS questions, count(*) FILTER (WHERE s=0) AS zero_simple,
       round(100.0*count(*) FILTER (WHERE s=0)/count(*),1) AS pct_zero_simple
FROM (SELECT CASE WHEN array_length(regexp_split_to_array(trim(q.text),'\s+'),1) <= 8 THEN 'a) <=8 words'
                  WHEN array_length(regexp_split_to_array(trim(q.text),'\s+'),1) <= 12 THEN 'b) 9-12 words'
                  ELSE 'c) 13+ words' END AS bucket,
             (SELECT count(*) FROM chunks c WHERE c.sv_simple @@ plainto_tsquery('simple', q.text)) AS s
      FROM q) t GROUP BY bucket ORDER BY bucket;

\echo === stopword tax: fraction of ANDed lexemes that are english stopwords ===
SELECT round(avg(total),2) AS avg_anded_terms_simple,
       round(avg(total-content_terms),2) AS avg_stopword_terms,
       round(100.0*avg((total-content_terms)::numeric/total),1) AS pct_terms_that_are_stopwords
FROM (SELECT numnode(plainto_tsquery('simple',q.text)) AS total,
             coalesce(numnode(plainto_tsquery('english',q.text)),0) AS content_terms FROM q) t;
""")

io.open("/tmp/load.sql", "w", encoding="utf-8").write("\n".join(lines))
print("sql bytes:", os.path.getsize("/tmp/load.sql"), "chunks:", len(chunks), "questions:", len(qs))
