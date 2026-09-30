# NIR-1 first retrieval evaluation

`manifest.json` and `corpus.json` are design expectations fixed before observing
Raw or IR rankings. `freeze.json` records the independent expectation review and
the exact hashes; the manifest's draft status describes the reviewed snapshot.
Never edit those bytes to make a measured candidate pass.

The corpus has 24 positive queries, balanced between semantic and Raw/prose
tasks and Japanese and English. Each language has 22 source scenes. Ten separate
safety scenarios cover eight isolated target-only IR pools and two mixed pools.
These synthetic expectations are not human author measurements or a locked
generalization holdout. Existing reranker and Chronicle evaluation corpora are
not reused.

Run the light contract gate with:

```sh
node --test scripts/quality/nir1-retrieval/contract.test.mjs
node scripts/quality/validate-nir1-retrieval.mjs --require-freeze
```

The local Raw runner requires the exact production ONNX files, a standard
main/preload/Native build receipt and a display. Model acquisition is separate;
the runner performs no downloads or external inference. It copies verified
model/tokenizer bytes only into its own new evaluation profile and leaves
existing application data untouched. The private evaluation profile disables
legacy credential migration and automatic backups.

```sh
NIR1_JA_MODEL=/absolute/path/to/ruri-model_int8.onnx \
NIR1_EN_MODEL=/absolute/path/to/bge-model_int8.onnx \
NIR1_BUILD_RECEIPT=/absolute/path/to/standard-build.json \
xvfb-run -a node scripts/quality/run-nir1-retrieval.mjs \
  --mode raw --output /absolute/path/to/new-evidence-directory
```

`--mode precheck` validates local prerequisites without launching Electron or
executing a model. Missing resources and incomplete measurements produce a
`blocked` receipt and a nonzero exit. `baseline-complete` describes Raw only; it
does not award IR, Graph, Packing, technical product-path or author-value acceptance.

The evaluation renderer imports the actual `fetchRelatedPastScenes`, query
builder, selector, Drizzle reader and preload APIs. It creates each case through
canonical typed project/tree writers in an independent database, with only that
case's S2. Its elapsed query time includes the production Electron IPC and
Native audit/embedding/FTS5/search work. A transparent bootstrap observes IPC
command names and success/error envelopes so production fail-soft catches cannot
turn a failed query into a fast successful baseline. It does not alter handlers,
authority, arguments or returned values. Debounce and rendering time are outside
this retrieval metric.

Each query runs five warmups followed by 30 recorded calls. The runner verifies
the 24-query balanced population before assigning B or D. It retains failures
and verifies Raw membership/order/scores/excerpts remain deterministic. Cold
build trials use five independent Japanese/English corpus pairs; each trial's T
sample is the sum of both language build-to-searchable durations. Loading models,
opening/migrating workspaces and creating source data precede those timers.

Normal Chronicle extraction, current child creation and explicit approval are
required before the hybrid comparison. That setup must follow
`manifest.fixtureGeneration`; semantic seeds in the corpus are expectations,
not authority rows to inject. Hybrid measurement must additionally capture the
real Revision/Index eligibility, Freshness, generation and Evidence bindings,
exercise all ten safety scenarios, and run the predeclared mutation/recovery
workload. A Raw-only receipt cannot stand in for those unimplemented checks.

The current recovery acceptance is `acceptance-policy-v2.json`, approved in
[`nir1-recovery-acceptance/2`](../../docs/plans/nir1-recovery-acceptance-v2.md).
The loader keeps the frozen manifest intact and exposes `effectiveRecovery`
separately: immediate invalidation, responsive opening/editing/search and Raw
availability are mandatory; new IR may rebuild in the background. A two-second
p95 is an improvement target, and 100 trials per class / 400 total are no longer
mandatory gates. The 100-current-revision workload remains a diagnostic fixture.
Restore correctness, progress and failure recovery remain required. Prior failed
or incomplete receipts retain their original criteria and status. This revision
does not change Gold, models, ranking, B/D/T or disclosure boundaries.
