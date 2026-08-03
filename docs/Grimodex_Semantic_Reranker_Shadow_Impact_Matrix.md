# Semantic Reranker Integration — Impact Matrix

## Scope and invariant

Gate 2 promoted the following fixed configurations to an experimental,
project-scoped opt-in integration:

- Japanese: `hotchpotch/japanese-reranker-xsmall-v2`, top 30.
- English: `cross-encoder/ms-marco-MiniLM-L4-v2`, top 30.

The reranker may change only the order of scenes already admitted by the
existing Semantic Recall policy. It must not change the retrieval pool,
admission thresholds, or injection cap. `off` is the default, `shadow` remains
an optional developer diagnostic, and `apply` is used only for real sends when
the project toggle is enabled. Impact Review is outside this change.

## Boundary matrix

| Boundary                             | Input                                                                                  | Output                                                    | Owner                                       | Failure / stale behavior                                                                         | Validation evidence                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Chat context → Semantic Recall       | Immutable request id, workspace generation, project id, user message, scene tail       | Baseline or safely reranked injected chunks               | renderer context planner                    | Only real `send` requests carry a mode; live/preview/copy never apply a reranker                 | `sceneContextSource.test.ts`, `semanticRecall.test.ts` |
| Semantic Recall → apply coordinator  | Frozen dense top 30, sparse ranks, existing admitted chunks, language, immutable scope | Applied order or exact baseline fallback                  | renderer                                    | 2.5s hard timeout; one native lane; busy, errors, reindex, stale scope/query all use baseline    | `semanticRerankerApply.test.ts`                        |
| Semantic Recall → shadow coordinator | Same frozen input                                                                      | Fire-and-forget comparison job                            | renderer                                    | Enabled only by the explicit development flag; never changes injection                           | `semanticRerankerShadow.test.ts`                       |
| Coordinators → Electron IPC          | Query parts and candidate text for scoring only                                        | Scores, hashes, token/truncation counters, native latency | typed preload invoke contract               | A failed/missing model is contained to this optional reorder                                     | `ipcContract.test.ts`, coordinator tests               |
| Electron IPC → N-API                 | Validated score request, max 30 candidates                                             | JSON wire result                                          | `electron/shared/ipcContract.ts`            | Missing/old native method is an explicit IPC error                                               | Electron contract tests                                |
| N-API → shared Rust reranker         | Pinned language model, pair inputs, batch size 4, max 512 tokens                       | One finite logit and token counters per candidate         | `grimodex-semantic`                         | Model or checksum failure rejects only the optional reorder                                      | Rust unit/integration tests, N-API check               |
| Shadow coordinator → comparison log  | IDs, hashes, ranks, scores, token counts, latency; no manuscript text                  | JSONL record                                              | Electron main                               | Main rebuilds a strict safe record and hashes workspace/project/scene identifiers                | `shellCommands.test.ts`                                |
| Workspace/reindex authority          | Workspace key, open revision, project id, query generation                             | Current/stale decision                                    | runtime identity registries + reindex store | Reindex suppresses dispatch; workspace/project/query drift records a drop and never a comparison | coordinator tests, architecture validation             |

## Ownership and rollback

- Existing dense gate, floor, sparse rescue, distinct-scene preference, and
  backfill remain owned by `src/features/chat/semanticRecall.ts`.
- Cross-encoder logits only reorder the frozen pool. They are never compared
  with cosine thresholds and never become an admission threshold.
- In `apply`, the current selection is retained until scoring completes and is
  returned unchanged on timeout, failure, reindex, busy state, or stale
  workspace/query generation.
- In `shadow`, counterfactual IDs are persisted but never inserted into a
  prompt.
- The default rollback is the project setting `ai.semanticReranker=false`.
  The developer shadow can also be removed by omitting
  `VITE_SEMANTIC_RERANKER_SHADOW=1`.
- Release jobs bootstrap the two pinned, checksum-verified model snapshots and
  package only `ja_xsmall` and `en_minilm_l4`.

## Optional diagnostic evidence

The JSONL schema retains enough metadata to compute:

- baseline versus reranked scene order;
- exact dense, current hybrid, and reranker rank for every frozen candidate;
- baseline versus counterfactual final-three injection order and set changes;
- first-presented chunk changes;
- query/candidate token counts and truncation rates;
- retrieval, queue, IPC/native, and end-to-end latency;
- stale/suppressed/failed job rates;
- model identity, manifest hash, candidate-set hash, and process RSS at record
  time.

Gold inclusion, gold injection position/MRR, candidate-generation misses, and
no-match injection remain label-derived metrics. Private labels stay outside
the repository and join to the log by work, query, candidate-set, candidate,
and scene hashes.

The optional research workflow is
`experiments/lfm25-encoder-phase0/SHADOW_CORPUS_PROTOCOL.md`. It pools the
union of dense/current-hybrid/reranker top 10 for four-grade human review,
rejects work leakage between private development and holdout, reports
candidate-generation/conditional-reranker/admission/end-to-end denominators
separately, and fingerprints an optional frozen holdout without retaining
text. These artifacts remain observational evidence. Corpus quantity,
holdout, and slice floors are not product-enablement requirements.
