# NIR-1 binding trace — cf871087

Static investigation, 2026-09-08. V3 design adopted for precheck; activation
unapproved. No runtime changes or execution acceptance.

## Cold-start: partial path exists; completeness not established

| Existing path | Proven boundary |
| --- | --- |
| `stage_provenance.rs:prepare_chronicle_v2_proposal_set_summary` / `validate_v2_envelope_stage_receipt` | Persisted ProposalSet receipt refs and revisionBasis bind revision to verified terminal synthesis |
| `load_verified_stage_receipts_for_hydration` through `repository.rs:get_run_review_bundle` | Revalidates stored receipt digest, model-binding sidecar, Task/Attempt lifecycle and terminal AI audit |
| `load_v2_context_artifact` | Loads a unique synthesis companion by root/terminal execution and parsed output digest; returns artifact key/digest, cluster and observation refs |
| `extractionCoordinator.ts` resume path | Calls getRun, hydrateInlineArtifactsFromNative, hydrateChronicleStageReceiptsFromNative and loads the saved snapshot; real cold hydration already exists |
| `chronicleV2Production.ts:buildEventSynthesisContextManifests` | Whole cluster/observation inputs, not just selected Evidence |
| Observation `buildObservationPromptArtifactForInput` | Coordinator AI defaults to citation-id-v2: `buildCitationIdObservationPromptArtifactFromCaptured` renders ALL bound windows/segments, including unselected occurrences. Direct task legacy default is not the production recipe |
| Repair `buildStructuredRepairPromptArtifactForInput` | Citation-ID builder uses expected-shape, allowed-ids, visible-windows and broken-response. Legacy two-input recipe is insufficient |

Unproved: a complete reader from selected revision through the saved execution
plan to EVERY upstream model-visible input, checked against stage context
bindings. Hydrating existing rows proves their validity, not that no required
member is missing. Rebuilding a closure from caller-selected receipts is not a
deterministic membership authority (ADR 011).

This does NOT prove data loss or require storing full closure. The smallest next
implementation to assess is a read-only Native material-roster resolver rooted
in revision → verified synthesis artifact → saved task plan/snapshot, expanding
versioned stage recipes. It must prove completeness or explicitly report which
binding is unavailable. Repair-parent material coverage remains unresolved.
If a required selector cannot be reconstructed, propose only the missing compact
source-membership seal bound to the stage receipt/request digest; full closure
or raw response persistence remains unauthorized.

First feasibility experiment: standard production persisted revision, discard
process/artifact caches, reopen DB and resolve complete materials or specific
missing/unsupported/inconsistent bindings. No embedding/search/navigation is
required at this stage. Final product cold-start acceptance subsequently adds
Freshness, context, admission, IR results and navigation. Removing a required
receipt/artifact/window or unselected visible segment must not allow a smaller
surviving roster to become complete.

Recipes must match component contract digest AND input protocol, not stageId
alone. Unknown recipe never falls back to legacy. Source material from Repair's
visible windows is included independently of its parent's selected Evidence.

## Eligibility: real additional writer and remaining coverage

| Mutation | Verified owner / required transactional hook |
| --- | --- |
| Revision append | `repository.rs:append_revision_on_conn` updates current pointer/status under expected-current guard |
| Human-derived Scope/projection child | `human_materialization.rs:create_human_derived_revision_with_c2b_projection_materialization` independently publishes child Freshness and updates current pointer/status on its supplied connection; must invalidate index in that SAME transaction |
| Decision / combined revision-decision | `repository.rs:append_decision_on_conn` inserts ledger and updates current-revision status; invalidate before caller commits |
| Project deletion | `domain_writes.rs:project_delete` transaction deletes decisions/revisions; remove project IR state, do not rebuild deleted project |
| Restore | `backup_restore.rs` calls `ensure_restore_epochs_for_workspace` on staged DB; invalidate before publishing restored workspace |
| Source evaluation | Canonical evaluator/publication owns revision Freshness; index invalidation does not replace that evaluation |

`resolve_source_revision` has no eligibility-set source kind. New source
registration/digest schema and atomic invalidation hooks are necessary changes,
including the human-materialization route missed by a repository-only inventory.
Apply/undo/redo, replay/import and remaining deletion coverage are NOT yet
certified. `append_decision_on_conn` calls `ensure_proposal_not_applied`, so do
not invent a supported post-Apply withdrawal in a test: use supported pre-Apply
revocation and separately inspect actual Apply/undo semantics. Applied status
alone must not erase prior explicit approval. A new unreviewed child cannot
inherit the parent's approval even when its embedding input digest is identical.

## Backend context: persisted value found; resolver binding incomplete

`projects.phase_resolution_mode` is persisted and constrained to reading/story/
auto. `domain_writes.rs:select_project_row` reads it; `project_patch` writes it.
The private reader is not an existing public IR query API. No need to treat a
renderer store as authority for this value.

Actual Related Scenes order/Phase semantics reside in TypeScript
`phaseResolver.ts:computeSceneTimeIndex` and `context/resolveApplicablePhases`.
A backend equivalent was not established. The necessary change is backend
same-project scene/phase/temporal reads plus resolver parity fixtures for all
modes/incomplete coverage. Exact remaining reader/field mappings are still
blocking; no invented axis defaults or renderer-computed authority.

## Navigation clarification

Capture S2 disclosure context and a navigation request ID. The request's own
expected transition through `openEditorDocument(syncSceneContext=true)` to S1
is continuation, not cancellation. Keep S2 for admission and bind selection to
the destination S1 editor session/generation. Cancel unrelated navigation,
project switches and replacement requests. Add the positive S2→S1 transition
with active-scene notifications to existing negative cases.

The three V3 design boundaries remain closed. Material completeness proof,
writer coverage and backend resolver binding remain open implementation
prechecks. Independent candidate acceptance is unchanged.

## Limited Native recipe replay (2026-09-08)

The opt-in `nir1-material-diagnostics` CLI now supports
`citation-id-v2/observation-v5/synthesis-v2/single-window/identity-merge/no-repair@1`.
It opens the existing database read-only, holds a read transaction and emits
only source metadata and proof digests. It does not migrate or write the DB.
The only TypeScript product-file change exports the existing synthesis builder
for parity testing; its body and the production instructions are unchanged.
The diagnostic module is absent without its opt-in Cargo feature.

Selection starts with the verified revision/synthesis companion and original
required receipt roster. Accepted current Task/Attempt artifacts bind snapshot,
window plan, raw observations, identity merge, clusters and synthesis inputs.
Native reconstructs request-local aliases and every JSON span/context segment,
including unselected spans and intervening context, then renders both ancestor
observation and selected synthesis requests. The reconstructed Context Set,
component contract and final request digests must all equal persisted receipt
seals before source materials are published. Synthesis input membership and
Evidence-to-source mapping are checked against these same artifacts.

`complete` means **source material membership only**. It grants no S2 disclosure
admission, Freshness result, IR search permission or navigation authority.
Repair, unknown contracts/catalog recipes, multiple windows and nonidentity
local merges remain explicitly unsupported. SQL/I/O failures remain errors;
missing proof and inconsistent bindings cannot publish a partial material list.
This is not a claim that every no-repair Chronicle path is supported.

The existing synthetic fixed-response production journey generated, approved,
Applied and reopened the cold fixture before this replay implementation. No
additional model call or persistence format was introduced. Its copied closed
DB contains 3 verified receipts and 11 verified artifacts. The selected revision
now reaches `complete` in a separate Native process: 2 necessary requests match
all 3 digest domains, and 9 source segments (5 spans plus 4 context separators)
cover the full 72 UTF-16 code-unit window, including the unselected bell span.

`production-golden.json` preserves this independent TS-produced fixture's
inputs and original receipt digests. The live TS builders reproduce all 3
saved requests and compare static contracts to frozen `contracts.json`.
Native tests use those preexisting seals, never Native-generated expectations.
A changed synthesis body leaves declaration/component digests unchanged but
fails the final request seal. Repair/unknown-contract refusal and UTF-16
surrogate boundaries are also covered.

The same four corrupt-copy probes assert specific failures: removing a required
receipt or changing its saved digest fails the original revision receipt roster;
removing an unselected visible catalog span fails snapshot/catalog payload
digest; removing a window fails window-plan payload digest. Expected seals are
retained. These are detection tests, not resistance to resealing all authorities.
Every probe checks that the CLI leaves the database bytes unchanged.

Local evidence is under `/tmp/nir1-material-roster-replay-evidence/`:
`candidate-manifest.json` binds the base SHA, tracked diff and untracked bytes,
file hashes, binary and fixture hashes, commands, CLI outputs and test logs.
The frozen candidate patch includes untracked files. Nothing was committed or
pushed. These temporary paths need preserving when handing off outside this host.

```sh
cargo build --manifest-path src-tauri/Cargo.toml -p grimodex-db --no-default-features --features nir1-material-diagnostics --bin nir1-material-roster
src-tauri/target/debug/nir1-material-roster <cold-fixture.db> <project-id> <revision-id>
node scripts/nir1-material-roster-probe.mjs src-tauri/target/debug/nir1-material-roster <cold-fixture.db> <project-id> <revision-id>
```

CLI exit zero means the diagnostic ran; inspect `status` for membership outcome.
Default-build boundary checks and focused tests are experimental evidence, not
independent candidate acceptance. Full product acceptance, independent review,
activation, new storage/index/IPC/UI and external APIs remain outside this work.
