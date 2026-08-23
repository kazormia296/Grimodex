# NIR-0 C2A persistence impact matrix

This matrix is the C2A Phase 1/TDD boundary for the frozen base
`802b34423f071ae97ebd28b12e249b6f1ebfcf24`. It records the call paths and
observable contracts without selecting a migration number, schema version, or
production activation point.

## Dependency and hot-file map

| Concern | Current call path on the frozen base | C2A seam under test | Owner / blocker |
| --- | --- | --- | --- |
| Task completion | `narrative_extraction_finish_task` → `repository::finish_task` → `task_leases::persist_task_artifacts` | One transaction for task output, real extraction artifact, terminal receipts/model bindings, and a validated stage-provenance closure; any closure failure rolls back every sibling | D1 tables/columns and C2A closure validator; the frozen base has no durable closure validator |
| Envelope V2 root | `narrative_extraction_save_proposal_set` → `insert_proposal_seed` → `reconciliation_envelope::validate_reconciliation_envelope` → source-basis/edge writers | Native recomputes and stores canonical C1 Envelope V2, exact proposal kind/schema/adapter identity, durable Envelope digests, and project-qualified revision identity | D1 schema contract, then C2A validator/writer |
| Revision append | `narrative_extraction_append_revision` → `append_revision_on_conn` | CAS on the current revision; V2 current can never receive V1/no-envelope/legacy-unbound child; stable error code for downgrade and inheritance boundaries | D1 trigger + C2A typed writer |
| Human derivation | Existing review facade currently accepts the client-shaped append DTO | New typed Native request carries only `proposalId`, `expectedCurrentRevisionId`, `parentRevisionId`, `expectedParentEnvelopeDigest`, projection payload, Adapter identity, and `surfaceId`; Native fixes actor/project boundaries and derives all metadata | Compile-RED in `narrative_c2a_human_request_compile_red.rs` with all cases executable once the typed API exists; D1/API and C2A writer implementation wait |
| Resolver freshness | `source_revision::resolve_source_revision` resolves `scene-body` as `v<version>@<updated_at>` | Parent stores the observed token; a later live resolver advance is visible as stale, but C2A does not create/promote a child | C2B owns child declarations, freshness convergence, and current-Epoch initialization |
| Project identity | Proposal revisions are joined through `proposal_set.project_id` | Same payload in two projects has distinct row identity; lookup must include project boundary and never hash payload content | D1 identity/foreign-key contract |
| Production Chronicle path | `runChronicleExtractionCoordinator` → `saveChronicleProposalSet`; review edits → `recordChronicleProposalRevision` | Remains on V1 fallback; fixtures only. No V2 production marker or current revision promotion | C2B/D2 activation gate |

## Required C2A behavior and RED coverage

| Requirement | Observable contract | Fixture / test boundary | Status on frozen base |
| --- | --- | --- | --- |
| Exact Envelope V2 persistence | C1 constants are exact: `narrative.chronicle.scene-event`, `chronicle.create-event@1`, `chronicle.scene-event@1`; semantic payload is observation-derived; Native recomputes the durable Envelope assertion/material/context/projection digests and writes sorted canonical JSON | `persists_native_canonical_envelope_v2_and_project_qualified_identity`; `native_recomputes_or_rejects_each_nested_envelope_digest_field` for each claimed field | RED: base accepts only V1 envelope shape; forged fields must eventually use one canonical `NEX_ENVELOPE_DIGEST_MISMATCH` code |
| Atomic closure bundle | Valid companion includes C1 observation + synthesis terminal receipts, model bindings, closure, output, and raw observation artifact; corrupt only closure digest and all task/attempt/output/artifacts remain unchanged | `persists_a_valid_atomic_stage_bundle_with_receipts_bindings_output_and_artifact`; `rejects_only_corrupt_closure_and_rolls_back_all_siblings` | Valid path is a companion; corrupt path RED until D1/C2A closure validator and durable closure contract exist |
| Typed Native Human Derivation | Request shape has `parentRevisionId`, `expectedParentEnvelopeDigest`, typed Adapter `{id,version}`, `surfaceId`, trusted project argument, and Native Human actor; no client derivation fields | `narrative_c2a_human_request_compile_red.rs` defines the policy-shaped request, seeds a real V2 parent plus D1 sealed declaration head, uses a separate trusted project, asserts the persisted actor, and carries all non-ignored negatives | RED: frozen base lacks the typed Native writer and V2 basis persistence |
| Human negative boundaries | Current-correct/parent-wrong, wrong current, parent digest, forged trusted-project boundary, adapter id/version, surface, zero-edge parent, and stale resolver writer invocation are explicit; this RED does not claim a runtime forged actor/derivation request because those fields are intentionally absent from the exact ingress shape; each future rejection uses a stable NEX code and stale source token is retained | `narrative_c2a_human_request_compile_red.rs` cases, including D1-backed stale resolver invocation; no legacy decision-JSON adapter | Blocked on D1 API/schema and C2A typed writer |
| Dormant persistence only | C2A must not promote `current_revision_id`, create child declarations, initialize current-Epoch, or wire review UI/production V2 | `resolver_advance_preserves_observed_parent_token_without_c2b_promotion`, `zero_edge_parent_remains_dormant_until_c2b_child_declaration`, activation-policy assertion | Green boundary fixture; promotion journey explicitly C2B |
| Project-scoped identity | Revision row ID is project-qualified through the proposal set; cross-project lookup returns no row and same payload does not alias | Envelope root test | RED behind V2 persistence |
| Monotonicity and downgrade | V2→real V1-envelope/no-envelope append, V2→legacy `inheritReconciliationEnvelope`, legacy explicit inheritance, and direct SQL downgrade all fail with explicit boundary codes; stale current CAS is separate from source freshness | `v2_to_v1_downgrade_and_legacy_inheritance_have_stable_boundaries` plus Human current/parent cases | RED for V2/SQL trigger; legacy inheritance boundary is explicit |
| Zero-edge boundary | A dormant V2 parent has no C2A-owned child Consumer edge; typed Human writer rejects a zero-edge parent once D1 publishes the API | zero-edge runtime fixture + compile-RED case | C2B dependency |
| Disabled activation | Policy says `state=disabled`, no production entry points, V2 emission/Human UI/current promotion blocked until C2B, V1 fallback retained | `c2a_stays_dormant_and_chronicle_v2_activation_is_disabled` | Green policy guard |

## Ownership and handoff

The RED artifacts deliberately do not edit these D1-owned or shared hot files:

- `src-tauri/crates/grimodex-db/src/migrate.rs`
- `src-tauri/crates/grimodex-core/src/workspace_schema.rs`
- `src/db/schema.ts` and the generated schema contract
- `src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs`
- `src-tauri/crates/grimodex-db/src/narrative_extraction/reconciliation_envelope.rs`

D1 must publish the schema/table/column/trigger contract first. C2A production
work then owns the typed writer and V2 validator integration; any N-API shape
change follows that contract. C2B/D2 own child Consumer declarations,
freshness convergence, current-Epoch initialization, review/UI wiring, and
production activation. Until those lanes land, Chronicle entry points remain
on the existing V1 path.

## Validation boundary

This is a test-only remediation of the earlier RED artifact. Cargo is
intentionally not run from the parallel lane. The remediation commit records
the exact fixture and expected failures; it does not claim implementation,
schema readiness, or activation readiness. The atomic-stage fixture recomputes
its receipt and closure digests as a pure C1 companion, but the frozen
`finish_task` path has no closure validator; durable closure validation is
claimed only after D1/C2A publishes that contract.
