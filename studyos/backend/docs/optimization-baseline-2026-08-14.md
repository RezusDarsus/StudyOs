# StudyOS optimization baseline — 2026-08-14

This is the first persisted baseline after provider telemetry became available. It is not a pre-optimization comparison, so it must not be used to claim a total percentage improvement over the original application.

Course: `8b5d52d7-9880-4e79-be68-2b6f9c5eed68`

## Provider telemetry snapshot

- Average input tokens per token-bearing chat call: 6,328.9
- Average output tokens per token-bearing chat call: 902.9
- CHAT requests recorded: 25
- EMBEDDING requests recorded: 77
- Structured calls: 5; successful: 3; failed: 2; repair used: 1
- All completion calls: 10; historical truncations: 2
- Answer-cache eligible requests: 3; hits: 1
- CHAT average latency: 30,457.48 ms; p95: 79,366 ms
- EMBEDDING average latency: 196.19 ms; p95: 506.2 ms
- Estimated cost: unavailable because provider price environment values are not configured

The two structured failures and two truncations are historical calls made before JSON-object mode and explicit non-thinking behavior were enabled; they remain in telemetry intentionally.

## Output-cap evidence

For successful CHAT completions with `finish_reason=stop`, the observed output-token p95 was 1,681.35 and maximum was 2,066 across eight calls. Successful structured calls had p95 1,935.3 and maximum 2,066 across three calls. The general CHAT hard cap is therefore 3,200 tokens, leaving more than 50% margin over the observed structured maximum. Expansion calls keep narrower task-specific caps.

## Retrieval baseline with regressed embedding mode

The 30-case `distributed-systems-retrieval-v1.json` set produced the following while user queries were incorrectly embedded as passages:

| Mode | Recall@5 | Recall@10 | MRR |
|---|---:|---:|---:|
| Lexical | 0.0333 | 0.0333 | 0.0333 |
| Vector | 0.3333 | 0.4333 | 0.1672 |
| Hybrid | 0.4000 | 0.6333 | 0.2024 |

## Corrected retrieval result

After restoring `input_type=query` for searches and preserving the calculated reciprocal-rank-fusion score through reranking, the same 30 cases produced:

| Mode | Recall@5 | Recall@10 | MRR |
|---|---:|---:|---:|
| Lexical | 0.0333 | 0.0333 | 0.0333 |
| Vector | 0.3667 | 0.5333 | 0.1862 |
| Hybrid | 0.4000 | 0.5667 | 0.2261 |

Relative to the regressed run, vector retrieval improved on all three metrics. Hybrid Recall@5 was unchanged and MRR improved, while hybrid Recall@10 decreased. This tradeoff is recorded rather than presented as an across-the-board gain. No retrieval weights were tuned against this evaluation set.

## Model-routing gate

The repository contains 20 fixtures for each internal operation: grading, topic extraction, memory extraction, summary, and assessment extraction. The configured internal model currently equals the primary model, so no cheaper routing is active and no cost or quality gain is claimed. A distinct internal model must pass schema validity, semantic agreement, correctness, latency, token, and cost evaluation before activation.
