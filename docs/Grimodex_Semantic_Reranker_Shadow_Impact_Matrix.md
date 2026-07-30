# Semantic Reranker Shadow Integration — Impact Matrix

## Scope and invariant

Gate 2 promoted the following fixed configurations to a development-only
shadow integration:

- Japanese: `hotchpotch/japanese-reranker-xsmall-v2`, top 30.
- English: `cross-encoder/ms-marco-MiniLM-L4-v2`, top 30.

The shadow path is observational. It must not change the candidate set,
admission thresholds, final prompt, or current chat-send latency. Impact Review
is outside this change.

## Boundary matrix

| Boundary                             | Input                                                                                  | Output                                                    | Owner                                       | Failure / stale behavior                                                                         | Validation evidence                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Chat context → Semantic Recall       | Immutable request id, workspace generation, project id, user message, scene tail       | Current injected chunks                                   | renderer context planner                    | Existing empty fallback remains authoritative; only real `send` requests may enqueue shadow work | `sceneContextSource.test.ts`, `semanticRecall.test.ts` |
| Semantic Recall → shadow coordinator | Frozen dense top 30, sparse ranks, existing admitted chunks, language, immutable scope | Fire-and-forget job                                       | renderer                                    | Disabled unless dev flag is explicit; suppressed during reindex                                  | `semanticRerankerShadow.test.ts`                       |
| Shadow coordinator → Electron IPC    | Query parts and candidate text for scoring only                                        | Scores, hashes, token/truncation counters, native latency | typed preload invoke contract               | One active job; latest pending job wins; old scope/generation is discarded                       | `ipcContract.test.ts`, coordinator tests               |
| Electron IPC → N-API                 | Validated score request, max 30 candidates                                             | JSON wire result                                          | `electron/shared/ipcContract.ts`            | Missing/old native method is an explicit IPC error                                               | Electron contract tests                                |
| N-API → shared Rust reranker         | Pinned language model, pair inputs, batch size 4, max 512 tokens                       | One finite logit and token counters per candidate         | `grimodex-semantic`                         | Model or checksum failure rejects only the shadow job                                            | Rust unit/integration tests, N-API check               |
| Shadow coordinator → comparison log  | IDs, hashes, ranks, scores, token counts, latency; no manuscript text                  | JSONL record                                              | Electron main                               | Main rebuilds a strict safe record and hashes workspace/project/scene identifiers                | `shellCommands.test.ts`                                |
| Workspace/reindex authority          | Workspace key, open revision, project id, query generation                             | Current/stale decision                                    | runtime identity registries + reindex store | Reindex suppresses dispatch; workspace/project/query drift records a drop and never a comparison | coordinator tests, architecture validation             |

## Ownership and rollback

- Existing dense gate, floor, sparse rescue, distinct-scene preference, and
  backfill remain owned by `src/features/chat/semanticRecall.ts`.
- Cross-encoder logits only reorder the frozen pool. They are never compared
  with cosine thresholds and never become an admission threshold.
- The current selection is returned before the deferred shadow job starts.
- Counterfactual IDs are persisted but never inserted into a prompt.
- The default rollback is the absence of
  `VITE_SEMANTIC_RERANKER_SHADOW=1`; no database migration or durable product
  setting is introduced.
- The model artifacts remain local experiment resources and are not added to
  packaged application resources by this change.

## Shadow exit evidence

The JSONL schema retains enough metadata to compute:

- baseline versus reranked scene order;
- baseline versus counterfactual final-three injection order and set changes;
- first-presented chunk changes;
- query/candidate token counts and truncation rates;
- retrieval, queue, IPC/native, and end-to-end latency;
- stale/suppressed/failed job rates;
- model identity, manifest hash, candidate-set hash, and process RSS at record
  time.

Gold inclusion, gold injection position/MRR, candidate-generation misses, and
no-match injection remain label-derived metrics. Private labels stay outside
the repository and join to the log by query and scene hashes.
