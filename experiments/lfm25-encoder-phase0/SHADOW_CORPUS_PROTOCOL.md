# Semantic Recall shadow corpus protocol

## Decision boundary

The public Gate 2 corpus is sufficient for selecting a model for an
observational shadow, but it is not product-enablement evidence.

| Language | Positive queries | No-match queries | Independent works |
| -------- | ---------------: | ---------------: | ----------------: |
| Japanese |               12 |                6 |                 1 |
| English  |               22 |                6 |                 1 |

One Japanese positive query therefore moves a binary metric by 8.33
percentage points, one English positive by 4.55 points, and one no-match query
by 16.67 points. These fixtures have already been used to choose xsmall over
tiny, MiniLM-L4 for English, and top 30 over top 12. Reusing them as a final
test would measure selection fit rather than generalization.

The three corpus roles are fixed:

```text
gate2-public       -> model-selection validation; committed and unchanged
shadow-private-dev -> local investigation and failure analysis
frozen-holdout     -> untouched work-level promotion evidence
```

No quantity or metric produced by this workflow enables the reranker in the
product. The integration remains development-only, asynchronous, and
non-applying.

## Privacy and storage contract

The product comparison log remains:

```text
~/.grimodex/logs/semantic-reranker-shadow.jsonl
```

It contains hashes, ranks, scores, token/truncation counters, model identity,
memory, and latency. It never contains a user message, scene tail, candidate
text, scene title, workspace path, project ID, or manuscript text.

Private labels contain only:

- privacy hashes for a project, human-assigned work family, query, candidate
  set, candidate, and scene;
- dense, current hybrid, and reranker ranks;
- standardized slice tags and no-match type;
- a human relevance grade.

Within this experiment, private label files and holdout locks must stay under
`data/private/`, which is ignored by Git. Generated aggregate reports must stay
under `artifacts/` or `data/private/`. The management CLI rejects an attempted
private output elsewhere inside the experiment.

The CLI does not reconstruct or export manuscript text. Human review must
inspect the corresponding local workspace or an explicit local replay in
memory, then enter only hashes and labels. Candidate ranks and scene hashes in
the template provide the correlation keys. This is intentionally a corpus
contract, not an automatic labeller.

## Query and judgment contract

Each completed shadow query contributes a frozen 30-candidate snapshot. New
logs include an explicit `denseRank` alongside the existing current hybrid and
reranker ranks. Logs created before `denseRank` was added cannot prove the
three-method pool and must be recollected.

The complete human judgment pool for one query is:

```text
dense top 10
union current hybrid top 10
union selected reranker top 10
```

Every candidate in that deduplicated union receives exactly one grade:

| Grade | Meaning                                      |
| ----: | -------------------------------------------- |
|     3 | Directly needed to answer the query          |
|     2 | Useful and relevant                          |
|     1 | Weakly related but not sufficient            |
|     0 | Irrelevant, misleading, or unsupported       |

Grades 2 and 3 count as relevant for binary Recall and injection summaries.
The graded values remain available for a later NDCG report.

A human-verified positive query must name at least one reference scene hash.
The reference scene may be absent from all 30 candidates; that is a valid
candidate-generation miss. A human-verified no-match query must use one of:

```text
out-of-domain
unsupported-in-workspace
```

All pooled candidates for a no-match query must have grade 0.

## Work-level isolation and holdout

The `workHash` is the privacy-safe product/project identity from the shadow
record and remains the join key. The human reviewer must also set
`workFamilyHash` from a stable local identifier for the underlying story.
Copies, exports, restored backups, and derived projects of the same story use
the same family hash even when their `workHash` values differ.

One work family may appear in only one of:

```text
shadow-private-dev
frozen-holdout
```

Queries are never randomly divided across those splits. Both direct project
leakage and derived-project family leakage are rejected. Duplicate query
hashes are also rejected so repeated shadow runs cannot inflate the independent
sample count. A language report also rejects mixed model IDs, revisions, or
manifests; evidence from different model snapshots must be reported separately.

After holdout labels are complete, `freeze-holdout` hashes the canonical
combination of:

- selected model revision and manifest;
- candidate set and all three rankings;
- injection counters and tokenization evidence;
- standardized labels and slices.

The command refuses to overwrite an existing lock. Validation fails if a
label, rank, candidate, model identity, or tokenization record later changes.

## Collection slices

Every verified query needs at least one standardized slice. Common slices are:

- `question-only`
- `short-tail`
- `near-500-char-tail`
- `truncated-512`
- `topic-mismatch`
- `proper-noun-heavy`
- `long-query`

Japanese hard-case slices are:

- `implicit-reference`
- `dialogue-fact`
- `omitted-subject`
- `alias`
- `phase-change`
- `similar-scene`
- `gold-below-dense-10`

English reporting retains:

- `semantic`
- `morphology`
- `lexical-proper-noun`

Hard no-match slices are:

- `hard-no-match`
- `same-name-different-character`
- `similar-event-wrong-target`
- `generic-fiction-overlap`
- `proper-noun-only`
- `scene-tail-distractor`

The template automatically adds `truncated-512` when any candidate pair reports
query or candidate truncation. The human reviewer supplies semantic slices.

## Staged quantity targets

Readiness is reported independently for Japanese and English.

| Stage               | Positive | No-match | Work families | Holdout works | Holdout positive | Holdout no-match | Max one-family share |
| ------------------- | -------: | -------: | ------------: | ------------: | ---------------: | ---------------: | -------------------: |
| Shadow initial      |       50 |       30 |             3 |             0 |                0 |                0 |                  50% |
| Experimental opt-in |      100 |       60 |             4 |             1 |               20 |               10 |                  40% |
| Default candidate   |      200 |      100 |             5 |             2 |               50 |               30 |                  35% |

All counts are per language. These are minimum corpus floors, not statistical
guarantees. The report exposes `quantityReady`, `holdoutReady`, and
`contributionReady` independently. `evidenceReady` requires all three, but
means only that the evidence package is ready for a product decision; it is
not itself a product-enablement verdict.

## Commands

Run commands from `experiments/lfm25-encoder-phase0`.

Create a draft hash-only label file from completed shadow records:

```bash
.venv/bin/python tools/manage_shadow_corpus.py init-labels \
  --shadow-log /absolute/path/to/semantic-reranker-shadow.jsonl \
  --output data/private/shadow-corpus/labels.jsonl \
  --split shadow-private-dev
```

The command refuses to overwrite an existing label file. Edit the private
JSONL locally, set `workFamilyHash`, set `reviewStatus` to `human-verified`,
assign query metadata, and fill every `relevanceGrade`.

Derive `workFamilyHash` without placing the stable local family identifier in
shell history:

```bash
.venv/bin/python tools/manage_shadow_corpus.py hash-work-family
```

Use the same local family identifier for every copy or derived project of one
story. The tool emits only its privacy hash.

When a positive reference scene is outside the candidate union, derive the
same privacy hash used by the product without placing the scene ID in shell
history:

```bash
.venv/bin/python tools/manage_shadow_corpus.py hash-scene-id
```

Paste the local scene ID on stdin and press Enter; the tool emits only its
privacy hash.

Validate the join and write an aggregate-only report:

```bash
.venv/bin/python tools/manage_shadow_corpus.py validate \
  --shadow-log /absolute/path/to/semantic-reranker-shadow.jsonl \
  --labels data/private/shadow-corpus/labels.jsonl \
  --report artifacts/phase0b/shadow-corpus/report.json
```

After holdout review is complete, create the non-overwriting lock:

```bash
.venv/bin/python tools/manage_shadow_corpus.py freeze-holdout \
  --shadow-log /absolute/path/to/semantic-reranker-shadow.jsonl \
  --labels data/private/shadow-corpus/labels.jsonl \
  --output data/private/shadow-corpus/holdout-lock.json
```

Subsequent promotion reports must validate that lock:

```bash
.venv/bin/python tools/manage_shadow_corpus.py validate \
  --shadow-log /absolute/path/to/semantic-reranker-shadow.jsonl \
  --labels data/private/shadow-corpus/labels.jsonl \
  --holdout-lock data/private/shadow-corpus/holdout-lock.json \
  --report artifacts/phase0b/shadow-corpus/report.json
```

## Layered report

The aggregate report deliberately separates:

- candidate generation: reference scene present in the frozen top 30 or miss;
- conditional reranker: Recall@3 only when a reference scene is in the pool;
- end to end: Recall@3 over every positive query;
- admission: relevant injection after the unchanged product admission policy,
  reported with baseline-specific, reranker-specific, and common denominators;
- no-match: baseline and counterfactual any-injection rates.

This prevents an English candidate-generation miss, a reranker ranking miss,
and an admission rejection from being counted as the same failure. The report
contains counts, rates, slice coverage, and stage deficits only. It contains no
source paths or hashed identifiers.
