//! Persistent run runtime for Narrative Extraction (Chronicle + Codex Vertical Slice).

pub(crate) mod application_contributions;
mod attention;
mod c2z_preparation;
pub(crate) mod c2zb_application_rekey;
mod c2zc_canonical_cutover;
#[cfg(feature = "c2zc-fixture-builder")]
pub mod c2zc_restore_fixture;
pub mod change_feed;
mod chronicle_operations;
mod codex_operations;
mod codex_snapshots;
mod codex_undo;
mod commit;
mod consumer_identity;
mod contribution_target_state;
mod cursor_reservation;
pub mod declaration_storage;
mod dependency_edges;
mod detail_operations;
mod evaluator;
mod execution_state;
mod field_authority;
mod finding_identity;
mod finding_observation;
mod foreshadow_operations;
mod foreshadow_undo;
mod inbox_read_model;
mod incremental_freshness;
mod legacy_backfill;
pub mod maintenance_contracts;
mod maintenance_lifecycle;
pub mod maintenance_route_registry;
pub mod maintenance_runtime;
pub mod maintenance_skip_evidence;
pub mod nir1_chronicle_index;
mod nir1_entity_relation;
pub mod nir1_entity_relation_index;
pub mod nir1_graph;
pub use declaration_storage::{
    read_active_dependency_declaration_set, verify_dependency_declaration_storage,
    write_dependency_declaration_set, write_dependency_declaration_set_in_tx,
    ActiveDependencyDeclarationSet, DependencyDeclaration, DependencyDeclarationSetReceipt,
    DependencyDeclarationSetRequest, DependencyDeclarationSetState, StoredDependencyDeclaration,
};
pub use maintenance_contracts::{
    bundled_dependency_producer_registry, current_maintenance_coordinates, DependencyProducerEntry,
    DependencyProducerRegistry, DependencyProducerWriter, MaintenanceContractCoordinates,
};
pub use maintenance_skip_evidence::{
    evaluate_completed_run_skip, persist_completed_run_skip_evidence,
    persist_completed_run_skip_evidence_in_tx, read_completed_run_skip_evidence,
    CompletedRunSkipDecision, CompletedRunSkipEvidence, CompletedRunSkipExpectation,
    CompletedRunSkipReason, COMPLETED_RUN_SKIP_EVIDENCE_FIELD, REBUILD_RUN_KIND_CONTRACT_VERSION,
    VERIFY_RUN_KIND_CONTRACT_VERSION,
};
#[cfg(test)]
pub(crate) use material_membership::MATERIAL_MEMBERSHIP_READ_COUNT;
pub use nir1_entity_relation::{
    evaluate_nir1_entity_relation_disclosure, find_nir1_entity_relation_revision_run,
    nir1_entity_relation_revision_current_read_for_renderer,
    nir1_entity_relation_revision_prepare_receipt, nir1_entity_relation_revision_read_for_renderer,
    prepare_nir1_entity_relation_revision, read_nir1_entity_relation_revision,
    read_nir1_entity_relation_revision_current,
    read_nir1_entity_relation_revision_current_for_revision,
    revalidate_nir1_entity_relation_disclosure, Nir1EntityRelationDisclosure,
    Nir1EntityRelationDisclosureRead, Nir1EntityRelationMaterialSceneProof,
    Nir1EntityRelationRevision, Nir1EntityRelationRevisionCurrentRead,
    Nir1EntityRelationRevisionPrepareRequest, Nir1EntityRelationRevisionRead,
    Nir1EntityRelationRevisionRequest, Nir1EntityRelationRevisionRestoreMatch,
    NIR1_ENTITY_RELATION_DECISION_LOCKED, NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
    NIR1_ENTITY_RELATION_SET_KIND,
};
pub use nir1_graph::{read_nir1_graph, Nir1GraphRequest, Nir1GraphResponse};
pub use reconciliation_envelope::SourceBasisRow;
pub use repository::PROPOSAL_REVISION_D1_PRODUCER_GENERATION;
pub(crate) use repository::{
    release_project_destructive_permit, try_reserve_project_destructive_permit,
};
pub(crate) use scene_scope::backfill_scene_scope_storage_in_tx;
pub(crate) use scene_scope::ensure_scene_scope_binding_in_tx;
pub(crate) use scene_scope::ensure_scope_registry_in_tx;
pub(crate) use scene_scope::refresh_scene_scope_source_token_for_scene_in_tx;
pub(crate) use scene_scope::refresh_scene_scope_source_token_in_tx;
#[cfg(test)]
pub(crate) use scene_scope::MATERIAL_SCOPE_PRELOAD_QUERY_COUNT;
pub(crate) use scene_scope::{
    canonical_scene_scope_snapshot, canonical_scope_registry_snapshot, scope_extension_digest,
};
pub(crate) use scene_scope::{
    ensure_character_reference_mutation_allowed_in_tx,
    ensure_character_snapshot_restore_allowed_in_tx,
    invalidate_character_references_with_events_in_tx,
};
pub use scene_scope::{
    read_narrative_scene_scope, update_narrative_scene_scope,
    update_narrative_scene_scope_registry, NarrativeSceneScopeReadV1,
    NarrativeSceneScopeRegistryUpdatePayload, NarrativeSceneScopeUpdatePayload,
};
mod human_derivation;
pub mod human_material_basis;
mod human_materialization;
mod material_membership;
mod material_membership_root;
mod nir1_packing;
pub use material_membership::{
    read_revision_material_membership, MaterialMembershipRead, RevisionMaterialMembership,
    VerifiedMaterialRevision,
};
pub use material_membership_root::{
    Material, RequestDigests, RequestProof, RosterIssue, RosterStatus, VerifiedArtifact,
    VerifiedReceipt,
};
mod models;
mod phase_operations;
mod phase_snapshots;
mod phase_undo;
mod plot_thread_operations;
mod plot_thread_undo;
mod project_scope_authority;
mod publish_runtime;
mod reconciliation_envelope;
mod repair;
mod retrieval_admission;
mod scene_scope;
mod scope_dependency_projection;
pub use nir1_packing::{
    read_and_pack_native_a2_context, NativeNir1AuthorityBinding, NativeNir1DecisionBinding,
    NativeNir1PackedContext, NativeNir1PackingRequest, NativeNir1RawContextItem,
    NativeNir1ScopeBinding, NativeNir1SelectedContextItem,
};
pub use retrieval_admission::{
    read_retrieval_query_context, read_retrieval_scene_source, read_revision_retrieval_eligibility,
    ChronicleRetrievalDocument, QueryIdentityState, RetrievalQueryContext,
    RetrievalQueryContextRead, RetrievalSceneSource, RetrievalSceneSourceBinding,
    RetrievalSceneSourceRead, RevisionEligibilityDecision, RevisionEligibilityRead,
    RevisionEligibilityReason, RevisionEligibilitySnapshot,
};
mod revision_eligibility;
pub use revision_eligibility::{
    read_revision_canonical_freshness, RevisionFreshnessRead, RevisionFreshnessReason,
    RevisionFreshnessSnapshot,
};
#[cfg(feature = "nir1-material-diagnostics")]
pub mod material_roster;
#[cfg(feature = "nir1-material-diagnostics")]
pub mod nir1_capacity_diagnostics;
#[cfg(feature = "nir1-material-diagnostics")]
pub mod nir1_capacity_fixtures;
mod repository;
mod restore_rebuild;
mod scope_authority_runtime;
mod semantic_bindings;
mod semantic_epoch;
mod semantic_index_diagnostics;
mod source_revision;
#[allow(unused_imports)]
pub(crate) use source_revision::{
    resolve_current_source_state_with_control,
    resolve_source_revision_with_control,
};
mod stage_provenance;
mod task_leases;
mod temporal_constraints;
mod temporal_nodes;
mod temporal_operations;
mod temporal_projections;
mod temporal_snapshots;
mod temporal_undo;
mod terminal_failure;
mod undo;
mod v2_apply_sources;
mod verify_coverage;

pub(crate) const INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID: &str =
    "narrative-incremental-freshness/v1";

// Gate C2 core primitives. C2-1 composes the Change Feed/cursor/evaluator/
// publish pieces through `incremental_freshness`; other crate-private exports
// remain shared building blocks for the maintenance Run Kinds below.
#[allow(unused_imports)]
pub(crate) use application_contributions::{
    list_contributions_for_application, list_contributions_for_target, record_contribution_in_tx,
    ApplicationContribution, ContributionTargetState,
};
#[allow(unused_imports)]
pub(crate) use attention::{get_attention, is_attention_applicable};
// C2-T1: exposed through narrative_maintenance_attention_set/_clear
// (electron/native/grimodex-node/src/lib.rs).
pub(crate) use attention::rehome_orphaned_attention_in_tx;
pub use attention::{
    clear_attention, clear_attention_in_tx, set_attention, set_attention_in_tx,
    AttentionDisposition, AttentionRow, AttentionWriteOutcome, SetAttentionRequest,
};
// cursor_reservation::acknowledge_cursor_in_tx is the SCHEMA_VERSION 23
// reservation-aware acknowledge (Lane I); it is a distinct function from
// the pre-existing change_feed::acknowledge_cursor_in_tx (accessed as
// `change_feed::acknowledge_cursor_in_tx` since `change_feed` stays a
// `pub mod`, not flattened here) — same table, two different consumer
// protocols, not interchangeable.
#[allow(unused_imports)]
pub(crate) use cursor_reservation::{
    acknowledge_cursor_in_tx, get_cursor, reclaim_stale_reservation_in_tx,
    reserve_cursor_range_in_tx, CursorRow,
};
#[allow(unused_imports)]
pub(crate) use dependency_edges::{
    canonical_source_object_identity, delete_edges_for_consumer_in_tx, find_edges_by_consumer,
    find_edges_by_source, record_dependency_edge_in_tx, DependencyEdge, APPLICATION_CONSUMER_KIND,
    PROPOSAL_REVISION_CONSUMER_KIND, RUN_CONSUMER_KIND, SOURCE_IDENTITY_PREFIXES,
};
#[allow(unused_imports)]
pub(crate) use evaluator::{evaluate_edge, BuildAction, EdgeComparisonInput, EdgeObservation};
#[allow(unused_imports)]
pub(crate) use execution_state::{
    supersede_run_in_tx, transition_attempt_status_in_tx, transition_run_status_in_tx,
    transition_task_status_in_tx, NarrativeAttemptStatus, NarrativeRunStatus, NarrativeTaskStatus,
};
#[allow(unused_imports)]
pub(crate) use finding_observation::{
    list_observations_for_epoch, record_finding_observation_in_tx,
};
// C2-T1: FindingObservationRow crosses the N-API boundary as a field of
// InboxEntry (narrative_maintenance_inbox_list).
pub use finding_identity::{
    bundled_finding_rule_registry, material_basis_digest, observation_digest,
    stable_finding_identity, FindingRule, FindingRuleRegistry, MaterialBasisInput,
    ObservationDigestInput, BUNDLED_FINDING_RULE_ID, BUNDLED_FINDING_RULE_VERSION,
    MAINTENANCE_FAILURE_FINDING_RULE_ID, MAINTENANCE_FAILURE_FINDING_RULE_VERSION,
};
pub use finding_observation::FindingObservationRow;
// EvidenceFreshness / FindingReasonCode: canonical home is `evaluator`
// (Lane F); `finding_observation` (Lane C) imports them from there instead
// of a second, drifting copy — both Lanes independently defined this pair
// in parallel and the Integration Owner collapsed it during Wave 1 merge.
#[allow(unused_imports)]
pub(crate) use evaluator::{EvidenceFreshness, FindingReasonCode};
#[allow(unused_imports)]
pub(crate) use inbox_read_model::{list_consumer_freshness, ConsumerFreshnessRow};
// C2-T1: called from narrative_maintenance_inbox_list
// (electron/native/grimodex-node/src/lib.rs).
pub use c2z_preparation::{
    inspect_legacy_generic_freshness_parity, inspect_project_cutover_readiness,
    inspect_workspace_cutover_readiness, plan_application_rekey, ApplicationRekeyCandidate,
    ApplicationRekeyFanOut, ApplicationRekeyPlan, DependencySetMismatch, ExistingApplicationTarget,
    FreshnessParityReport, FreshnessStatusMismatch, InvalidLegacyDependency,
    PendingV3BackfillApplication, ProjectCutoverReadiness, ReadinessGate, ReadinessState,
    RekeyCollision, RekeyInvalidItem, RekeyMappingKind, RetainedRunConsumerEdge,
    UnattributedRekeyItem, UnsupportedGenericFreshness, VerifyReadiness, WorkspaceCutoverReadiness,
    REQUIRED_VERIFY_CHECKS,
};
pub use c2zc_canonical_cutover::{
    canonical_application_freshness, cut_over_workspace_freshness,
    inspect_workspace_cutover_readiness_with_liveness, record_live_scheduler_heartbeat,
    CanonicalCutoverReadiness, CanonicalCutoverReceipt, CanonicalFreshnessAuthority,
    CanonicalFreshnessRow, SchedulerLivenessEvidence, C2_ZC_CUTOVER_CONTRACT_VERSION,
    C2_ZC_CUTOVER_MIGRATION_ID,
};
pub(crate) use c2zc_canonical_cutover::{
    mint_c2zc_import_project_birth_epoch_in_tx, mint_c2zc_project_birth_epoch_in_tx,
    mint_c2zc_scan_publish_project_birth_epoch_in_tx,
};
pub use inbox_read_model::{build_maintenance_inbox, InboxEntry, InboxEntryKind};
pub use incremental_freshness::{
    run_incremental_freshness_cycle, run_incremental_freshness_cycle_with_hold,
    run_incremental_freshness_cycle_with_lifecycle_control,
    run_incremental_freshness_cycle_with_liveness_capability,
    run_incremental_freshness_cycle_with_liveness_capability_and_hold,
    run_incremental_freshness_cycle_with_liveness_capability_and_hold_and_lifecycle_control,
    IncrementalFreshnessBatchSummary, IncrementalFreshnessCycleOutcome,
    IncrementalFreshnessHeldSummary, IncrementalFreshnessShadowConsumerSummary,
    IncrementalFreshnessShadowSummary, SuccessfulIncrementalFreshnessCycle,
    NARRATIVE_DEPENDENCY_V2_SHADOW_RUNTIME,
};
pub use incremental_freshness::FreshnessLifecycleControl;
pub use nir1_entity_relation_index::{GraphWorkControl, GraphWorkStage};
pub use source_revision::{
    is_validation_terminated, validation_terminated, ValidationTerminated,
    ValidationTerminationReason,
};
pub use maintenance_route_registry::{
    route_descriptor_by_id, route_descriptor_for_run_kind, route_descriptors,
    route_id_for_run_kind, MaintenanceRouteDescriptor,
    NARRATIVE_MAINTENANCE_ROUTE_REGISTRY_VERSION,
};
pub use maintenance_runtime::{
    canonical_work_key, canonical_work_key_for_epoch, classify_failure, coalesce_desired_work,
    decide_execution, decide_run_recovery, decide_run_recovery_for_epoch,
    discover_before_cutover_maintenance_work_with_coordinates, discover_durable_maintenance_work,
    discover_durable_maintenance_work_with_config,
    discover_durable_maintenance_work_with_coordinates, effective_maintenance_coordinates,
    plan_maintenance_trigger, preflight_maintenance_cycle_request, read_run_ledger,
    read_run_ledger_for_epoch, recovery_canonical_key, retry_backoff_ms,
    terminalize_interrupted_runs, terminalize_interrupted_runs_for_epoch,
    terminalize_stale_interrupted_runs, terminalize_stale_interrupted_runs_for_epoch,
    AutomaticRunKind, DesiredWork, FailureClass, FailureClassification,
    InterruptedRunTerminalization, MaintenanceExecutionDecision, MaintenanceExecutionMode,
    MaintenanceTrigger, NarrativeMaintenanceCiConfig, NarrativeMaintenanceCiFault,
    NarrativeMaintenanceCiSetup, NarrativeMaintenanceCiTrigger, NarrativeSystemWorkMarker,
    RecoveryAction, RecoveryDecision, RecoveryMode, RunLedgerCounts, StaleActiveRun, WorkKey,
    LEGACY_BACKFILL_WORK_KEY, MAX_AUTOMATIC_RETRIES, NARRATIVE_MAINTENANCE_MAX_SAFE_GENERATION,
    REBUILD_DERIVED_WORK_KEY, VERIFY_WORK_KEY_PREFIX,
};
pub use maintenance_runtime::{
    complete_foreground_system_work_run, find_running_foreground_system_work_run,
    find_running_foreground_system_work_slot, run_system_work_cycle,
    run_system_work_cycle_with_modes, run_system_work_cycle_with_modes_and_config,
    run_system_work_cycle_with_modes_and_config_and_foreground_owner,
    run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control,
    ForegroundSystemWorkRun, MaintenanceCycleControl, MaintenanceCycleRequest,
    MaintenanceCycleResult, MaintenanceCycleStatus, MaintenanceWorkRequest,
    MaintenanceWorkspaceBinding, MAX_MAINTENANCE_WORK_ITEMS_PER_CYCLE,
};
#[allow(unused_imports)]
pub(crate) use publish_runtime::{
    publish_freshness_evaluation_in_tx, write_consumer_freshness_in_tx, write_edge_state_in_tx,
};
#[allow(unused_imports)]
pub(crate) use restore_rebuild::{
    durable_graph_state_digest_with_control, rebuild_repair_dependency_edges_in_tx,
    rebuild_verify_dependency_edges, rotate_epoch_for_restore_in_tx,
    validate_graph_state_digest_with_control, verify_dependency_graph_snapshot_with_control,
    RebuildVerifyReport,
};
pub(crate) use task_leases::with_immediate_transaction;
pub use terminal_failure::{
    project_terminal_failure_for_run, resolve_terminal_failure_for_run,
    TerminalFailureProjectionOutcome, TerminalFailureResolutionOutcome,
    TERMINAL_FAILURE_CONSUMER_KIND,
};

// Gate C2 Run Kind Policy: the five named operations replacing the old
// two-value `rebuildNarrativeDependencyIndex(mode: verify|repair)`
// (`policies/narrative/narrative-run-kind-policy.json`'s `apiSplit`).
// `pub` (not `pub(crate)`): called directly from
// `electron/native/grimodex-node/src/lib.rs`, a different crate.
pub use legacy_backfill::{
    bootstrap_legacy_dependency_backfill_for_project,
    bootstrap_legacy_dependency_backfill_for_project_with_control, get_backfill_status_for_project,
    inject_legacy_backfill_fault_for_project, inject_legacy_backfill_fault_for_work,
    BackfillStatus, BackfillSummary, LegacyBackfillBootstrapOutcome, LegacyBackfillFaultOutcome,
};
pub use repair::{
    repair_narrative_dependency_declarations_for_project,
    repair_narrative_dependency_declarations_for_request, seal_repair_plan, RepairOutcome,
    RepairPlan,
};
pub use restore_rebuild::{
    ack_maintenance_wakes, canonical_verify_outcome_digest, durable_graph_state_digest,
    ensure_restore_epochs_for_workspace, list_pending_maintenance_wakes,
    production_verify_check_coverage, rebuild_narrative_derived_state_for_project,
    rebuild_narrative_derived_state_for_project_with_control,
    record_maintenance_delivery_failure_wake, run_dependency_verify_for_project,
    run_dependency_verify_for_project_with_coordinates,
    run_dependency_verify_for_project_with_coordinates_and_control,
    try_cancel_preempted_maintenance_run,
    verify_narrative_dependency_graph_for_project, DependencyGraphVerifyReport,
    PendingMaintenanceWake, RebuildDerivedStateOutcome, RebuildDerivedStateSummary,
    RebuildShadowVerificationSummary, VerifyRunOutcome,
};
#[allow(unused_imports)]
pub(crate) use semantic_epoch::{create_epoch_in_tx, list_epochs};
// `pub`: `get_current_epoch`/`CurrentEpoch` resolve the Semantic Epoch a
// sealed Repair plan is bound to, needed from
// `electron/native/grimodex-node/src/lib.rs`'s
// `repair_narrative_dependency_declarations` before calling
// `seal_repair_plan`.
pub use semantic_epoch::{get_current_epoch, CurrentEpoch};
#[allow(unused_imports)]
pub(crate) use semantic_index_diagnostics::{
    compute_dependency_set_digest, is_semantic_index_dirty,
    semantic_index_metadata_from_dependency_edges, SemanticIndexMetadata,
};
pub use verify_coverage::VerifyCoverageCheck;

pub(crate) use foreshadow_operations::collect_aggregate_snapshot;
pub(crate) use foreshadow_undo::{
    delete_snapshot_at_version, ensure_matches_snapshot as ensure_foreshadow_snapshot_matches,
    reapply_created_snapshot,
};
pub(crate) use phase_operations::collect_phase_snapshot;
pub(crate) use semantic_bindings::collect_semantic_binding_snapshot;
pub(crate) use temporal_snapshots::{
    collect_constraint_snapshot, collect_node_snapshot, collect_projection_snapshot,
};

pub use commit::digest_plan;
pub(crate) use field_authority::{
    legacy_value_present, propagate_source_change_freshness_in_tx, record_human_field_write,
};
pub use models::{
    AppendDecisionPayload, AppendRevisionPayload, ApplyCommitPayload, ArtifactInput,
    ChronicleBlockedDiscardExpectation, ChronicleStageC1ExecutionBinding, ChronicleStageExecution,
    ChronicleStageModelBinding, ChronicleStageProvenanceClosure, ChronicleStageReceiptRef,
    ChronicleStageTerminalReceipt, ClaimTaskPayload, CommitApplicationRef, CommitOperation,
    CreateHumanDerivedRevisionRequest, CreateRunPayload, CreateTaskSeed, EntityBindingSeed,
    FailTaskPayload, FinishTaskPayload, GetCommitStatusPayload, GetNarrativeBackfillStatusPayload,
    HumanFieldLockPayload, IsRunResumableForReviewPayload, IsRunResumableForReviewResult,
    ListChronicleTaskResumeCandidatesPayload, ListResumableRunsPayload, NarrativeAdapterIdentity,
    NarrativeMaintenanceAttentionClearPayload, NarrativeMaintenanceAttentionSetPayload,
    NarrativeMaintenanceInboxListPayload, PrepareCommitPayload, ProposalSeed,
    RebuildNarrativeDerivedStatePayload, ReconciliationEnvelopeInheritance,
    RepairNarrativeDependencyDeclarationsPayload, RetryNarrativeLegacyBackfillPayload,
    ReviseAndDecidePayload, RunRefPayload, SaveProposalSetPayload, TrustedHumanDerivationScope,
    TrustedRevealBasis, TrustedScopeBoundary, TrustedScopeInterval, TrustedUnresolvedConstraint,
    UndoCommitPayload, VerifyNarrativeDependencyGraphPayload,
};
pub use repository::ensure_test_schema;
pub use scope_authority_runtime::{
    load_historical_scope_authority_basis, HISTORICAL_SCOPE_AUTHORITY_ARTIFACT_KIND,
};
pub use temporal_operations::TemporalScenePatchPayload;

use serde_json::Value;

use crate::change_events::AppendChangeEvent;
use crate::idempotency::{
    canonical_write_payload_fingerprint, insert_idempotent_response, load_idempotent_response,
    IdempotencyRequest,
};
use crate::Database;
use change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    require_replay_lineage_in_project, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};

pub fn narrative_extraction_create_run(
    db: &Database,
    payload: CreateRunPayload,
) -> anyhow::Result<Value> {
    repository::create_run(db, payload)
}

/// Native-only Chronicle Human Derivation writer.  The trusted project
/// boundary is deliberately separate from the renderer-shaped request; the
/// implementation fixes actor/derivation metadata and consumes (but never
/// mutates) the D1 sealed declaration head.
pub fn narrative_extraction_create_human_derived_revision(
    db: &Database,
    trusted_project_id: &str,
    request: CreateHumanDerivedRevisionRequest,
) -> anyhow::Result<Value> {
    human_derivation::create_human_derived_revision(db, trusted_project_id, request)
}

/// Native-only scope-aware Human Derivation writer.  The renderer-shaped
/// request remains unchanged; a trusted resolver supplies the non-Serde
/// context only when a secret Scope must be re-derived.
pub fn narrative_extraction_create_human_derived_revision_with_scope(
    db: &Database,
    trusted_project_id: &str,
    trusted_scope: Option<TrustedHumanDerivationScope>,
    request: CreateHumanDerivedRevisionRequest,
) -> anyhow::Result<Value> {
    human_derivation::create_human_derived_revision_with_scope(
        db,
        trusted_project_id,
        trusted_scope,
        request,
    )
}

/// Native-owned C2B materialization seam. Projection-only and ScopeOverride
/// derive and publish the complete child material atomically against the
/// Native live project Scope authority.
pub fn narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization(
    db: &Database,
    trusted_project_id: &str,
    request: CreateHumanDerivedRevisionRequest,
    derivation_kind: human_material_basis::HumanMaterialDerivationKind,
) -> anyhow::Result<Value> {
    human_materialization::create_human_derived_revision_with_c2b_projection_materialization(
        db,
        trusted_project_id,
        request,
        derivation_kind,
    )
}

/// Production C2B Human writer. Native classifies the edited Chronicle
/// payload and selects projection-only versus ScopeOverride inside the same
/// transaction; the renderer cannot provide a derivation kind.
pub fn narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto(
    db: &Database,
    trusted_project_id: &str,
    request: CreateHumanDerivedRevisionRequest,
) -> anyhow::Result<Value> {
    human_materialization::create_human_derived_revision_with_c2b_projection_materialization_auto(
        db,
        trusted_project_id,
        request,
    )
}

pub fn narrative_extraction_get_run(
    db: &Database,
    run_id: String,
    project_id: String,
) -> anyhow::Result<Value> {
    repository::get_run(db, run_id, project_id)
}

pub fn narrative_extraction_list_resumable_runs(
    db: &Database,
    payload: ListResumableRunsPayload,
) -> anyhow::Result<Value> {
    repository::list_resumable_runs(db, payload)
}

pub fn narrative_extraction_is_run_resumable_for_review(
    db: &Database,
    payload: IsRunResumableForReviewPayload,
) -> anyhow::Result<IsRunResumableForReviewResult> {
    repository::is_run_resumable_for_review(db, payload)
}

pub fn narrative_extraction_list_chronicle_task_resume_candidates(
    db: &Database,
    payload: ListChronicleTaskResumeCandidatesPayload,
) -> anyhow::Result<Value> {
    repository::list_chronicle_task_resume_candidates(db, payload)
}

pub fn narrative_extraction_cancel_run(
    db: &Database,
    payload: RunRefPayload,
) -> anyhow::Result<Value> {
    repository::cancel_run_with_expectation(
        db,
        payload.run_id,
        payload.project_id,
        payload.chronicle_blocked_discard,
    )
}

pub fn narrative_extraction_claim_task(
    db: &Database,
    payload: ClaimTaskPayload,
) -> anyhow::Result<Value> {
    repository::claim_task(db, payload)
}

pub fn narrative_extraction_finish_task(
    db: &Database,
    payload: FinishTaskPayload,
) -> anyhow::Result<Value> {
    repository::finish_task(db, payload)
}

pub fn narrative_extraction_finish_task_with_control(
    db: &Database,
    payload: FinishTaskPayload,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    repository::finish_task_with_control(db, payload, control)
}

pub fn narrative_extraction_fail_task(
    db: &Database,
    payload: FailTaskPayload,
) -> anyhow::Result<Value> {
    repository::fail_task(db, payload)
}

pub fn narrative_extraction_save_proposal_set(
    db: &Database,
    payload: SaveProposalSetPayload,
) -> anyhow::Result<Value> {
    repository::save_proposal_set(db, payload)
}

pub fn narrative_extraction_save_proposal_set_with_control(
    db: &Database,
    payload: SaveProposalSetPayload,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    repository::save_proposal_set_with_control(db, payload, control)
}

pub fn narrative_extraction_create_nir1_entity_relation_revision(
    db: &Database,
    request: Nir1EntityRelationRevisionRequest,
) -> anyhow::Result<Value> {
    nir1_entity_relation::create_nir1_entity_relation_revision(db, request)
}

pub fn narrative_extraction_prepare_nir1_entity_relation_revision(
    db: &Database,
    request: Nir1EntityRelationRevisionPrepareRequest,
) -> anyhow::Result<Value> {
    nir1_entity_relation::prepare_nir1_entity_relation_revision(db, request)
}

pub fn narrative_extraction_get_run_review_bundle(
    db: &Database,
    payload: RunRefPayload,
) -> anyhow::Result<Value> {
    repository::get_run_review_bundle(db, payload.run_id, payload.project_id)
}

pub fn narrative_extraction_append_revision(
    db: &Database,
    payload: AppendRevisionPayload,
) -> anyhow::Result<Value> {
    repository::append_revision(db, payload)
}

pub fn narrative_extraction_append_revision_with_control(
    db: &Database,
    payload: AppendRevisionPayload,
    control: &mut dyn GraphWorkControl,
) -> anyhow::Result<Value> {
    repository::append_revision_with_control(db, payload, control)
}

pub fn narrative_extraction_append_decision(
    db: &Database,
    payload: AppendDecisionPayload,
) -> anyhow::Result<Value> {
    repository::append_decision(db, payload)
}

/// Human review endpoint. The actor class is fixed by this Native entrypoint;
/// renderer fields can request only exact field paths, never change the actor
/// or scope that Native records.
pub fn narrative_extraction_append_human_decision(
    db: &Database,
    payload: AppendDecisionPayload,
) -> anyhow::Result<Value> {
    repository::append_human_decision(db, payload)
}

pub fn narrative_extraction_revise_and_decide(
    db: &Database,
    payload: ReviseAndDecidePayload,
) -> anyhow::Result<Value> {
    repository::revise_and_decide(db, payload)
}

pub fn narrative_extraction_revise_and_decide_with_control(
    db: &Database,
    payload: ReviseAndDecidePayload,
    control: &mut dyn nir1_entity_relation_index::GraphWorkControl,
) -> anyhow::Result<Value> {
    repository::revise_and_decide_with_control(db, payload, control)
}

pub fn narrative_extraction_revise_and_decide_as_human(
    db: &Database,
    payload: ReviseAndDecidePayload,
) -> anyhow::Result<Value> {
    repository::revise_and_decide_as_human(db, payload)
}

pub fn narrative_extraction_revise_and_decide_as_human_with_control(
    db: &Database,
    payload: ReviseAndDecidePayload,
    control: &mut dyn nir1_entity_relation_index::GraphWorkControl,
) -> anyhow::Result<Value> {
    repository::revise_and_decide_as_human_with_control(db, payload, control)
}

pub fn narrative_extraction_prepare_commit(
    db: &Database,
    payload: PrepareCommitPayload,
) -> anyhow::Result<Value> {
    commit::narrative_extraction_prepare_commit(db, payload)
}

pub fn narrative_extraction_prepare_commit_with_control(
    db: &Database,
    payload: PrepareCommitPayload,
    control: &mut dyn nir1_entity_relation_index::GraphWorkControl,
) -> anyhow::Result<Value> {
    commit::narrative_extraction_prepare_commit_with_control(db, payload, Some(control))
}

pub fn narrative_extraction_apply_commit(
    db: &Database,
    payload: ApplyCommitPayload,
) -> anyhow::Result<Value> {
    commit::narrative_extraction_apply_commit(db, payload)
}

pub fn narrative_extraction_apply_commit_with_control(
    db: &Database,
    payload: ApplyCommitPayload,
    control: &mut dyn nir1_entity_relation_index::GraphWorkControl,
) -> anyhow::Result<Value> {
    commit::narrative_extraction_apply_commit_with_control(db, payload, Some(control))
}

pub fn narrative_extraction_get_commit_status(
    db: &Database,
    payload: GetCommitStatusPayload,
) -> anyhow::Result<Value> {
    commit::narrative_extraction_get_commit_status(db, payload)
}

pub fn narrative_extraction_undo_commit(
    db: &Database,
    payload: UndoCommitPayload,
) -> anyhow::Result<Value> {
    undo::narrative_extraction_undo_commit(db, payload)
}

pub fn narrative_extraction_redo_commit(
    db: &Database,
    payload: UndoCommitPayload,
) -> anyhow::Result<Value> {
    undo::narrative_extraction_redo_commit(db, payload)
}

/// Human-only CAS for explicit field locks. The Electron endpoint below is
/// the only production caller; automated Apply has no route to this function.
pub fn narrative_extraction_set_human_field_lock(
    db: &Database,
    payload: HumanFieldLockPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        crate::narrative_runtime_policy::require_narrative_extraction_allowed(conn)?;
        task_leases::with_immediate_transaction(conn, |conn| {
            field_authority::set_human_field_lock_in_tx(conn, &payload)
        })
    })
}

/// Workspace-wide bootstrap for Legacy Dependency Backfill (Gate C2 Run
/// Kind Policy `dependency-backfill`): every Project in the workspace that
/// doesn't already have a Backfill Run gets one. Unlike every other
/// function in this facade it is not an IPC command (no payload, no
/// `Value` return) and is best-effort by design — it logs and continues
/// past a per-project failure rather than propagating (a failed Backfill
/// must never fail the Workspace open itself; Legacy Freshness stays the
/// read authority either way, per the Run Kind Policy's
/// `duringBackfillProductBehavior`).
///
/// The durable C2-5B phase owner invokes the per-project implementation on
/// its live `Database` connection. This facade remains a compatibility entry
/// point for callers that need best-effort workspace bootstrap; it does not
/// own phase discovery or dispatch.
pub fn narrative_extraction_bootstrap_legacy_backfill(db: &Database) {
    let project_ids: Vec<String> = match db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT projects.id
               FROM projects
              WHERE NOT EXISTS (
                    SELECT 1
                      FROM project_settings
                     WHERE project_settings.project_id = projects.id
                       AND project_settings.key = 'scan.import.state'
                       AND project_settings.value = 'staging'
              )
              ORDER BY projects.created_at ASC, projects.id ASC",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }) {
        Ok(ids) => ids,
        Err(error) => {
            tracing::warn!(
                "legacy dependency backfill bootstrap: failed to list projects: {error}"
            );
            return;
        }
    };
    for project_id in project_ids {
        if let Err(error) =
            legacy_backfill::bootstrap_legacy_dependency_backfill_for_project(db, &project_id)
        {
            tracing::error!(
                "legacy dependency backfill bootstrap failed for project '{project_id}': {error}"
            );
        }
    }
}

pub fn temporal_scene_patch(
    db: &Database,
    payload: TemporalScenePatchPayload,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !payload.request_id.trim().is_empty(),
        "requestId is required"
    );
    anyhow::ensure!(
        !payload.session_id.trim().is_empty(),
        "sessionId is required"
    );
    anyhow::ensure!(!payload.event_uid.trim().is_empty(), "eventUid is required");
    let replay = matches!(
        payload.origin,
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
    );
    let complete_lineage = payload
        .original_transaction_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        && payload
            .undo_journal_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    anyhow::ensure!(
        replay == complete_lineage
            && (replay
                || (payload.original_transaction_id.is_none()
                    && payload.undo_journal_id.is_none())),
        "undo/redo origin requires originalTransactionId and undoJournalId"
    );
    let request_hash = canonical_write_payload_fingerprint("temporal_scene_patch", &payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "temporal_scene_patch",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "TEMPORAL_SCENE_REQUEST_CONFLICT",
    };
    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            if let Some(response) = load_idempotent_response(conn, &idempotency_request)? {
                return Ok(response);
            }
            if replay {
                let original_transaction_id = payload
                    .original_transaction_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("originalTransactionId is required"))?;
                let undo_journal_id = payload
                    .undo_journal_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("undoJournalId is required"))?;
                require_replay_lineage_in_project(
                    conn,
                    &payload.project_id,
                    original_transaction_id,
                    undo_journal_id,
                )?;
            }
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let before = temporal_operations::collect_scene_temporal_snapshot(
                conn,
                &payload.project_id,
                &payload.target_id,
            )?;
            let before_feed = crate::canonical_feed_snapshots::canonical_scene_snapshot(
                conn,
                &payload.project_id,
                &payload.target_id,
            )?;
            let (mut value, scene_scope_refresh_event) =
                temporal_operations::apply_scene_temporal_patch_in_tx(
                    conn,
                    &payload.project_id,
                    &payload,
                    &now,
                )?;
            if payload.origin == NarrativeChangeOrigin::Human {
                crate::narrative_extraction::record_human_field_write(
                    conn,
                    &payload.project_id,
                    "scene",
                    &payload.target_id,
                    &[
                        "/storyTimeOrder",
                        "/storyTimeLabel",
                        "/startTime",
                        "/startMinute",
                        "/startGranularity",
                        "/endTime",
                        "/endMinute",
                        "/endGranularity",
                        "/precision",
                    ],
                    &now,
                )?;
            }
            let version = value
                .get("version")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow::anyhow!("temporal scene patch result has no version"))?;
            let updated_at = value
                .get("updatedAt")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("temporal scene patch result has no updatedAt"))?;
            let source_key = format!("project:scene:{}", payload.target_id);
            let source_token = format!("v{version}@{updated_at}");
            crate::narrative_extraction::propagate_source_change_freshness_in_tx(
                conn,
                &payload.project_id,
                "scene-body",
                &source_key,
                Some(&source_token),
                &now,
                &payload.session_id,
            )?;
            let after = temporal_operations::collect_scene_temporal_snapshot(
                conn,
                &payload.project_id,
                &payload.target_id,
            )?;
            let after_feed = crate::canonical_feed_snapshots::canonical_scene_snapshot(
                conn,
                &payload.project_id,
                &payload.target_id,
            )?;
            let undo_journal_id = payload
                .undo_journal_id
                .clone()
                .unwrap_or_else(|| payload.request_id.clone());
            if !replay {
                let before_json = serde_json::to_string(&before)?;
                let after_json = serde_json::to_string(&after)?;
                crate::undo_journal::insert_undo_journal_in_tx(
                    conn,
                    crate::undo_journal::UndoJournalInsert {
                        id: &undo_journal_id,
                        project_id: &payload.project_id,
                        surface: "tree",
                        entity_kind: "scene_temporal",
                        entity_id: &payload.target_id,
                        op_kind: "update",
                        before_json: Some(&before_json),
                        after_json: Some(&after_json),
                        base_version: payload.base_version,
                        result_version: version,
                        change_event_uid: Some(&payload.event_uid),
                    },
                )?;
            }
            let field_paths = [
                ("endGranularity", "/endGranularity"),
                ("endMinute", "/endMinute"),
                ("endTime", "/endTime"),
                ("precision", "/precision"),
                ("startGranularity", "/startGranularity"),
                ("startMinute", "/startMinute"),
                ("startTime", "/startTime"),
                ("storyTimeLabel", "/storyTimeLabel"),
                ("storyTimeOrder", "/storyTimeOrder"),
            ];
            let mut changed_paths = field_paths
                .iter()
                .filter(|(field, _)| before.get(*field) != after.get(*field))
                .map(|(_, path)| (*path).to_string())
                .collect::<Vec<_>>();
            if changed_paths.is_empty() {
                changed_paths.push("/version".to_string());
            }
            let timestamp = chrono::DateTime::parse_from_rfc3339(&now)
                .map(|value| value.timestamp_millis())
                .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());
            let append = append_canonical_and_narrative_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &AppendChangeEvent {
                    event_uid: payload.event_uid.clone(),
                    scene_id: Some(payload.target_id.clone()),
                    domain: "tree".to_string(),
                    op_type: "temporal.scene.patch".to_string(),
                    entity_type: Some("scene".to_string()),
                    entity_id: Some(payload.target_id.clone()),
                    payload: serde_json::json!({
                        "fields": changed_paths.clone(),
                        "before": before.clone(),
                        "after": after.clone(),
                    })
                    .to_string(),
                    timestamp,
                },
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: "temporal.scene.patch".to_string(),
                    source_change_event_uid: payload.event_uid.clone(),
                    cause_kind: match payload.origin {
                        NarrativeChangeOrigin::Undo => NarrativeChangeCauseKind::Undo,
                        NarrativeChangeOrigin::Redo => NarrativeChangeCauseKind::Redo,
                        _ => NarrativeChangeCauseKind::Forward,
                    },
                    origin: payload.origin,
                    original_transaction_id: payload.original_transaction_id.clone(),
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: Some(undo_journal_id.clone()),
                    application_ids: Vec::new(),
                    occurred_at: now,
                    events: vec![
                        NarrativeChangeEventInput {
                            object_key: serde_json::json!({
                                "kind": "scene",
                                "sceneId": payload.target_id,
                            }),
                            change_kind: if changed_paths
                                .iter()
                                .any(|path| path == "/storyTimeOrder" || path == "/storyTimeLabel")
                            {
                                "order".to_string()
                            } else {
                                "calendar".to_string()
                            },
                            mutation_kind: "update".to_string(),
                            before_version: Some(payload.base_version),
                            before_digest: Some(narrative_snapshot_digest(&before_feed)?),
                            after_version: Some(version),
                            after_digest: Some(narrative_snapshot_digest(&after_feed)?),
                            structural_impact: Some(serde_json::json!({
                                "changedPaths": changed_paths.clone(),
                            })),
                            changed_paths,
                            text_impact: None,
                        },
                        scene_scope_refresh_event,
                    ],
                },
            )?;
            value["maintenanceTransactionId"] = Value::String(append.narrative.transaction_id);
            value["changeEventUid"] = Value::String(payload.event_uid.clone());
            value["undoJournalId"] = Value::String(undo_journal_id);
            insert_idempotent_response(conn, &idempotency_request, &payload.project_id, &value)?;
            Ok(value)
        })();
        match result {
            Ok(value) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

#[cfg(feature = "nir1-material-diagnostics")]
pub mod disclosure_precheck;

#[cfg(feature = "nir1-material-diagnostics")]
pub mod disclosure_policy;
