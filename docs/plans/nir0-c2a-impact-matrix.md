# NIR-0 C2A persistence impact matrix

This matrix is the C2A Phase 1/TDD boundary for the frozen base
`802b34423f071ae97ebd28b12e249b6f1ebfcf24`. It records the current call paths,
the behavior that C2A must add, and the files that remain owned by D1 or a
later lane. It does not select a schema version, migration number, or
production activation point.

## Current call paths

| Concern | Current public entry point | Current implementation path | C2A behavioral seam | Owner / dependency |
| --- | --- | --- | --- | --- |
| AI task completion | `narrative_extraction_finish_task` | `narrative_extraction::finish_task` → `repository::finish_task` → `task_leases::persist_task_artifacts` | Persist task output, extraction artifacts, model bindings/terminal receipts, and the stage-provenance closure in one transaction; reject a malformed closure without leaving any sibling row | C2A writer; D1 schema first |
| Proposal-set root revision | `narrative_extraction_save_proposal_set` | `repository::save_proposal_set` → `insert_proposal_seed` → `reconciliation_envelope::validate_reconciliation_envelope` → source-basis and `proposal-revision` Edge writers | Accept and persist a Native-validated Envelope V2, recomputing payload/envelope digests and materializing the child Consumer identity | C2A; D1 schema first |
| Revision append | `narrative_extraction_append_revision` | `repository::append_revision` → `append_revision_on_conn` | Preserve V2 once current; never permit V2 → V1/no-envelope/legacy-unbound; keep current-revision CAS atomic | C2A typed writer plus D1 trigger |
| Human derivation | `narrative_extraction_revise_and_decide_as_human` (legacy review path) and the future C2A writer boundary | `repository::revise_and_decide_with_actor` currently delegates to the client-shaped append path | Native computes old/new diff, strongest classification, child Scope/digests, material basis, and project-scoped identity; client cannot submit derivation metadata | C2A; C3 owns later review/UI wiring |
| Renderer/native bridge | `electron/native/grimodex-node` narrative extraction N-API methods; renderer `nativeApi.ts` and `proposalRepository.ts` | N-API JSON → typed `grimodex_db::narrative_extraction` facade; current renderer still sends V1 or legacy inheritance | Add/describe the typed C2A seam without wiring Chronicle production V2 before C2B | C2A N-API boundary; activation remains disabled |
| Chronicle producer | `runChronicleExtractionCoordinator` → `saveChronicleProposalSet`; review edits → `recordChronicleProposalRevision` | `proposalRepository.ts` builds V1 and review edits call `appendRevision` | Keep these production entry points on the V1 fallback until C2B; pure V2 fixtures and Native tests are allowed | C1/E1 already own pure adapter; C2B owns activation |

## Required C2A behavior

| Requirement | Observable contract | RED coverage in `narrative_c2a_persistence.rs` |
| --- | --- | --- |
| Envelope V2 persistence | A valid `schemaVersion: 2` Envelope is stored as canonical JSON with Native-computed digest and `origin_kind = enveloped`; Proposal kind/schema and payload digest remain distinct | root save round-trip and canonical digest assertions |
| Atomic closure bundle | Task output, extraction artifact, and stage-provenance closure share the completion transaction; one invalid closure rolls back all three, while a valid bundle is the later green-path companion | invalid-closure rollback (the frozen API has no closure validator yet) |
| Native-verified Human Derivation | Native rejects caller-supplied derivation/digest/Scope metadata, computes `/title`, `/note`, and disclosure paths, accepts mixed `title + secret` as `scope-override`, and rejects unknown/assertion-affecting paths | mixed scope override, forged envelope, unsupported path |
| Material basis / Freshness | Child receives its own source/evidence/dependency declarations and Consumer identity; stale parent may be edited without live-token refusal; zero-edge child is rejected | child declaration and stale-parent cases |
| Project-scoped identity | Revision identity is the persisted revision row ID, stable while its Project exists, and never inferred from payload content; deletion semantics are explicit | same payload in two projects and project-qualified lookup (deletion journey remains a D1/C2A follow-up) |
| CAS and monotonicity | Parent/current revision CAS is required; once current is V2, child must be typed V2; structural downgrade is rejected with `NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN` | stale CAS, V2→V1/no-envelope, and trigger-defense cases |
| Disabled activation | C2A merge alone does not make Chronicle production emit V2, expose Human-derived V2 UI, or promote a V2 current Revision | production entry-point/activation guard remains disabled |

## Hot-file and handoff boundary

The RED tests and this matrix do not edit these D1-owned or C2A hot files:

- `src-tauri/crates/grimodex-db/src/migrate.rs`
- `src-tauri/crates/grimodex-core/src/workspace_schema.rs`
- `src/db/schema.ts` and generated schema contract
- `src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs`
- `src-tauri/crates/grimodex-db/src/narrative_extraction/reconciliation_envelope.rs`

D1 must first publish the schema/table/column contract and migration
checkpoint. C2A production work then owns the typed writer and envelope
validator integration in the two C2A hot files, plus the N-API boundary if the
public payload shape changes. C2B/D2 remain prerequisites for material-basis
Freshness convergence and activation. Until those dependencies land, the
Chronicle V1 save/review entry points must remain unchanged.

## Validation boundary

This phase adds behavioral tests before implementation. Cargo is intentionally
not run from the parallel lane until the integration owner grants the shared
Rust lane. The RED commit therefore records the test contract and the frozen
base evidence separately from any schema or runtime implementation.
