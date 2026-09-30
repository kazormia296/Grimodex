# NIR-1 Related Scenes: approval draft v3

Status: `[precheck]` — draft, awaiting explicit user confirmation. No runtime
activation is authorized by this document. Base inspected:
`cf871087a95e9edcd1d7fa86a4260794ee90c36c` (clean master before this draft).
The user supports the v2 direction and authorizes binding precheck work, but has
NOT approved runtime activation or an independent-review exemption. This revision
is design work only. All proposed
runtime semantics below remain unapproved; existing policies remain unchanged.

## Scope and existing contracts

Connect reviewed Chronicle `scene-event@1` revisions to Related Scenes; preserve
the existing raw-text dense/sparse route and evidence navigation. This is a
partial NIR-1 slice, not completion of the milestone. Exclude Chat, generic graph
traversal, Correction Memory, extraction Gold/judge changes and external APIs.

The roadmap's Reserved Semantic Index section currently prohibits nonzero
metadata, active D1 heads, V1 edges and Consumer Freshness for this consumer.
Activation therefore requires coordinated policy/runtime changes, not merely
embedding rows. ADR 005 and `policies/narrative/retrieval-disclosure.json` require
admission before ranking. Current Related Scenes reading-order filtering alone
does not implement that contract.

## Historical-reference admission (material policy proposal)

Production `chronicleSceneEventAdapter.ts:createScopeBase` stores
`scene: { kind: "exact", ref: sceneRef }`, including for nonsecret events.
`deriveChronicleSceneEventScope` retains that axis for secret events. Existing
`contracts/disclosure.ts:evaluateNarrativeDisclosure` accepts the older Scope
form and rejects a scene mismatch. It is NOT already a Scope V2 retrieval
runtime. An implicit V2-to-legacy conversion cannot solve this conflict.

Propose a dedicated, versioned `historical-reference` purpose for this slice:

1. Preserve the immutable Scope V2 and its digest. Its scene axis still says
   where the event assertion holds. Require `exact(S1)` to match the event's
   validated source/Evidence scene S1; unsupported scene forms are ineligible
   for this initial slice. A multi-scene Evidence set is not silently flattened:
   only a verified Evidence target at S1 can supply this scene's result. This
   target choice is NOT admission of the revision: the whole-material rule below
   must pass before any embedding score or display contribution is permitted.
2. Keep query scene S2 as `currentSceneId` throughout admission. Independently
   require S1 to precede S2 under the existing resolved Related Scenes order.
   The result is a reference to an assertion at S1, never a claim that it holds
   at S2. Return the purpose and assertion scene in provenance.
3. Evaluate disclosure bounds (including secret/reveal and temporal bounds)
   against S2's query context. Preserve all non-scene constraints: viewpoint,
   knowledge holder, audience, Timeline, Worldline and narrative layer. The
   initial slice conservatively rejects unresolved constraints and any secret
   event (`allowSecrets=false`); later secret support requires separate scope.
4. Do not change `exact` to `any`, substitute S1 into the query context, or remove
   `scene-scope-mismatch` from existing proposition-application policy. Existing
   consumers retain that check. A new purpose-specific policy/fixture contract
   must be approved before implementing this different scene comparison.

### Query context authorities and explicit limits

The current fetch reads project ID, active scene, tree and phase-mode stores. It
does not supply the full disclosure context. The following is the proposed
binding, not a claim that all these backend read APIs already exist.

| Field | Proposed authority / resolution | Missing or unsupported value |
| --- | --- | --- |
| Workspace / project / S2 | Active backend workspace binding and persisted scene membership; renderer IDs are requests only | Reject IR query |
| Phase mode / phase resolution | Existing phase-mode preference and ADR 002 resolver over persisted same-project tree/phase data; preserve its `auto` fallback | Unresolved resolution rejects IR; do not manufacture a Phase |
| Reading order / temporal anchor | S2 and source scene in that canonical tree/order snapshot; story-time from persisted temporal data when the resolved axis requires it | Missing required axis rejects; never use S1 as query anchor |
| Audience | Explicit `reader` purpose of this Related Scenes reference view, validated by backend purpose allowlist | No author/all-secrets privilege implied; exact other audience rejected |
| Viewpoint / knowledge holder | Explicit reader-reference context, not a character simulation. No synthetic character ID; use typed `not-applicable` for these two axes in this purpose | Only candidate `any` passes without a resolved matching identity; exact/unresolved rejects |
| Timeline / Worldline / narrative layer | Persisted query-scene context if an existing authoritative binding can be demonstrated | Typed unavailable, not invented default; candidate `any` can pass, constrained/unresolved candidate rejects |
| allowSecrets | Fixed false for this first slice | Secret revisions are ineligible even after reveal in this bounded release |
| Candidate Scope / disclosure | Approved immutable envelope plus canonical decision/Scope-affecting state | Missing or invalid rejects; mutable UI values cannot grant access |

Typed `not-applicable`/unavailable distinctions and acceptance of explicit
candidate `any` are NEW purpose-specific semantics, not a relaxation hidden in
the legacy validator. They require policy approval. Query fields must be
present with explicit resolution states; omitted context never means allow.
If an exact identity cannot be sourced, the candidate stays excluded. This
permits the production nonsecret base Scope (all other axes `any`) to be
referenced without fabricating viewpoint/knowledge/temporal identities.

Mandatory positive: run the standard production Adapter, persist and approve a
nonsecret S1 event, then retrieve it from later S2 with its ORIGINAL `exact(S1)`
Scope and navigate to S1 Evidence. Test-only `any` substitutions do not pass.
Mandatory negatives: the same assertion must not become applicable at S2;
future S1, secret, exact-axis mismatch and unresolved Scope remain excluded.

### Whole-revision disclosure unit

Admission covers ALL semantic information used for scoring or display, not just
the chosen quotation. Verify every Evidence item and all story-bearing inputs
in the transitive recorded production provenance (sourceBasis, model-visible
context manifests, original/merged observations, synthesis and upstream stage
closure). Each must be disclosable to S2. Freshness does not grant disclosure.

For v3, reject the WHOLE revision if any material is future, forbidden, unresolved,
or cannot be traced to a disclosure authority. Do not select S1 Evidence to
sanitize a summary informed by S3, or redact words and reuse the original vector.
Multi-scene material is allowed only when EVERY contributing scene/material can
be verified. Non-Evidence catalog/context inputs need the same proof; a
single-scene Evidence set is not an exemption. An opaque catalog/artifact with
no complete disclosure mapping makes the revision ineligible. Do not create a
new information-propagation inference system for this slice.

Production evidence: `chronicleV2Production.ts:buildDependencyDeclarations`
retains non-Evidence sourceBasis and model-visible context as
`opaque-model-context`; `sceneRefForDocument` chooses the first Evidence scene,
which does not certify other materials' visibility. Adapter
`assertMaterialBasis`/`assertEvidenceProvenance` validate structure and binding,
not query-time disclosure. The indexed serializer's four fields can incorporate
any of those inputs, so checking only their text or first source is insufficient.

Full payload/envelope retention means BACKEND audit storage. Return only admitted
event fields, the chosen admitted Evidence excerpt, review/Freshness labels and
opaque identity references needed for navigation. Do not return full envelopes,
context rosters, forbidden source names or rejection details containing story
text. Backend diagnostics can retain bounded reason codes without exposing that
content. Unknown material coverage must stay observable as IR unavailable, not
be silently counted as a successful empty search.

Required negative: S1 + future S3 Evidence with a sabotage summary has zero
contribution to S2 even when S1 alone is selected for display. Repeat with S3
only in non-Evidence model context. Required production positive must prove full
material coverage, not strip sourceBasis/context to make the test pass. If the
standard producer cannot provide this proof, report a production-path blocker;
do not claim that fail-closed zero results deliver the retrieval slice.

## Eligibility: two consumers, one canonical authority

Eligibility is a conjunction, evaluated against a coherent current snapshot:

```text
current explicitly approved revision (decision ledger; not merely applied)
AND canonical Freshness(project, proposal-revision, revisionId) is fresh
AND the revision's canonical dependency evaluation is current and usable
AND required Evidence exists and matches its recorded source binding
AND revision/envelope/input/model identity and sealed index generation match
AND canonical Freshness(project, semantic-index, indexKey) is fresh and usable
AND historical-reference disclosure admission succeeds for query S2
```

`proposal-revision` uses `narrative_proposal_revisions.id`; do not create a
`narrative-ir-revision` consumer. Both states belong to the existing canonical
`narrative_consumer_freshness` authority/evaluator. Missing/unknown/stale or
pending evaluation/build state is not usable. Epoch/cursor/dependency binding
must establish that no relevant pending changes are being ignored. Index
metadata/timestamps cannot certify either consumer's Freshness.

Verified registry: `proposal-revision-source-basis` maps to
`repository.rs:record_revision_dependency_edges_in_tx` with generation
`proposal-revision-dependency/v1` and validated envelope sourceBasis. The
application-specific `canonical_application_freshness` reader cannot be called
with a revision ID; a properly scoped revision/index reader is needed, using
the same authority validations, not another store.

Reuse the revision's canonical dependency evaluation, including non-Evidence
inputs. Evidence quote equality alone is insufficient. Index rebuilding cannot
refresh, reinterpret or reapprove its source revision. If that revision is
stale, a successfully rebuilt index still must not return it.

Source/writer precheck remains BLOCKING: map every new index declaration to
registered source addresses and mutation writers, including eligibility
changes, Scope changes and restore. The current producer registry has no IR
index producer. Whether revision/decision state requires a newly registered
source or an existing invalidation binding remains unresolved; a consumer ID
must not be presumed to be a registered Source. Resolve this in a reviewed
binding table before activation, without duplicating revision dependency logic.

## Deterministic embedding representation v1

Propose serializer `chronicle-semantic-retrieval/1`: UTF-8 JSON with exactly these
ordered keys: `summary`, `actuality`, `attribution`, `narrativeFrame`. Values come
only from the validated semantic payload inside the approved immutable revision.
Use JSON string escaping, no whitespace formatting, no normalization or mutable
title/note substitution, and no generated query-time summary. Missing or invalid
fields reject the row. This minimal serializer intentionally excludes other
semantic payload fields from embedding text; retain the complete payload and
envelope in backend audit storage, including significance and observation
references. Renderer receives only the admitted projection described above.

Bind serializer version and SHA-256 of exact input bytes, revision ID, envelope
digest, model/version/dimension and generation to the rebuildable cache. Freeze
model tokenizer/truncation settings in evaluation; over-limit representations
are ineligible in v1 rather than silently truncating modality fields. Keep
actuality/attribution/narrativeFrame as structured result fields as well: a dream
or attributed claim must not be displayed as an unqualified actual event.
Projection-only title/note edits do not change the embedding input digest.

## Final scene ranking contract v1

- First run the EXISTING raw selector with its existing limit, thresholds,
  sparse rescue, tie rules, winner anchor and representative excerpt. Call this
  ordered list R (at most 8). Do not retune the raw baseline in this slice.
- IR admission precedes scoring, rank numbering and candidate caps. Collapse
  eligible revisions to one IR entry per Evidence scene using maximum cosine,
  with equal scores resolved by revision ID then Evidence ID. No event-count
  bonus. Sort scenes by that score then scene ID; keep at most 8 as list I.
  Nonfinite scores reject. Use the existing language gateScore as the initial
  IR cosine floor, explicitly an uncalibrated proposal to freeze before eval.
- If I is empty (including failure/rebuild/timeout), return R unchanged in
  membership, order, score and excerpt. No extra raw candidate may enter merely
  because excluded IR was fetched.
- Otherwise fuse R and I by scene ID using equal-weight RRF:
  `sum(1 / (RRF_K + rank0))`, once per list, using the existing RRF_K constant.
  Sort by fusion score descending, raw rank ascending (absent = infinity), IR
  rank ascending (absent = infinity), then scene ID ascending. Cap at 8.
- Preserve the existing confident raw dense winner at position 1 even during
  final fusion, if that winner was actually anchored by the raw selector.
  Carry that explicit flag from selection; do not infer confidence from the
  top raw row. IR can improve positions below it or enter the list; it cannot
  displace this anchor in v1. This limits possible quality gains intentionally.
- A raw+IR scene retains its raw representative excerpt; display eligible IR
  event/Evidence separately. An IR-only scene uses its verified Evidence.
  Revoking IR removes its contribution/provenance and recomputes from R, never
  subtracts from a previously truncated mixed list. Preserve evidence/status
  separately from the fusion score; score is not truth or approval strength.

Within usable sealed generations with the same admitted inputs, forbidden IR
must have zero influence on allowed ranks, slots AND excerpts.
ANN over a forbidden pool followed by filtering top-K does not satisfy this:
the implementation must rank an admitted pool or demonstrate equivalent exact
eligible retrieval. A corpus-wide normalization/statistic including forbidden
rows would also violate this invariant.

RRF is an internal ordering value, never `scene.score * 100` percent. Preserve
raw score separately and use an explicitly discriminated fused result shape
with fusion rank/score and optional raw/IR cosine fields. In the fused UI show
rank; any similarity display must label its raw/IR origin. Raw-only fallback
keeps its existing score/excerpt behavior. The current percent rendering in
`RelatedScenesSection.tsx` must not receive a fusion score.

## Evidence navigation binding (IR only)

Keep workspace/project, original query S2 and context identity, revision ID,
envelope digest, Evidence ID, source kind/key/revision token, quote digest and
normalizer identity attached to the IR request until final position resolution.
The backend reconstructs/revalidates these references; renderer-supplied values
are never authority. Do not reduce the IR request to `{sceneId, chunkText}`.

On click, recheck current approval/current revision, BOTH canonical consumers,
whole-material admission for the original S2, and Evidence/source binding. If
an unrelated UI query/navigation has replaced this request, discard it rather
than substituting a new scene. The request's expected S2→S1 transition is not
cancellation: retain S2 for disclosure and bind selection to its destination S1
editor session using the navigation request ID. A revoked decision rejects
navigation even when the quote is intact.
Use existing `openEditorDocument` for screen transition, but a distinct typed IR
pending request and resolver: do NOT call Raw `findChunkInDoc` for Evidence.

The current Evidence set stores quote/digest and source binding, not a guaranteed
unique editor range. Initial resolver must verify the FULL quote against the
same canonical source revision, then map a unique full match to the current
ProseMirror document with the corresponding normalizer. It must retain identity
while doing so. Recheck editor document/session generation immediately before
selection; unsaved edits or a changed version invalidate the old range. No
prefix matching, first-occurrence choice, heuristic reanchoring or clamped stale
positions may be presented as verified Evidence.

If the range is ambiguous/unmappable but current admission and source validity
remain confirmed, open S1 without a highlight. If a source/approval change has
invalidated eligibility, cancel and refresh instead. After asynchronous checks,
use canonical invalidation notifications and document generation guards to
discard stale requests. Revalidation is snapshot-bound, not a permanent grant.

Tests: identical first 60 characters in different passages; duplicate FULL
quotes; multi-paragraph quotes; source edit after backend revalidation; unsaved
editor change; approval withdrawn with unchanged text; project/query switch.
None may select another passage as verified Evidence. Existing Raw string-jump
behavior is outside this change.

## Index invalidation unit and concrete binding precheck

Choose ONE project-scoped index consumer for v3. Dirty/pending/stale/unknown
index state disables ALL IR for that project until a usable sealed generation
and canonical Freshness are published. Do not serve supposedly unaffected
rows while the consumer is unusable. A change to a query-ineligible row may
therefore temporarily remove otherwise eligible A and return exact Raw R.

Distinguish two guarantees: (1) content invariance for usable generations with
identical admitted inputs; (2) availability during update, which explicitly
permits full IR suspension. Record suspension reason, duration, affected query
count and raw fallback count separately; never count them as IR success. The
single-index granularity does not promise absence of timing/availability signals.

| Binding | Existing authority / writer verified at base | v3 decision and remaining activation work |
| --- | --- | --- |
| Evidence scene Source | `chronicleV2Production.ts:projectSourceKeyForDocument` maps to `project:scene:<nodeId>`; `source_revision.rs:resolve_source_revision` handles `scene-body`, and canonical text revalidation currently supports scene-body | Resolve all Evidence document refs through same-project snapshot origins; require token/digest/normalizer and source disclosure. Unsupported kinds reject |
| Material closure | `buildDependencyDeclarations` emits direct-evidence, opaque-model-context and component-contract dependencies; Adapter envelope binds sourceBasis/context | Walk verified upstream material closure; classify every material with registered authority. Non-story component data needs a versioned allowlist, never a guessed exemption. Catalog/artifact per-material disclosure mapping and its completeness proof remain BLOCKING |
| Revision authority | `repository.rs:record_revision_dependency_edges_in_tx`; canonical proposal-revision consumer | Reuse its canonical evaluator; propagate relevant invalidation to the project index without treating a rebuilt vector as a refreshed revision |
| Eligibility roster / Scope revision | `repository.rs:append_revision_on_conn`, `append_decision_on_conn`, and combined `revise_and_decide` entry points; decisions update proposal status under current-revision guard | Propose registered project-scoped source `nir1-chronicle-eligibility-set` with backend-derived digest of revision/envelope/current-pointer and authoritative decision bindings. This is NEW, not supported by the current source resolver. Add resolver/registry and transactional index invalidation for all owning mutation paths before activation; do not invent an unregistered dependency |
| Freshness changes | `incremental_freshness.rs` publishes canonical evaluation; source resolver supports scene-body, snapshot-document, projection, catalog, scope authority, artifact and Evidence kinds | Index declares the actual registered material inputs plus the proposed eligibility source. Gate on revision Freshness at query time as well. Evaluate and suspend index on affected canonical publications; no second durable revision Freshness store |
| Restore | `backup_restore.rs` calls `ensure_restore_epochs_for_workspace` in `restore_rebuild.rs` for staged DB | Invalidate the entire IR generation before restored workspace is usable. Existing reserved-index manual-terminal behavior remains until an approved declared-producer migration and verification update |
| Publish / read / navigation | Metadata/D1 binding remains the v2 proposal; existing Raw navigation is `sceneChunkJump` → pending store → `EditorPane` → `findChunkInDoc` | Add project index producer and typed identity-preserving IR search/navigation paths after approval; both editor consumption paths must use the IR resolver. Never reuse application-only Freshness reader for revision IDs |

The proposed eligibility source is a rebuildable binding to existing decisions,
not a new approval authority. Producer generation must seal its roster and all
material dependency digests atomically; subsequent source/decision changes must
invalidate that generation before serving. Exact digest schema, source role,
all mutation/undo/restore writer coverage and event publication remain blocking
until reviewed against `change-feed-writers.json`, `protected-writers.json` and
the source resolver. This static trace identifies implementation owners; it does
not falsely certify complete writer coverage or enable that new Source.

## Proposed threat model — user confirmation required

- Trusted: the active workspace binding, backend validation and canonical
  revision, decision, dependency and Freshness authorities. A recorded human
  approval authorizes use of that revision; it does not establish truth.
- Untrusted: scene prose, model-derived summaries, renderer arguments, cached
  vectors/metadata, restored cache state and asynchronous stale responses.
- In scope: cross-project/workspace disclosure, forbidden Scope/knowledge or
  future information, superseded or revoked approval, stale/deleted Evidence,
  generation mismatch, restore/rebuild races, and forged renderer references.
- Out of scope: a compromised OS/backend, arbitrary local DB tampering by an
  administrator, and security redesign of existing raw-text search.
- Mandatory defenses: backend-bound workspace/project checks; explicit resolved
  disclosure admission before scoring; canonical approval/Freshness reads;
  immutable revision/envelope binding; fail closed for IR on unknown/mismatch;
  generation-checked publication; revalidation before returning evidence and
  on navigation. Ineligible IR never contributes score or excerpt.
- Acceptance implication: raw-text search remains usable when IR is unavailable,
  but that fallback does not count as successful IR retrieval. Unknown disclosure
  context can legitimately yield zero IR results and must remain observable.

## Minimal impact matrix / proposed binding

All new names below are proposals, not existing registered identities.

| Flow | Owner / boundary | Contract and invariant | Fallback / verification |
| --- | --- | --- | --- |
| Produce IR vectors | Shared Rust producer `nir1-reviewed-chronicle-v1` | Only current, explicitly accepted pilot revisions with valid Evidence; no ingestion of legacy Event embeddings as IR | No eligible revision means no IR row; accepted/rejected/superseded cases |
| Index identity | Backend metadata and D1 | Project column remains separate; proposed index key `nir1-reviewed-chronicle:v1`; item identity is revision ID plus envelope digest; record embedding model/version and generation | Reject identity/model/dimension mismatch; rebuild derived cache |
| Publish generation | Shared producer and DB transaction | Metadata index key = D1 consumer key = Freshness consumer key; metadata generation = active sealed D1 producer generation; dependency digest = sealed set digest | Partial/pending generation cannot serve; retain no stale eligible view |
| Dependency and invalidation | Existing canonical evaluator | Declare actual Evidence source revisions, decision/revision eligibility and Scope dependencies; model unsupported source identities explicitly before activation | Source edit/delete, decision reversal, Scope edit or restore makes old candidates ineligible; missing source registration blocks implementation |
| Restore / migration | Existing restore and schema machinery | Invalidate IR cache generation after restore; never infer authority from old embedding chunks; activate only this declared producer | Rebuild explicitly; preserve reserved treatment of unrelated producers |
| Candidate admission | Shared Rust → N-API → typed IPC | Implement historical-reference purpose only AFTER its policy approval; preserve Scope V2; query context stays S2; read both canonical consumers | Production exact(S1) positive; future/secret/unresolved negatives |
| Candidate merge | Related Scenes fetch / selector | Use final scene ranking contract v1 above; bounded R/I lists, one contribution per scene/list, explicit raw winner anchor | Excluded IR has zero rank/slot/excerpt influence; exact raw fallback |
| Display and jump | RelatedScenesSection / typed IR pending request / editor resolver | Return admitted fields only; preserve revision/Evidence/source identity to full-quote position resolution; use openEditorDocument for transition | Duplicate quote falls back to scene-only when eligible; source/approval invalidation cancels |
| Refresh / cancellation | Fetch lifecycle | Project/scene changes and canonical invalidation cannot publish stale responses; rebuild is not Freshness proof | Race tests including project switch and edits while results remain open |

Raw route inspected: `fetchRelatedScenes.ts` → `semanticSearch` and
`fetchSparseSceneIds` → `selectRelatedPastScenes` → `RelatedScenesSection.tsx` →
`requestSceneChunkJump` (Raw only). IR navigation must follow the distinct
identity-preserving contract above. Current selector builds its scene pool from dense hits;
merely adding IR IDs to sparse IDs would not introduce IR-only scenes.

Before editing runtime, map the proposed source dependencies to registered
addresses and writers, and resolve the disclosure context supplied by Related
Scenes. Missing axes must not be invented or treated as unrestricted. Any
material deviation from this draft requires reconfirmation.

## Acceptance and evaluation protocol

Connection checks use deterministic vectors/candidate scores and exercise actual
IPC/backend boundaries: approved revision to result to Evidence; duplicate scene;
edited/deleted source; revoked/superseded revision; IR missing or rebuilding;
forbidden higher-scoring candidate; workspace/project switch; restore race.
Also require production exact(S1) retrieval from S2; stale revision plus rebuilt
fresh index stays excluded; Evidence text unchanged but interpretation dependency
or Scope changed; duplicate event revisions do not inflate scene score; IR
revocation restores raw score/order/excerpt; dream/actuality survives display;
forbidden IR additions in usable generations with identical admitted inputs
leave all allowed results unchanged; dirty/pending project index instead causes
observable whole-IR suspension and exact Raw fallback; delayed IR never
overwrites a newer query or blocks raw beyond its separately fixed budget.
These checks establish wiring and state behavior only.

Before running either retrieval variant, commit a small separate retrieval case
manifest containing exact query/source texts, reviewed revisions, eligible
expected scene IDs and graded relevance, query purpose/context and resolution
states, scene order, Scope/disclosure, revision/envelope/decision snapshots,
canonical dependency/Freshness/epoch state, serializer/model settings and ranking
parameters. Hash this manifest before comparative runs. Suggested scenarios: north-gate repair
to earlier collapse/evacuation; paraphrase without shared event wording; similar
wording with irrelevant event; raw-only scene; excluded future/secret event.
These are case outlines, not yet frozen Gold. Do not revise expected scenes
after seeing rankings. Do not edit extraction Gold or its judge.

Compare the same corpus/model/query settings with raw dense+sparse and with IR
added. Proposed thresholds: Recall@8 and nDCG@8 must not regress in the
unweighted macro-average across positive queries; at
least one predeclared IR-benefit case must improve rank; all returned IR evidence
must be valid and violations from IR-derived candidates, score contributions
and displayed information must be zero. This is not a security claim about the
existing raw search. Zero-positive forbidden-information cases are safety
checks, excluded from positive retrieval averages. For positive cases use
Recall@8 = retrieved relevant scene count / eligible relevant scene count,
and nDCG@8 with gain `2^grade - 1`, discount `log2(rank1 + 1)`, normalized by the
ideal eligible ordering. Freeze integer grades before runs. Report top-1 regressions
individually. Measure warm p95 latency, index rebuild time and incremental update
cost separately; propose latency budget from baseline before inspecting IR
results. Also fix an IR wait/deadline budget from raw baseline measurements
before inspecting IR results: raw completion must not wait for IR beyond that
budget; timeout returns exact R, discards late results for that query and is
reported as IR unavailable. Test a hung IR producer with a deterministic clock.
Budget milliseconds remain pending measurement, not implicit infinite wait.
No quality claim until the corpus and budget are fixed and measured. A passing
small corpus demonstrates improvement only for those fixed cases, not general
novel-search quality. A failed comparison is reported, not repaired by changing
expected scenes; algorithm revisions require a new declared comparison.
Use local embedding runtime if available; paid APIs or external data transfer
require a separate necessity/scope proposal and authorization.

## Separate approvals and remaining precheck

1. Design decision pending: historical-reference Scope semantics, typed context
   states, initial nonsecret-only limit, both-consumer eligibility, serializer
   and final fusion rules. No approval is inferred from support for direction.
2. Before runtime activation: resolve the source/writer binding table and exact
   backend context-read/evaluation paths, update the canonical policy contracts
   through the appropriate authoring workflow, and obtain explicit confirmation
   of the resulting threat-model/binding version. Current document is NOT a
   claim that these unresolved implementation mappings are complete.
   V3 fixes the three boundary decisions: whole-material revision admission,
   identity-preserving navigation, and project-wide IR suspension. Remaining
   blockers are material-closure disclosure authority/completeness (including
   a standard production positive), new eligibility-source registration and
   complete transactional writer coverage, and concrete backend context reads.
   Do not weaken these to enable otherwise ineligible existing revisions.
3. Independent acceptance is a separate procedure, not waived. Proposed process:
   user brings a frozen candidate and ledger (base/head/tree/clean state,
   receipts, approved threat-model ref) to a separate Astra session whose
   reviewer never edits the candidate. No external reviewer/subagent is started
   automatically. Reviewer assignment/handoff remains to be agreed separately.
   This static design review is not candidate acceptance. Findings reopen the
   candidate and invalidate receipts as required by AGENTS.

After the required confirmations: implement one vertical slice with focused gates, then Quick
and verify before a completion commit. Merge requires clean Full-from-stage-1
and verify. No review exemption is requested as part of design approval.
No runtime/policy changes, tests, commit, push or PR have been made by this
document revision; validation is document/diff inspection only.
