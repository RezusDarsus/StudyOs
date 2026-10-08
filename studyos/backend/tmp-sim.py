import re, os, io, glob, json

TARGET_CHARS = 3200  # StructureAwareChunker.java:11

def normalize(text):  # PdfTextExtractor.java:46
    text = text.replace(chr(0), "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

def pages_from_dump(raw):
    parts = re.split(r"=== PAGE (\d+) ===\n", raw)
    out = []
    for i in range(1, len(parts), 2):
        out.append((int(parts[i]), normalize(parts[i + 1])))
    return out

def chunk(pages):
    """Faithful port of StructureAwareChunker.chunk (lines 13-38)."""
    result = []
    buf = []
    buflen = 0
    startPage = 1
    endPage = 1
    ordinal = 0
    for (pageNumber, text) in pages:
        if buflen == 0:
            startPage = pageNumber
        endPage = pageNumber
        for paragraph in re.split(r"\n\s*\n", text):
            clean = paragraph.strip()
            if clean.strip() == "":
                continue
            offset = 0
            while offset < len(clean):
                part = clean[offset:min(offset + TARGET_CHARS, len(clean))]
                if buflen > 0 and buflen + len(part) + 2 > TARGET_CHARS:
                    result.append((ordinal, startPage, endPage, "".join(buf).strip()))
                    ordinal += 1
                    buf = []
                    buflen = 0
                    startPage = pageNumber
                buf.append(part)
                buf.append("\n\n")
                buflen += len(part) + 2
                offset += TARGET_CHARS
    if buflen > 0:
        result.append((ordinal, startPage, endPage, "".join(buf).strip()))
    return result

docs = {}
allchunks = []
for path in sorted(glob.glob("tmp-pdftxt/*.txt")):
    raw = io.open(path, encoding="utf-8", errors="replace").read()
    pages = pages_from_dump(raw)
    if not pages:
        pages = [(1, normalize(raw))]
    name = os.path.basename(path)
    cs = chunk(pages)
    docs[name] = (len(pages), len(cs))
    for (o, ps, pe, c) in cs:
        allchunks.append({"doc": name, "ordinal": o, "page_start": ps, "page_end": pe, "content": c})

print("DOC, pages, chunks")
for k, v in docs.items():
    print("  %-70s pages=%d chunks=%d" % (k[:70], v[0], v[1]))
print("TOTAL chunks:", len(allchunks))
mp = sum(1 for c in allchunks if c["page_end"] > c["page_start"])
print("chunks spanning >1 page: %d / %d = %.1f%%" % (mp, len(allchunks), 100.0 * mp / len(allchunks)))
spans = [c["page_end"] - c["page_start"] + 1 for c in allchunks]
print("max pages in one chunk:", max(spans), " mean:", round(sum(spans) / len(spans), 2))
lens = [len(c["content"]) for c in allchunks]
print("chunk char len: min=%d max=%d mean=%d  (TARGET_CHARS=%d)" % (min(lens), max(lens), sum(lens) / len(lens), TARGET_CHARS))
print("chunks exceeding TARGET_CHARS:", sum(1 for l in lens if l > TARGET_CHARS))
io.open("/tmp/chunks.json", "w", encoding="utf-8").write(json.dumps(allchunks))

# real user questions
t = io.open("reports/postfix-80-2026-08-21-final/full-transcript.md", encoding="utf-8").read()
qs = [q.strip() for q in re.findall(r"^## \d+\. Prompt\s*\n+(.+?)\n", t, re.M)]
io.open("/tmp/questions.json", "w", encoding="utf-8").write(json.dumps(qs))
print("questions:", len(qs))
