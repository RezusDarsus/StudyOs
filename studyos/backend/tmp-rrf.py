import json, io, re

qs = json.load(io.open("/tmp/questions.json", encoding="utf-8"))

def reranker_terms(query):  # LexicalRerankerProvider.java:8  -> new HashSet<>(...) so duplicates collapse
    lowered = re.sub(r"[^a-z0-9-]", " ", query.lower())
    return set(t for t in re.split(r"\s+", lowered) if len(t) >= 3)

K = 60
N = 30
r1, r30 = 1.0 / (K + 1), 1.0 / (K + N)
print("RRF_K=%d, candidateLimit=%d  (HybridRetriever.java:19, RankFusion.java:8)" % (K, N))
print("  per-list contribution 1/(60+i+1): rank1=%.8f ... rank30=%.8f" % (r1, r30))
print()
print("CASE 1 - both arms non-empty (nominal 'hybrid'):")
both_max, both_min = 2 * r1, r30
rng_both = both_max - both_min
print("  max fused = 2/61 = %.8f (rank1 in both)   min fused = 1/90 = %.8f" % (both_max, both_min))
print("  FULL RRF SCORE RANGE = %.8f" % rng_both)
print()
print("CASE 2 - lexical arm empty (MEASURED: 80/80 real questions):")
rng_one = r1 - r30
print("  max fused = 1/61 = %.8f   min fused = 1/90 = %.8f" % (r1, r30))
print("  FULL RRF SCORE RANGE = %.8f" % rng_one)
print("  adjacent-rank gap (rank1 vs rank2) = 1/61-1/62 = %.8f" % (1 / 61 - 1 / 62))
print()
print("Overlap term = matches/terms.size(), step per additional matched term = 1/T:")
for T in (4, 10):
    s = 1.0 / T
    print("  T=%2d : step=%.6f   = %6.2fx the CASE-1 range   = %6.2fx the CASE-2 range   = %7.1fx the adjacent-rank gap"
          % (T, s, s / rng_both, s / rng_one, s / (1 / 61 - 1 / 62)))
print()
Tth = 1
while 1.0 / Tth > rng_both:
    Tth += 1
print("  1/T exceeds the ENTIRE case-1 RRF range for every T <= %d  (1/%d=%.8f > %.8f)" % (Tth - 1, Tth - 1, 1.0 / (Tth - 1), rng_both))
Tth2 = 1
while 1.0 / Tth2 > rng_one:
    Tth2 += 1
print("  1/T exceeds the ENTIRE case-2 RRF range for every T <= %d  (1/%d=%.8f > %.8f)" % (Tth2 - 1, Tth2 - 1, 1.0 / (Tth2 - 1), rng_one))
print()
Ts = [len(reranker_terms(q)) for q in qs]
Ts = [t for t in Ts if t > 0]
print("REAL 80 questions - reranker term-set size T (HashSet, duplicates collapsed):")
print("  min=%d max=%d mean=%.2f median=%d" % (min(Ts), max(Ts), sum(Ts) / len(Ts), sorted(Ts)[len(Ts) // 2]))
print("  step 1/T: min=%.4f max=%.4f mean=%.4f" % (1.0 / max(Ts), 1.0 / min(Ts), sum(1.0 / t for t in Ts) / len(Ts)))
dom_both = sum(1 for t in Ts if 1.0 / t > rng_both)
dom_one = sum(1 for t in Ts if 1.0 / t > rng_one)
print("  questions where ONE extra substring match outranks the ENTIRE fusion range:")
print("    case 1 (both arms):   %d/%d = %.0f%%" % (dom_both, len(Ts), 100.0 * dom_both / len(Ts)))
print("    case 2 (lexical dead): %d/%d = %.0f%%" % (dom_one, len(Ts), 100.0 * dom_one / len(Ts)))
print()
print("Worked example: dense rank 1 (best cosine) vs dense rank 30 (worst), T=7:")
T = 7
best = r1 + 3.0 / T
worst = r30 + 4.0 / T
print("  rank1  chunk, 3/7 terms substring-matched: %.6f + %.6f = %.6f" % (r1, 3.0 / T, best))
print("  rank30 chunk, 4/7 terms substring-matched: %.6f + %.6f = %.6f" % (r30, 4.0 / T, worst))
print("  -> rank30 wins by %.6f ; the reranker promotes the WORST candidate over the BEST." % (worst - best))
