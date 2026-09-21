//! Grimodex Electron シェルの Rust バックエンド (Electron 移行 Phase 2 S2、
//! 設計書 §4.2 / §4.3)。
//!
//! `#[napi]` class `Backend` が grimodex-db の `WorkspaceState` を保持し、
//! 垂直スライスのコマンド群 + `onEvent` を Node (Electron main) へ公開する。
//!
//! - **全公開関数は async + `spawn_blocking`** (軽量 stat の
//!   `validate_workspace_path` と、終了を確実に待つ
//!   `ime_export_deactivate_on_exit` を除く)。同期 `#[napi]` は Node main thread =
//!   Electron main プロセス全体をブロックする (Phase 0 スパイク実証) —
//!   busy_timeout 5s を踏んだ db_execute が全窓の IPC を止める事故を構造的に防ぐ。
//! - 返り値は当面 **JSON 文字列** (rows の二重シリアライズは Phase 3 の最適化
//!   候補として記録済み。§4.2)。
//! - エラーは `AppError` の Display 文字列をそのまま reason に載せる (§5.2 の
//!   文字列ワイヤ契約。convert.rs 参照)。

mod convert;
#[cfg(feature = "legacy-keyring-migration")]
mod legacy_keyring;
mod narrative_maintenance;
mod post_effect_runtime;
mod profile_egress;
mod related_scenes;
mod related_scenes_build_registry;
mod related_scenes_context;
mod related_scenes_query;
mod related_scenes_registry;
mod state;
#[cfg(test)]
mod test_link_stubs;
mod workspace_lifecycle_view;

use std::io::Write;
use std::ops::{Deref, DerefMut};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadSafeCallContext;
use napi::JsFunction;
use napi_derive::napi;

use grimodex_core::codex_matching::{CachedMatcher, CodexMatch, MatchEntry};
use grimodex_db::agent_writes;
use grimodex_db::ai_audit::{sanitize_diagnostic_credentials, AppendAiAuditEvent};
#[cfg(test)]
use grimodex_db::backup_restore::restore_backup_core;
use grimodex_db::backup_restore::{list_backups, restore_backup_core_with_open_lock};
use grimodex_db::change_events::AppendChangeEvent;
use grimodex_db::chronicle::{self, SetParticipantsPayload, UpsertProjectCalendarPayload};
use grimodex_db::domain_writes::{
    self, ApplyAiTreePlanPayload, CodexRenameApplyPayload, CodexRenameUndoPayload,
    CreateScanStagingProjectPayload, ProjectCreatePayload, ProjectDeletePayload,
    ProjectPatchPayload, ReplaceAuthorshipLanePayload, ScanStagingProjectPublishPayload,
    SetEntityTagsPayload, TreeNodeCreatePayload, TreeNodeDeletePayload, TreeNodePatchPayload,
    UndoAiTreePlanPayload,
};
use grimodex_db::editor_stickies;
use grimodex_db::events::EventSink;
use grimodex_db::foreshadow::{
    self, ForeshadowCreatePayload, ForeshadowDeletePayload, ForeshadowPatch, ForeshadowSetupPatch,
};
use grimodex_db::ime_export::{
    clear_all_exports, get_status as get_ime_export_status, refresh_project_export,
    remove_project_export_if_absent, resolve_mode_from_preferences,
    resolve_options_from_preferences, set_active_project, ImeExportOptions, ImeExportRequestGate,
    ImeExportRequestToken, ImeIntegrationMode,
};
use grimodex_db::lint_ignores::{self, CopyPayload, CreatePayload, MovePayload};
use grimodex_db::lint_terms::{
    self, InsertPayload as LintTermInsertPayload, UpdatePayload as LintTermUpdatePayload,
};
use grimodex_db::map_writes::{self, MapWritePayload};
use grimodex_db::narrative_extraction::{
    self, AttentionDisposition, AutomaticRunKind, FreshnessLifecycleControl,
    GetNarrativeBackfillStatusPayload, GraphWorkControl, GraphWorkStage,
    IsRunResumableForReviewPayload, LegacyBackfillBootstrapOutcome, LegacyBackfillFaultOutcome,
    ListChronicleTaskResumeCandidatesPayload, ListResumableRunsPayload, MaintenanceCycleControl,
    MaintenanceCycleRequest, MaintenanceCycleStatus, MaintenanceWorkspaceBinding,
    NarrativeMaintenanceAttentionClearPayload, NarrativeMaintenanceAttentionSetPayload,
    NarrativeMaintenanceCiConfig, NarrativeMaintenanceCiFault, NarrativeMaintenanceCiTrigger,
    NarrativeMaintenanceInboxListPayload, RebuildDerivedStateOutcome,
    RebuildNarrativeDerivedStatePayload, RepairNarrativeDependencyDeclarationsPayload,
    RetryNarrativeLegacyBackfillPayload, RunRefPayload, TemporalScenePatchPayload,
    VerifyNarrativeDependencyGraphPayload, WorkKey,
};
use grimodex_db::narrative_extraction::{validation_terminated, ValidationTerminationReason};
use grimodex_db::open::{
    open_workspace_sync_traced_with_pre_swap, NativeWorkspaceOpenResult,
    NativeWorkspaceOpenSpanName, NativeWorkspaceOpenTrace,
};
use grimodex_db::plot_threads::{
    self, PlotDeletePayload, PlotThreadBranchCreatePayload, PlotThreadBranchPatch,
    PlotThreadCreatePayload, PlotThreadDeleteSnapshotPayload, PlotThreadLinkCreatePayload,
    PlotThreadLinkPatch, PlotThreadMoveMarkerBundlePayload, PlotThreadPatch,
    PlotThreadRestoreSnapshotPayload,
};
use grimodex_db::post_effect::{self, ReplyToAnnotationArgs};
use grimodex_db::project_snapshots::{
    self, ApplyProjectSnapshotRestorePayload, CreateProjectSnapshotPayload, RestoreScope,
};
use grimodex_db::recovery::{
    export_safe_mode_diagnostics, list_safe_mode_candidates, quarantine_live_database,
    restore_safe_mode_candidate, verify_safe_mode_candidate,
};
use grimodex_db::revision_restore::{self, RestoreSceneRevisionPayload};
use grimodex_db::runtime_performance_seed::{self, RuntimePerformanceSeedPayload};
use grimodex_db::sample_seed;
use grimodex_db::scene_body::{self, SaveSceneBodyBundlePayload};
use grimodex_db::state::{
    active_database, active_workspace_path, active_workspace_snapshot, ActiveWorkspace,
    ActiveWorkspaceSnapshot, PinnedWorkspaceDb, WorkspaceAuthority,
};
use grimodex_db::timelapse::{TimelapseBodySnapshotTarget, TimelapseGenesisBaselineKind};
use grimodex_db::trash_bin::{self, TrashBinCreatePayload, TrashBinRestorePayload};
use grimodex_db::web_editor_handoff;
use grimodex_db::workspace::{self, GlobalSettings};
use grimodex_db::workspace_lease::try_acquire_shared;
use grimodex_db::{
    with_db_state, AdmissionKind, AdmissionOutcome, AdmissionRejection, AppError, BatchStatement,
    ControlRequest, ControlSlotOutcome, Database, DeliveryAdmissionOutcome, DeliverySequence,
    LifecycleSnapshot, LifecycleState, MaintenancePermit, OperationId, PermitAdmission,
    RepairIntegrityPayload, TransitionStage,
};

use convert::{app_err_to_napi, from_wire, join_err_to_napi, lint_err_to_napi, params_array};
use post_effect_runtime::{NodePostEffectAiClient, NodePostEffectRuntime};
use state::{
    AppState, EventQueue, EventTsfn, NarrativeMaintenanceCleanupOutcome,
    NarrativeMaintenanceRecoveryReceipt,
};
use uuid::Uuid;
use workspace_lifecycle_view::{
    LifecycleTerminalKind, WorkspaceLifecycleStatus, WorkspaceLifecycleView,
    WorkspaceLifecycleViewAdapter, WORKSPACE_LIFECYCLE_EVENT,
};

#[cfg(test)]
fn install_test_workspace(state: &AppState, authority: PinnedWorkspaceDb) {
    let authority_id = narrative_authority_id(&authority);
    let generation = state
        .narrative_maintenance_recovery_gate
        .binding_for_authority(&authority_id)
        .generation;
    let workspace_id = std::fs::read_to_string(authority.path().join(".grimodex/workspace.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| authority_id.clone());
    let binding = grimodex_db::LiveBinding::new(
        authority.path().to_string_lossy(),
        workspace_id,
        authority.identity(),
        generation,
    );
    *state.ws.inner.lock().expect("workspace lock") = Some(ActiveWorkspace::new(authority));
    state
        .ws
        .switching
        .core()
        .set_ready(binding)
        .expect("test workspace lifecycle ready");
}

#[cfg(test)]
mod narrative_maintenance_rebound_tests {
    use super::*;
    use grimodex_db::state::WorkspaceAuthority;
    use std::collections::BTreeSet;

    #[test]
    fn same_path_reopen_returns_a_rebound_binding_for_a_new_authority_instance() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-maintenance-rebound-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let workspace_path = root.join("workspace");
        std::fs::create_dir_all(workspace_path.join(".grimodex")).expect("metadata directory");
        std::fs::write(
            workspace_path.join(".grimodex/workspace.json"),
            serde_json::json!({"id": "same-workspace"}).to_string(),
        )
        .expect("workspace metadata");
        let old_database =
            Database::new(&workspace_path.join("grimodex.db")).expect("old database");
        old_database.migrate().expect("old migration");
        let old_authority =
            WorkspaceAuthority::from_database_for_test(old_database, workspace_path.clone())
                .expect("old authority");
        let expected = grimodex_db::LiveBinding::new(
            workspace_path.to_string_lossy(),
            "same-workspace",
            old_authority.identity(),
            1,
        );
        drop(old_authority);

        let replacement_database =
            Database::new(&workspace_path.join("grimodex.db")).expect("replacement database");
        let replacement = WorkspaceAuthority::from_database_for_test(
            replacement_database,
            workspace_path.clone(),
        )
        .expect("replacement authority");
        assert_ne!(expected.authority_instance, replacement.identity());
        let state = AppState::new(
            &root.to_string_lossy(),
            &root.join("resources").to_string_lossy(),
        )
        .expect("app state");
        install_test_workspace(&state, Arc::clone(&replacement));
        let before_rotation = narrative_maintenance_binding_for_authority(&state, &replacement);
        let descriptor = grimodex_db::workspace_lifecycle::RecoveryDescriptor {
            descriptor_id: grimodex_db::RecoveryDescriptorId::new(1),
            root_operation_id: grimodex_db::OperationId::new(1),
            owner: grimodex_db::workspace_lifecycle::RecoveryDescriptorOwner::WorkspaceTransition,
            expected_binding: Some(expected),
            run: None,
            additional_runs: Vec::new(),
            responsibility: None,
            control_generation: grimodex_db::ControlGeneration::new(1),
            resolved: false,
            delivery_sequences: BTreeSet::new(),
        };

        let rotated = state
            .narrative_maintenance_recovery_gate
            .rotate_generation_for_binding(&before_rotation)
            .expect("same authority rotates its recovery generation");
        let receipt_active = narrative_maintenance_binding_for_authority(&state, &replacement);
        let receipt_rebound = descriptor_rebound_binding_for_authority(
            &state,
            &descriptor,
            &replacement,
            &replacement,
        )
        .expect("same-path replacement has a rebound proof");
        assert_eq!(receipt_active, rotated);
        assert_eq!(receipt_rebound, receipt_active);
        assert_ne!(receipt_active.generation, before_rotation.generation);

        let rebound = descriptor_rebound_binding_for_authority(
            &state,
            &descriptor,
            &replacement,
            &replacement,
        )
        .expect("same-path replacement must produce a rebound proof");
        assert!(!rebound.authority_id.is_empty());
        assert!(rebound.generation > 0);

        drop(replacement);
        let _ = std::fs::remove_dir_all(root);
    }
}

const RUNTIME_PERFORMANCE_OWNER_TOKEN_ENV: &str = "GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN";
const NARRATIVE_MAINTENANCE_EPOCH_ROTATED_EVENT: &str = "narrative-maintenance:epoch-rotated";

type NarrativeCiProjectCursorRow = (
    Option<String>,
    i64,
    Option<i64>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
);

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimelapseBodyBaselineTargetWire {
    kind: String,
    id: String,
}

fn narrative_authority_id(authority: &PinnedWorkspaceDb) -> String {
    // Workspace metadata survives a process restart, while the recovery gate
    // generation is unique to the live Backend and still changes for an
    // in-process authority replacement. A durable foreground marker can be
    // rediscovered for startup recovery, but cannot be released by a fresh
    // process merely because it reopened the same workspace path.
    let metadata_path = authority.path().join(".grimodex/workspace.json");
    if let Ok(raw) = std::fs::read_to_string(metadata_path) {
        if let Ok(metadata) = serde_json::from_str::<grimodex_db::workspace::WorkspaceMeta>(&raw) {
            if !metadata.id.is_empty() && metadata.id == metadata.id.trim() {
                return format!("workspace:{}", metadata.id);
            }
        }
    }
    format!("authority:{}", authority.identity())
}

fn is_narrative_maintenance_cleanup_failure(error: &impl std::fmt::Display) -> bool {
    let message = error.to_string();
    message.contains("NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED")
        || message.contains("NIR1_MAINTENANCE_CONNECTION_UNUSABLE")
        || message.contains("NEX_MAINTENANCE_CONNECTION_UNUSABLE")
}

fn is_narrative_maintenance_preemption(error: &impl std::fmt::Display) -> bool {
    if is_narrative_maintenance_cleanup_failure(error) {
        return false;
    }
    let message = error.to_string();
    message.starts_with("NEX_MAINTENANCE_CONNECTION_PREEMPTED")
        || message.contains("NEX_VALIDATION_TERMINATED:foreground-preempted")
}

fn is_expected_c2zc_cutover_not_ready(error: &anyhow::Error) -> bool {
    error.to_string().starts_with("NEX_C2ZC_CUTOVER_NOT_READY:")
}

fn require_held_cutover_not_ready(cutover_not_ready: bool) -> std::result::Result<(), AppError> {
    if cutover_not_ready {
        Ok(())
    } else {
        Err(AppError::Anyhow(anyhow::anyhow!(
            "NEX_MAINTENANCE_CI_FRESHNESS_HOLD_CUTOVER_READY: held Freshness candidate unexpectedly passed the canonical cutover gate"
        )))
    }
}

/// Return the post-cycle state that a CI product journey may use to bind a
/// main-process quiescence receipt.  This deliberately lives beside the
/// existing freshness scheduler call instead of becoming a read/N-API
/// command: the values are read from the same pinned Database after the
/// successful cycle has been revalidated.
fn narrative_ci_quiescence_state(
    db: &Database,
    binding: &MaintenanceWorkspaceBinding,
    freshness_hold_project_id: Option<&str>,
    held_project_id: Option<&str>,
) -> anyhow::Result<serde_json::Value> {
    narrative_ci_quiescence_state_with_snapshot_hook(
        db,
        binding,
        freshness_hold_project_id,
        held_project_id,
        None,
    )
}

fn narrative_ci_quiescence_state_with_snapshot_hook(
    db: &Database,
    binding: &MaintenanceWorkspaceBinding,
    freshness_hold_project_id: Option<&str>,
    held_project_id: Option<&str>,
    after_project_ids: Option<&dyn Fn()>,
) -> anyhow::Result<serde_json::Value> {
    binding.validate()?;
    if let Some(held_project_id) = held_project_id {
        anyhow::ensure!(
            freshness_hold_project_id == Some(held_project_id),
            "NEX_MAINTENANCE_CI_FRESHNESS_HOLD_RESULT_MISMATCH: held project does not match the effective CI hold"
        );
    }
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN DEFERRED TRANSACTION")?;
        let result = (|| -> anyhow::Result<serde_json::Value> {
            let project_ids: Vec<String> = {
                let mut statement = conn.prepare("SELECT id FROM projects ORDER BY id ASC")?;
                let project_ids = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                project_ids
            };
            if let Some(after_project_ids) = after_project_ids {
                after_project_ids();
            }
            let mut projects = Vec::with_capacity(project_ids.len());
            for project_id in project_ids {
                let (
                    current_epoch_id,
                    feed_head,
                    acknowledged_through,
                    reserved_through,
                    active_run_id,
                    cursor_epoch_id,
                    last_error,
                ): NarrativeCiProjectCursorRow = conn.query_row(
                    "SELECT
                    (SELECT id
                       FROM narrative_semantic_epochs
                      WHERE project_id = ?1
                      ORDER BY epoch_number DESC, id DESC
                      LIMIT 1),
                    COALESCE((SELECT MAX(canonical_sequence)
                                FROM narrative_change_events
                               WHERE project_id = ?1), 0),
                    (SELECT acknowledged_through_sequence
                       FROM narrative_change_cursors
                      WHERE project_id = ?1
                        AND consumer_id = 'narrative-incremental-freshness/v1'
                      LIMIT 1),
                    (SELECT reserved_through_sequence
                       FROM narrative_change_cursors
                      WHERE project_id = ?1
                        AND consumer_id = 'narrative-incremental-freshness/v1'
                      LIMIT 1),
                    (SELECT active_run_id
                       FROM narrative_change_cursors
                      WHERE project_id = ?1
                        AND consumer_id = 'narrative-incremental-freshness/v1'
                      LIMIT 1),
                    (SELECT semantic_epoch_id
                       FROM narrative_change_cursors
                      WHERE project_id = ?1
                        AND consumer_id = 'narrative-incremental-freshness/v1'
                      LIMIT 1),
                    (SELECT last_error
                       FROM narrative_change_cursors
                      WHERE project_id = ?1
                        AND consumer_id = 'narrative-incremental-freshness/v1'
                      LIMIT 1)",
                    [project_id.as_str()],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    },
                )?;
                projects.push(serde_json::json!({
                    "projectId": project_id,
                    "currentEpochId": current_epoch_id,
                    "feedHead": feed_head,
                    "cursor": {
                        "acknowledgedThrough": acknowledged_through,
                        "reservedThrough": reserved_through,
                        "activeRunId": active_run_id,
                        "semanticEpochId": cursor_epoch_id,
                        "lastError": last_error,
                    },
                }));
            }

            let (marker_migration_id, marker_contract_version, marker_applied_at): (
                Option<String>,
                Option<i64>,
                Option<String>,
            ) = conn.query_row(
                "SELECT
                (SELECT migration_id
                   FROM schema_data_migrations
                  WHERE migration_id = ?1
                  ORDER BY applied_at DESC
                  LIMIT 1),
                (SELECT contract_version
                   FROM schema_data_migrations
                  WHERE migration_id = ?1
                  ORDER BY applied_at DESC
                  LIMIT 1),
                (SELECT applied_at
                   FROM schema_data_migrations
                  WHERE migration_id = ?1
                  ORDER BY applied_at DESC
                  LIMIT 1)",
                [grimodex_db::narrative_extraction::C2_ZC_CUTOVER_MIGRATION_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let marker = marker_migration_id.map(|migration_id| {
                serde_json::json!({
                    "migrationId": migration_id,
                    "contractVersion": marker_contract_version,
                    "appliedAt": marker_applied_at,
                })
            });
            let mut state = serde_json::json!({
                "authorityId": binding.authority_id.clone(),
                "generation": binding.generation,
                "freshnessHoldProjectId": freshness_hold_project_id,
                "heldProjectId": held_project_id,
                "projects": projects,
                "marker": marker,
            });
            let digest = format!(
                "sha256:{}",
                grimodex_db::narrative_extraction::digest_plan(&state)
            );
            state["stateDigest"] = serde_json::Value::String(digest);
            Ok(state)
        })();
        match result {
            Ok(state) => {
                conn.execute_batch("COMMIT")?;
                Ok(state)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

#[cfg(test)]
mod narrative_extraction_workspace_binding_tests {
    use super::*;
    use grimodex_db::state::{PinnedWorkspaceDb, WorkspaceAuthority};
    use std::sync::Arc;

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "grimodex-node-extraction-binding-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    fn workspace_authority(
        root: &std::path::Path,
        directory: &str,
        metadata_id: &str,
    ) -> (PinnedWorkspaceDb, PathBuf) {
        let workspace_path = root.join(directory);
        let metadata_dir = workspace_path.join(".grimodex");
        std::fs::create_dir_all(&metadata_dir).expect("workspace metadata directory");
        std::fs::write(
            metadata_dir.join("workspace.json"),
            serde_json::json!({
                "id": metadata_id,
                "created_at": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .expect("workspace metadata");
        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        database
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO projects (id, title) VALUES ('project-1', 'Project')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed project");
        let authority =
            WorkspaceAuthority::from_database_for_test(database, workspace_path.clone())
                .expect("workspace authority");
        (authority, workspace_path)
    }

    fn extraction_run_payload(run_id: &str) -> serde_json::Value {
        serde_json::json!({
            "runId": run_id,
            "projectId": "project-1",
            "surfacePathId": "binding-regression",
            "scopeJson": {},
            "specJson": { "domain": "binding-regression" },
            "specDigest": "binding-regression-spec",
            "snapshotDigest": "binding-regression-snapshot",
            "tasks": [{
                "taskId": format!("{run_id}-task"),
                "taskKind": "binding-regression-task",
                "inputJson": {},
                "priority": 1
            }]
        })
    }

    fn table_count(authority: &PinnedWorkspaceDb, table: &str) -> i64 {
        authority
            .db()
            .with_conn(|conn| {
                Ok(
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                        row.get(0)
                    })?,
                )
            })
            .expect("table count")
    }

    #[tokio::test]
    async fn stale_binding_never_writes_same_metadata_clone_before_generation_rotates() {
        let root = test_root();
        let resources = root.join("resources");
        let (authority_a, path_a) = workspace_authority(&root, "workspace-a", "clone-id");
        let state = AppState::new(&root.to_string_lossy(), &resources.to_string_lossy())
            .expect("app state");
        install_test_workspace(&state, Arc::clone(&authority_a));
        let backend = Backend {
            state: Arc::new(state),
        };

        // Canonical path equality accepts an equivalent lexical path instead
        // of rejecting it on Windows/UNC or through a `.` component.
        let binding_json = backend
            .narrative_extraction_capture_workspace_binding(
                path_a.join(".").to_string_lossy().to_string(),
            )
            .await
            .expect("capture Workspace A binding");
        let binding: serde_json::Value = serde_json::from_str(&binding_json).expect("binding JSON");
        assert_eq!(
            binding["authorityInstanceId"],
            authority_a.identity().to_string()
        );

        backend
            .narrative_extraction_create_run(extraction_run_payload("run-a"), binding.clone())
            .await
            .expect("create Run in A");
        let claim: serde_json::Value = serde_json::from_str(
            &backend
                .narrative_extraction_claim_task(
                    serde_json::json!({
                        "runId": "run-a",
                        "projectId": "project-1",
                        "leaseOwner": "binding-test",
                        "taskKinds": ["binding-regression-task"]
                    }),
                    binding.clone(),
                )
                .await
                .expect("claim A Task"),
        )
        .expect("claim JSON");
        assert_eq!(claim["claimed"], true);

        let (authority_b, _) = workspace_authority(&root, "workspace-b", "clone-id");
        // Model the narrow production handoff: the new DB authority is already
        // published, while the recovery generation has not rotated yet.
        install_test_workspace(&backend.state, Arc::clone(&authority_b));

        let stale_create = backend
            .narrative_extraction_create_run(
                extraction_run_payload("run-must-not-land-in-b"),
                binding.clone(),
            )
            .await
            .expect_err("Workspace A binding cannot create a Run in B");
        assert!(stale_create
            .to_string()
            .contains("NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED"));

        let stale_finish = backend
            .narrative_extraction_finish_task(
                serde_json::json!({
                    "runId": "run-a",
                    "projectId": "project-1",
                    "taskId": claim["task"]["taskId"],
                    "attemptId": claim["task"]["attemptId"],
                    "leaseOwner": "binding-test",
                    "outputJson": { "completed": true },
                    "artifacts": [{
                        "artifactKind": "binding-regression-artifact",
                        "payloadStorage": "inline-json",
                        "payloadJson": { "value": "must-not-land-in-b" }
                    }]
                }),
                binding,
            )
            .await
            .expect_err("claimed A Task cannot finish in B");
        assert!(stale_finish
            .to_string()
            .contains("NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED"));

        assert_eq!(table_count(&authority_b, "narrative_extraction_runs"), 0);
        assert_eq!(table_count(&authority_b, "narrative_extraction_tasks"), 0);
        assert_eq!(
            table_count(&authority_b, "narrative_extraction_artifacts"),
            0
        );
        let a_task_status: String = authority_a
            .db()
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT status FROM narrative_extraction_tasks WHERE id = 'run-a-task'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("A task status");
        assert_eq!(a_task_status, "running");

        drop(authority_a);
        drop(authority_b);
        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod narrative_freshness_restore_lock_tests {
    use super::*;
    use grimodex_db::state::WorkspaceAuthority;
    use std::sync::{mpsc, Arc, TryLockError};
    use std::time::{Duration, Instant};

    struct TestRoot(PathBuf);

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn completed_freshness_cycle_releases_authority_before_restore_quiescence() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-node-freshness-restore-lock-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let cleanup = TestRoot(root.clone());
        let workspace_path = root.join("workspace");
        let resources = root.join("resources");
        let metadata_dir = workspace_path.join(".grimodex");
        std::fs::create_dir_all(&metadata_dir).expect("workspace metadata directory");
        std::fs::write(
            metadata_dir.join("workspace.json"),
            serde_json::json!({
                "id": "freshness-restore-lock",
                "created_at": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .expect("workspace metadata");

        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        database
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed project");
        let backup_name = "grimodex-freshness-restore-lock.db";
        let backups_dir = workspace_path.join("backups");
        std::fs::create_dir_all(&backups_dir).expect("backups directory");
        database
            .backup_to(&backups_dir.join(backup_name))
            .expect("write restore candidate");

        let authority =
            WorkspaceAuthority::from_database_for_test(database, workspace_path.clone())
                .expect("workspace authority");
        let old_authority_identity = authority.identity();
        let state = Arc::new(
            AppState::new(&root.to_string_lossy(), &resources.to_string_lossy())
                .expect("app state"),
        );
        install_test_workspace(&state, authority);

        let (cycle_completed_tx, cycle_completed_rx) = mpsc::channel();
        let (release_cycle_tx, release_cycle_rx) = mpsc::channel();
        let cycle_state = Arc::clone(&state);
        let cycle_thread = std::thread::spawn(move || {
            run_narrative_freshness_cycle_inner(&cycle_state, || {
                cycle_completed_tx
                    .send(())
                    .expect("publish cycle completion");
                release_cycle_rx.recv().expect("release cycle finalization");
            })
        });
        cycle_completed_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("freshness cycle completed before authority recheck");

        let restore_state = Arc::clone(&state);
        let restore_thread = std::thread::spawn(move || {
            let state_for_hook = Arc::clone(&restore_state);
            restore_backup_core(&restore_state.ws, backup_name, move || {
                state_for_hook
                    .narrative_maintenance_recovery_gate
                    .mark_workspace_swapped();
            })
        });

        // restore_backup_core takes open_lock before detaching the active
        // authority and entering wait_for_sole_owner. Observe that exact lock
        // boundary without timing sleeps, then let freshness finalize.
        let lock_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match state.ws.open_lock.try_lock() {
                Err(TryLockError::WouldBlock) => break,
                Err(TryLockError::Poisoned(error)) => {
                    panic!("workspace open lock poisoned: {error}")
                }
                Ok(guard) => {
                    drop(guard);
                    assert!(
                        Instant::now() < lock_deadline,
                        "restore did not acquire workspace open lock"
                    );
                    std::thread::yield_now();
                }
            }
        }
        release_cycle_tx
            .send(())
            .expect("release freshness finalization");

        let restore_result = restore_thread.join().expect("restore thread");
        let cycle_result = cycle_thread.join().expect("freshness thread");
        // wait_for_sole_owner() owns the bounded pin-drain failure; keep
        // unrelated restore I/O latency out of this ordering contract.
        restore_result.expect("restore must not time out waiting for freshness authority");
        let restored_for_core = state
            .ws
            .inner
            .lock()
            .expect("workspace state")
            .as_ref()
            .expect("restored workspace")
            .authority
            .clone();
        install_test_workspace(&state, restored_for_core);
        assert!(
            cycle_result
                .expect("workspace replacement is a fail-soft scheduler outcome")
                .is_none(),
            "restored authority must reject the old cycle without a heartbeat"
        );

        let restored_authority = active_database(&state.ws).expect("restored authority");
        assert_ne!(restored_authority.identity(), old_authority_identity);
        drop(restored_authority);
        let active = state.ws.inner.lock().expect("workspace state").take();
        drop(active);
        drop(state);
        drop(cleanup);
        assert!(!root.exists(), "fixture must clean up");
    }

    #[test]
    fn maintenance_revalidation_releases_both_cycle_pins_before_restore_quiescence() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-node-maintenance-restore-lock-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let cleanup = TestRoot(root.clone());
        let workspace_path = root.join("workspace");
        let resources = root.join("resources");
        let metadata_dir = workspace_path.join(".grimodex");
        std::fs::create_dir_all(&metadata_dir).expect("workspace metadata directory");
        std::fs::write(
            metadata_dir.join("workspace.json"),
            serde_json::json!({
                "id": "maintenance-restore-lock",
                "created_at": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .expect("workspace metadata");

        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        database
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed project");
        let backup_name = "grimodex-maintenance-restore-lock.db";
        let backups_dir = workspace_path.join("backups");
        std::fs::create_dir_all(&backups_dir).expect("backups directory");
        database
            .backup_to(&backups_dir.join(backup_name))
            .expect("write restore candidate");

        let authority =
            WorkspaceAuthority::from_database_for_test(database, workspace_path.clone())
                .expect("workspace authority");
        let old_authority_identity = authority.identity();
        let state = Arc::new(
            AppState::new(&root.to_string_lossy(), &resources.to_string_lossy())
                .expect("app state"),
        );
        let expected_binding = narrative_maintenance_binding_for_authority(&state, &authority);
        install_test_workspace(&state, authority);
        let completed_authority = active_database(&state.ws).expect("cycle authority");
        let validation_snapshot =
            active_workspace_snapshot(&state.ws).expect("cycle validation snapshot");
        let validation_authority = validation_snapshot.authority.clone();
        drop(validation_snapshot);

        let (cycle_completed_tx, cycle_completed_rx) = mpsc::channel();
        let (release_cycle_tx, release_cycle_rx) = mpsc::channel();
        let revalidation_state = Arc::clone(&state);
        let revalidation_thread = std::thread::spawn(move || {
            let current = revalidate_narrative_workspace_after_cycle(
                &revalidation_state,
                completed_authority,
                vec![validation_authority],
                &expected_binding,
                || {
                    cycle_completed_tx
                        .send(())
                        .expect("publish cycle completion");
                    release_cycle_rx.recv().expect("release cycle finalization");
                },
            )?;
            Ok::<_, AppError>(current.is_some())
        });
        cycle_completed_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("maintenance cycle completed before authority recheck");

        let restore_state = Arc::clone(&state);
        let restore_thread = std::thread::spawn(move || {
            let state_for_hook = Arc::clone(&restore_state);
            restore_backup_core(&restore_state.ws, backup_name, move || {
                state_for_hook
                    .narrative_maintenance_recovery_gate
                    .mark_workspace_swapped();
            })
        });
        let lock_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match state.ws.open_lock.try_lock() {
                Err(TryLockError::WouldBlock) => break,
                Err(TryLockError::Poisoned(error)) => {
                    panic!("workspace open lock poisoned: {error}")
                }
                Ok(guard) => {
                    drop(guard);
                    assert!(
                        Instant::now() < lock_deadline,
                        "restore did not acquire workspace open lock"
                    );
                    std::thread::yield_now();
                }
            }
        }
        release_cycle_tx
            .send(())
            .expect("release maintenance finalization");

        let restore_result = restore_thread.join().expect("restore thread");
        let revalidation_result = revalidation_thread.join().expect("revalidation thread");
        // wait_for_sole_owner() owns the bounded pin-drain failure; keep
        // unrelated restore I/O latency out of this ordering contract.
        restore_result.expect("restore must not time out waiting for maintenance authorities");
        let restored_for_core = state
            .ws
            .inner
            .lock()
            .expect("workspace state")
            .as_ref()
            .expect("restored workspace")
            .authority
            .clone();
        install_test_workspace(&state, restored_for_core);
        assert!(
            !revalidation_result.expect("maintenance revalidation"),
            "replacement authority must reject the completed old cycle"
        );

        let restored_authority = active_database(&state.ws).expect("restored authority");
        assert_ne!(restored_authority.identity(), old_authority_identity);
        drop(restored_authority);
        let active = state.ws.inner.lock().expect("workspace state").take();
        drop(active);
        drop(state);
        drop(cleanup);
        assert!(!root.exists(), "fixture must clean up");
    }

    #[test]
    fn freshness_scheduler_keeps_not_ready_workspace_fail_soft() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-node-freshness-cutover-not-ready-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let cleanup = TestRoot(root.clone());
        let workspace_path = root.join("workspace");
        let resources = root.join("resources");
        std::fs::create_dir_all(&workspace_path).expect("workspace directory");

        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        database
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed project");

        let authority = WorkspaceAuthority::from_database_for_test(database, workspace_path)
            .expect("workspace authority");
        let state = Arc::new(
            AppState::new(&root.to_string_lossy(), &resources.to_string_lossy())
                .expect("app state"),
        );
        install_test_workspace(&state, authority);

        let result = run_narrative_freshness_cycle_inner(&state, || {})
            .expect("not-ready cutover is an expected scheduler outcome");
        let result = result.expect("not-ready cutover must notify the activation owner");
        let result: serde_json::Value =
            serde_json::from_str(&result).expect("not-ready result JSON");
        assert_eq!(result["hasMore"], false);
        assert_eq!(result["cutoverNotReady"], true);

        let active = state.ws.inner.lock().expect("workspace state").take();
        drop(active);
        drop(state);
        drop(cleanup);
        assert!(!root.exists(), "fixture must clean up");
    }

    #[test]
    fn freshness_scheduler_surfaces_unexpected_cutover_marker_errors() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-node-freshness-cutover-marker-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let cleanup = TestRoot(root.clone());
        let workspace_path = root.join("workspace");
        let resources = root.join("resources");
        let metadata_dir = workspace_path.join(".grimodex");
        std::fs::create_dir_all(&metadata_dir).expect("workspace metadata directory");
        std::fs::write(
            metadata_dir.join("workspace.json"),
            serde_json::json!({
                "id": "freshness-cutover-marker",
                "created_at": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .expect("workspace metadata");

        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        database
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO schema_data_migrations
                        (migration_id, contract_version, applied_at)
                     VALUES (?1, 999, '2026-01-01T00:00:00.000Z')",
                    [grimodex_db::narrative_extraction::C2_ZC_CUTOVER_MIGRATION_ID],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed unsupported cutover marker");

        let authority = WorkspaceAuthority::from_database_for_test(database, workspace_path)
            .expect("workspace authority");
        let state = Arc::new(
            AppState::new(&root.to_string_lossy(), &resources.to_string_lossy())
                .expect("app state"),
        );
        install_test_workspace(&state, authority);

        let result = run_narrative_freshness_cycle_inner(&state, || {})
            .expect("unexpected marker/schema failure must transfer recovery ownership")
            .expect("recovery transfer result");
        let result: serde_json::Value =
            serde_json::from_str(&result).expect("recovery result JSON");
        assert_eq!(result["status"], "workspace-unavailable");
        assert_eq!(result["reason"], "freshness-recovery-required");
        assert!(result["descriptorId"].is_number());
        assert!(
            state.ws.inner.lock().expect("workspace state").is_none(),
            "the failed authority must be detached before descriptor retry"
        );

        let active = state.ws.inner.lock().expect("workspace state").take();
        drop(active);
        drop(state);
        drop(cleanup);
        assert!(!root.exists(), "fixture must clean up");
    }
}

#[cfg(test)]
mod narrative_freshness_result_contract_tests {
    use super::*;

    #[test]
    fn held_result_uses_app_error_for_unexpected_cutover_ready() {
        require_held_cutover_not_ready(true).expect("held NOT_READY evidence is accepted");
        let error = require_held_cutover_not_ready(false)
            .expect_err("held result must fail when cutover unexpectedly succeeds");
        assert!(error
            .to_string()
            .starts_with("NEX_MAINTENANCE_CI_FRESHNESS_HOLD_CUTOVER_READY:"));
    }
}

#[cfg(test)]
mod narrative_ci_quiescence_snapshot_tests {
    use super::*;
    use grimodex_db::state::WorkspaceAuthority;

    #[test]
    fn quiescence_projection_keeps_one_read_snapshot_across_external_mutation() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-node-quiescence-snapshot-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let workspace_path = root.join("workspace");
        std::fs::create_dir_all(workspace_path.join(".grimodex"))
            .expect("workspace metadata directory");
        std::fs::write(
            workspace_path.join(".grimodex/workspace.json"),
            serde_json::json!({
                "id": "quiescence-snapshot",
                "created_at": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .expect("workspace metadata");
        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        database
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed project");
        let db_path = workspace_path.join("grimodex.db");
        let authority =
            WorkspaceAuthority::from_database_for_test(database, workspace_path.clone())
                .expect("workspace authority");
        let binding = MaintenanceWorkspaceBinding {
            authority_id: "authority:quiescence-snapshot".to_string(),
            generation: 1,
        };
        let external_path = db_path.clone();
        let state = narrative_ci_quiescence_state_with_snapshot_hook(
            authority.db(),
            &binding,
            None,
            None,
            Some(&|| {
                let external = Database::new(&external_path).expect("external database");
                external
                    .with_conn(|conn| {
                        conn.execute(
                            "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
                             VALUES (?1, 1, '2026-01-01T00:00:00.000Z')",
                            [grimodex_db::narrative_extraction::C2_ZC_CUTOVER_MIGRATION_ID],
                        )?;
                        Ok::<_, anyhow::Error>(())
                    })
                    .expect("external marker mutation");
            }),
        )
        .expect("snapshot state");
        // `migrate()` seeds the bootstrap project; the explicit fixture row
        // above makes the pre-hook snapshot contain both rows.  The external
        // mutation only adds the cutover marker, so the project projection
        // must still contain that original two-row set.
        assert_eq!(state["projects"].as_array().expect("projects").len(), 2);
        assert!(state["marker"].is_null());
        drop(authority);
        let _ = std::fs::remove_dir_all(root);
    }
}

fn narrative_maintenance_binding_for_authority(
    state: &AppState,
    authority: &PinnedWorkspaceDb,
) -> MaintenanceWorkspaceBinding {
    state
        .narrative_maintenance_recovery_gate
        .binding_for_authority(&narrative_authority_id(authority))
}

fn record_maintenance_recovery_binding(
    state: &AppState,
    descriptor_id: grimodex_db::workspace_lifecycle::RecoveryDescriptorId,
    attempt_id: Option<&str>,
    binding: Option<&MaintenanceWorkspaceBinding>,
) {
    let Some(binding) = binding else {
        return;
    };
    if let Ok(mut bindings) = state.narrative_maintenance_recovery_bindings.lock() {
        bindings.insert(
            descriptor_id.get(),
            (attempt_id.map(ToOwned::to_owned), binding.clone()),
        );
    }
}

fn maintenance_recovery_binding(
    state: &AppState,
    descriptor_id: grimodex_db::workspace_lifecycle::RecoveryDescriptorId,
) -> Option<(Option<String>, MaintenanceWorkspaceBinding)> {
    state
        .narrative_maintenance_recovery_bindings
        .lock()
        .ok()
        .and_then(|bindings| bindings.get(&descriptor_id.get()).cloned())
}

fn take_maintenance_recovery_binding(
    state: &AppState,
    descriptor_id: grimodex_db::workspace_lifecycle::RecoveryDescriptorId,
) -> Option<(Option<String>, MaintenanceWorkspaceBinding)> {
    state
        .narrative_maintenance_recovery_bindings
        .lock()
        .ok()
        .and_then(|mut bindings| bindings.remove(&descriptor_id.get()))
}

fn first_completed_maintenance_recovery_receipt(
    state: &AppState,
) -> Option<(u64, NarrativeMaintenanceRecoveryReceipt)> {
    state
        .narrative_maintenance_recovery_receipts
        .lock()
        .ok()
        .and_then(|receipts| {
            receipts
                .iter()
                .next()
                .map(|(id, receipt)| (*id, receipt.clone()))
        })
}

fn remember_completed_maintenance_recovery(
    state: &AppState,
    descriptor_id: grimodex_db::workspace_lifecycle::RecoveryDescriptorId,
    receipt: NarrativeMaintenanceRecoveryReceipt,
) -> bool {
    if let Ok(mut receipts) = state.narrative_maintenance_recovery_receipts.lock() {
        // A completed receipt is transport evidence, not a second durable
        // responsibility. Never evict an unACKed receipt to make room for a
        // newer one: the descriptor must retain its responsibility until a
        // replayable receipt has been stored and ACKed by main.
        if receipts.len() >= 256 && !receipts.contains_key(&descriptor_id.get()) {
            return false;
        }
        receipts.insert(descriptor_id.get(), receipt);
        return true;
    }
    false
}

fn forget_completed_maintenance_recovery(
    state: &AppState,
    descriptor_id: grimodex_db::workspace_lifecycle::RecoveryDescriptorId,
) {
    if let Ok(mut receipts) = state.narrative_maintenance_recovery_receipts.lock() {
        receipts.remove(&descriptor_id.get());
    }
}

fn recovery_receipt_slot_available(
    state: &AppState,
    descriptor_id: grimodex_db::workspace_lifecycle::RecoveryDescriptorId,
) -> bool {
    state
        .narrative_maintenance_recovery_receipts
        .lock()
        .map(|receipts| receipts.contains_key(&descriptor_id.get()) || receipts.len() < 256)
        .unwrap_or(false)
}

/// Resolve the authority owned by the workspace-swap caller.  The shared
/// opener raises `switching` before invoking its pre-swap callback, so the
/// normal `active_database` guard intentionally rejects this lookup.  The
/// callback already owns `open_lock`; reading the pinned Arc directly under
/// `ws.inner` is the narrow owner-only escape hatch needed to inspect the
/// exact authority and pending-run binding before `QuiescedSamePath` removes
/// it.  Callers outside that callback retain the normal fail-closed lookup.
fn workspace_swap_owner_authority(
    state: &AppState,
    owner_can_observe_transition: bool,
) -> std::result::Result<PinnedWorkspaceDb, AppError> {
    if owner_can_observe_transition {
        let inner = match state.ws.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => {
                // A caught panic in the shared opener may poison the mutex
                // after the old authority is still the only published one.
                // The lifecycle owner is the sole recovery boundary here;
                // consume that guard, clear the marker, and continue to
                // inspect the exact authority rather than strand recovery.
                state.ws.inner.clear_poison();
                poisoned.into_inner()
            }
        };
        return inner
            .as_ref()
            .map(|workspace| Arc::clone(&workspace.authority))
            .ok_or(AppError::NoWorkspace);
    }
    active_database(&state.ws)
}

/// Reopen maintenance admission after a workspace open/restore path exits.
/// The binding is resolved from the authority that actually remains active,
/// so an error before publication restores the old binding while a successful
/// replacement restores the new generation.
fn reopen_narrative_maintenance_admission(
    state: &Arc<AppState>,
) -> std::result::Result<(), AppError> {
    // Open/Restore now hold the shared lifecycle transition until the
    // terminal projection is published, so the compatibility switching view
    // is still raised while this unwind/reopen path runs.  Resolve the exact
    // owner authority through the narrow swap-owner helper instead of calling
    // the normal fail-closed DB pin and accidentally stranding the admission
    // gate after a pre-swap error.
    let binding = match workspace_swap_owner_authority(state, true) {
        Ok(authority) => Some(
            state
                .narrative_maintenance_recovery_gate
                .binding_for_authority(&narrative_authority_id(&authority)),
        ),
        Err(AppError::NoWorkspace) => None,
        Err(error) => return Err(error),
    };
    state
        .narrative_maintenance_recovery_gate
        .reopen_admission(binding.as_ref())
        .map_err(AppError::Anyhow)
}

/// A panic while the shared open/restore implementation owns `open_lock`
/// poisons that mutex even when the native owner catches the panic.  Recover
/// the lock only after the workspace switching and maintenance-admission
/// invariants have been restored; otherwise fail closed and leave the
/// workspace in recovery rather than allowing a poisoned or half-swapped
/// authority to be reused.
fn recover_workspace_open_lock_after_panic(
    state: &Arc<AppState>,
) -> std::result::Result<(), AppError> {
    // The shared lifecycle core intentionally remains in Transition until the
    // blocking worker has joined.  A panic is therefore allowed to leave the
    // legacy compatibility flag raised at this point; the outer supervisor
    // converts the joined operation to RecoveryRequired.  Rejecting a raised
    // flag here would strand the transition before that supervisor can emit a
    // terminal recovery projection.
    state
        .narrative_maintenance_recovery_gate
        .assert_no_active_attempts()
        .map_err(AppError::Anyhow)?;
    // A caught panic can unwind while the shared opener still owns the
    // workspace mutexes. Clear their poison markers only after the lifecycle
    // gate and switching flag have been restored; future operations then
    // re-read the exact surviving authority instead of failing closed on a
    // recoverable panic.
    state.ws.inner.clear_poison();
    state.ws.open_lock.clear_poison();
    Ok(())
}

/// Close maintenance admission before checking process-local preempted Run
/// owners. With admission closed no active cycle can add a new owner between
/// the gate check and the workspace swap. A pending owner on a reusable
/// connection blocks the swap; a quarantined owner is retained and handed to
/// the replacement authority before admission is reopened.
fn close_narrative_maintenance_for_workspace_swap(
    state: &Arc<AppState>,
    allow_restore_only_recovery: bool,
) -> std::result::Result<bool, AppError> {
    // Safe Mode and RecoveryRequired deliberately leave admission closed while
    // no live authority exists. Only the shared open path may consume that
    // state: its pre-swap hook runs while `open_lock` is held, so concurrent
    // recovery opens cannot queue a second operation behind the same closed
    // admission. Restore itself requires a live authority and must always own
    // a fresh close; otherwise it could borrow an earlier operation's close,
    // wait for `open_lock`, and later swap after admission has reopened.
    let already_closed = state
        .narrative_maintenance_recovery_gate
        .maintenance_admission_is_closed();
    if already_closed {
        let workspace_swap_owns_gate = state
            .narrative_maintenance_recovery_gate
            .admission_owned_by_workspace_swap();
        let owner_authority = if allow_restore_only_recovery && workspace_swap_owns_gate {
            workspace_swap_owner_authority(state, true).ok()
        } else {
            // Restore closes admission before waiting for the open lock, but
            // it must never inherit a closed gate left by an earlier open.
            // The open owner alone may use the replacement-recovery retry.
            None
        };
        let replacement_recovery_pending = if allow_restore_only_recovery
            && workspace_swap_owns_gate
        {
            if state
                .narrative_maintenance_recovery_gate
                .restore_recovery_pending()
            {
                // A completed restore handed the closed gate to the next
                // serialized open. If the restore captured an exact binding,
                // only that authority may consume the handoff; a missing
                // authority is allowed to proceed to recovery open.
                match state
                    .narrative_maintenance_recovery_gate
                    .restore_recovery_binding()
                {
                    Some(expected) => owner_authority
                        .as_ref()
                        .map(|authority| narrative_authority_id(authority) == expected.authority_id)
                        .unwrap_or(false),
                    None => true,
                }
            } else {
                owner_authority
                    .as_ref()
                    .map(|authority| {
                        let authority_id = narrative_authority_id(authority);
                        !state
                            .narrative_maintenance_preempted_runs
                            .pending_for_authority(&authority_id)
                            .is_empty()
                    })
                    .unwrap_or(false)
            }
        } else {
            false
        };
        let restore_only_without_authority =
            if allow_restore_only_recovery && workspace_swap_owns_gate {
                // Keep the lock order used by `active_workspace_snapshot`: inner
                // first, then SafeMode. A poisoned workspace lock is not evidence
                // of a safe restore-only state, so fail closed.
                let no_live_authority = state
                    .ws
                    .inner
                    .lock()
                    .map(|inner| inner.is_none())
                    .unwrap_or(false);
                no_live_authority && state.ws.safe_mode.is_active()
            } else {
                false
            };
        if !restore_only_without_authority && !replacement_recovery_pending {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "NEX_MAINTENANCE_ADMISSION_CLOSED: workspace swap admission is owned by another operation"
            )));
        }
        if replacement_recovery_pending {
            // A previous replacement authority could not terminalize an
            // exact handed-off Run.  The gate intentionally stayed closed;
            // allow the next serialized workspace open to replace that
            // authority and retry the same owner, while still rejecting any
            // active attempt marker.
            state
                .narrative_maintenance_recovery_gate
                .assert_no_active_attempts()
                .map_err(AppError::Anyhow)?;
            return Ok(true);
        }
        state
            .narrative_maintenance_recovery_gate
            .retire_quarantined_attempt_bindings(
                &state
                    .narrative_maintenance_attempts
                    .failed_cleanup_attempts(),
            )
            .map_err(AppError::Anyhow)?;
        state
            .narrative_maintenance_recovery_gate
            .assert_no_active_attempts()
            .map_err(AppError::Anyhow)?;
        return Ok(false);
    }
    // The shared lifecycle core admits the Restore/Open transition before
    // this function is entered and projects that admission through the
    // compatibility `switching` view.  Do not use that projection as a
    // second owner check here: doing so would reject the very Restore that
    // just acquired the logical transition permit before it can close the
    // maintenance gate.  A competing operation is rejected by the core; the
    // physical `open_lock` below remains the serialization boundary.
    let active_binding = workspace_swap_owner_authority(state, allow_restore_only_recovery)
        .ok()
        .map(|authority| {
            state
                .narrative_maintenance_recovery_gate
                .binding_for_authority(&narrative_authority_id(&authority))
        });
    if let Some(binding) = active_binding.as_ref() {
        // A terminal receipt with failed cleanup quarantines the old
        // connection. Retire only its process-local gate marker as part of
        // this exact old-authority swap; the receipt remains in the attempt
        // registry and the quarantined connection is never reused.
        let quarantined = state
            .narrative_maintenance_attempts
            .failed_cleanup_attempt_ids_for_binding(binding);
        if allow_restore_only_recovery {
            state
                .narrative_maintenance_recovery_gate
                .close_for_workspace_swap_with_quarantined_attempts(binding, &quarantined)
                .map_err(AppError::Anyhow)?;
        } else {
            state
                .narrative_maintenance_recovery_gate
                .close_for_restore_with_quarantined_attempts(binding, &quarantined)
                .map_err(AppError::Anyhow)?;
        }
    } else {
        // A failed cleanup may have detached its old authority before the
        // next open reaches this hook. Retire only receipts that already
        // proved their connections unusable, using each receipt's exact old
        // binding; a live/clean marker still makes the swap fail closed.
        let quarantined = state
            .narrative_maintenance_attempts
            .failed_cleanup_attempts();
        if quarantined.is_empty() {
            if allow_restore_only_recovery {
                state
                    .narrative_maintenance_recovery_gate
                    .close_for_workspace_swap()
                    .map_err(AppError::Anyhow)?;
            } else {
                state
                    .narrative_maintenance_recovery_gate
                    .close_for_restore()
                    .map_err(AppError::Anyhow)?;
            }
        } else {
            if allow_restore_only_recovery {
                state
                    .narrative_maintenance_recovery_gate
                    .close_for_workspace_swap_with_quarantined_attempt_bindings(&quarantined)
                    .map_err(AppError::Anyhow)?;
            } else {
                state
                    .narrative_maintenance_recovery_gate
                    .close_for_restore_with_quarantined_attempt_bindings(&quarantined)
                    .map_err(AppError::Anyhow)?;
            }
        }
    }
    if let Ok(authority) = workspace_swap_owner_authority(state, allow_restore_only_recovery) {
        let binding = state
            .narrative_maintenance_recovery_gate
            .binding_for_authority(&narrative_authority_id(&authority));
        // Admission is already closed, so no new owner can add another
        // pending Run. Repeat the exact-binding drain until a pass makes no
        // progress, then perform the final process-local recheck immediately
        // before the authority swap.
        // A cleanup failure quarantines this exact connection.  Do not call
        // the terminalizer through it again: preserve the Run entry and hand
        // its recovery responsibility to the replacement authority below.
        if authority.db().connection_reusable() {
            loop {
                let pending = state
                    .narrative_maintenance_preempted_runs
                    .pending_for_binding(&binding);
                if pending.is_empty() {
                    break;
                }
                let mut removed_any = false;
                for run_id in pending {
                    if matches!(
                        grimodex_db::narrative_extraction::try_cancel_preempted_maintenance_run(
                            authority.db(),
                            &run_id,
                            "NEX_MAINTENANCE_CONNECTION_PREEMPTED: draining before workspace swap",
                        ),
                        Ok(true)
                    ) {
                        state.narrative_maintenance_preempted_runs.remove(&run_id);
                        removed_any = true;
                    }
                }
                if !removed_any {
                    break;
                }
            }
            if !state
                .narrative_maintenance_preempted_runs
                .pending_for_binding(&binding)
                .is_empty()
            {
                let error = anyhow::anyhow!(
                    "NEX_MAINTENANCE_PREEMPTED_RUN_ACTIVE: reusable authority could not drain pending Run"
                );
                let reopen = state
                    .narrative_maintenance_recovery_gate
                    .reopen_admission(None)
                    .map_err(AppError::Anyhow);
                return match reopen {
                    Ok(()) => Err(AppError::Anyhow(error)),
                    Err(reopen_error) => Err(reopen_error),
                };
            }
        } else if !state
            .narrative_maintenance_preempted_runs
            .pending_for_binding(&binding)
            .is_empty()
        {
            tracing::warn!(
                target: "narrative.maintenance",
                authority_id = %binding.authority_id,
                generation = binding.generation,
                "deferring pending maintenance Run to the replacement authority after connection quarantine"
            );
        }
    }
    Ok(true)
}

/// Finish the handoff of exact preempted Runs after a replacement authority
/// has been published.  The old generation remains recorded in the
/// process-local owner entry, while the new pinned connection performs the
/// only terminal write.  Entries for another workspace stay owned by that
/// workspace and are not silently discarded during a switch.
fn drain_preempted_maintenance_runs_after_workspace_swap(
    state: &AppState,
) -> std::result::Result<(), AppError> {
    // The supervisor still owns the logical transition permit and the
    // compatibility switching projection while it performs this protected
    // handoff. Resolve the exact newly published authority through that owner
    // boundary instead of treating the in-flight transition as a normal DB
    // command and failing with WORKSPACE_SWITCHING.
    let authority =
        workspace_swap_owner_authority(state, true).or_else(|_| active_database(&state.ws))?;
    let authority_id = narrative_authority_id(&authority);
    let pending = state
        .narrative_maintenance_preempted_runs
        .pending_for_authority(&authority_id);
    for (run_id, previous_binding) in pending {
        match grimodex_db::narrative_extraction::try_cancel_preempted_maintenance_run(
            authority.db(),
            &run_id,
            "NEX_MAINTENANCE_CONNECTION_PREEMPTED: recovered by replacement authority",
        ) {
            Ok(true) => state.narrative_maintenance_preempted_runs.remove(&run_id),
            Ok(false) => {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_PREEMPTED_RUN_ACTIVE: replacement authority could not acquire the exact pending Run (previous generation {})",
                    previous_binding.generation
                )))
            }
            Err(error) => {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_PREEMPTED_RUN_RECOVERY_FAILED: run {run_id} handed off from generation {}: {error}",
                    previous_binding.generation
                )))
            }
        }
    }
    if !state
        .narrative_maintenance_preempted_runs
        .pending_for_authority(&authority_id)
        .is_empty()
    {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "NEX_MAINTENANCE_PREEMPTED_RUN_ACTIVE: replacement authority still has pending Runs"
        )));
    }
    Ok(())
}

/// Tracks the narrow interval in which workspace open/restore owns the closed
/// maintenance gate.  Reopening is an explicit supervisor action; `Drop`
/// only relinquishes this local marker and must never make a failed or
/// unwound workspace operation look successfully handed off.
struct NarrativeMaintenanceAdmissionReopenGuard {
    state: Arc<AppState>,
    armed: bool,
}

impl NarrativeMaintenanceAdmissionReopenGuard {
    fn new(state: Arc<AppState>) -> Self {
        Self {
            state,
            armed: false,
        }
    }

    fn arm(&mut self) {
        self.armed = true;
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    fn reopen(&mut self) -> std::result::Result<(), AppError> {
        let result = reopen_narrative_maintenance_admission(&self.state);
        if result.is_ok() {
            self.disarm();
        }
        result
    }

    /// Complete the compatibility handoff only when this guard owns the close. Restore-only outcomes keep
    /// admission closed until a later valid open succeeds; an error during
    /// that recovery attempt must not reopen the gate accidentally.
    fn complete_admission_handoff(&mut self) -> std::result::Result<(), AppError> {
        if !self.armed {
            return Ok(());
        }
        self.reopen()
    }
}

impl Drop for NarrativeMaintenanceAdmissionReopenGuard {
    fn drop(&mut self) {
        // A dropped guard is not a Join, cleanup, activation, or recovery
        // proof.  Leave the shared gate fail-closed until the explicit
        // success/failure owner calls `complete_admission_handoff` or records
        // a recovery descriptor.  The `state` field is retained so the guard
        // remains tied to the exact owner even though Drop performs no
        // lifecycle mutation.
        let _ = &self.state;
    }
}

/// Finish the structured result from the shared workspace opener. Restore-only
/// outcomes deliberately leave `WorkspaceState` without a Database authority;
/// they therefore bind the recovery target and preserve the outcome directly,
/// while Ready/Migrated outcomes reopen maintenance against their new binding.
fn finish_workspace_open_success(
    state: &AppState,
    path: &str,
    opened: grimodex_db::recovery::WorkspaceOpenOutcome,
    trace: &mut NativeWorkspaceOpenTrace,
    admission_guard: &mut NarrativeMaintenanceAdmissionReopenGuard,
) -> std::result::Result<String, AppError> {
    let restore_only = opened.is_restore_only();
    if restore_only {
        state
            .profile_egress
            .bind_recovery_workspace(Some(path.to_string()));
        // The shared opener intentionally leaves SafeMode/RecoveryRequired
        // without a live authority.  Keep the maintenance admission closed
        // for that restore-only binding; dropping an armed guard must not
        // reopen it as an unwind fallback.
        admission_guard.disarm();
    } else {
        // A failed cleanup may have left an exact Run in the process-local
        // preempted-owner registry after the old connection was quarantined.
        // Recover it before reopening admission so a fresh attempt cannot
        // race the handoff or make the old Run invisible to startup recovery.
        if let Err(error) = drain_preempted_maintenance_runs_after_workspace_swap(state) {
            // Keep admission fail-closed when the replacement could not
            // terminalize the exact Run.  The owner entry remains for a
            // later recovery attempt; reopening here would allow new work to
            // bypass that unresolved handoff.
            admission_guard.disarm();
            return Err(error);
        }
        admission_guard.reopen()?;
    }

    let serialize_span = trace.begin_span(NativeWorkspaceOpenSpanName::SerializeEvent);
    state.events.emit(
        "workspace:opened",
        serde_json::json!({
            "path": path,
            "restoreOnly": restore_only,
        }),
    );
    match serde_json::to_string(&opened) {
        Ok(json) => {
            trace.finish_span(serialize_span);
            Ok(json)
        }
        Err(error) => {
            trace.fail_span(serialize_span);
            Err(AppError::Anyhow(anyhow::Error::from(error)))
        }
    }
}

/// Foreground extraction binding. `authority_id` may intentionally survive a
/// cloned/restored Workspace, and the recovery `generation` rotates just after
/// authority publication. The process-local authority instance therefore
/// closes the publication-to-generation-rotation window as an independent
/// exact CAS coordinate.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NarrativeExtractionWorkspaceBinding {
    authority_id: String,
    generation: u64,
    /// Decimal string keeps the opaque u64 exact across the JS boundary.
    authority_instance_id: String,
}

impl NarrativeExtractionWorkspaceBinding {
    fn validate(&self) -> anyhow::Result<()> {
        MaintenanceWorkspaceBinding {
            authority_id: self.authority_id.clone(),
            generation: self.generation,
        }
        .validate()?;
        let identity = self.authority_instance_id.parse::<u64>()?;
        anyhow::ensure!(
            identity > 0 && identity.to_string() == self.authority_instance_id,
            "authorityInstanceId must be a canonical positive decimal integer"
        );
        Ok(())
    }
}

fn narrative_extraction_binding_for_authority(
    state: &AppState,
    authority: &PinnedWorkspaceDb,
) -> NarrativeExtractionWorkspaceBinding {
    let maintenance = narrative_maintenance_binding_for_authority(state, authority);
    NarrativeExtractionWorkspaceBinding {
        authority_id: maintenance.authority_id,
        generation: maintenance.generation,
        authority_instance_id: authority.identity().to_string(),
    }
}

fn idempotency_receipt_exists(
    db: &Database,
    domain: &str,
    request_id: &str,
) -> anyhow::Result<bool> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM idempotency_requests
                 WHERE domain = ?1 AND request_id = ?2
            )",
            [domain, request_id],
            |row| row.get::<_, i64>(0),
        )? != 0)
    })
}

fn emit_narrative_epoch_rotated(
    state: &AppState,
    binding: &MaintenanceWorkspaceBinding,
    project_id: &str,
    operation: &str,
) {
    state.events.emit(
        NARRATIVE_MAINTENANCE_EPOCH_ROTATED_EVENT,
        serde_json::json!({
            "projectId": project_id,
            "operation": operation,
            "reason": "semantic-epoch-rotated",
            "authorityId": binding.authority_id,
            "generation": binding.generation,
        }),
    );
}

fn should_emit_narrative_epoch_rotated(replayed: bool, changed: bool) -> bool {
    !replayed && changed
}

fn validate_runtime_performance_owner_token(owner_token: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        owner_token.len() <= 200,
        "runtime performance fixture owner token is too long"
    );
    let expected = std::env::var(RUNTIME_PERFORMANCE_OWNER_TOKEN_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("runtime performance fixture seed is disabled"))?;
    anyhow::ensure!(
        !owner_token.is_empty() && owner_token == expected,
        "runtime performance fixture owner token mismatch"
    );
    Ok(())
}

#[derive(Clone)]
struct CorrelatedStreamEmitter {
    events: EventQueue,
    stream_id: String,
}

impl CorrelatedStreamEmitter {
    fn new(events: EventQueue, stream_id: String) -> Self {
        Self { events, stream_id }
    }
}

impl grimodex_ai::emit::StreamEmitter for CorrelatedStreamEmitter {
    fn emit(&self, channel: &str, mut payload: serde_json::Value) {
        match &mut payload {
            serde_json::Value::Object(object) => {
                object.insert(
                    "streamId".to_string(),
                    serde_json::Value::String(self.stream_id.clone()),
                );
            }
            other => {
                payload = serde_json::json!({
                    "streamId": self.stream_id,
                    "payload": other,
                });
            }
        }
        EventSink::emit(&self.events, channel, payload);
    }
}

const SEMANTIC_RERANKER_BUSY_MARKER: &str = "RERANKER_BUSY:";

fn try_with_semantic_reranker_lane<T, R>(
    lane: &Mutex<T>,
    operation: impl FnOnce(&mut T) -> anyhow::Result<R>,
) -> anyhow::Result<R> {
    let mut runtime = match lane.try_lock() {
        Ok(runtime) => runtime,
        Err(TryLockError::WouldBlock) => {
            return Err(anyhow::anyhow!(
                "{SEMANTIC_RERANKER_BUSY_MARKER} semantic reranker lane is occupied"
            ));
        }
        Err(TryLockError::Poisoned(error)) => {
            return Err(anyhow::anyhow!("semantic reranker lock poisoned: {error}"));
        }
    };
    operation(&mut runtime)
}

/// spawn_blocking + `AppError` → `napi::Error` 写像の定形。Tauri 側 M3 方針
/// (「db コマンドは async、長時間系は spawn_blocking」) の写像 (§4.2)。
async fn run_blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> std::result::Result<T, AppError> + Send + 'static,
{
    napi::tokio::task::spawn_blocking(f)
        .await
        .map_err(join_err_to_napi)?
        .map_err(app_err_to_napi)
}

fn emit_workspace_lifecycle_view(state: &AppState, view: &WorkspaceLifecycleView) {
    match serde_json::to_value(view) {
        Ok(payload) => state.events.emit(WORKSPACE_LIFECYCLE_EVENT, payload),
        Err(error) => tracing::error!(
            target: "workspace.lifecycle",
            %error,
            "failed to serialize workspace lifecycle view"
        ),
    }
}

fn begin_workspace_lifecycle_transition_wire(
    state: &AppState,
    kind: AdmissionKind,
) -> std::result::Result<Option<String>, AppError> {
    begin_workspace_lifecycle_transition_wire_for_recovery(state, kind, None)
}

fn begin_workspace_lifecycle_transition_wire_for_recovery(
    state: &AppState,
    kind: AdmissionKind,
    recovery_descriptor_id: Option<grimodex_db::RecoveryDescriptorId>,
) -> std::result::Result<Option<String>, AppError> {
    let outcome = match recovery_descriptor_id {
        Some(descriptor_id) => state
            .workspace_lifecycle
            .try_begin_transition_kind_for_recovery(kind, descriptor_id)?,
        None => state.workspace_lifecycle.try_begin_transition_kind(kind)?,
    };
    match outcome {
        AdmissionOutcome::Admitted(_) => {
            // Stop long-lived semantic/post-effect/related-scenes work before
            // the transition worker can reach its physical boundary.  Their
            // participant leases remain visible until the task observes this
            // cancellation, so acquire_physical_exclusive cannot publish a
            // replacement over a live old-authority reader.
            state.post_effect_abort.abort_all();
            state.semantic.semantic_cancel_background();
            let _ = state.related_scenes.stop_for_workspace_transition();
            let view = state
                .workspace_lifecycle
                .snapshot_for_workspace(&state.ws)?;
            emit_workspace_lifecycle_view(state, &view);
            Ok(None)
        }
        AdmissionOutcome::NotAdmitted { reason, snapshot } => Ok(Some(
            serde_json::json!({
                "status": "not-admitted",
                "reasonCode": admission_rejection_code(&reason),
                "snapshot": lifecycle_snapshot_wire(&snapshot),
            })
            .to_string(),
        )),
    }
}

/// Select the only descriptor that an explicit Open may resolve. A
/// WorkspaceTransition root is eligible only when the requested locator and
/// durable workspace identity are the same as the failed candidate; a retry
/// to another path must leave the old root owned by its original descriptor.
fn workspace_transition_recovery_for_open(
    state: &AppState,
    requested_path: &str,
) -> std::result::Result<Option<grimodex_db::RecoveryDescriptorId>, AppError> {
    let snapshot = state.workspace_lifecycle.lifecycle_snapshot()?;
    let requested =
        std::fs::canonicalize(requested_path).unwrap_or_else(|_| PathBuf::from(requested_path));
    let descriptor_ids = match snapshot.state {
        grimodex_db::LifecycleState::RecoveryRequired { descriptor_id }
            if descriptor_id
                != grimodex_db::workspace_lifecycle::SAFE_MODE_RECOVERY_DESCRIPTOR_ID =>
        {
            vec![descriptor_id]
        }
        _ => state.workspace_lifecycle.recovery_descriptor_ids()?,
    };
    if descriptor_ids.is_empty() {
        return Ok(None);
    }
    let metadata_path = requested.join(".grimodex/workspace.json");
    let metadata = match std::fs::read_to_string(metadata_path) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(None),
    };
    let requested_workspace_id = serde_json::from_str::<serde_json::Value>(&metadata)
        .ok()
        .and_then(|value| {
            value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        });
    let mut matches = Vec::new();
    let mut maintenance_match = false;
    for descriptor_id in descriptor_ids {
        if descriptor_id == grimodex_db::workspace_lifecycle::SAFE_MODE_RECOVERY_DESCRIPTOR_ID {
            continue;
        }
        let descriptor = state
            .workspace_lifecycle
            .recovery_descriptor(descriptor_id)?;
        let Some(expected) = descriptor.expected_binding else {
            continue;
        };
        let expected_path = std::fs::canonicalize(&expected.locator)
            .unwrap_or_else(|_| PathBuf::from(&expected.locator));
        if requested == expected_path
            && requested_workspace_id.as_deref() == Some(expected.workspace_id.as_str())
        {
            match descriptor.owner {
                grimodex_db::workspace_lifecycle::RecoveryDescriptorOwner::WorkspaceTransition => {
                    matches.push(descriptor_id);
                }
                grimodex_db::workspace_lifecycle::RecoveryDescriptorOwner::Maintenance => {
                    maintenance_match = true;
                }
            }
        }
    }
    match matches.as_slice() {
        [] if maintenance_match => Err(AppError::Anyhow(anyhow::anyhow!(
            "NEX_WORKSPACE_RECOVERY_REQUIRES_DESCRIPTOR"
        ))),
        [] => Ok(None),
        [descriptor_id] => Ok(Some(*descriptor_id)),
        _ => Err(AppError::Anyhow(anyhow::anyhow!(
            "NEX_WORKSPACE_RECOVERY_DESCRIPTOR_AMBIGUOUS"
        ))),
    }
}

/// Validate an Open target before lifecycle admission. This check is
/// deliberately side-effect free: the shared opener may create a new
/// workspace directory, but malformed/unsafe targets must be rejected while
/// the current Ready authority is still untouched.
fn preflight_workspace_open_target(path: &str) -> std::result::Result<(), AppError> {
    let target = Path::new(path);
    grimodex_db::open::reject_unsafe_workspace_path(target)?;
    if let Ok(metadata) = std::fs::symlink_metadata(target) {
        if !metadata.is_dir() {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "NEX_WORKSPACE_OPEN_TARGET_NOT_DIRECTORY: workspace target is not a directory"
            )));
        }
    }
    Ok(())
}

fn admission_rejection_code(reason: &AdmissionRejection) -> &'static str {
    match reason {
        AdmissionRejection::NoWorkspace => "no-workspace",
        AdmissionRejection::ActiveOperation => "active-operation",
        AdmissionRejection::Transition => "transition",
        AdmissionRejection::RecoveryRequired => "recovery-required",
        AdmissionRejection::Closed => "closed",
        AdmissionRejection::Capacity => "capacity",
        AdmissionRejection::RecoveryPrerequisite => "recovery-prerequisite",
        AdmissionRejection::OutOfOrder => "out-of-order",
        AdmissionRejection::Conflict => "conflict",
        AdmissionRejection::Retired => "retired",
    }
}

fn lifecycle_snapshot_wire(snapshot: &LifecycleSnapshot) -> serde_json::Value {
    let state = match &snapshot.state {
        LifecycleState::NoWorkspace => serde_json::json!({ "state": "no-workspace" }),
        // A rejected request never authorizes binding reuse, so ready snapshots
        // intentionally omit the authority identity at this boundary.
        LifecycleState::Ready(_) => serde_json::json!({ "state": "ready" }),
        LifecycleState::Transition { stage, .. } => serde_json::json!({
            "state": "transition",
            "phase": match stage {
                TransitionStage::Draining => "draining",
                TransitionStage::Replacing => "replacing",
                TransitionStage::Recovering => "recovering",
                TransitionStage::Finishing => "finishing",
            }
        }),
        LifecycleState::RecoveryRequired { .. } => {
            serde_json::json!({ "state": "recovery-required" })
        }
        LifecycleState::Closed => serde_json::json!({ "state": "closed" }),
    };
    let mut object = serde_json::Map::new();
    object.insert("revision".to_string(), serde_json::json!(snapshot.revision));
    if let Some(values) = state.as_object() {
        object.extend(values.clone());
    }
    serde_json::Value::Object(object)
}

fn begin_workspace_lifecycle_recovery(state: &AppState) -> std::result::Result<(), AppError> {
    // Safe Mode is a durable, process-independent recovery root represented
    // by descriptor zero.  Materialize that state before admitting the
    // candidate-bound transition; ordinary descriptors go through the same
    // core API once their exact id is known.
    state
        .workspace_lifecycle
        .mark_safe_mode_recovery_required()?;
    let descriptor_id = match state.workspace_lifecycle.lifecycle_snapshot()?.state {
        LifecycleState::RecoveryRequired { descriptor_id } => descriptor_id,
        _ => grimodex_db::workspace_lifecycle::SAFE_MODE_RECOVERY_DESCRIPTOR_ID,
    };
    let (view, changed) = state
        .workspace_lifecycle
        .begin_recovery_transition(descriptor_id, &state.ws)?;
    if changed {
        emit_workspace_lifecycle_view(state, &view);
    }
    Ok(())
}

fn publish_workspace_lifecycle_from_workspace(
    state: &AppState,
) -> std::result::Result<WorkspaceLifecycleView, AppError> {
    let view = state
        .workspace_lifecycle
        .complete_transition_from_workspace(&state.ws)?;
    emit_workspace_lifecycle_view(state, &view);
    Ok(view)
}

/// Publish a panic/poison outcome only after the blocking worker has joined.
/// The candidate authority remains hidden behind RecoveryRequired even when a
/// pre-swap hook had already installed it; a panic is never an activation proof.
fn publish_workspace_lifecycle_recovery_after_join(
    state: &AppState,
) -> std::result::Result<WorkspaceLifecycleView, AppError> {
    let view = state
        .workspace_lifecycle
        .publish_recovery_required(&state.ws)?;
    emit_workspace_lifecycle_view(state, &view);
    Ok(view)
}

/// Bind the exact lifecycle revision/token produced by this Open to its
/// terminal wire outcome. Native's event callback is intentionally
/// non-blocking, so the renderer cannot safely infer that a later Ready
/// snapshot belongs to this Open from a process-wide minimum revision alone.
/// Keeping the proof on the Open response gives the renderer an operation
/// specific handoff in either callback order.
fn attach_workspace_lifecycle_proof(
    wire: String,
    lifecycle: &WorkspaceLifecycleView,
) -> napi::Result<String> {
    let mut value = serde_json::from_str::<serde_json::Value>(&wire)
        .map_err(|error| napi::Error::from_reason(format!("invalid open outcome: {error}")))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| napi::Error::from_reason("workspace open outcome must be a JSON object"))?;
    if !matches!(
        object.get("status").and_then(serde_json::Value::as_str),
        Some("ready" | "migrated")
    ) {
        return Ok(value.to_string());
    }
    object.insert(
        "lifecycle".to_owned(),
        serde_json::to_value(lifecycle).map_err(|error| {
            napi::Error::from_reason(format!("invalid lifecycle proof: {error}"))
        })?,
    );
    Ok(value.to_string())
}

/// Serialize the operation-scoped Restore result.  The renderer receives
/// only the opaque lifecycle projection (revision/token/status); authority
/// locators, instances, Run ids, and native error text stay inside Native.
fn serialize_restore_outcome(
    status: &str,
    operation_outcome: &str,
    content_effect: &str,
    lifecycle: &WorkspaceLifecycleView,
    activation: Option<&str>,
    reason_code: Option<&str>,
) -> napi::Result<String> {
    let mut value = serde_json::Map::new();
    value.insert("status".to_owned(), serde_json::json!(status));
    value.insert(
        "operationOutcome".to_owned(),
        serde_json::json!(operation_outcome),
    );
    value.insert(
        "contentEffect".to_owned(),
        serde_json::json!(content_effect),
    );
    value.insert(
        "lifecycle".to_owned(),
        serde_json::to_value(lifecycle).map_err(|error| {
            napi::Error::from_reason(format!("invalid lifecycle view: {error}"))
        })?,
    );
    if let Some(activation) = activation {
        value.insert("activation".to_owned(), serde_json::json!(activation));
    }
    if let Some(reason_code) = reason_code {
        value.insert("reasonCode".to_owned(), serde_json::json!(reason_code));
    }
    serde_json::to_string(&serde_json::Value::Object(value))
        .map_err(|error| napi::Error::from_reason(format!("invalid restore outcome: {error}")))
}

fn restore_activation_for_view(view: &WorkspaceLifecycleView) -> Option<&'static str> {
    match view.activation {
        workspace_lifecycle_view::WorkspaceLifecycleActivation::Ready => Some("ready"),
        workspace_lifecycle_view::WorkspaceLifecycleActivation::RequiresOpen => {
            Some("requires-open")
        }
        workspace_lifecycle_view::WorkspaceLifecycleActivation::None => None,
    }
}

fn restore_not_admitted_outcome(state: &AppState, reason_code: &str) -> napi::Result<String> {
    let lifecycle = state
        .workspace_lifecycle
        .snapshot_for_workspace(&state.ws)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let status = if lifecycle.status == WorkspaceLifecycleStatus::Closed {
        "closed"
    } else {
        "not-admitted"
    };
    serialize_restore_outcome(
        status,
        "unknown",
        "none",
        &lifecycle,
        None,
        Some(reason_code),
    )
}

fn open_descriptor_recovery_authority(
    binding: &grimodex_db::LiveBinding,
) -> std::result::Result<PinnedWorkspaceDb, AppError> {
    let path = std::path::PathBuf::from(&binding.locator);
    let metadata_path = path.join(".grimodex/workspace.json");
    let metadata = std::fs::read_to_string(&metadata_path).map_err(anyhow::Error::from)?;
    let workspace_id = serde_json::from_str::<serde_json::Value>(&metadata)
        .ok()
        .and_then(|value| {
            value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        })
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::Anyhow(anyhow::anyhow!(
                "NEX_WORKSPACE_IDENTITY_INVALID: descriptor recovery metadata has no id"
            ))
        })?;
    if workspace_id != binding.workspace_id {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "NEX_WORKSPACE_BINDING_CHANGED: descriptor locator metadata identity changed"
        )));
    }
    let lease = try_acquire_shared(&path).map_err(|error| anyhow::anyhow!(error))?;
    let database = Database::new(&path.join("grimodex.db"))?;
    Ok(Arc::new(WorkspaceAuthority::new(database, path, lease)))
}

/// Return a rebinding proof only when the descriptor target is the authority
/// that is currently published after recovery.  A descriptor for W1 may be
/// reconciled while W2 remains Ready; in that case the active authority is
/// deliberately not a proof for W1 and retained W1 work must stay parked.
fn descriptor_rebound_binding_for_authority(
    state: &AppState,
    descriptor: &grimodex_db::workspace_lifecycle::RecoveryDescriptor,
    _recovered_authority: &PinnedWorkspaceDb,
    active: &PinnedWorkspaceDb,
) -> Option<MaintenanceWorkspaceBinding> {
    let expected = descriptor.expected_binding.as_ref()?;
    // A successful same-path reopen deliberately creates a new authority
    // instance. The proof is the descriptor's joined/retired boundary plus
    // the replacement's exact locator and durable workspace identity; the
    // old instance number is evidence for the old binding, not a requirement
    // on the replacement binding.
    if !descriptor_replacement_matches_expected_workspace(expected, active)
        || !descriptor_replacement_retirement_proven(descriptor, expected, active)
    {
        return None;
    }
    Some(narrative_maintenance_binding_for_authority(state, active))
}

/// Match the descriptor's original live authority exactly. This is used only
/// to decide whether an already-active authority is the original scope (for
/// example, whether W2 is unrelated to a W1 recovery). It must not be reused
/// as the replacement proof because a valid reopen rotates authority_instance.
fn descriptor_expected_matches_authority_identity(
    binding: &grimodex_db::LiveBinding,
    authority: &PinnedWorkspaceDb,
) -> bool {
    if binding.authority_instance != authority.identity()
        || binding.locator != authority.path().to_string_lossy()
    {
        return false;
    }
    descriptor_expected_matches_workspace(binding, authority)
}

/// Verify the durable workspace identity of a replacement without requiring
/// the retired authority's process-local instance to survive the reopen.
fn descriptor_replacement_matches_expected_workspace(
    binding: &grimodex_db::LiveBinding,
    authority: &PinnedWorkspaceDb,
) -> bool {
    if binding.locator != authority.path().to_string_lossy() {
        return false;
    }
    descriptor_expected_matches_workspace(binding, authority)
}

fn descriptor_expected_matches_workspace(
    binding: &grimodex_db::LiveBinding,
    authority: &PinnedWorkspaceDb,
) -> bool {
    let metadata_path = authority.path().join(".grimodex/workspace.json");
    let workspace_id = std::fs::read_to_string(metadata_path)
        .ok()
        .and_then(|metadata| serde_json::from_str::<serde_json::Value>(&metadata).ok())
        .and_then(|value| {
            value
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
        });
    workspace_id.as_deref() == Some(binding.workspace_id.as_str())
}

fn descriptor_replacement_retirement_proven(
    descriptor: &grimodex_db::workspace_lifecycle::RecoveryDescriptor,
    expected: &grimodex_db::LiveBinding,
    replacement: &PinnedWorkspaceDb,
) -> bool {
    let has_runs = descriptor.run.is_some() || !descriptor.additional_runs.is_empty();
    let all_runs_retired = descriptor
        .run
        .iter()
        .chain(descriptor.additional_runs.iter())
        .all(|ownership| ownership.handle.worker_joined && ownership.handle.connection_retired);
    // A descriptor without a Run still has the supervisor Join and protected
    // replacement boundary. A distinct active authority proves that the
    // retired instance is no longer the published authority; run-bearing
    // descriptors additionally require their durable connection receipt.
    if has_runs {
        all_runs_retired
    } else {
        expected.authority_instance != replacement.identity()
    }
}

/// Drop the retired authority from the active workspace slot before a
/// descriptor-bound resolver opens its replacement. The identity check keeps
/// a concurrent workspace switch from detaching a newer authority.
fn detach_retired_maintenance_authority(
    state: &AppState,
    retired_identity: u64,
) -> std::result::Result<(), AppError> {
    let mut inner = state
        .ws
        .inner
        .lock()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error.to_string())))?;
    if inner
        .as_ref()
        .is_some_and(|active| active.authority.identity() == retired_identity)
    {
        // Dropping the ActiveWorkspace releases the shared file lease. The
        // replacement recovery owner therefore acquires its lease after the
        // old authority and its SQLite handle have been retired.
        *inner = None;
    }
    Ok(())
}

fn recovery_baton_key(path: &std::path::Path, authority_instance: u64) -> String {
    format!("{}#{authority_instance}", path.to_string_lossy())
}

fn retry_recovery_baton_close(
    state: &AppState,
    descriptor_id: grimodex_db::workspace_lifecycle::RecoveryDescriptorId,
    binding: &grimodex_db::LiveBinding,
) -> std::result::Result<bool, AppError> {
    let key = recovery_baton_key(
        std::path::Path::new(&binding.locator),
        binding.authority_instance,
    );
    let baton = state
        .narrative_maintenance_recovery_batons
        .lock()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error.to_string())))?
        .get(&key)
        .cloned();
    let Some(baton) = baton else {
        return Ok(true);
    };
    if !baton.db().retirement_close_pending() {
        return Ok(true);
    }
    if let Err(error) = baton.db().retry_retirement_close() {
        tracing::warn!(
            target: "narrative.maintenance",
            %error,
            descriptor_id = descriptor_id.get(),
            "maintenance recovery close retry remains pending"
        );
        return Ok(false);
    }
    state
        .workspace_lifecycle
        .mark_descriptor_connection_retired(descriptor_id)?;
    Ok(true)
}

#[derive(Clone, Copy, Debug, Default)]
struct AuthorityRetirement {
    connection_retired: bool,
    baton_retained: bool,
}

/// Retire a supervisor-pinned authority before transferring a failed
/// execution to its descriptor. The connection health transition and the
/// active-slot detach happen before the local Arc is dropped, so the next
/// descriptor resolver must open a distinct authority and lease.
fn retire_authority_for_recovery_with_status(
    state: &AppState,
    authority: Option<PinnedWorkspaceDb>,
) -> AuthorityRetirement {
    let Some(authority) = authority else {
        return AuthorityRetirement::default();
    };
    let retirement_result = match authority.db().retire_connection_for_recovery() {
        Ok(()) => Ok(()),
        Err(error) => {
            tracing::error!(
                target: "narrative.maintenance",
                %error,
                "maintenance recovery could not retire old connection"
            );
            Err(error)
        }
    };
    let receipt_ready = retirement_result.is_ok();
    // A close failure leaves the returned Connection in the DB's quarantine
    // baton. Keep the authority/lease alive and detach it from the active
    // slot, but do not report retirement proof until an explicit retry closes
    // that handle successfully.
    let baton_required = receipt_ready || authority.db().retirement_close_pending();
    let mut baton_retained = false;
    if baton_required {
        let baton_stored = match state.narrative_maintenance_recovery_batons.lock() {
            Ok(mut batons) => {
                let key = recovery_baton_key(authority.path(), authority.identity());
                batons.insert(key, Arc::clone(&authority));
                true
            }
            Err(error) => {
                tracing::error!(
                    target: "narrative.maintenance",
                    %error,
                    "maintenance recovery could not retain lease-only baton"
                );
                false
            }
        };
        if baton_stored {
            baton_retained = true;
            if let Err(error) = detach_retired_maintenance_authority(state, authority.identity()) {
                tracing::error!(
                    target: "narrative.maintenance",
                    %error,
                    "maintenance recovery could not detach retired authority"
                );
            }
        }
    }
    // The active slot, when it still pointed at this identity, was detached
    // above. Dropping this final worker/supervisor Arc releases its lease.
    drop(authority);
    AuthorityRetirement {
        connection_retired: receipt_ready,
        baton_retained,
    }
}

fn retire_authority_for_recovery(state: &AppState, authority: Option<PinnedWorkspaceDb>) -> bool {
    retire_authority_for_recovery_with_status(state, authority).connection_retired
}

/// Resolve one exact maintenance recovery descriptor before ordinary cycle
/// admission. The descriptor is the only source of Run identity; no WorkKey
/// lookup or `active_database()` fallback is allowed while the core is in
/// RecoveryRequired. A successful resolution intentionally returns a
/// workspace-unavailable result so main requeues the delivery and performs a
/// fresh Ready snapshot before dispatching new work.
#[derive(Clone, Debug)]
struct MaintenanceRecoveryReconciliation {
    descriptor_id: grimodex_db::workspace_lifecycle::RecoveryDescriptorId,
    reason: String,
    maintenance_binding: Option<(Option<String>, MaintenanceWorkspaceBinding)>,
    rebound_binding: Option<MaintenanceWorkspaceBinding>,
}

fn reconcile_maintenance_recovery_descriptor(
    state: &AppState,
) -> std::result::Result<Option<MaintenanceRecoveryReconciliation>, AppError> {
    let snapshot = state.workspace_lifecycle.lifecycle_snapshot()?;
    let transition_ticket = state.workspace_lifecycle.current_transition_ticket()?;
    let descriptor_ids = match snapshot.state {
        LifecycleState::RecoveryRequired { descriptor_id } => vec![descriptor_id],
        LifecycleState::Ready(_) => state.workspace_lifecycle.recovery_descriptor_ids()?,
        // Native shutdown changes a Ready projection to a synthetic
        // Finishing transition (operation 0). If a background descriptor
        // worker was already admitted, let that exact owner finish its
        // receipt/ACK handoff instead of treating the ticket as an unknown
        // transition and wedging shutdown forever.
        LifecycleState::Transition {
            operation_id,
            stage: TransitionStage::Finishing,
        } if operation_id == OperationId::new(0) => transition_ticket
            .as_ref()
            .and_then(|ticket| ticket.recovery_descriptor_id)
            .into_iter()
            .collect(),
        _ => return Ok(None),
    };
    let active_authority = state.workspace_lifecycle.recovery_authority(&state.ws)?;
    let mut selected: Option<(
        grimodex_db::workspace_lifecycle::RecoveryDescriptorId,
        PinnedWorkspaceDb,
    )> = None;
    for descriptor_id in descriptor_ids {
        if descriptor_id == grimodex_db::workspace_lifecycle::SAFE_MODE_RECOVERY_DESCRIPTOR_ID {
            continue;
        }
        let descriptor = state
            .workspace_lifecycle
            .recovery_descriptor(descriptor_id)?;
        // The automatic pump owns only maintenance Run descriptors. Open and
        // Restore descriptors, including an initial Open candidate that failed
        // after installation, stay with the explicit workspace transition
        // supervisor and must not be silently activated here.
        if descriptor.owner
            != grimodex_db::workspace_lifecycle::RecoveryDescriptorOwner::Maintenance
        {
            continue;
        }
        if maintenance_recovery_binding(state, descriptor_id).is_none() {
            // A maintenance descriptor without its exact process-local
            // binding proof is not actionable by this pump. Keep the durable
            // root visible for the owner that can supply that evidence.
            continue;
        }
        let Some(binding) = descriptor.expected_binding.as_ref() else {
            continue;
        };
        // A failed close leaves the old SQLite handle and its shared lease in
        // a recovery baton.  Finish that close before opening or selecting
        // any authority for this descriptor.  In particular, do not let
        // `Database::new` below create a same-path connection while the old
        // handle is still alive.
        if !retry_recovery_baton_close(state, descriptor_id, binding)? {
            return Ok(Some(MaintenanceRecoveryReconciliation {
                descriptor_id,
                reason: "maintenance-recovery-connection-close-pending".to_owned(),
                maintenance_binding: maintenance_recovery_binding(state, descriptor_id),
                rebound_binding: None,
            }));
        }
        if let Some(authority) = active_authority.as_ref() {
            let metadata_path = authority.path().join(".grimodex/workspace.json");
            let workspace_id = std::fs::read_to_string(&metadata_path)
                .ok()
                .and_then(|metadata| serde_json::from_str::<serde_json::Value>(&metadata).ok())
                .and_then(|value| {
                    value
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(ToOwned::to_owned)
                });
            if binding.locator == authority.path().to_string_lossy()
                && workspace_id.as_deref() == Some(binding.workspace_id.as_str())
                && authority.db().connection_reusable()
            {
                selected = Some((descriptor_id, Arc::clone(authority)));
                break;
            }
        }
        // A descriptor may outlive the authority that created it (for
        // example W1 remains recoverable while W2 is Ready).  Reopen only the
        // exact descriptor locator under a fresh shared lease; never fall back
        // to the current active DB or a WorkKey lookup.
        if let Ok(authority) = open_descriptor_recovery_authority(binding) {
            selected = Some((descriptor_id, authority));
            break;
        }
    }
    let Some((descriptor_id, authority)) = selected else {
        return Ok(None);
    };
    // Resolution releases the descriptor responsibility only after the
    // process-local completion proof has been reserved. If every replay slot
    // is still unACKed, leave this descriptor responsible and let the next
    // pump retry after main ACKs one of the existing proofs.
    if !recovery_receipt_slot_available(state, descriptor_id) {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "NEX_MAINTENANCE_RECOVERY_RECEIPT_CAPACITY"
        )));
    }
    let descriptor = state
        .workspace_lifecycle
        .recovery_descriptor(descriptor_id)?;
    let existing_descriptor_ticket = transition_ticket.as_ref().is_some_and(|ticket| {
        ticket.kind == AdmissionKind::Recover
            && ticket.recovery_descriptor_id == Some(descriptor_id)
    });
    let view = if existing_descriptor_ticket {
        state
            .workspace_lifecycle
            .projected_recovery_transition_view(&state.ws)?
    } else {
        match state
            .workspace_lifecycle
            .try_begin_recovery_transition_for_workspace(descriptor_id, &state.ws)?
        {
            grimodex_db::AdmissionOutcome::Admitted(_) => {
                // `try_begin_recovery_transition` stores the ticket in the
                // adapter projection; obtain the corresponding public view only
                // through the normal transition helper so the renderer projection
                // remains revisioned and opaque.
                state
                    .workspace_lifecycle
                    .projected_recovery_transition_view(&state.ws)?
            }
            grimodex_db::AdmissionOutcome::NotAdmitted { .. } => {
                // An unrelated W2 maintenance owner may still be live while a W1
                // descriptor remains unresolved.  Keep the descriptor pending and
                // let the next recovery pump retry after W2 has joined; do not
                // enter a partial Transition that activation cannot complete.
                return Ok(None);
            }
        }
    };
    // Descriptor recovery is allowed to finish in the background while an
    // unrelated workspace remains Ready.  Do not publish a transient
    // Transition for that root: renderer would invalidate the live W2 scope
    // and then mistake the final W2 Ready snapshot for a successful rebind.
    // The shared core still records the transition and guards admission; the
    // public projection remains scoped to the active workspace.
    let background_descriptor_recovery = active_authority
        .as_ref()
        .zip(descriptor.expected_binding.as_ref())
        .is_some_and(|(active, expected)| {
            !descriptor_expected_matches_authority_identity(expected, active)
        });
    if !background_descriptor_recovery {
        emit_workspace_lifecycle_view(state, &view);
    }
    // A cleanup-quarantined authority must never be republished as Ready.
    // Install a replacement only after the shared recovery transition owns
    // the logical boundary; W2 remains untouched because its path is
    // different from the descriptor root.
    if active_authority.as_ref().is_some_and(|old_authority| {
        !old_authority.db().connection_reusable()
            && old_authority.path() == authority.path()
            && old_authority.identity() != authority.identity()
    }) || active_authority.is_none()
    {
        let mut inner = state
            .ws
            .inner
            .lock()
            .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error.to_string())))?;
        let can_install = match (active_authority.as_ref(), inner.as_ref()) {
            (None, None) => true,
            (Some(old_authority), Some(active)) => {
                active.authority.identity() == old_authority.identity()
            }
            _ => false,
        };
        if can_install {
            *inner = Some(ActiveWorkspace::new(Arc::clone(&authority)));
        }
    }

    let reconciliation =
        (|| -> std::result::Result<Option<MaintenanceRecoveryReconciliation>, AppError> {
            let activation_pending = descriptor.resolved && descriptor.responsibility.is_some();
            if !activation_pending {
                let mut runs = Vec::new();
                if let Some(run) = descriptor.run.clone() {
                    runs.push(run);
                }
                runs.extend(descriptor.additional_runs.clone());
                for ownership in runs {
                    match ownership.state {
                        grimodex_db::RunCreationState::Reserved
                        | grimodex_db::RunCreationState::CreationNotCommitted => {}
                        grimodex_db::RunCreationState::ReuseSelectionUnknown => {
                            let selected_run_id = ownership
                                .handle
                                .selected_reuse_run_id
                                .as_deref()
                                .ok_or_else(|| {
                                    AppError::Anyhow(anyhow::anyhow!(
                                "NEX_RUN_REUSE_SELECTION_UNKNOWN: selected Run ID is missing"
                            ))
                                })?;
                            let selected_handle =
                                narrative_extraction::resolve_reused_maintenance_run(
                                    authority.db(),
                                    selected_run_id,
                                )
                                .map_err(AppError::Anyhow)?;
                            state
                                .workspace_lifecycle
                                .attach_reuse_selection_to_descriptor(
                                    descriptor_id,
                                    grimodex_db::RunOwnership {
                                        state: grimodex_db::RunCreationState::Reused,
                                        handle: selected_handle.clone(),
                                    },
                                )?;
                            narrative_extraction::recover_maintenance_run_exact(
                                authority.db(),
                                &selected_handle,
                                "NEX_MAINTENANCE_RECOVERY_DESCRIPTOR",
                            )
                            .map_err(AppError::Anyhow)?;
                        }
                        grimodex_db::RunCreationState::CreationUnknown => {
                            match narrative_extraction::resolve_maintenance_run_creation_unknown(
                                authority.db(),
                                &ownership.handle,
                            )
                            .map_err(AppError::Anyhow)?
                            {
                                narrative_extraction::CreationResolution::NotCommitted => continue,
                                narrative_extraction::CreationResolution::Created => {
                                    narrative_extraction::recover_maintenance_run_exact(
                                        authority.db(),
                                        &ownership.handle,
                                        "NEX_MAINTENANCE_RECOVERY_DESCRIPTOR",
                                    )
                                    .map_err(AppError::Anyhow)?;
                                }
                            }
                        }
                        grimodex_db::RunCreationState::Created
                        | grimodex_db::RunCreationState::Reused => {
                            narrative_extraction::recover_maintenance_run_exact(
                                authority.db(),
                                &ownership.handle,
                                "NEX_MAINTENANCE_RECOVERY_DESCRIPTOR",
                            )
                            .map_err(AppError::Anyhow)?;
                        }
                    }
                }

                let generation = descriptor.control_generation;
                let request = ControlRequest {
                    generation,
                    fingerprint: format!("maintenance-descriptor:{descriptor_id}"),
                    payload: "terminalize-exact-runs".to_owned(),
                };
                match state
                    .workspace_lifecycle
                    .request_recovery_control(descriptor_id, &request)?
                {
                    ControlSlotOutcome::Accepted { .. } => {
                        state.workspace_lifecycle.complete_recovery_control(
                            descriptor_id,
                            generation,
                            "resolved",
                        )?;
                    }
                    ControlSlotOutcome::Replay { result, .. } => {
                        if result.as_deref() != Some("resolved") {
                            state.workspace_lifecycle.complete_recovery_control(
                                descriptor_id,
                                generation,
                                "resolved",
                            )?;
                        }
                    }
                    ControlSlotOutcome::Conflict { .. } => {
                        return Err(AppError::Anyhow(anyhow::anyhow!(
                            "NEX_MAINTENANCE_RECOVERY_CONTROL_CONFLICT"
                        )))
                    }
                    ControlSlotOutcome::Retired => {
                        return Err(AppError::Anyhow(anyhow::anyhow!(
                            "NEX_MAINTENANCE_RECOVERY_CONTROL_RETIRED"
                        )))
                    }
                }
                state
                    .workspace_lifecycle
                    .resolve_recovery_control(descriptor_id, generation)?;
                state
                    .workspace_lifecycle
                    .ack_recovery_control(descriptor_id, generation)?;
            }
            let maintenance_binding = maintenance_recovery_binding(state, descriptor_id);
            Ok(Some(MaintenanceRecoveryReconciliation {
                descriptor_id,
                reason: "maintenance-recovery-complete".to_owned(),
                maintenance_binding,
                rebound_binding: None,
            }))
        })();

    match reconciliation {
        Ok(mut result) => {
            // Capture the authority that will be visible at the activation
            // boundary before publishing Ready.  After publication another
            // Open may legitimately admit a new Transition, so calling
            // `active_database()` here would either fail closed or observe a
            // different workspace and produce an ACK-impossible receipt.
            // The open lock prevents a competing replacement from changing
            // the active slot until this reconciliation returns.
            let receipt_authority = state
                .ws
                .inner
                .lock()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error.to_string())))?
                .as_ref()
                .map(|active| Arc::clone(&active.authority));
            // `begin_recovery_transition` must be joined before the core may
            // publish a Ready binding. The recovery worker above performs no
            // protected workspace replacement, so this is the exact native
            // join boundary for the descriptor owner.
            let view = publish_workspace_lifecycle_from_workspace(state)?;
            let shutdown_finishing = state.workspace_lifecycle.shutdown_requested()?;
            if !matches!(view.status, WorkspaceLifecycleStatus::Ready) && !shutdown_finishing {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_RECOVERY_ACTIVATION_INCOMPLETE"
                )));
            }
            if result.is_some() {
                // The exact main-side binding remains available through any
                // activation failure. Retire the cleanup-failed gate marker
                // only after Ready is proven, then rotate the current
                // maintenance generation so a stale receipt cannot resume
                // the reopened authority.
                if let Some(reconciliation) = result.as_mut() {
                    if let Some((attempt_id, binding)) = reconciliation.maintenance_binding.as_ref()
                    {
                        if let Some(attempt_id) = attempt_id.as_deref() {
                            state
                                .narrative_maintenance_recovery_gate
                                .retire_recovered_attempt_binding(attempt_id, binding)
                                .map_err(AppError::Anyhow)?;
                        }
                        let _ = state
                            .narrative_maintenance_recovery_gate
                            .rotate_generation_for_binding(binding);
                    }
                    // Store the replayable proof before releasing the durable
                    // descriptor.  If the receipt capacity is full, the
                    // descriptor and its responsibility remain actionable;
                    // releasing first would strand the exact Run with no
                    // transport evidence for main to ACK.
                    if let Some((attempt_id, binding)) =
                        maintenance_recovery_binding(state, descriptor_id)
                    {
                        // Generation rotation is part of the same activation
                        // boundary as the replayable receipt.  Do not retain
                        // the binding captured before `rotate_generation`:
                        // same-workspace reopen deliberately advances the
                        // generation while keeping the authority/path.  A
                        // stale receipt would make the first response fail
                        // binding validation and would let a replay carry the
                        // same stale proof into the next delivery attempt.
                        let Some(active_binding) = receipt_authority.as_ref().map(|authority| {
                            narrative_maintenance_binding_for_authority(state, authority)
                        }) else {
                            return Err(AppError::Anyhow(anyhow::anyhow!(
                                "NEX_MAINTENANCE_RECOVERY_ACTIVE_BINDING_MISSING"
                            )));
                        };
                        let rebound_binding = receipt_authority.as_ref().and_then(|active| {
                            descriptor_rebound_binding_for_authority(
                                state,
                                &descriptor,
                                &authority,
                                active,
                            )
                        });
                        let receipt_stored = remember_completed_maintenance_recovery(
                            state,
                            descriptor_id,
                            NarrativeMaintenanceRecoveryReceipt {
                                recovered_binding: binding.clone(),
                                active_binding: Some(active_binding),
                                rebound_binding: rebound_binding.clone(),
                            },
                        );
                        if !receipt_stored {
                            return Err(AppError::Anyhow(anyhow::anyhow!(
                                "NEX_MAINTENANCE_RECOVERY_RECEIPT_CAPACITY"
                            )));
                        }
                        if let Err(error) = state
                            .workspace_lifecycle
                            .release_recovery_responsibility(descriptor_id)
                        {
                            forget_completed_maintenance_recovery(state, descriptor_id);
                            return Err(error);
                        }
                        let _ = take_maintenance_recovery_binding(state, descriptor_id);
                        reconciliation.rebound_binding = rebound_binding;
                        reconciliation.maintenance_binding = Some((attempt_id, binding));
                    } else {
                        return Err(AppError::Anyhow(anyhow::anyhow!(
                            "NEX_MAINTENANCE_RECOVERY_BINDING_MISSING"
                        )));
                    }
                }
            }
            // Keep the old lease-only baton until replacement installation,
            // exact Run reconciliation, control completion, and Ready
            // publication have all succeeded. The local replacement Arc is
            // still alive here, so removing the baton cannot create a gap.
            if let Some(binding) = descriptor.expected_binding.as_ref() {
                let key = recovery_baton_key(
                    std::path::Path::new(&binding.locator),
                    binding.authority_instance,
                );
                if let Ok(mut batons) = state.narrative_maintenance_recovery_batons.lock() {
                    batons.remove(&key);
                }
            }
            Ok(result)
        }
        Err(error) => {
            if background_descriptor_recovery {
                // The W1 descriptor is being recovered while W2 remains the
                // live renderer scope.  Join the failed recovery worker and
                // retire only its temporary transition ticket; keeping the
                // core globally RecoveryRequired here would stop W2 and leave
                // the next retry with no original binding.
                if state
                    .workspace_lifecycle
                    .mark_current_transition_joined()
                    .and_then(|_| {
                        state
                            .workspace_lifecycle
                            .abandon_background_recovery(&state.ws)
                    })
                    .is_ok()
                {
                    if let Ok(view) = state.workspace_lifecycle.snapshot_for_workspace(&state.ws) {
                        emit_workspace_lifecycle_view(state, &view);
                    }
                }
            } else {
                let _ = publish_workspace_lifecycle_recovery_after_join(state);
            }
            Err(error)
        }
    }
}

/// Run descriptor reconciliation under the same short Native open boundary
/// used by the ordinary maintenance delivery path.  Freshness has its own
/// scheduler and can be the only producer after a descriptor is created, so
/// it must be able to advance that root without waiting for a normal delivery
/// record or for the workspace to be admitted as a new maintenance attempt.
fn reconcile_maintenance_recovery_with_open_lock(
    state: &AppState,
) -> std::result::Result<Option<MaintenanceRecoveryReconciliation>, AppError> {
    // Recovery performs real DB/file work before it can publish a Ready
    // replacement. Keep the participant alive for the whole reconciliation,
    // including the descriptor-bound transition and final proof.
    let _workspace_operation = state
        .begin_workspace_operation()
        .map_err(AppError::Anyhow)?;
    let _open_guard = state.ws.open_lock.lock().map_err(|error| {
        AppError::Anyhow(anyhow::anyhow!(
            "NEX_MAINTENANCE_OPEN_LOCK_UNAVAILABLE: {error}"
        ))
    })?;
    reconcile_maintenance_recovery_descriptor(state)
}

/// Called by the eventual native shutdown owner after terminal cleanup has
/// been proven. It is deliberately crate-local so a renderer or arbitrary
/// main caller cannot manufacture a Closed state by invoking a setter.
#[allow(dead_code)]
pub(crate) fn publish_workspace_lifecycle_closed(
    state: &AppState,
) -> std::result::Result<WorkspaceLifecycleView, AppError> {
    let view = state.workspace_lifecycle.publish_closed()?;
    emit_workspace_lifecycle_view(state, &view);
    Ok(view)
}

/// Execute a manual maintenance operation through the shared lifecycle
/// owner. The public command still returns the adapter's typed outcome, but
/// the operation is admitted into the same core execution membership as the
/// automatic scheduler before it touches the pinned database.
enum ManualNarrativeMaintenanceCompletion<T> {
    DurableSuccess(T),
    Noop(T),
}

/// Owns a manual maintenance admission while the synchronous setup phase
/// validates the authority, work identity, and attempt registration.  Setup
/// can fail before the operation body exists, so dropping the raw permit would
/// leave a pending core ticket forever.  The guard proves the setup owner has
/// joined and releases that ticket; once the body starts, ownership is moved
/// into the normal finalizer below.
struct ManualMaintenancePermitSetupGuard {
    permit: Option<MaintenancePermit>,
}

impl ManualMaintenancePermitSetupGuard {
    fn new(permit: MaintenancePermit) -> Self {
        Self {
            permit: Some(permit),
        }
    }

    fn take(&mut self) -> Option<MaintenancePermit> {
        self.permit.take()
    }
}

impl Drop for ManualMaintenancePermitSetupGuard {
    fn drop(&mut self) {
        let Some(mut permit) = self.permit.take() else {
            return;
        };
        // Setup has not entered the operation body.  If the cleanup itself
        // fails, the core remains fail-closed rather than manufacturing a
        // successful execution result; the ignored error is surfaced by the
        // caller's original setup error.
        let _ = permit.mark_joined().and_then(|_| permit.release());
    }
}

fn run_manual_narrative_maintenance<T, F>(
    state: Arc<AppState>,
    project_id: String,
    run_kind: AutomaticRunKind,
    external_attempt_id: Option<String>,
    operation: F,
) -> anyhow::Result<T>
where
    F: for<'a> FnOnce(
        &Database,
        &'a MaintenanceCycleControl<'a>,
        &'a str,
    ) -> anyhow::Result<ManualNarrativeMaintenanceCompletion<T>>,
{
    // Manual maintenance owns a real DB connection and may create/finish a
    // Run across several transactions. Register it as a workspace
    // participant for the full synchronous supervisor scope so shutdown and
    // replacement cannot publish Closed/Ready while this owner is still
    // cleaning up.
    let _workspace_operation = state.begin_workspace_operation()?;
    anyhow::ensure!(
        matches!(
            run_kind,
            AutomaticRunKind::Backfill
                | AutomaticRunKind::Verify
                | AutomaticRunKind::RebuildDerived
        ),
        "manual narrative maintenance kind is unsupported"
    );

    // Synchronize a frozen/compatibility authority before admission, then
    // reserve the maintenance execution before pinning the database or
    // touching attempt/Run ownership.  An Open/Restore racing this boundary
    // must either be admitted first (and make this request NotAdmitted) or
    // observe this live execution and drain it; it may not replace the
    // authority while setup is mutating durable maintenance state.
    state
        .workspace_lifecycle
        .ensure_authority_ready(&state.ws)?;
    let lifecycle_permit = match state
        .workspace_lifecycle
        .begin_maintenance()
        .map_err(|error| anyhow::anyhow!("{error}"))?
    {
        PermitAdmission::Admitted(mut permit) => {
            if let Err(error) = permit.start() {
                permit.cancel_before_start().map_err(|cleanup| {
                    anyhow::anyhow!("NEX_MAINTENANCE_PENDING_START_CLEANUP_FAILED: {cleanup}")
                })?;
                return Err(anyhow::anyhow!(
                    "NEX_MAINTENANCE_PENDING_START_REJECTED: {error}"
                ));
            }
            ManualMaintenancePermitSetupGuard::new(permit)
        }
        PermitAdmission::NotAdmitted { reason, snapshot } => {
            anyhow::bail!(
                "NEX_MAINTENANCE_NOT_ADMITTED: {reason:?} at lifecycle revision {}",
                snapshot.revision
            );
        }
    };
    let mut lifecycle_permit_setup = lifecycle_permit;
    let authority = active_database(&state.ws)?;
    // Capture the verified DB namespace before any maintenance transaction
    // starts. Run creation reservations are invoked from inside that
    // transaction and must not recursively lock the same SQLite connection.
    let project_lifecycle_namespace =
        grimodex_db::narrative_extraction::project_lifecycle_namespace_for_database(
            authority.db(),
        )?;
    let semantic_epoch_id = authority
        .db()
        .with_conn(|conn| narrative_extraction::get_current_epoch(conn, &project_id))?
        .map(|epoch| epoch.id);
    let raw_work_key = match run_kind {
        AutomaticRunKind::Verify => format!(
            "{}{}",
            narrative_extraction::VERIFY_WORK_KEY_PREFIX,
            semantic_epoch_id.as_deref().ok_or_else(|| {
                anyhow::anyhow!("NEX_MAINTENANCE_NO_EPOCH: project has no Semantic Epoch")
            })?
        ),
        AutomaticRunKind::RebuildDerived => {
            anyhow::ensure!(
                semantic_epoch_id.is_some(),
                "NEX_MAINTENANCE_NO_EPOCH: project has no Semantic Epoch"
            );
            narrative_extraction::REBUILD_DERIVED_WORK_KEY.to_string()
        }
        AutomaticRunKind::Backfill => narrative_extraction::LEGACY_BACKFILL_WORK_KEY.to_string(),
    };
    let identity = match semantic_epoch_id.as_deref() {
        Some(epoch_id) => WorkKey::new_for_epoch(
            project_id.clone(),
            run_kind,
            raw_work_key,
            epoch_id.to_owned(),
        )?,
        None => WorkKey::new(project_id.clone(), run_kind, raw_work_key)?,
    };
    let canonical_work_key = identity.canonical_key();
    let authority_id = narrative_authority_id(&authority);
    let binding = state
        .narrative_maintenance_recovery_gate
        .binding_for_authority(&authority_id);
    let (attempt_id, owns_registration) = match external_attempt_id {
        Some(attempt_id) if !attempt_id.trim().is_empty() => (attempt_id, false),
        Some(_) => anyhow::bail!("NEX_MAINTENANCE_ATTEMPT_ID_INVALID: attemptId is required"),
        None => (format!("manual-maintenance-{}", Uuid::new_v4()), true),
    };
    if owns_registration {
        state
            .narrative_maintenance_recovery_gate
            .register_attempt(&attempt_id, &binding)?;
        if let Err(error) = state
            .narrative_maintenance_attempts
            .begin(&attempt_id, &binding)
        {
            state
                .narrative_maintenance_recovery_gate
                .release_attempt(&attempt_id);
            return Err(error);
        }
    } else {
        // The Electron main scheduler has already admitted this exact
        // attempt into Native. Manual execution only claims its work here;
        // it must not register a second recovery owner or replace the
        // binding after a workspace switch has started.
        state
            .narrative_maintenance_attempts
            .ensure_open_binding(&attempt_id, &binding)?;
    }
    let mut attempt_guard =
        NarrativeMaintenanceAttemptGuard::new(Arc::clone(&state), attempt_id.clone());
    attempt_guard.bind_authority(Arc::clone(&authority));
    if let Err(error) = state
        .narrative_maintenance_attempts
        .start(&attempt_id, [canonical_work_key.clone()])
    {
        let _ = attempt_guard.finalize_interrupted();
        return Err(error);
    }
    if let Err(error) = state
        .narrative_maintenance_attempts
        .mark_work_started(&attempt_id, &canonical_work_key)
    {
        let _ = attempt_guard.finalize_interrupted();
        return Err(error);
    }

    let state_for_control = Arc::clone(&state);
    let stop_signal = match state
        .narrative_maintenance_attempts
        .stop_signal(&attempt_id)
    {
        Ok(signal) => signal,
        Err(error) => {
            let _ = attempt_guard.finalize_interrupted();
            return Err(error);
        }
    };
    let finalization_granted_signal = match state
        .narrative_maintenance_attempts
        .finalization_granted_signal(&attempt_id)
    {
        Ok(signal) => signal,
        Err(error) => {
            let _ = attempt_guard.finalize_interrupted();
            return Err(error);
        }
    };
    let mut lifecycle_permit = lifecycle_permit_setup
        .take()
        .expect("manual maintenance setup permit must remain owned until body setup completes");
    let stop_signal_for_check = Arc::clone(&stop_signal);
    let lifecycle_permit_for_check = &lifecycle_permit;
    let should_stop = || -> anyhow::Result<()> {
        if lifecycle_permit_for_check.stop_requested()? {
            anyhow::bail!(
                "NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED: transition is draining this execution"
            );
        }
        if stop_signal_for_check.load(std::sync::atomic::Ordering::Acquire)
            || state_for_control
                .narrative_maintenance_attempts
                .stop_requested(&attempt_id)?
        {
            anyhow::bail!(
                "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation requested at a Rust work boundary"
            );
        }
        Ok(())
    };
    let defer_preempted_run = |run_id: &str| -> anyhow::Result<()> {
        state_for_control
            .narrative_maintenance_preempted_runs
            .defer(run_id, &binding)
    };
    let grant_finalize = |work_key: &str| -> anyhow::Result<()> {
        anyhow::ensure!(
            work_key == canonical_work_key,
            "NEX_MAINTENANCE_WORK_KEY_MISMATCH: manual finalization grant is not bound to the exact work"
        );
        anyhow::ensure!(
            state_for_control
                .narrative_maintenance_attempts
                .grant_work_finalize(&attempt_id, work_key)?,
            "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation won before work finalization"
        );
        Ok(())
    };
    let no_work =
        |_item: &grimodex_db::narrative_extraction::DesiredWork| Ok::<_, anyhow::Error>(());
    let creation_run_id = Arc::new(Mutex::new(None::<String>));
    let creation_run_id_for_start = Arc::clone(&creation_run_id);
    let creation_run_id_for_outcome = Arc::clone(&creation_run_id);
    let creation_run_id_for_reset = Arc::clone(&creation_run_id);
    let attach_run = |ownership: grimodex_db::workspace_lifecycle::RunOwnership| {
        lifecycle_permit
            .attach_run_ownership(ownership)
            .map_err(|error| anyhow::anyhow!("{error}"))
    };
    let reserve_run = |ownership: grimodex_db::workspace_lifecycle::RunOwnership| {
        let project_id = ownership.handle.project_id.clone();
        let database_path = ownership.handle.database_path.clone();
        let database_file_identity = ownership.handle.database_file_identity.clone();
        grimodex_db::narrative_extraction::try_reserve_project_creation_in_namespace(
            &project_lifecycle_namespace,
            &project_id,
        )?;
        if let Err(error) = lifecycle_permit.attach_run_ownership(ownership) {
            grimodex_db::narrative_extraction::release_project_creation_for_handle(
                &project_id,
                database_path.as_deref(),
                database_file_identity.as_deref(),
            );
            return Err(anyhow::anyhow!("{error}"));
        }
        Ok(())
    };
    let mark_run_creation_started = |run_id: &str| {
        *creation_run_id_for_start
            .lock()
            .map_err(|error| anyhow::anyhow!("creation tracking lock poisoned: {error}"))? =
            Some(run_id.to_owned());
        lifecycle_permit
            .mark_run_creation_started(run_id)
            .map_err(|error| anyhow::anyhow!("{error}"))
    };
    let mark_run_reuse_selection_unknown = |reservation_run_id: &str, selected_run_id: &str| {
        *creation_run_id_for_start
            .lock()
            .map_err(|error| anyhow::anyhow!("creation tracking lock poisoned: {error}"))? =
            Some(reservation_run_id.to_owned());
        lifecycle_permit
            .mark_run_reuse_selection_unknown(reservation_run_id, selected_run_id)
            .map_err(|error| anyhow::anyhow!("{error}"))
    };
    let mark_run_creation_outcome =
        |outcome: grimodex_db::workspace_lifecycle::RunCreationTransactionOutcome| {
            let run_id = creation_run_id_for_outcome
                .lock()
                .map_err(|error| anyhow::anyhow!("creation tracking lock poisoned: {error}"))?
                .clone();
            if let Some(run_id) = run_id {
                lifecycle_permit
                    .mark_run_creation_outcome(&run_id, outcome)
                    .map_err(|error| anyhow::anyhow!("{error}"))?;
            }
            Ok(())
        };
    let reset_run_creation_tracking = || {
        *creation_run_id_for_reset
            .lock()
            .map_err(|error| anyhow::anyhow!("creation tracking lock poisoned: {error}"))? = None;
        Ok(())
    };
    let mark_run_terminalized = |run_id: &str| {
        lifecycle_permit
            .mark_run_terminalized(run_id)
            .map_err(|error| anyhow::anyhow!("{error}"))
    };
    let control = MaintenanceCycleControl {
        should_stop: &should_stop,
        stop_signal: Some(stop_signal),
        finalization_granted_signal: Some(finalization_granted_signal),
        defer_preempted_run: &defer_preempted_run,
        grant_finalize: &grant_finalize,
        register_work: &no_work,
        work_started: &no_work,
        work_completed: &no_work,
        work_noop_completed: &no_work,
        work_deferred: &no_work,
        attach_run: Some(&attach_run),
        reserve_run: Some(&reserve_run),
        mark_run_creation_started: Some(&mark_run_creation_started),
        mark_run_reuse_selection_unknown: Some(&mark_run_reuse_selection_unknown),
        mark_run_creation_outcome: Some(&mark_run_creation_outcome),
        reset_run_creation_tracking: Some(&reset_run_creation_tracking),
        mark_run_terminalized: Some(&mark_run_terminalized),
    };

    let operation_result = match catch_unwind(AssertUnwindSafe(|| {
        operation(authority.db(), &control, &canonical_work_key)
    })) {
        Ok(result) => result,
        Err(_) => Err(anyhow::anyhow!(
            "NEX_MAINTENANCE_PANIC: manual maintenance worker panicked"
        )),
    };
    let result = match operation_result {
        Ok(completion) => {
            let finish = (|| -> anyhow::Result<T> {
                attempt_guard.mark_cleanup_clean(&state)?;
                let value = match completion {
                    ManualNarrativeMaintenanceCompletion::DurableSuccess(value) => {
                        state
                            .narrative_maintenance_attempts
                            .mark_work_succeeded(&attempt_id, &canonical_work_key)?;
                        value
                    }
                    ManualNarrativeMaintenanceCompletion::Noop(value) => {
                        state
                            .narrative_maintenance_attempts
                            .mark_work_completed(&attempt_id, &canonical_work_key)?;
                        value
                    }
                };
                state
                    .narrative_maintenance_attempts
                    .close_work_registration(&attempt_id)?;
                anyhow::ensure!(
                    state
                        .narrative_maintenance_attempts
                        .arm_finalize_success(&attempt_id)?,
                    "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation won before final attempt publication"
                );
                anyhow::ensure!(
                    attempt_guard.finalize_success()?,
                    "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation won before finalization"
                );
                Ok(value)
            })();
            if finish.is_err() && !attempt_guard.finalized {
                let _ = attempt_guard.finalize_interrupted();
            }
            finish
        }
        Err(error) => {
            let cleanup = attempt_guard.mark_cleanup_clean(&state);
            let terminal = attempt_guard.finalize_interrupted();
            match (cleanup, terminal) {
                (Ok(()), Ok(())) => Err(error),
                (Err(cleanup), Ok(())) => Err(error.context(format!(
                    "NEX_MAINTENANCE_CONNECTION_CLEANUP_FAILED: {cleanup}"
                ))),
                (Ok(()), Err(terminal)) => Err(error.context(format!(
                    "NEX_MAINTENANCE_ATTEMPT_TERMINALIZE_FAILED: {terminal}"
                ))),
                (Err(cleanup), Err(terminal)) => Err(error.context(format!(
                    "NEX_MAINTENANCE_CONNECTION_CLEANUP_FAILED: {cleanup}; terminalize: {terminal}"
                ))),
            }
        }
    };

    // Manual routes are synchronous inside the Native blocking boundary, so
    // this function is the supervisor for the permit.  Never rely on Drop to
    // infer Join: the operation body has returned, cleanup has been observed,
    // and only now may the shared core release or transfer the execution.
    let lifecycle_result = if result.is_ok() {
        lifecycle_permit
            .mark_joined()
            .and_then(|_| lifecycle_permit.release())
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("NEX_MAINTENANCE_LIFECYCLE_RELEASE_FAILED: {error}"))
    } else {
        lifecycle_permit
            .mark_joined()
            .map_err(|error| anyhow::anyhow!("NEX_MAINTENANCE_LIFECYCLE_JOIN_FAILED: {error}"))
            .and_then(|_| {
                let run_ownership = lifecycle_permit
                    .has_run_ownership()
                    .map_err(|error| anyhow::anyhow!("{error}"))?;
                if let Some(authority) = attempt_guard.authority.take() {
                    if authority.db().connection_reusable() && !run_ownership {
                        // A durable terminal transaction already removed the
                        // exact Run ownership slot.  A reusable connection is
                        // sufficient only after that proof; cleanup health
                        // alone must not release a still-running Run.
                        return lifecycle_permit
                            .release()
                            .map(|_| ())
                            .map_err(|error| anyhow::anyhow!("{error}"));
                    }
                    let _ = retire_authority_for_recovery(&state, Some(authority));
                }
                let descriptor_id = lifecycle_permit
                    .transfer_to_recovery()
                    .map_err(|error| anyhow::anyhow!("{error}"))?;
                record_maintenance_recovery_binding(
                    &state,
                    descriptor_id,
                    Some(&attempt_id),
                    Some(&binding),
                );
                Ok(())
            })
    };
    if let Err(error) = lifecycle_result {
        return Err(result
            .err()
            .unwrap_or_else(|| anyhow::anyhow!("{error}"))
            .context(error.to_string()));
    }
    result
}

const ENTITY_SEED_MAX_SOURCES: u32 = 900;
const ENTITY_SEED_MAX_REQUEST_UTF8_BYTES: usize = 8 * 1024 * 1024;
const ENTITY_SEED_MAX_REF_UTF8_BYTES: usize = 1024;
const ENTITY_SEED_MAX_LANGUAGE_UTF8_BYTES: usize = 64;
const ENTITY_SEED_MAX_PROPERTY_NAME_UTF8_BYTES: usize = 64;

fn invalid_entity_seed_request(message: impl std::fmt::Display) -> Error {
    Error::from_reason(format!("invalid request: {message}"))
}

#[derive(Default)]
struct EntitySeedJsStringBudget {
    raw_utf8_bytes: usize,
}

impl EntitySeedJsStringBudget {
    fn admit(
        &mut self,
        value: &napi::JsString,
        label: &str,
        field_max_utf8_bytes: Option<usize>,
    ) -> Result<()> {
        // V8 can expose the UTF-16 length without first allocating a Rust
        // copy. Every valid scalar requires at least one UTF-8 byte per
        // UTF-16 unit, so this rejects obviously oversized strings before the
        // potentially expensive UTF-8 length scan as well.
        let utf16_len = value
            .utf16_len()
            .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
        if let Some(field_max) = field_max_utf8_bytes {
            if utf16_len > field_max {
                return Err(invalid_entity_seed_request(format!(
                    "{label} exceeds {field_max} UTF-8 bytes"
                )));
            }
        }
        let remaining = ENTITY_SEED_MAX_REQUEST_UTF8_BYTES
            .checked_sub(self.raw_utf8_bytes)
            .ok_or_else(|| {
                invalid_entity_seed_request("entity seed request exceeds the 8 MiB wire budget")
            })?;
        if utf16_len > remaining {
            return Err(invalid_entity_seed_request(
                "entity seed request exceeds the 8 MiB wire budget",
            ));
        }

        let utf8_len = value
            .utf8_len()
            .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
        if let Some(field_max) = field_max_utf8_bytes {
            if utf8_len > field_max {
                return Err(invalid_entity_seed_request(format!(
                    "{label} exceeds {field_max} UTF-8 bytes"
                )));
            }
        }
        self.raw_utf8_bytes = self
            .raw_utf8_bytes
            .checked_add(utf8_len)
            .filter(|total| *total <= ENTITY_SEED_MAX_REQUEST_UTF8_BYTES)
            .ok_or_else(|| {
                invalid_entity_seed_request("entity seed request exceeds the 8 MiB wire budget")
            })?;
        Ok(())
    }
}

fn entity_seed_utf16_string(value: napi::JsString, label: &str) -> Result<String> {
    let utf16 = value
        .into_utf16()
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
    utf16.as_str().map_err(|_| {
        invalid_entity_seed_request(format!("{label} contains a lone UTF-16 surrogate"))
    })
}

fn entity_seed_string_property(
    object: &napi::JsObject,
    name: &str,
    label: &str,
    budget: &mut EntitySeedJsStringBudget,
    field_max_utf8_bytes: Option<usize>,
) -> Result<String> {
    let value: napi::JsString = object
        .get_named_property(name)
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
    budget.admit(&value, label, field_max_utf8_bytes)?;
    entity_seed_utf16_string(value, label)
}

fn validate_entity_seed_object_keys(
    object: &napi::JsObject,
    label: &str,
    expected: &[&str],
) -> Result<()> {
    let properties = object
        .get_property_names()
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
    let length = properties
        .get_array_length()
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
    let mut actual = Vec::with_capacity(length as usize);
    for index in 0..length {
        let key: napi::JsString = properties
            .get_element(index)
            .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
        let key_label = format!("{label} property name");
        let key_utf16_len = key
            .utf16_len()
            .map_err(|error| invalid_entity_seed_request(format!("{key_label}: {error}")))?;
        if key_utf16_len > ENTITY_SEED_MAX_PROPERTY_NAME_UTF8_BYTES {
            return Err(invalid_entity_seed_request(format!(
                "{key_label} exceeds {ENTITY_SEED_MAX_PROPERTY_NAME_UTF8_BYTES} UTF-8 bytes"
            )));
        }
        let key_utf8_len = key
            .utf8_len()
            .map_err(|error| invalid_entity_seed_request(format!("{key_label}: {error}")))?;
        if key_utf8_len > ENTITY_SEED_MAX_PROPERTY_NAME_UTF8_BYTES {
            return Err(invalid_entity_seed_request(format!(
                "{key_label} exceeds {ENTITY_SEED_MAX_PROPERTY_NAME_UTF8_BYTES} UTF-8 bytes"
            )));
        }
        let key = entity_seed_utf16_string(key, &key_label)?;
        if !expected.contains(&key.as_str()) {
            return Err(invalid_entity_seed_request(format!(
                "unknown field `{key}` in {label}"
            )));
        }
        actual.push(key);
    }
    for required in expected {
        if !actual.iter().any(|key| key == required) {
            return Err(invalid_entity_seed_request(format!(
                "missing field `{required}` in {label}"
            )));
        }
    }
    Ok(())
}

fn entity_seed_u32_property(object: &napi::JsObject, name: &str, label: &str) -> Result<u32> {
    let value: f64 = object
        .get_named_property(name)
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > u32::MAX as f64 {
        return Err(invalid_entity_seed_request(format!(
            "{label} must be an unsigned 32-bit integer"
        )));
    }
    Ok(value as u32)
}

fn entity_seed_object_property(
    object: &napi::JsObject,
    name: &str,
    label: &str,
) -> Result<napi::JsObject> {
    object
        .get_named_property(name)
        .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))
}

fn entity_seed_request_from_js(
    request: napi::JsObject,
) -> Result<grimodex_semantic::entity_seeds::ExtractCodexEntitySeedsRequestV1> {
    validate_entity_seed_object_keys(
        &request,
        "request",
        &[
            "schemaVersion",
            "normalizerVersion",
            "language",
            "minimumOccurrenceCount",
            "sources",
        ],
    )?;
    let mut string_budget = EntitySeedJsStringBudget::default();
    let schema_version =
        entity_seed_u32_property(&request, "schemaVersion", "request.schemaVersion")?;
    let normalizer_version = entity_seed_string_property(
        &request,
        "normalizerVersion",
        "request.normalizerVersion",
        &mut string_budget,
        None,
    )?;
    let language = entity_seed_string_property(
        &request,
        "language",
        "request.language",
        &mut string_budget,
        Some(ENTITY_SEED_MAX_LANGUAGE_UTF8_BYTES),
    )?;
    let minimum_occurrence_count = entity_seed_u32_property(
        &request,
        "minimumOccurrenceCount",
        "request.minimumOccurrenceCount",
    )?;
    let sources_object = entity_seed_object_property(&request, "sources", "request.sources")?;
    if !sources_object
        .is_array()
        .map_err(|error| invalid_entity_seed_request(format!("request.sources: {error}")))?
    {
        return Err(invalid_entity_seed_request(
            "request.sources must be an array",
        ));
    }
    let source_count = sources_object
        .get_array_length()
        .map_err(|error| invalid_entity_seed_request(format!("request.sources: {error}")))?;
    if source_count > ENTITY_SEED_MAX_SOURCES {
        return Err(invalid_entity_seed_request(format!(
            "request.sources must contain at most {ENTITY_SEED_MAX_SOURCES} items"
        )));
    }

    let mut sources = Vec::with_capacity(source_count as usize);
    for index in 0..source_count {
        let label = format!("request.sources[{index}]");
        let source: napi::JsObject = sources_object
            .get_element(index)
            .map_err(|error| invalid_entity_seed_request(format!("{label}: {error}")))?;
        validate_entity_seed_object_keys(
            &source,
            &label,
            &["sourceRef", "documentRef", "documentRange", "text"],
        )?;
        let range_label = format!("{label}.documentRange");
        let range = entity_seed_object_property(&source, "documentRange", &range_label)?;
        validate_entity_seed_object_keys(&range, &range_label, &["start", "end"])?;
        sources.push(
            grimodex_semantic::entity_seeds::EntitySeedCanonicalSourceV1 {
                source_ref: entity_seed_string_property(
                    &source,
                    "sourceRef",
                    &format!("{label}.sourceRef"),
                    &mut string_budget,
                    Some(ENTITY_SEED_MAX_REF_UTF8_BYTES),
                )?,
                document_ref: entity_seed_string_property(
                    &source,
                    "documentRef",
                    &format!("{label}.documentRef"),
                    &mut string_budget,
                    Some(ENTITY_SEED_MAX_REF_UTF8_BYTES),
                )?,
                document_range: grimodex_semantic::entity_seeds::CanonicalRangeV1 {
                    start: entity_seed_u32_property(
                        &range,
                        "start",
                        &format!("{range_label}.start"),
                    )?,
                    end: entity_seed_u32_property(&range, "end", &format!("{range_label}.end"))?,
                },
                text: entity_seed_string_property(
                    &source,
                    "text",
                    &format!("{label}.text"),
                    &mut string_budget,
                    None,
                )?,
            },
        );
    }

    Ok(
        grimodex_semantic::entity_seeds::ExtractCodexEntitySeedsRequestV1 {
            schema_version,
            normalizer_version,
            language,
            minimum_occurrence_count,
            sources,
        },
    )
}

pub struct ExtractCodexEntitySeedsTask {
    request: std::result::Result<
        grimodex_semantic::entity_seeds::ExtractCodexEntitySeedsRequestV1,
        String,
    >,
}

impl napi::Task for ExtractCodexEntitySeedsTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        let request = self
            .request
            .as_ref()
            .map_err(|reason| Error::from_reason(reason.clone()))?;
        let response = grimodex_semantic::entity_seeds::extract_codex_entity_seeds(request)
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&response).map_err(|error| {
            Error::from_reason(format!("failed to serialize entity seeds: {error}"))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

fn native_workspace_open_trace_enabled() -> bool {
    std::env::var("GRIMODEX_WORKSPACE_OPEN_TRACE")
        .as_deref()
        .is_ok_and(|value| value == "1")
}

/// Semantic commandの共通境界。blocking poolへ投入する**前**にruntimeの
/// optimistic pin（epoch snapshot → active DB Arc → generation再確認）を完了し、
/// closure中にworkspace/epochを再解決しない。これにより切替待ち行列中でも
/// 1 commandが別DB/別cache generationへ跨らない。
async fn run_semantic_wire<T, F>(state: Arc<AppState>, operation: F) -> Result<String>
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(
            &grimodex_semantic::runtime::SemanticRuntime,
            &grimodex_semantic::runtime::SemanticRequest,
        ) -> anyhow::Result<T>
        + Send
        + 'static,
{
    // The SemanticRequest owns a pinned authority through the blocking
    // operation, but the shared lifecycle core must also observe that DB
    // membership. Keep this participant across the spawn/Join boundary so a
    // workspace replacement or shutdown cannot declare Closed while semantic
    // I/O is still using the old authority.
    let workspace_operation = state
        .begin_workspace_operation()
        .map_err(|error| app_err_to_napi(AppError::Anyhow(error)))?;
    let workspace_participant = state
        .ws
        .lifecycle_core()
        .begin_workspace_participant()
        .map_err(|error| app_err_to_napi(AppError::Anyhow(anyhow::anyhow!(error))))?;
    let request = state
        .semantic
        .pin_request(|| active_database(&state.ws))
        .map_err(app_err_to_napi)?;
    let runtime = Arc::clone(&state.semantic);
    napi::tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let _workspace_operation = workspace_operation;
        let _workspace_participant = workspace_participant;
        let value = operation(&runtime, &request)?;
        Ok(serde_json::to_string(&value)?)
    })
    .await
    .map_err(join_err_to_napi)?
    .map_err(|error| Error::from_reason(format!("{error:#}")))
}

async fn run_scoped_semantic_wire<T, F>(
    state: Arc<AppState>,
    expected_workspace_path: String,
    operation: F,
) -> Result<String>
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(
            &grimodex_semantic::runtime::SemanticRuntime,
            &grimodex_semantic::runtime::SemanticRequest,
        ) -> anyhow::Result<T>
        + Send
        + 'static,
{
    let workspace_operation = state
        .begin_workspace_operation()
        .map_err(|error| app_err_to_napi(AppError::Anyhow(error)))?;
    let workspace_participant = state
        .ws
        .lifecycle_core()
        .begin_workspace_participant()
        .map_err(|error| app_err_to_napi(AppError::Anyhow(anyhow::anyhow!(error))))?;
    let request = pin_scoped_semantic_request(&state, &expected_workspace_path)?;
    let runtime = Arc::clone(&state.semantic);
    napi::tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let _workspace_operation = workspace_operation;
        let _workspace_participant = workspace_participant;
        let value = operation(&runtime, &request)?;
        Ok(serde_json::to_string(&value)?)
    })
    .await
    .map_err(join_err_to_napi)?
    .map_err(|error| Error::from_reason(format!("{error:#}")))
}

fn pin_scoped_semantic_request(
    state: &Arc<AppState>,
    expected_workspace_path: &str,
) -> Result<grimodex_semantic::runtime::SemanticRequest> {
    state
        .semantic
        .pin_request(|| {
            let workspace = active_workspace_snapshot(&state.ws)?;
            let active = workspace
                .path()
                .canonicalize()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
            let expected = PathBuf::from(expected_workspace_path)
                .canonicalize()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
            if active != expected {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "SEMANTIC_INDEX_WORKSPACE_CHANGED: expected {}, active {}",
                    expected.display(),
                    active.display()
                )));
            }
            Ok(Arc::clone(workspace.db()))
        })
        .map_err(app_err_to_napi)
}

fn authoritative_ime_options(
    state: &AppState,
    fallback: &ImeExportOptions,
) -> std::result::Result<ImeExportOptions, AppError> {
    let _guard = state
        .gs
        .write_lock
        .lock()
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
    let settings = workspace::read_global_settings(&state.gs.path);
    Ok(resolve_options_from_preferences(
        &settings.user_preferences,
        fallback,
    ))
}

fn authoritative_ime_mode(
    state: &AppState,
    fallback: ImeIntegrationMode,
) -> std::result::Result<ImeIntegrationMode, AppError> {
    let _guard = state
        .gs
        .write_lock
        .lock()
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
    let settings = workspace::read_global_settings(&state.gs.path);
    Ok(resolve_mode_from_preferences(
        &settings.user_preferences,
        fallback,
    ))
}

/// Linearization barrier for a native workspace replacement. The swap hook
/// waits for an old snapshot writer to finish, rotates the request generation,
/// and deactivates the shared pointer before any new writer can enter.
fn rotate_ime_workspace(state: &AppState) {
    rotate_ime_workspace_traced(state, None);
}

fn rotate_ime_workspace_traced(state: &AppState, mut trace: Option<&mut NativeWorkspaceOpenTrace>) {
    let lock_span = trace
        .as_deref_mut()
        .and_then(|trace| trace.begin_span(NativeWorkspaceOpenSpanName::ImeLockWait));
    let _writer = match state.ime_write_lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(trace) = trace {
        trace.finish_span(lock_span);
    }
    state.ime_request_gate.rotate_workspace();
    if let Err(error) = set_active_project(&state.ime_root, None, ImeIntegrationMode::On) {
        eprintln!("failed to deactivate IME pointer during workspace swap: {error}");
    }
}

fn validate_ime_workspace(
    workspace: &ActiveWorkspaceSnapshot,
    expected_workspace_path: &str,
) -> std::result::Result<(), AppError> {
    let expected = PathBuf::from(expected_workspace_path);
    if workspace.path() != expected {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "IME_WORKSPACE_CHANGED: expected {}, active {}",
            expected.display(),
            workspace.path().display()
        )));
    }
    Ok(())
}

fn validate_codex_workspace(
    workspace: &ActiveWorkspaceSnapshot,
    expected_workspace_path: &str,
) -> std::result::Result<(), AppError> {
    let active = workspace
        .path()
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    // Canonicalize on the same side of the N-API boundary. Node and Rust can
    // use different lexical representations for the same Windows/UNC path
    // (for example Rust's verbatim `\\?\` prefix), so comparing a Rust
    // canonical path with a raw JS string rejects a legitimate workspace.
    let expected = PathBuf::from(expected_workspace_path)
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    if active != expected {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "CODEX_WORKSPACE_CHANGED: expected {}, active {}",
            expected.display(),
            active.display()
        )));
    }
    Ok(())
}

fn validate_ai_audit_workspace(
    workspace: &ActiveWorkspaceSnapshot,
    expected_workspace_path: &str,
) -> std::result::Result<(), AppError> {
    let active = workspace
        .path()
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    let expected = PathBuf::from(expected_workspace_path)
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    if active != expected {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "AI_AUDIT_WORKSPACE_CHANGED: expected {}, active {}",
            expected.display(),
            active.display()
        )));
    }
    Ok(())
}

fn validate_timelapse_workspace(
    workspace: &ActiveWorkspaceSnapshot,
    expected_workspace_path: &str,
) -> std::result::Result<(), AppError> {
    if expected_workspace_path.is_empty()
        || expected_workspace_path.trim() != expected_workspace_path
        || expected_workspace_path.chars().count() > 16_384
    {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "TIMELAPSE_GENESIS_BASELINE_INVALID_WORKSPACE_PATH: expectedWorkspacePath must be exact, non-empty, and at most 16384 characters"
        )));
    }
    let active = workspace
        .path()
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    let expected = PathBuf::from(expected_workspace_path)
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    if active != expected {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "TIMELAPSE_GENESIS_BASELINE_WORKSPACE_CHANGED: expected {}, active {}",
            expected.display(),
            active.display()
        )));
    }
    Ok(())
}

fn validate_narrative_extraction_workspace(
    workspace: &ActiveWorkspaceSnapshot,
    expected_workspace_path: &str,
) -> std::result::Result<(), AppError> {
    let active = workspace
        .path()
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    // Keep both paths on the Rust side of the boundary. Windows may expose
    // the same directory to JS lexically and to Rust with a verbatim/UNC
    // representation; canonical equality is the authority check.
    let expected = PathBuf::from(expected_workspace_path)
        .canonicalize()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!(error)))?;
    if active != expected {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED: expected {}, active {}",
            expected.display(),
            active.display()
        )));
    }
    Ok(())
}

/// Optimistically bind one request token to the exact DB/path snapshot seen at
/// IPC arrival. A concurrent swap either makes `active_workspace_snapshot`
/// fail closed or changes the gate generation so registration retries.
fn pin_ime_workspace_request(
    state: &AppState,
    expected_workspace_path: &str,
    mut register: impl FnMut(&ImeExportRequestGate, u64) -> Option<ImeExportRequestToken>,
) -> std::result::Result<(ActiveWorkspaceSnapshot, ImeExportRequestToken), AppError> {
    loop {
        let generation = state.ime_request_gate.workspace_generation();
        let workspace = active_workspace_snapshot(&state.ws)?;
        validate_ime_workspace(&workspace, expected_workspace_path)?;
        if let Some(request) = register(&state.ime_request_gate, generation) {
            return Ok((workspace, request));
        }
    }
}

/// agent_writes 19 コマンドの定形写像。FE の `{ payload }` を DTO へ
/// deserialize し、共有 impl を with_db_state 上で呼んで結果 Value を JSON 文字列
/// で返す (Tauri の `with_db(&ws, |db| agent_xxx_impl(db, payload))` の写像)。
/// 各 impl 内で BEGIN IMMEDIATE → tracked write → commit_or_rollback が閉じる。
async fn agent_write_cmd<T, F>(
    state: Arc<AppState>,
    label: &'static str,
    payload: serde_json::Value,
    f: F,
) -> Result<String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
    F: FnOnce(&grimodex_db::Database, T) -> anyhow::Result<serde_json::Value> + Send + 'static,
{
    run_blocking(move || {
        // Every renderer-owned write is a shutdown participant.  The guard is
        // independent of foreground/maintenance admission so parallel writes
        // retain their existing SQLite priority while Closed waits for their
        // actual transaction return.
        let _workspace_operation = state
            .begin_workspace_operation()
            .map_err(AppError::Anyhow)?;
        let authority_context = if payload.get("authorityRoute").is_some() {
            let context: grimodex_db::agent_writes::RendererCanonicalWriteContext =
                from_wire(label, payload.clone())?;
            agent_writes::validate_renderer_authority_context(&context)?;
            Some(serde_json::to_value(context).map_err(|error| AppError::Anyhow(error.into()))?)
        } else {
            None
        };
        let dto: T = from_wire(label, payload)?;
        with_db_state(&state.ws, |db| {
            let result = match authority_context {
                Some(context) => {
                    grimodex_db::change_events::with_renderer_authority_context(context, || {
                        f(db, dto)
                    })?
                }
                None => f(db, dto)?,
            };
            Ok(serde_json::to_string(&result)?)
        })
    })
    .await
}

/// Foreground Apply/Prepare owner.  Eligibility reads borrow this control
/// through the same SQLite transaction as their DML, and a concurrent
/// lifecycle transition turns into a typed validation termination instead of
/// being normalized as Source missing or a failed Prepared commit.
struct ForegroundValidationControl<'permit> {
    state: Arc<AppState>,
    lifecycle_permit: &'permit MaintenancePermit,
}

impl<'permit> ForegroundValidationControl<'permit> {
    fn new(state: Arc<AppState>, lifecycle_permit: &'permit MaintenancePermit) -> Self {
        Self {
            state,
            lifecycle_permit,
        }
    }
}

impl GraphWorkControl for ForegroundValidationControl<'_> {
    fn check(&mut self, _stage: GraphWorkStage) -> anyhow::Result<()> {
        if self
            .lifecycle_permit
            .stop_requested()
            .map_err(|error| anyhow::anyhow!("foreground lifecycle permit unavailable: {error}"))?
        {
            return Err(validation_terminated(
                ValidationTerminationReason::WorkspaceGenerationChanged,
                "foreground validation stopped by the shared lifecycle owner",
            ));
        }
        if self
            .state
            .workspace_shutdown_requested
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(validation_terminated(
                ValidationTerminationReason::Closed,
                "foreground validation stopped by Native shutdown",
            ));
        }
        let snapshot =
            self.state.ws.switching.core().snapshot().map_err(|error| {
                anyhow::anyhow!("workspace lifecycle state unavailable: {error}")
            })?;
        if matches!(snapshot.state, LifecycleState::Transition { .. }) {
            return Err(validation_terminated(
                ValidationTerminationReason::WorkspaceGenerationChanged,
                "foreground validation stopped while workspace lifecycle was transitioning",
            ));
        }
        if matches!(
            snapshot.state,
            LifecycleState::Closed | LifecycleState::RecoveryRequired { .. }
        ) {
            return Err(validation_terminated(
                ValidationTerminationReason::Closed,
                "foreground validation has no usable workspace authority",
            ));
        }
        Ok(())
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

/// Admit a foreground command before it opens or borrows a DB transaction.
/// The returned permit is intentionally held by the command closure until the
/// transaction, result serialization, and connection cleanup have returned.
fn begin_foreground_lifecycle_permit(
    state: &AppState,
) -> std::result::Result<MaintenancePermit, AppError> {
    match state.workspace_lifecycle.begin_foreground()? {
        PermitAdmission::Admitted(mut permit) => {
            if let Err(error) = permit.start() {
                let cleanup = permit.cancel_before_start().map_err(|cleanup| {
                    AppError::Anyhow(anyhow::anyhow!(
                        "NEX_FOREGROUND_PENDING_START_CLEANUP_FAILED: {cleanup}"
                    ))
                });
                return match cleanup {
                    Ok(_) => Err(AppError::Anyhow(anyhow::anyhow!(
                        "NEX_FOREGROUND_PENDING_START_REJECTED: {error}"
                    ))),
                    Err(cleanup_error) => Err(cleanup_error),
                };
            }
            Ok(permit)
        }
        PermitAdmission::NotAdmitted { reason, snapshot } => {
            Err(AppError::Anyhow(anyhow::anyhow!(
                "NEX_FOREGROUND_NOT_ADMITTED: {reason:?} at lifecycle revision {}",
                snapshot.revision
            )))
        }
    }
}

/// Finalize a foreground lifecycle execution only after its DB closure has
/// returned.  A finalizer failure remains visible in the shared core instead
/// of being hidden behind a successful command result.
fn finish_foreground_lifecycle_permit<T>(
    state: &Arc<AppState>,
    mut permit: MaintenancePermit,
    operation: std::result::Result<T, AppError>,
    cleanup_proven: bool,
    pinned_authority: PinnedWorkspaceDb,
) -> std::result::Result<T, AppError> {
    let finalization = match permit.mark_joined() {
        Ok(()) => {
            // The transition may have started after this foreground owner
            // entered its finalizer.  The normal Ready-only getter then
            // fails closed, but that failure cannot be used as evidence that
            // the exact connection is gone: the transition is waiting for
            // this permit to release.  Keep the authority pinned from before
            // admission and inspect/retire that exact owner instead.
            let connection_reusable = cleanup_proven && pinned_authority.db().connection_reusable();
            if !connection_reusable {
                // A returned body is not a cleanup proof. Quarantine/retire
                // the exact authority before handing the lifecycle owner to
                // a descriptor; otherwise Ready would expose a connection
                // whose rollback/poison state was never verified.
                let retirement = retire_authority_for_recovery_with_status(
                    state,
                    Some(Arc::clone(&pinned_authority)),
                );
                if retirement.baton_retained {
                    if retirement.connection_retired {
                        permit.mark_connection_retired().map_err(|error| {
                            AppError::Anyhow(anyhow::anyhow!(error.to_string()))
                        })?;
                    }
                    match permit.transfer_to_recovery() {
                        Ok(descriptor_id) => {
                            let recovery_binding = narrative_maintenance_binding_for_authority(
                                state,
                                &pinned_authority,
                            );
                            record_maintenance_recovery_binding(
                                state,
                                descriptor_id,
                                None,
                                Some(&recovery_binding),
                            );
                            if let Ok(view) =
                                state.workspace_lifecycle.snapshot_for_workspace(&state.ws)
                            {
                                emit_workspace_lifecycle_view(state, &view);
                            }
                            Err(AppError::Anyhow(anyhow::anyhow!(
                                "NEX_FOREGROUND_CONNECTION_QUARANTINED: foreground lifecycle moved to recovery"
                            )))
                        }
                        Err(error) => Err(AppError::Anyhow(anyhow::anyhow!(
                            "NEX_FOREGROUND_RECOVERY_HANDOFF_FAILED: {error}"
                        ))),
                    }
                } else if retirement.connection_retired {
                    // The close itself succeeded but the process-local
                    // lease baton could not be retained. Keep the execution
                    // owner visible rather than handing a descriptor to a
                    // resolver that cannot prove the old lease boundary.
                    Err(AppError::Anyhow(anyhow::anyhow!(
                        "NEX_FOREGROUND_RECOVERY_BATON_UNAVAILABLE: retired authority lease could not be retained"
                    )))
                } else {
                    // No retirement proof and no baton means the authority
                    // remains an unresolved live owner. Do not release or
                    // transfer it as if a replacement could safely proceed.
                    Err(AppError::Anyhow(anyhow::anyhow!(
                        "NEX_FOREGROUND_CONNECTION_CLEANUP_UNPROVEN: authority could not be retired"
                    )))
                }
            } else {
                permit.release().map(|_| ()).map_err(|error| {
                    AppError::Anyhow(anyhow::anyhow!(
                        "NEX_FOREGROUND_LIFECYCLE_RELEASE_FAILED: {error}"
                    ))
                })
            }
        }
        Err(error) => Err(AppError::Anyhow(anyhow::anyhow!(
            "NEX_FOREGROUND_LIFECYCLE_JOIN_FAILED: {error}"
        ))),
    };
    match (operation, finalization) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(operation_error), Ok(())) => Err(operation_error),
        (Ok(_), Err(finalization_error)) => Err(finalization_error),
        (Err(operation_error), Err(finalization_error)) => Err(AppError::Anyhow(anyhow::anyhow!(
            "{operation_error}; foreground lifecycle finalizer failed: {finalization_error}"
        ))),
    }
}

async fn foreground_commit_cmd<T, F>(
    state: Arc<AppState>,
    label: &'static str,
    payload: serde_json::Value,
    f: F,
) -> Result<String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
    F: FnOnce(
            &grimodex_db::Database,
            T,
            &mut dyn GraphWorkControl,
        ) -> anyhow::Result<serde_json::Value>
        + Send
        + 'static,
{
    run_blocking(move || {
        let _workspace_operation = state
            .begin_workspace_operation()
            .map_err(AppError::Anyhow)?;
        // Keep the complete snapshot, not only its Arc, until the foreground
        // finalizer returns.  The snapshot owns the lifecycle participant;
        // moving out `.authority` alone would let Open/Restore drain and
        // replace this DB before the permit is admitted.
        let pinned_workspace = active_workspace_snapshot(&state.ws)?;
        let pinned_authority = Arc::clone(&pinned_workspace.authority);
        let lifecycle_permit = begin_foreground_lifecycle_permit(&state)?;
        let mut cleanup_proven = true;
        let operation = match catch_unwind(AssertUnwindSafe(
            || -> std::result::Result<String, AppError> {
                let authority_context = if payload.get("authorityRoute").is_some() {
                    let context: grimodex_db::agent_writes::RendererCanonicalWriteContext =
                        from_wire(label, payload.clone())?;
                    agent_writes::validate_renderer_authority_context(&context)?;
                    Some(
                        serde_json::to_value(context)
                            .map_err(|error| AppError::Anyhow(error.into()))?,
                    )
                } else {
                    None
                };
                let dto: T = from_wire(label, payload)?;
                let mut validation_control =
                    ForegroundValidationControl::new(Arc::clone(&state), &lifecycle_permit);
                validation_control.check(GraphWorkStage::Source)?;
                with_db_state(&state.ws, |db| {
                    let result = match authority_context {
                        Some(context) => {
                            grimodex_db::change_events::with_renderer_authority_context(
                                context,
                                || f(db, dto, &mut validation_control),
                            )?
                        }
                        None => f(db, dto, &mut validation_control)?,
                    };
                    Ok(serde_json::to_string(&result)?)
                })
            },
        )) {
            Ok(operation) => {
                if operation.as_ref().err().is_some_and(|error| {
                    error
                        .to_string()
                        .contains("NEX_DB_TRANSACTION_CLEANUP_UNPROVEN")
                }) {
                    cleanup_proven = false;
                }
                operation
            }
            Err(_) => {
                cleanup_proven = false;
                Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_FOREGROUND_TRANSACTION_PANIC: foreground transaction panicked"
                )))
            }
        };
        let result = finish_foreground_lifecycle_permit(
            &state,
            lifecycle_permit,
            operation,
            cleanup_proven,
            pinned_authority,
        );
        drop(pinned_workspace);
        result
    })
    .await
}

/// Chronicle/Codex extraction mutations are part of a long-running renderer
/// operation.  Bind each write to the exact Native WorkspaceAuthority captured
/// before that operation started; resolving `with_db_state` at write time
/// would otherwise let a late continuation land in a same-project clone.
async fn narrative_extraction_bound_write_cmd<T, F>(
    state: Arc<AppState>,
    label: &'static str,
    payload: serde_json::Value,
    workspace_binding: serde_json::Value,
    f: F,
) -> Result<String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
    F: FnOnce(&grimodex_db::Database, T) -> anyhow::Result<serde_json::Value> + Send + 'static,
{
    run_blocking(move || {
        let _workspace_operation = state
            .begin_workspace_operation()
            .map_err(AppError::Anyhow)?;
        let requested_binding: NarrativeExtractionWorkspaceBinding =
            from_wire("workspaceBinding", workspace_binding)?;
        requested_binding.validate().map_err(AppError::Anyhow)?;
        let dto: T = from_wire(label, payload)?;
        let workspace = active_workspace_snapshot(&state.ws)?;
        let current_binding =
            narrative_extraction_binding_for_authority(&state, &workspace.authority);
        if current_binding != requested_binding {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED: extraction mutation was bound to authority {} generation {} instance {}, active authority is {} generation {} instance {}",
                requested_binding.authority_id,
                requested_binding.generation,
                requested_binding.authority_instance_id,
                current_binding.authority_id,
                current_binding.generation,
                current_binding.authority_instance_id,
            )));
        }
        // Keep this pinned authority (and its shared file lease) for the full
        // transaction. A concurrent replacement may publish a new active DB,
        // but this write can only complete against the DB that passed the CAS.
        serde_json::to_string(&f(workspace.authority.db(), dto)?)
            .map_err(|error| AppError::Anyhow(error.into()))
    })
    .await
}

/// Bound foreground mutation variant.  Proposal writes must use the exact
/// captured workspace authority while also borrowing the lifecycle-owned
/// validation stop scope for every eligibility read in their transaction.
async fn narrative_extraction_bound_foreground_write_cmd<T, F>(
    state: Arc<AppState>,
    label: &'static str,
    payload: serde_json::Value,
    workspace_binding: serde_json::Value,
    f: F,
) -> Result<String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
    F: FnOnce(
            &grimodex_db::Database,
            T,
            &mut dyn GraphWorkControl,
        ) -> anyhow::Result<serde_json::Value>
        + Send
        + 'static,
{
    run_blocking(move || {
        let _workspace_operation = state
            .begin_workspace_operation()
            .map_err(AppError::Anyhow)?;
        // Retain the snapshot's participant through the complete transaction
        // and lifecycle finalizer.  Extracting only the authority would leave
        // a replacement window before foreground admission.
        let pinned_workspace = active_workspace_snapshot(&state.ws)?;
        let pinned_authority = Arc::clone(&pinned_workspace.authority);
        let lifecycle_permit = begin_foreground_lifecycle_permit(&state)?;
        let mut cleanup_proven = true;
        let operation = match catch_unwind(AssertUnwindSafe(|| -> std::result::Result<String, AppError> {
            let requested_binding: NarrativeExtractionWorkspaceBinding =
                from_wire("workspaceBinding", workspace_binding)?;
            requested_binding.validate().map_err(AppError::Anyhow)?;
            let dto: T = from_wire(label, payload)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            let current_binding =
                narrative_extraction_binding_for_authority(&state, &workspace.authority);
            if current_binding != requested_binding {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED: extraction mutation was bound to authority {} generation {} instance {}, active authority is {} generation {} instance {}",
                    requested_binding.authority_id,
                    requested_binding.generation,
                    requested_binding.authority_instance_id,
                    current_binding.authority_id,
                    current_binding.generation,
                    current_binding.authority_instance_id,
                )));
            }
            let mut validation_control =
                ForegroundValidationControl::new(Arc::clone(&state), &lifecycle_permit);
            validation_control.check(GraphWorkStage::Source)?;
            let result = f(
                workspace.authority.db(),
                dto,
                &mut validation_control,
            )?;
            serde_json::to_string(&result).map_err(|error| AppError::Anyhow(error.into()))
        })) {
            Ok(operation) => {
                if operation
                    .as_ref()
                    .err()
                    .is_some_and(|error| error.to_string().contains("NEX_DB_TRANSACTION_CLEANUP_UNPROVEN"))
                {
                    cleanup_proven = false;
                }
                operation
            }
            Err(_) => {
                cleanup_proven = false;
                Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_FOREGROUND_TRANSACTION_PANIC: foreground transaction panicked"
                )))
            }
        };
        let result = finish_foreground_lifecycle_permit(
            &state,
            lifecycle_permit,
            operation,
            cleanup_proven,
            pinned_authority,
        );
        drop(pinned_workspace);
        result
    })
    .await
}

/// Strict renderer mutation variant. The same flat JSON object is decoded as
/// both the long-lived domain DTO and its Gate C1 canonical identity context.
/// Standalone MCP callers continue to use the shared domain functions directly.
async fn canonical_agent_write_cmd<T, F>(
    state: Arc<AppState>,
    label: &'static str,
    payload: serde_json::Value,
    f: F,
) -> Result<String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
    F: FnOnce(
            &grimodex_db::Database,
            T,
            grimodex_db::agent_writes::RendererCanonicalWriteContext,
        ) -> anyhow::Result<serde_json::Value>
        + Send
        + 'static,
{
    run_blocking(move || {
        let _workspace_operation = state
            .begin_workspace_operation()
            .map_err(AppError::Anyhow)?;
        let dto: T = from_wire(label, payload.clone())?;
        let context = from_wire(label, payload)?;
        agent_writes::validate_renderer_authority_context(&context)?;
        let context_json =
            serde_json::to_value(&context).map_err(|error| AppError::Anyhow(error.into()))?;
        with_db_state(&state.ws, |db| {
            grimodex_db::change_events::with_renderer_authority_context(context_json, || {
                Ok(serde_json::to_string(&f(db, dto, context)?)?)
            })
        })
    })
    .await
}

/// チャット送信の 1 メッセージ (Tauri の `commands::ai::ChatMessagePayload` 相当)。
#[derive(serde::Deserialize)]
struct ChatMsgDto {
    role: String,
    content: String,
}

/// C2B Human writer wire envelope. The project id is a Native authority
/// argument to the shared writer; the nested request deliberately contains no
/// actor, derivation, Scope, D1, or Freshness fields.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateHumanDerivedRevisionWirePayload {
    project_id: String,
    request: grimodex_db::narrative_extraction::CreateHumanDerivedRevisionRequest,
}

/// Renderer が request.prepared を durable append した実行との相関だけを渡す。
/// request content / transport header / credential はこの DTO に存在しない。
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeAiAuditContext {
    expected_workspace_path: String,
    project_id: Option<String>,
    operation_id: String,
    execution_id: String,
    parent_execution_id: Option<String>,
    path_id: String,
}

impl NativeAiAuditContext {
    fn validate(&self) -> anyhow::Result<()> {
        for (name, value) in [
            (
                "expectedWorkspacePath",
                self.expected_workspace_path.as_str(),
            ),
            ("operationId", self.operation_id.as_str()),
            ("executionId", self.execution_id.as_str()),
            ("pathId", self.path_id.as_str()),
        ] {
            anyhow::ensure!(!value.trim().is_empty(), "auditContext.{name} is required");
            anyhow::ensure!(
                value == value.trim(),
                "auditContext.{name} must not contain surrounding whitespace"
            );
        }
        if let Some(project_id) = self.project_id.as_deref() {
            anyhow::ensure!(
                !project_id.trim().is_empty(),
                "auditContext.projectId must be non-empty or null"
            );
            anyhow::ensure!(
                project_id == project_id.trim(),
                "auditContext.projectId must not contain surrounding whitespace"
            );
        }
        if let Some(parent_execution_id) = self.parent_execution_id.as_deref() {
            anyhow::ensure!(
                !parent_execution_id.trim().is_empty(),
                "auditContext.parentExecutionId must be non-empty or null"
            );
            anyhow::ensure!(
                parent_execution_id == parent_execution_id.trim(),
                "auditContext.parentExecutionId must not contain surrounding whitespace"
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeAiHttpAuditRoute {
    provider: String,
    model: String,
    api_variant: Option<String>,
    endpoint_id: Option<String>,
}

impl NativeAiHttpAuditRoute {
    /// Route fields are copied from the exact ChatParams/settings snapshot later used
    /// to build the provider request. No renderer route claim is trusted here.
    fn from_params(
        settings: &grimodex_ai::AiSettings,
        params: &grimodex_ai::ChatParams<'_>,
    ) -> Self {
        let endpoint_id = matches!(params.provider, grimodex_ai::AiProvider::OpenaiCompatible)
            .then(|| settings.active_openai_compatible_endpoint_id.clone())
            .flatten();
        Self {
            provider: params.provider.to_string(),
            model: params.model.to_string(),
            api_variant: params.api_variant.clone(),
            endpoint_id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeAiFusionAuditConfiguration {
    enabled: bool,
    custom_configuration_applied: bool,
    configuration_complete: bool,
    analysis_models: Vec<String>,
    judge_model: Option<String>,
    provider_selected_fusion_panel_observed: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct NativeAiEffectiveRequestConfiguration {
    ai_novelist_mode: &'static str,
    request_max_output_tokens: u32,
    resolved_tool_protocol: &'static str,
    retry_429: bool,
    extra_body: Option<serde_json::Value>,
    openrouter_provider_pin: Option<String>,
    fusion: Option<NativeAiFusionAuditConfiguration>,
}

fn ai_novelist_extra_body_for_audit(
    params: &grimodex_ai::ChatParams<'_>,
) -> Option<serde_json::Value> {
    if !matches!(params.provider, grimodex_ai::AiProvider::AiNovelist) {
        return None;
    }
    let source = params.extra_body.as_ref()?.as_object()?;
    let mut projected = serde_json::Map::new();
    for key in grimodex_ai::ai_novelist::EXTRA_SAMPLING_KEYS
        .iter()
        .copied()
        .chain(["multilingualmode", "multilingual_mode"])
    {
        if let Some(value) = source.get(key) {
            projected.insert(key.to_string(), value.clone());
        }
    }
    (!projected.is_empty()).then_some(serde_json::Value::Object(projected))
}

impl NativeAiEffectiveRequestConfiguration {
    fn from_params(params: &grimodex_ai::ChatParams<'_>) -> Self {
        let ai_novelist_mode = match params.ai_novelist_mode {
            grimodex_ai::AiNovelistMode::Chat => "chat",
            grimodex_ai::AiNovelistMode::Completion => "completion",
        };
        let request_max_output_tokens = grimodex_ai::effective_request_max_output_tokens(params);
        let resolved_tool_protocol = match params.resolved_tool_protocol {
            grimodex_ai::ResolvedToolProtocol::Native => "native",
            grimodex_ai::ResolvedToolProtocol::Hermes => "hermes",
        };
        let openrouter_provider_pin =
            matches!(params.provider, grimodex_ai::AiProvider::OpenRouter)
                .then(|| params.openrouter_provider_pin.map(str::trim))
                .flatten()
                .filter(|pin| !pin.is_empty())
                .map(str::to_string);
        let fusion = if matches!(params.provider, grimodex_ai::AiProvider::OpenRouter)
            && params.model == "openrouter/fusion"
        {
            let enabled = params.fusion.is_some_and(|fusion| fusion.enabled);
            let analysis_models = if enabled {
                params
                    .fusion
                    .into_iter()
                    .flat_map(|fusion| fusion.analysis_models.iter())
                    .map(|model| model.trim().to_string())
                    .filter(|model| !model.is_empty())
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let judge_model = if enabled {
                params
                    .fusion
                    .and_then(|fusion| fusion.judge_model.as_deref())
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                    .map(str::to_string)
            } else {
                None
            };
            let custom_configuration_applied =
                enabled && (!analysis_models.is_empty() || judge_model.is_some());
            let configuration_complete = custom_configuration_applied
                && !analysis_models.is_empty()
                && judge_model.is_some();
            Some(NativeAiFusionAuditConfiguration {
                enabled,
                custom_configuration_applied,
                configuration_complete,
                analysis_models,
                judge_model,
                // The app records its own explicit config. It never claims to observe a
                // provider-selected default panel.
                provider_selected_fusion_panel_observed: false,
            })
        } else {
            None
        };
        Self {
            ai_novelist_mode,
            request_max_output_tokens,
            resolved_tool_protocol,
            retry_429: params.retry_429,
            extra_body: ai_novelist_extra_body_for_audit(params),
            openrouter_provider_pin,
            fusion,
        }
    }
}

trait NativeAiAuditAppender: Send + Sync + 'static {
    fn append(&self, project_id: Option<&str>, events: &[AppendAiAuditEvent])
        -> anyhow::Result<()>;
}

impl NativeAiAuditAppender for Database {
    fn append(
        &self,
        project_id: Option<&str>,
        events: &[AppendAiAuditEvent],
    ) -> anyhow::Result<()> {
        self.append_ai_audit_events_for_scope(project_id, events)
            .map(|_| ())
    }
}

impl NativeAiAuditAppender for grimodex_db::WorkspaceAuthority {
    fn append(
        &self,
        project_id: Option<&str>,
        events: &[AppendAiAuditEvent],
    ) -> anyhow::Result<()> {
        self.db()
            .append_ai_audit_events_for_scope(project_id, events)
            .map(|_| ())
    }
}

struct NativeAiHttpAuditObserver {
    appender: Arc<dyn NativeAiAuditAppender>,
    context: NativeAiAuditContext,
    route: NativeAiHttpAuditRoute,
    effective_request_configuration: NativeAiEffectiveRequestConfiguration,
}

fn native_ai_audit_timestamp_ms() -> anyhow::Result<i64> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| anyhow::anyhow!("system clock is before Unix epoch: {error}"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| anyhow::anyhow!("AI audit timestamp exceeds i64"))
}

fn native_ai_transport_event_id(
    context: &NativeAiAuditContext,
    attempt_number: u32,
    kind: &str,
) -> String {
    // Length-prefixing makes this deterministic ID injective even if a caller supplies
    // delimiter characters inside executionId. Exact IDs are reused after reply loss.
    format!(
        "native-http:{}:{}:{attempt_number}:{kind}",
        context.execution_id.len(),
        context.execution_id
    )
}

fn native_ai_effective_request_event_id(context: &NativeAiAuditContext) -> String {
    format!(
        "native-effective-request:{}:{}",
        context.execution_id.len(),
        context.execution_id
    )
}

fn native_ai_transport_event(
    context: &NativeAiAuditContext,
    attempt_number: u32,
    kind: &str,
    event_type: &str,
    timestamp: i64,
    payload: serde_json::Value,
) -> AppendAiAuditEvent {
    AppendAiAuditEvent {
        event_id: native_ai_transport_event_id(context, attempt_number, kind),
        execution_id: context.execution_id.clone(),
        operation_id: context.operation_id.clone(),
        parent_execution_id: context.parent_execution_id.clone(),
        path_id: context.path_id.clone(),
        event_type: event_type.to_string(),
        timestamp,
        payload,
    }
}

fn append_native_ai_audit_exact(
    appender: &dyn NativeAiAuditAppender,
    project_id: Option<&str>,
    events: &[AppendAiAuditEvent],
    description: &str,
) -> anyhow::Result<()> {
    match appender.append(project_id, events) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            appender
                .append(project_id, events)
                .map_err(|second_error| {
                    anyhow::anyhow!(
                        "{description} failed after bounded retry; first append: {first_error:#}; second append: {second_error:#}"
                    )
                })
        }
    }
}

fn native_retry_delay_source(
    source: Option<grimodex_ai::HttpRetryDelaySource>,
) -> Option<&'static str> {
    source.map(|source| match source {
        grimodex_ai::HttpRetryDelaySource::RetryAfter => "retry-after",
        grimodex_ai::HttpRetryDelaySource::ExponentialBackoff => "exponential-backoff",
    })
}

impl grimodex_ai::HttpRetryObserver for NativeAiHttpAuditObserver {
    fn request_prepared(&self, request: &grimodex_ai::HttpPreparedRequest) -> anyhow::Result<()> {
        let timestamp = native_ai_audit_timestamp_ms()?;
        let mut limitations = Vec::new();
        if request.body.is_none() {
            limitations.push("native-effective-request-body-unavailable");
        }
        if let Some(fusion) = self.effective_request_configuration.fusion.as_ref() {
            if fusion.analysis_models.is_empty() {
                limitations.push("openrouter-fusion-provider-selected-panel-unobservable");
            }
            if fusion.judge_model.is_none() {
                limitations.push("openrouter-fusion-provider-selected-judge-unobservable");
            }
        }
        let capture_state = if limitations.is_empty() {
            "complete"
        } else {
            "partial"
        };
        let fusion = self
            .effective_request_configuration
            .fusion
            .as_ref()
            .map(|fusion| {
                serde_json::json!({
                    "enabled": fusion.enabled,
                    "customConfigurationApplied": fusion.custom_configuration_applied,
                    "configurationComplete": fusion.configuration_complete,
                    "analysisModels": fusion.analysis_models,
                    "judgeModel": fusion.judge_model,
                    "providerSelectedFusionPanelObserved": fusion.provider_selected_fusion_panel_observed,
                })
            });
        let event = AppendAiAuditEvent {
            event_id: native_ai_effective_request_event_id(&self.context),
            execution_id: self.context.execution_id.clone(),
            operation_id: self.context.operation_id.clone(),
            parent_execution_id: self.context.parent_execution_id.clone(),
            path_id: self.context.path_id.clone(),
            event_type: "request.prepared".to_string(),
            timestamp,
            payload: serde_json::json!({
                "captureState": capture_state,
                "credentialsExcluded": true,
                "effectiveRequestReceipt": true,
                "request": {
                    "body": request.body,
                },
                "route": {
                    "provider": self.route.provider,
                    "model": self.route.model,
                    "apiVariant": self.route.api_variant,
                    "endpointId": self.route.endpoint_id,
                    "source": "native-effective-request",
                },
                "effectiveRequestConfiguration": {
                    "source": "finalized-reqwest-json-value",
                    "serializationFidelity": "json-value",
                    "serializationWhitespaceAndKeyOrderPreserved": false,
                    "credentialsExcluded": true,
                    "aiNovelistMode": self.effective_request_configuration.ai_novelist_mode,
                    "requestMaxOutputTokens": self.effective_request_configuration.request_max_output_tokens,
                    "resolvedToolProtocol": self.effective_request_configuration.resolved_tool_protocol,
                    "retry429": self.effective_request_configuration.retry_429,
                    "extraBody": self.effective_request_configuration.extra_body,
                    "openrouterProviderPin": self.effective_request_configuration.openrouter_provider_pin,
                    "fusion": fusion,
                },
                "workspacePinned": true,
                "limitations": limitations,
            }),
        };
        append_native_ai_audit_exact(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &[event],
            "append native effective request.prepared",
        )
    }

    fn attempt_started(&self, attempt: &grimodex_ai::HttpAttemptStarted) -> anyhow::Result<()> {
        let timestamp = native_ai_audit_timestamp_ms()?;
        let mut limitations = Vec::new();
        let (endpoint_origin, endpoint_host) = match attempt.endpoint.as_ref() {
            Some(endpoint) => (Some(endpoint.origin.as_str()), Some(endpoint.host.as_str())),
            None => {
                limitations.push("native-request-endpoint-unavailable");
                (None, None)
            }
        };
        if let Some(fusion) = self.effective_request_configuration.fusion.as_ref() {
            if fusion.analysis_models.is_empty() {
                limitations.push("openrouter-fusion-provider-selected-panel-unobservable");
            }
            if fusion.judge_model.is_none() {
                limitations.push("openrouter-fusion-provider-selected-judge-unobservable");
            }
        }
        let capture_state = if limitations.is_empty() {
            "complete"
        } else {
            "partial"
        };
        let fusion = self
            .effective_request_configuration
            .fusion
            .as_ref()
            .map(|fusion| {
                serde_json::json!({
                    "enabled": fusion.enabled,
                    "customConfigurationApplied": fusion.custom_configuration_applied,
                    "configurationComplete": fusion.configuration_complete,
                    "analysisModels": fusion.analysis_models,
                    "judgeModel": fusion.judge_model,
                    "providerSelectedFusionPanelObserved": fusion.provider_selected_fusion_panel_observed,
                })
            });
        let event = native_ai_transport_event(
            &self.context,
            attempt.attempt_number,
            "started",
            "transport.attempt.started",
            timestamp,
            serde_json::json!({
                "captureState": capture_state,
                "credentialsExcluded": true,
                "attemptNumber": attempt.attempt_number,
                "sendOrdinal": attempt.send_ordinal,
                "sendPhase": "pre-send",
                "isRetry": attempt.is_retry,
                "reusesInitialPayload": attempt.reuses_initial_payload,
                "requestContentReference": {
                    "executionId": self.context.execution_id,
                    "eventType": "request.prepared",
                    "eventId": native_ai_effective_request_event_id(&self.context),
                },
                "route": {
                    "provider": self.route.provider,
                    "model": self.route.model,
                    "apiVariant": self.route.api_variant,
                    "endpointId": self.route.endpoint_id,
                    "endpointOrigin": endpoint_origin,
                    "endpointHost": endpoint_host,
                    "source": "native-effective-request",
                },
                "effectiveRequestConfiguration": {
                    "source": "native-chat-params",
                    "credentialsExcluded": true,
                    "providerBodyDuplicated": false,
                    "aiNovelistMode": self.effective_request_configuration.ai_novelist_mode,
                    "requestMaxOutputTokens": self.effective_request_configuration.request_max_output_tokens,
                    "resolvedToolProtocol": self.effective_request_configuration.resolved_tool_protocol,
                    "retry429": self.effective_request_configuration.retry_429,
                    "extraBody": self.effective_request_configuration.extra_body,
                    "openrouterProviderPin": self.effective_request_configuration.openrouter_provider_pin,
                    "fusion": fusion,
                },
                "workspacePinned": true,
                "limitations": limitations,
            }),
        );
        append_native_ai_audit_exact(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &[event],
            "append transport.attempt.started",
        )
    }

    fn attempt_finished(&self, attempt: &grimodex_ai::HttpAttemptFinished) -> anyhow::Result<()> {
        let timestamp = native_ai_audit_timestamp_ms()?;
        let delay_source = native_retry_delay_source(attempt.retry_delay_source);
        let finished = native_ai_transport_event(
            &self.context,
            attempt.attempt_number,
            "finished",
            "transport.attempt.finished",
            timestamp,
            serde_json::json!({
                "captureState": "complete",
                "credentialsExcluded": true,
                "attemptNumber": attempt.attempt_number,
                "actualHttpSendCount": attempt.actual_send_count,
                "sendPhase": if attempt.local_abort_observed
                    && attempt.actual_send_count.is_some()
                {
                    "pre-send-cancelled"
                } else {
                    "send-invoked"
                },
                "status": attempt.status,
                "finalStatus": if attempt.is_final { attempt.status } else { None },
                "outcome": if attempt.local_abort_observed {
                    "local-abort"
                } else if attempt.status.is_some() {
                    "http-response"
                } else {
                    "transport-error"
                },
                "retryEnabled": attempt.retry_enabled,
                "retryAfterObservedMs": attempt.retry_after_observed_ms,
                "retryDelayMs": attempt.retry_delay_ms,
                "retryDelaySource": delay_source,
                "willRetry": attempt.will_retry,
                "retryExhausted": attempt.retry_exhausted,
                "retryPayloadCloneUnavailable": attempt.retry_payload_clone_unavailable,
                "localAbortObserved": attempt.local_abort_observed,
                "providerAbortReceiptObserved": attempt.provider_abort_receipt_observed,
                "isFinal": attempt.is_final,
                "responseBodyCaptured": false,
            }),
        );
        let mut events = vec![finished];
        if attempt.will_retry {
            events.push(native_ai_transport_event(
                &self.context,
                attempt.attempt_number,
                "retrying",
                "execution.retrying",
                timestamp,
                serde_json::json!({
                    "captureState": "complete",
                    "credentialsExcluded": true,
                    "reason": "http-429",
                    "completedAttemptNumber": attempt.attempt_number,
                    "nextAttemptNumber": attempt.attempt_number.saturating_add(1),
                    "actualHttpSendCount": attempt.actual_send_count,
                    "sendPhase": "send-invoked",
                    "status": attempt.status,
                    "retryDelayMs": attempt.retry_delay_ms,
                    "retryDelaySource": delay_source,
                }),
            ));
        }
        append_native_ai_audit_exact(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &events,
            "append transport.attempt.finished",
        )
    }
}

fn pin_native_ai_audit_workspace(
    state: &AppState,
    context: &NativeAiAuditContext,
) -> std::result::Result<ActiveWorkspaceSnapshot, AppError> {
    context.validate().map_err(AppError::Anyhow)?;
    let workspace = active_workspace_snapshot(&state.ws)?;
    validate_ai_audit_workspace(&workspace, &context.expected_workspace_path)?;
    workspace
        .db()
        .validate_ai_audit_dispatch_precondition(
            context.project_id.as_deref(),
            &context.execution_id,
            &context.operation_id,
            context.parent_execution_id.as_deref(),
            &context.path_id,
        )
        .map_err(AppError::Anyhow)?;
    Ok(workspace)
}

fn attach_native_ai_http_observer(
    params: &mut grimodex_ai::ChatParams<'_>,
    settings: &grimodex_ai::AiSettings,
    workspace: &ActiveWorkspaceSnapshot,
    context: NativeAiAuditContext,
) {
    let route = NativeAiHttpAuditRoute::from_params(settings, params);
    let effective_request_configuration =
        NativeAiEffectiveRequestConfiguration::from_params(params);
    let appender: Arc<dyn NativeAiAuditAppender> = workspace.db().clone();
    params.http_retry_observer = Some(Arc::new(NativeAiHttpAuditObserver {
        appender,
        context,
        route,
        effective_request_configuration,
    }));
}

fn sanitize_native_ai_diagnostic(error: &anyhow::Error) -> String {
    sanitize_diagnostic_credentials(&format!("{error:#}"))
}

fn native_ai_error_to_napi(error: anyhow::Error) -> Error {
    Error::from_reason(sanitize_native_ai_diagnostic(&error))
}

/// `send_chat_message` / `send_chat_message_stream` の FE 引数 (camelCase)。
/// Tauri コマンドの引数群と 1:1。**API キーは含まない** — キーは main プロセスの
/// safeStorage で解決した平文を別引数 `api_key` で注入する (Phase 3 バッチ3a)。
/// Option フィールドは serde が欠落を None として扱う (Tauri の Option 引数と同挙動)。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    stream_id: Option<String>,
    messages: Vec<ChatMsgDto>,
    thinking: Option<grimodex_ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    api_variant: Option<String>,
    system_volatile_tail: Option<String>,
    model: Option<String>,
    provider: Option<grimodex_ai::AiProvider>,
    endpoint_id: Option<String>,
    expected_ollama_endpoint: Option<String>,
    request_max_output_tokens: Option<u32>,
    audit_context: NativeAiAuditContext,
    caller_identity: Option<profile_egress::CallerIdentity>,
}

/// `send_inline_ai_stream` の FE 引数 (camelCase)。チャットと同じ message / reasoning
/// 形だが、prompt cache / web search は受けず、AI のべりすとでは Completion mode を使う。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InlineAiRequest {
    stream_id: String,
    messages: Vec<ChatMsgDto>,
    thinking: Option<grimodex_ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    model: Option<String>,
    api_variant: Option<String>,
    provider: Option<grimodex_ai::AiProvider>,
    endpoint_id: Option<String>,
    audit_context: NativeAiAuditContext,
    caller_identity: Option<profile_egress::CallerIdentity>,
}

/// `send_agent_message` の FE 引数 (camelCase)。AgentMessage / AgentToolDef の
/// serde 定義を直接使い、toolUses / thinkingBlocks / inputSchema のワイヤをTauriと共有する。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    messages: Vec<grimodex_ai::AgentMessage>,
    tools: Vec<grimodex_ai::AgentToolDef>,
    thinking: Option<grimodex_ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    api_variant: Option<String>,
    web_search: Option<grimodex_ai::WebSearchConfig>,
    system_volatile_tail: Option<String>,
    model: Option<String>,
    provider: Option<grimodex_ai::AiProvider>,
    endpoint_id: Option<String>,
    expected_ollama_endpoint: Option<String>,
    request_max_output_tokens: Option<u32>,
    resolved_tool_protocol: Option<grimodex_ai::ResolvedToolProtocol>,
    audit_context: NativeAiAuditContext,
    caller_identity: Option<profile_egress::CallerIdentity>,
}

/// `list_ai_models` の FE 引数。API キーは一覧取得では任意なので main が
/// safeStorage から取得できた値（未設定なら空文字）を別引数で注入する。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListAiModelsRequest {
    provider: grimodex_ai::AiProvider,
    endpoint_id: Option<String>,
    selected_model_id: Option<String>,
    expected_ollama_endpoint: Option<String>,
    caller_identity: Option<profile_egress::CallerIdentity>,
}

/// `test_ai_connection` の FE 引数。接続先 provider/model は必須、variant / endpoint
/// は任意で、既知 endpoint だけを一時的に active へ切り替える。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestAiConnectionRequest {
    provider: grimodex_ai::AiProvider,
    model: String,
    api_variant: Option<String>,
    endpoint_id: Option<String>,
    audit_context: NativeAiAuditContext,
    caller_identity: Option<profile_egress::CallerIdentity>,
}

fn begin_profile_egress_dispatch(
    state: &Arc<AppState>,
    identity: Option<&profile_egress::CallerIdentity>,
) -> Result<profile_egress::ProfileDispatchPermit> {
    state
        .profile_egress
        .begin_dispatch(identity)
        .map_err(|error| Error::from_reason(format!("{error:#}")))
}

/// Pin the active workspace once for a generic DB dispatch and revalidate the
/// Native caller binding against that exact authority. The snapshot is kept
/// until serialization has completed; a workspace bind/invalidation during the
/// operation therefore causes the final revalidation to deny the result
/// instead of returning rows from either workspace.
fn pin_profile_egress_workspace(
    state: &Arc<AppState>,
    dispatch: &profile_egress::ProfileDispatchPermit,
    identity: Option<&profile_egress::CallerIdentity>,
) -> std::result::Result<ActiveWorkspaceSnapshot, AppError> {
    let workspace = active_workspace_snapshot(&state.ws)?;
    let workspace_id = workspace.path().to_string_lossy().into_owned();
    state
        .profile_egress
        .reauthorize_dispatch(dispatch, identity, Some(&workspace_id))
        .map_err(AppError::Anyhow)?;
    Ok(workspace)
}

fn reauthorize_profile_egress_workspace(
    state: &Arc<AppState>,
    dispatch: &profile_egress::ProfileDispatchPermit,
    identity: Option<&profile_egress::CallerIdentity>,
    workspace: &ActiveWorkspaceSnapshot,
) -> anyhow::Result<()> {
    let workspace_id = workspace.path().to_string_lossy().into_owned();
    state
        .profile_egress
        .reauthorize_dispatch(dispatch, identity, Some(&workspace_id))
}

const PROFILE_EGRESS_DB_RESULT_KIND_KEY: &str = "__grimodexDbResultKind";
const PROFILE_EGRESS_DB_READ_KIND: &str = "read";
const PROFILE_EGRESS_DB_MUTATION_KIND: &str = "committed-mutation";

fn serialize_profile_egress_db_result(
    rows: Vec<serde_json::Map<String, serde_json::Value>>,
    statement_may_mutate: bool,
) -> anyhow::Result<String> {
    let mut result = serde_json::Map::new();
    result.insert("rows".to_string(), serde_json::to_value(rows)?);
    result.insert(
        PROFILE_EGRESS_DB_RESULT_KIND_KEY.to_string(),
        serde_json::Value::String(
            if statement_may_mutate {
                PROFILE_EGRESS_DB_MUTATION_KIND
            } else {
                PROFILE_EGRESS_DB_READ_KIND
            }
            .to_string(),
        ),
    );
    serde_json::to_string(&result).map_err(anyhow::Error::from)
}

/// A database operation can commit before the final profile reauthorization
/// observes that D2a has revoked the dispatch.  Successful results retain an
/// internal kind marker so Electron main can distinguish a committed mutation
/// from a read without re-parsing SQL.  Main strips that marker before the
/// renderer boundary and converts a committed mutation to an opaque receipt if
/// its own publication gate has closed.  `statement_may_mutate` is supplied by
/// SQLite's prepared statement metadata in grimodex-db; it is not inferred from
/// SQL text or the Drizzle method name.
fn finish_profile_egress_db_dispatch(
    reauthorization: anyhow::Result<()>,
    rows: Vec<serde_json::Map<String, serde_json::Value>>,
    statement_may_mutate: bool,
) -> anyhow::Result<String> {
    match reauthorization {
        Ok(()) => serialize_profile_egress_db_result(rows, statement_may_mutate),
        Err(_error) if statement_may_mutate => {
            // The caller must not retry as if the write definitely did not
            // happen.  `rows` is deliberately discarded because a mutation
            // result may contain plaintext (for example RETURNING output).
            Ok(r#"{"rows":[],"committed":true}"#.to_string())
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod profile_egress_db_result_tests {
    use super::*;

    #[test]
    fn post_commit_reauthorization_denial_returns_an_opaque_committed_receipt() {
        let path = std::env::temp_dir().join(format!(
            "grimodex-db-reauth-race-{}.json",
            uuid::Uuid::new_v4()
        ));
        let state = profile_egress::ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(true)
            .expect("activate");
        let identity = profile_egress::CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "race-caller".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 7,
            workspace_id: None,
            session_id: "race-session".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        let permit = state.begin_dispatch(Some(&identity)).expect("dispatch");

        // Model the restriction/restore transition after SQLite has committed
        // but before the caller reaches the publication reauthorization.
        state.invalidate_callers();
        let reauthorization = state.reauthorize_dispatch(&permit, Some(&identity), None);
        let mut row = serde_json::Map::new();
        row.insert(
            "secret".to_string(),
            serde_json::Value::String("PRIVATE_SENTINEL".to_string()),
        );
        let wire = finish_profile_egress_db_dispatch(reauthorization, vec![row], true)
            .expect("committed mutation must not be reported as not executed");
        let value: serde_json::Value = serde_json::from_str(&wire).expect("receipt JSON");
        assert_eq!(value, serde_json::json!({ "rows": [], "committed": true }));

        drop(permit);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn successful_results_carry_the_native_statement_kind_for_main() {
        let mut mutation_row = serde_json::Map::new();
        mutation_row.insert(
            "secret".to_string(),
            serde_json::Value::String("PRIVATE_SENTINEL".to_string()),
        );
        let mutation_wire = finish_profile_egress_db_dispatch(Ok(()), vec![mutation_row], true)
            .expect("successful mutation result");
        let mutation_value: serde_json::Value =
            serde_json::from_str(&mutation_wire).expect("mutation result JSON");
        assert_eq!(
            mutation_value,
            serde_json::json!({
                "rows": [{ "secret": "PRIVATE_SENTINEL" }],
                "__grimodexDbResultKind": "committed-mutation"
            })
        );

        let read_wire = finish_profile_egress_db_dispatch(Ok(()), vec![], false)
            .expect("successful read result");
        let read_value: serde_json::Value =
            serde_json::from_str(&read_wire).expect("read result JSON");
        assert_eq!(
            read_value,
            serde_json::json!({ "rows": [], "__grimodexDbResultKind": "read" })
        );
    }

    #[test]
    fn read_result_is_denied_when_post_commit_reauthorization_fails() {
        let error = finish_profile_egress_db_dispatch(
            Err(anyhow::anyhow!("D2A_EGRESS_DENIED: caller revoked")),
            vec![],
            false,
        )
        .expect_err("read rows must not be published after reauthorization failure");
        assert!(error.to_string().contains("caller revoked"));
    }

    #[test]
    fn sqlite_readonly_results_are_not_promoted_to_committed_receipts() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("database");
        db.execute(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
            &[],
            "run",
        )
        .expect("schema");
        db.execute(
            "INSERT INTO app_settings (key, value) VALUES ('sentinel', 'value')",
            &[],
            "run",
        )
        .expect("seed");

        for sql in [
            "SELECT value FROM app_settings WHERE key = 'sentinel'",
            "/* leading comment */ SELECT value FROM app_settings WHERE key = 'sentinel'",
            "-- leading comment\nSELECT value FROM app_settings WHERE key = 'sentinel'",
            "WITH source AS (SELECT value FROM app_settings) SELECT value FROM source",
        ] {
            let execution = db
                .execute_renderer_profile_egress_with_result(sql, &[], "all")
                .expect("read-only SQL should execute");
            assert!(
                !execution.statement_may_mutate,
                "unexpected mutation: {sql}"
            );
            let error = finish_profile_egress_db_dispatch(
                Err(anyhow::anyhow!("D2A_EGRESS_DENIED: caller revoked")),
                execution.rows,
                execution.statement_may_mutate,
            )
            .expect_err("expired reads must remain errors");
            assert!(error.to_string().contains("caller revoked"));
            assert!(!error.to_string().contains("committed"));
        }
    }
}

fn caller_identity_from_args(
    args: &serde_json::Value,
) -> Result<Option<profile_egress::CallerIdentity>> {
    let Some(value) = args.get("callerIdentity") else {
        return Ok(None);
    };
    from_wire("callerIdentity", value.clone()).map_err(app_err_to_napi)
}

fn caller_identity_from_wire(
    serialized: Option<String>,
) -> Result<Option<profile_egress::CallerIdentity>> {
    serialized
        .map(|value| {
            serde_json::from_str(&value).map_err(|error| {
                Error::from_reason(format!(
                    "{} caller identity is malformed: {error}",
                    profile_egress::D2A_EGRESS_DENIED_MARKER
                ))
            })
        })
        .transpose()
}

struct RevalidatedNarrativeWorkspace<'a> {
    _open_guard: std::sync::MutexGuard<'a, ()>,
    authority: PinnedWorkspaceDb,
}

/// Borrowed lifecycle owner for the bounded Freshness cycle.  The owner is
/// deliberately Native-side: shared Freshness only receives checkpoints and
/// cannot infer workspace authority from a renderer-shaped argument.
struct NativeFreshnessLifecycleControl<'a> {
    state: &'a AppState,
}

impl FreshnessLifecycleControl for NativeFreshnessLifecycleControl<'_> {
    fn check(&mut self) -> anyhow::Result<()> {
        let lifecycle = self.state.ws.lifecycle_core().snapshot().map_err(|error| {
            anyhow::anyhow!("NEX_VALIDATION_TERMINATED:lifecycle-snapshot-unavailable:{error}")
        })?;
        let lifecycle_allows_work = match lifecycle.state {
            LifecycleState::Ready(_) => true,
            // Existing file-backed Native tests can install an authority
            // directly. Treat that narrow bootstrap shape as usable, while
            // still rejecting every explicit transition/recovery/closed
            // state from the shared core.
            LifecycleState::NoWorkspace => self
                .state
                .ws
                .inner
                .lock()
                .map(|active| active.is_some())
                .unwrap_or(false),
            LifecycleState::Transition { .. }
            | LifecycleState::RecoveryRequired { .. }
            | LifecycleState::Closed => false,
        };
        if !lifecycle_allows_work
            || self
                .state
                .ws
                .switching
                .load(std::sync::atomic::Ordering::Acquire)
        {
            anyhow::bail!("NEX_VALIDATION_TERMINATED:workspace-transition-in-progress");
        }
        if self.state.ws.safe_mode.is_active() {
            anyhow::bail!("NEX_VALIDATION_TERMINATED:workspace-recovery-required");
        }
        Ok(())
    }
}

fn revalidate_narrative_workspace_after_cycle<'a>(
    state: &'a AppState,
    completed_authority: PinnedWorkspaceDb,
    additional_cycle_pins: Vec<PinnedWorkspaceDb>,
    expected_binding: &MaintenanceWorkspaceBinding,
    before_authority_release: impl FnOnce(),
) -> std::result::Result<Option<RevalidatedNarrativeWorkspace<'a>>, AppError> {
    let completed_authority_identity = completed_authority.identity();
    before_authority_release();
    // open/restore own open_lock while waiting for every pinned authority Arc
    // to drain. Never wait for that lock while retaining a completed cycle's
    // shared workspace lease, or the two quiescence protocols wait on each
    // other. Maintenance passes its second validation snapshot here too.
    drop(additional_cycle_pins);
    drop(completed_authority);

    let open_guard = state
        .ws
        .open_lock
        .lock()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
    let current_authority = match active_database(&state.ws) {
        Ok(current_authority) => current_authority,
        Err(AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive) => {
            return Ok(None)
        }
        Err(error) if error.to_string().contains("NEX_WORKSPACE_BINDING_CHANGED") => {
            // A restore helper may have published the replacement authority
            // before the lifecycle supervisor has emitted its post-Join
            // projection.  Treat that boundary as unavailable until the
            // supervisor can reconcile the exact binding; never surface the
            // stale cycle as a successful freshness result.
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let current_binding = narrative_maintenance_binding_for_authority(state, &current_authority);
    if current_authority.identity() != completed_authority_identity
        || &current_binding != expected_binding
    {
        return Ok(None);
    }
    Ok(Some(RevalidatedNarrativeWorkspace {
        _open_guard: open_guard,
        authority: current_authority,
    }))
}

fn run_narrative_freshness_cycle_body(
    state: &AppState,
    after_cycle: impl FnOnce(),
) -> std::result::Result<Option<String>, AppError> {
    let ci_config = state.narrative_maintenance_ci_seam.config();
    let authority = match active_database(&state.ws) {
        Ok(authority) => authority,
        Err(AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive) => {
            return Ok(None)
        }
        Err(error) => return Err(error),
    };
    let binding = narrative_maintenance_binding_for_authority(state, &authority);
    binding.validate()?;
    if let Some(config) = ci_config.as_ref() {
        state
            .narrative_maintenance_ci_seam
            .validate_freshness_hold_binding(&binding)
            .map_err(AppError::Anyhow)?;
        if let Some(hold_project_id) = config.freshness_hold_project_id.as_deref() {
            let hold_exists = authority.db().with_conn(|conn| {
                let project_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM projects WHERE id = ?1",
                    [hold_project_id],
                    |row| row.get(0),
                )?;
                Ok::<_, anyhow::Error>(project_count == 1)
            })?;
            if !hold_exists {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_CI_FRESHNESS_HOLD_PROJECT_NOT_FOUND: effective hold project '{}' is not in the active workspace",
                    hold_project_id
                )));
            }
        }
    }
    // Liveness is minted only after the bounded cycle has returned
    // successfully. A failed graph evaluation, cursor reservation,
    // or publication therefore cannot attest a live scheduler or
    // activate the canonical authority.
    let mut lifecycle_control = NativeFreshnessLifecycleControl { state };
    let cycle_result = narrative_extraction::
        run_incremental_freshness_cycle_with_liveness_capability_and_hold_and_lifecycle_control(
            authority.db(),
            ci_config
                .as_ref()
                .and_then(|config| config.freshness_hold_project_id.as_deref()),
            &mut lifecycle_control,
        );
    let (cycle_outcome, successful_cycle) = cycle_result?;
    // A workspace swap may complete while the bounded cycle is
    // evaluating its pinned old authority. Re-resolve the active
    // authority before minting liveness so that a late old cycle can
    // never activate the database that is no longer current.
    let Some(current_workspace) = revalidate_narrative_workspace_after_cycle(
        state,
        authority,
        Vec::new(),
        &binding,
        after_cycle,
    )?
    else {
        return Ok(None);
    };
    // The existing main-only scheduler wake is the production owner of
    // automatic C2-ZC activation.  Durable readiness may still be incomplete
    // for a newly opened or recovering workspace, so that one expected state
    // is fail-soft and will be retried by the next wake.  Marker/schema,
    // malformed evidence, or any other unexpected failure remains visible to
    // the scheduler caller instead of silently leaving a split authority.
    let liveness_evidence = narrative_extraction::record_live_scheduler_heartbeat(
        current_workspace.authority.db(),
        &binding.authority_id,
        binding.generation,
        successful_cycle,
    )?;
    let cutover_result = current_workspace.authority.db().with_conn(|conn| {
        narrative_extraction::cut_over_workspace_freshness(conn, &liveness_evidence)
    });
    let mut cutover_not_ready = false;
    if let Err(error) = cutover_result {
        if !is_expected_c2zc_cutover_not_ready(&error) {
            return Err(AppError::Anyhow(error));
        }
        cutover_not_ready = true;
    }

    // The quiescence state is an acceptance-only extension of the existing
    // freshness result. Production launches keep the historical lightweight
    // result and therefore pay no extra workspace-wide read cost.
    let held_project_id = match &cycle_outcome {
        narrative_extraction::IncrementalFreshnessCycleOutcome::Held(summary) => {
            Some(summary.project_id.as_str())
        }
        _ => None,
    };
    let ci_quiescence_state = if ci_config.is_some() {
        Some(
            narrative_ci_quiescence_state(
                current_workspace.authority.db(),
                &binding,
                ci_config
                    .as_ref()
                    .and_then(|config| config.freshness_hold_project_id.as_deref()),
                held_project_id,
            )
            .map_err(AppError::Anyhow)?,
        )
    } else {
        None
    };

    let result = match cycle_outcome {
        narrative_extraction::IncrementalFreshnessCycleOutcome::Held(summary) => {
            require_held_cutover_not_ready(cutover_not_ready)?;
            let result = serde_json::json!({
                "hasMore": false,
                "noWrite": true,
                "held": true,
                "heldProjectId": summary.project_id,
                "cutoverNotReady": true,
                "quiescenceState": ci_quiescence_state,
            });
            Ok(Some(result.to_string()))
        }
        narrative_extraction::IncrementalFreshnessCycleOutcome::Idle => {
            if let Some(state) = ci_quiescence_state {
                let mut result = serde_json::json!({
                    "hasMore": false,
                    "noWrite": true,
                    "quiescenceState": state,
                });
                if cutover_not_ready {
                    result["cutoverNotReady"] = serde_json::json!(true);
                }
                Ok(Some(result.to_string()))
            } else if cutover_not_ready {
                Ok(Some(
                    serde_json::json!({
                        "hasMore": false,
                        "cutoverNotReady": true,
                    })
                    .to_string(),
                ))
            } else {
                Ok(None)
            }
        }
        narrative_extraction::IncrementalFreshnessCycleOutcome::Processed(summary) => {
            // D2 shadow diagnostics stay out of the durable Freshness
            // authority, but they must not be silently discarded at
            // the production boundary either: main is the only
            // observable telemetry sink for corrupt-head, selector,
            // and effect diagnostics.
            let v2_shadow =
                serde_json::to_value(&summary.v2_shadow).map_err(anyhow::Error::from)?;
            let mut result = serde_json::json!({
                "projectId": summary.project_id,
                "fromSequenceExclusive": summary.from_sequence_exclusive,
                "throughSequenceInclusive": summary.through_sequence_inclusive,
                "affectedEdgeCount": summary.affected_edge_count,
                "affectedConsumerCount": summary.affected_consumer_count,
                "hasMore": summary.has_more,
                "v2Shadow": v2_shadow,
            });
            if let Some(state) = ci_quiescence_state {
                // A processed batch necessarily crossed a durable cursor/run
                // boundary. The following idle/no-write cycle is the only
                // state eligible to publish a quiescence receipt.
                result["noWrite"] = serde_json::json!(false);
                result["quiescenceState"] = state;
            }
            if cutover_not_ready {
                result["cutoverNotReady"] = serde_json::json!(true);
            }
            Ok(Some(result.to_string()))
        }
    };
    // The permit remains live across revalidation, heartbeat, cutover, and
    // quiescence publication.  Only after every DB write and the final
    // serialized result has completed may the supervisor observe Join and
    // release the logical membership.
    result
}

#[cfg(test)]
fn run_narrative_freshness_cycle_inner(
    state: &AppState,
    after_cycle: impl FnOnce(),
) -> std::result::Result<Option<String>, AppError> {
    // Freshness is also a recovery pump.  A descriptor created by an earlier
    // Freshness failure must be reconciled even when ordinary maintenance has
    // no pending delivery to trigger its preflight.
    let _ = reconcile_maintenance_recovery_descriptor(state)?;
    let mut lifecycle_permit = match state.workspace_lifecycle.begin_maintenance()? {
        PermitAdmission::Admitted(mut permit) => {
            if let Err(error) = permit.start() {
                let cleanup = permit.cancel_before_start().map_err(|cleanup| {
                    AppError::Anyhow(anyhow::anyhow!(
                        "NEX_MAINTENANCE_PENDING_START_CLEANUP_FAILED: {cleanup}"
                    ))
                })?;
                let _ = cleanup;
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_PENDING_START_REJECTED: {error}"
                )));
            }
            permit
        }
        PermitAdmission::NotAdmitted { .. } => return Ok(None),
    };
    let result = run_narrative_freshness_cycle_body(state, after_cycle);
    lifecycle_permit
        .mark_joined()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
    match result {
        Ok(result) => lifecycle_permit
            .release()
            .map(|_| result)
            .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}"))),
        Err(error) => {
            let recovery_binding = active_database(&state.ws)
                .ok()
                .map(|authority| narrative_maintenance_binding_for_authority(state, &authority));
            if retire_authority_for_recovery(state, active_database(&state.ws).ok()) {
                lifecycle_permit
                    .mark_connection_retired()
                    .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
            }
            let descriptor_id = lifecycle_permit
                .transfer_to_recovery()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
            record_maintenance_recovery_binding(
                state,
                descriptor_id,
                None,
                recovery_binding.as_ref(),
            );
            tracing::error!(
                target: "narrative.maintenance",
                %error,
                descriptor_id = descriptor_id.get(),
                "freshness cycle failed after Join; responsibility transferred to recovery"
            );
            Ok(Some(
                serde_json::json!({
                    "status": "workspace-unavailable",
                    "reason": "freshness-recovery-required",
                    "descriptorId": descriptor_id,
                })
                .to_string(),
            ))
        }
    }
}

#[napi]
pub struct Backend {
    state: Arc<AppState>,
}

/// Drop guard for a process-local maintenance attempt. Any early return,
/// workspace mismatch, adapter error, or panic path settles as interrupted.
/// The recovery gate is released only after the pinned connection proves
/// reusable; otherwise the attempt remains a fail-closed quarantine marker.
/// The only success path must explicitly pass through `finalize_success`,
/// which linearizes cancellation against the final result.
struct NarrativeMaintenanceAttemptGuard {
    state: Arc<AppState>,
    attempt_id: String,
    authority: Option<PinnedWorkspaceDb>,
    finalized: bool,
    cleanup_reusable: bool,
}

/// Result returned by the blocking maintenance worker. The permit is moved
/// back to the async supervisor instead of being finalized by the worker
/// itself, so Join (including JoinError/panic) is an observable boundary.
struct NarrativeMaintenanceWorkerOutcome {
    result: std::result::Result<String, AppError>,
    lifecycle_permit: Option<MaintenancePermit>,
    lifecycle_work_started: bool,
    authority: Option<PinnedWorkspaceDb>,
    attempt_id: Option<String>,
    workspace_binding: Option<MaintenanceWorkspaceBinding>,
    admitted_delivery_sequence: Option<DeliverySequence>,
}

/// Keeps an admitted permit recoverable if the blocking task is cancelled or
/// terminates with a JoinError outside the inner catch_unwind boundary. On a
/// normal return the worker moves the permit into its outcome, so Drop has no
/// work to do.
struct MaintenancePermitLease {
    permit: Option<MaintenancePermit>,
    return_slot: Arc<Mutex<Option<MaintenancePermit>>>,
}

impl MaintenancePermitLease {
    fn new(return_slot: Arc<Mutex<Option<MaintenancePermit>>>) -> Self {
        let permit = match return_slot.lock() {
            Ok(mut slot) => slot.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        Self {
            permit,
            return_slot,
        }
    }
}

impl Deref for MaintenancePermitLease {
    type Target = Option<MaintenancePermit>;

    fn deref(&self) -> &Self::Target {
        &self.permit
    }
}

impl DerefMut for MaintenancePermitLease {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.permit
    }
}

impl Drop for MaintenancePermitLease {
    fn drop(&mut self) {
        let Some(permit) = self.permit.take() else {
            return;
        };
        if let Ok(mut slot) = self.return_slot.lock() {
            *slot = Some(permit);
        }
    }
}

impl NarrativeMaintenanceAttemptGuard {
    fn new(state: Arc<AppState>, attempt_id: String) -> Self {
        Self {
            state,
            attempt_id,
            authority: None,
            finalized: false,
            cleanup_reusable: false,
        }
    }

    fn bind_authority(&mut self, authority: PinnedWorkspaceDb) {
        self.authority = Some(authority);
    }

    fn finalize_success(&mut self) -> anyhow::Result<bool> {
        let granted = self
            .state
            .narrative_maintenance_attempts
            .grant_finalize(&self.attempt_id)?;
        // The automatic Native routes currently publish dependency freshness
        // and do not own the NIR-1 Graph publisher. Keep this receipt unset
        // rather than inferring a generation with a post-release read.
        let receipt =
            self.state
                .narrative_maintenance_attempts
                .settle(&self.attempt_id, granted, None)?;
        self.cleanup_reusable = self.cleanup_reusable
            && receipt.cleanup.status == "clean"
            && receipt.connection_reusable
            && self
                .authority
                .as_ref()
                .is_some_and(|authority| authority.db().connection_reusable());
        self.finalized = true;
        Ok(receipt.state == "succeeded" && self.cleanup_reusable)
    }

    fn finalize_interrupted(&mut self) -> anyhow::Result<()> {
        let receipt =
            self.state
                .narrative_maintenance_attempts
                .settle(&self.attempt_id, false, None)?;
        self.cleanup_reusable = self.cleanup_reusable
            && receipt.cleanup.status == "clean"
            && receipt.connection_reusable
            && self
                .authority
                .as_ref()
                .is_some_and(|authority| authority.db().connection_reusable());
        self.finalized = true;
        Ok(())
    }

    fn close_work_registration(&self) -> anyhow::Result<()> {
        self.state
            .narrative_maintenance_attempts
            .close_work_registration(&self.attempt_id)?;
        Ok(())
    }

    fn mark_cleanup_clean(&mut self, state: &AppState) -> anyhow::Result<()> {
        let Some(authority) = self.authority.as_ref() else {
            self.cleanup_reusable = false;
            state.narrative_maintenance_attempts.set_cleanup_outcome(
                &self.attempt_id,
                NarrativeMaintenanceCleanupOutcome {
                    status: "failed".to_string(),
                    error: Some(
                        "NEX_MAINTENANCE_CONNECTION_UNUSABLE: maintenance authority was not bound"
                            .to_string(),
                    ),
                },
                false,
            )?;
            anyhow::bail!(
                "NEX_MAINTENANCE_CONNECTION_UNUSABLE: maintenance authority was not bound"
            );
        };
        if !authority.db().connection_reusable() {
            let reason = authority
                .db()
                .connection_unusable_reason()
                .unwrap_or_else(|| "maintenance connection is quarantined".to_string());
            let error = format!("NEX_MAINTENANCE_CONNECTION_UNUSABLE: {reason}");
            self.cleanup_reusable = false;
            state.narrative_maintenance_attempts.set_cleanup_outcome(
                &self.attempt_id,
                NarrativeMaintenanceCleanupOutcome {
                    status: "failed".to_string(),
                    error: Some(error.clone()),
                },
                false,
            )?;
            anyhow::bail!(error);
        }
        state.narrative_maintenance_attempts.set_cleanup_outcome(
            &self.attempt_id,
            NarrativeMaintenanceCleanupOutcome {
                status: "clean".to_string(),
                error: None,
            },
            true,
        )?;
        self.cleanup_reusable = true;
        Ok(())
    }
}

impl Drop for NarrativeMaintenanceAttemptGuard {
    fn drop(&mut self) {
        if !self.finalized {
            // The phase-owned maintenance scope has already restored
            // autocommit, progress state, and busy timeout before it returns.
            // Consult only its process-local health result here: reacquiring
            // the SQLite mutex would wait behind a foreground owner that may
            // have arrived after cleanup and would make Drop block.
            if let Some(authority) = self.authority.as_ref() {
                if authority.db().connection_reusable() {
                    if self
                        .state
                        .narrative_maintenance_attempts
                        .set_cleanup_outcome(
                            &self.attempt_id,
                            NarrativeMaintenanceCleanupOutcome {
                                status: "clean".to_string(),
                                error: None,
                            },
                            true,
                        )
                        .is_ok()
                    {
                        self.cleanup_reusable = true;
                    }
                } else {
                    let reason = authority
                        .db()
                        .connection_unusable_reason()
                        .unwrap_or_else(|| "maintenance connection is quarantined".to_string());
                    let _ = self
                        .state
                        .narrative_maintenance_attempts
                        .set_cleanup_outcome(
                            &self.attempt_id,
                            NarrativeMaintenanceCleanupOutcome {
                                status: "failed".to_string(),
                                error: Some(format!(
                                    "NEX_MAINTENANCE_CONNECTION_UNUSABLE: {reason}"
                                )),
                            },
                            false,
                        );
                }
            }
            self.cleanup_reusable = match self.state.narrative_maintenance_attempts.settle(
                &self.attempt_id,
                false,
                None,
            ) {
                Ok(receipt) => {
                    self.cleanup_reusable
                        && receipt.cleanup.status == "clean"
                        && receipt.connection_reusable
                }
                Err(_) => false,
            };
        }
        if self.cleanup_reusable {
            self.state
                .narrative_maintenance_recovery_gate
                .release_attempt(&self.attempt_id);
        }
    }
}

fn deferred_narrative_maintenance_result(
    state: &AppState,
    attempt_guard: Option<&mut NarrativeMaintenanceAttemptGuard>,
) -> std::result::Result<String, AppError> {
    if let Some(guard) = attempt_guard {
        guard.mark_cleanup_clean(state).map_err(AppError::Anyhow)?;
        guard.finalize_interrupted().map_err(AppError::Anyhow)?;
        return Ok(serde_json::json!({
            "status": "accepted",
            "hasMore": true,
            "preempted": true,
        })
        .to_string());
    }
    Err(AppError::Anyhow(anyhow::anyhow!(
        "NEX_MAINTENANCE_CONNECTION_PREEMPTED: cleanup remains owned by the foreground connection"
    )))
}

async fn settle_profile_egress_startup(state: &Arc<AppState>) -> Result<String> {
    let initial = state.profile_egress.status();
    if !initial.restricted {
        let mut json =
            serde_json::to_value(initial).map_err(|error| Error::from_reason(error.to_string()))?;
        if let Some(object) = json.as_object_mut() {
            object.insert("chatStreamsStopped".to_string(), serde_json::json!(0));
            object.insert("inlineStreamsStopped".to_string(), serde_json::json!(0));
            object.insert("postEffectRunsStopped".to_string(), serde_json::json!(0));
        }
        return serde_json::to_string(&json).map_err(|error| Error::from_reason(error.to_string()));
    }

    // Close the gate before awaiting cancellation. The state mutex makes
    // this transition and every subsequent dispatch admission mutually
    // exclusive; an already restricted profile keeps its durable epoch.
    state
        .profile_egress
        .begin_startup_barrier()
        .map_err(|error| Error::from_reason(format!("{error:#}")))?;
    let post_effect_stopped = state.post_effect_abort.abort_all();
    let chat_stopped = state.chat_streams.abort_all().await;
    let inline_stopped = state.inline_ai_streams.abort_all().await;
    state.profile_egress.wait_for_dispatches().await;
    state.post_effect_abort.clear_abort_all();
    let status = state
        .profile_egress
        .confirm_in_flight_stopped()
        .map_err(|error| Error::from_reason(format!("{error:#}")))?;
    debug_assert!(status.in_flight_stopped);
    let mut json =
        serde_json::to_value(status).map_err(|error| Error::from_reason(error.to_string()))?;
    if let Some(object) = json.as_object_mut() {
        object.insert(
            "chatStreamsStopped".to_string(),
            serde_json::json!(chat_stopped),
        );
        object.insert(
            "inlineStreamsStopped".to_string(),
            serde_json::json!(inline_stopped),
        );
        object.insert(
            "postEffectRunsStopped".to_string(),
            serde_json::json!(post_effect_stopped),
        );
    }
    serde_json::to_string(&json).map_err(|error| Error::from_reason(error.to_string()))
}

#[napi]
impl Backend {
    /// `app_data_dir` は Electron main の `app.getPath("userData")` を明示注入
    /// (§4.2 / §6.8 — Phase 2 は `GrimodexElectronDev` 名で動かし、Tauri の
    /// com.miyakey.grimodex には触らない)。
    #[napi(constructor)]
    pub fn new(
        app_data_dir: String,
        semantic_resource_root: Option<String>,
        reranker_resource_root: Option<String>,
    ) -> Result<Backend> {
        // 旧 .node E2E / 外部callerとのconstructor互換を維持する。省略時はcwdや
        // build-time manifestへfallbackせず、必ず存在しないappData配下sentinelを使い、
        // Backend全体ではなくsemantic invokeだけをmodel missingで失敗させる。
        let semantic_resource_root = semantic_resource_root.unwrap_or_else(|| {
            PathBuf::from(&app_data_dir)
                .join("__missing_semantic_resources__")
                .to_string_lossy()
                .into_owned()
        });
        let state = AppState::new_with_reranker_root(
            &app_data_dir,
            &semantic_resource_root,
            reranker_resource_root.as_deref(),
        )
        .map_err(|e| Error::from_reason(format!("{e:#}")))?;
        // §7.1 の end-to-end 実証チャネルその 1。onEvent 登録前なので
        // EventQueue にバッファされ、登録時に flush される。schemaVersion は
        // スモークテストが PRAGMA user_version との一致検証に使う。
        state.events.emit(
            "backend:ready",
            serde_json::json!({ "schemaVersion": grimodex_core::SCHEMA_VERSION }),
        );
        Ok(Backend {
            state: Arc::new(state),
        })
    }

    /// Main-only D2a startup status. A fresh profile remains unrestricted until
    /// the main process explicitly activates the first protected publication;
    /// a persisted restricted profile reruns its startup quiescence barrier.
    #[napi]
    pub async fn initialize_profile_egress(&self) -> Result<String> {
        settle_profile_egress_startup(&self.state).await
    }

    /// Main-only first protected-publication activation. The caller is the
    /// Electron main process; this method is deliberately absent from the
    /// renderer IPC contract. Activation is durable and followed by the same
    /// quiescence barrier used for a restricted-profile restart.
    #[napi]
    pub async fn activate_profile_egress(&self) -> Result<String> {
        self.state
            .profile_egress
            .activate_first_restricted_publication(false)
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        settle_profile_egress_startup(&self.state).await
    }

    /// Main-only registration of one exact caller identity for this Backend
    /// process generation. Renderer IPC never exposes this method.
    #[napi]
    pub fn register_profile_egress_caller(&self, identity: String) -> Result<()> {
        let identity: profile_egress::CallerIdentity = serde_json::from_str(&identity)
            .map_err(|error| Error::from_reason(format!("invalid caller identity: {error}")))?;
        self.state
            .profile_egress
            .register_caller(&identity)
            .map_err(|error| Error::from_reason(format!("{error:#}")))
    }

    /// Main-only invalidation when the trusted workspace binding changes.
    /// Renderer-provided identities cannot clear or retain Native registrations.
    #[napi]
    pub fn invalidate_profile_egress_callers(&self) {
        self.state.profile_egress.invalidate_callers();
    }

    // ─────────────────────── license (Phase 3e) ──────────────────────────

    /// Main-process-only bridge used during the Electron v2 first-run
    /// credential migration. This method is deliberately absent from
    /// `NAPI_COMMANDS`, so renderer IPC cannot request plaintext credentials.
    /// Feature-off development builds return a disabled envelope and never
    /// touch the OS keyring.
    #[napi]
    pub async fn read_legacy_api_keys_for_migration(&self) -> Result<String> {
        #[cfg(feature = "legacy-keyring-migration")]
        {
            let settings_path = self.state.ai_settings_path.clone();
            run_blocking(move || {
                let export = legacy_keyring::read_legacy_api_keys(&settings_path)?;
                Ok(serde_json::to_string(&export).map_err(anyhow::Error::from)?)
            })
            .await
        }

        #[cfg(not(feature = "legacy-keyring-migration"))]
        {
            Ok(r#"{"available":false,"entries":[]}"#.to_string())
        }
    }

    /// Main/CI-only build gate. Packaging verifies both release-only features
    /// before electron-builder runs; this method is not registered in renderer
    /// IPC and contains no user data.
    #[napi]
    pub async fn get_native_build_capabilities(&self) -> Result<String> {
        Ok(serde_json::json!({
            "licensing": cfg!(feature = "licensing"),
            "legacyKeyringMigration": cfg!(feature = "legacy-keyring-migration"),
        })
        .to_string())
    }

    /// 常時exportするライセンス状態IPC。feature無効buildでは共有crateが
    /// exact disabled DTOを返し、license.jsonには一切触れない。
    #[napi]
    pub async fn get_license_state(&self) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        napi::tokio::task::spawn_blocking(move || {
            grimodex_license::get_license_state(&runtime)
                .and_then(|dto| serde_json::to_string(&dto).map_err(Into::into))
        })
        .await
        .map_err(join_err_to_napi)?
        .map_err(|error| Error::from_reason(format!("{error:#}")))
    }

    /// Polar activate → atomic license.json更新。HTTP await中にfile lockは保持しない。
    #[napi]
    pub async fn activate_license(&self, key: String) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        let dto = grimodex_license::activate_license(&runtime, key)
            .await
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 明示的な再検証。共有runtimeのsingle-flightとstale response guardを使う。
    #[napi]
    pub async fn revalidate_license(&self) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        let dto = grimodex_license::revalidate_license(&runtime)
            .await
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Polar側を解除してから、同じactivationである場合だけlocal stateを破棄する。
    #[napi]
    pub async fn deactivate_license(&self) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        let dto = grimodex_license::deactivate_license(&runtime)
            .await
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 起動5秒後/以後6時間周期のmain schedulerから呼ぶfail-soft cycle。
    /// disabled・not due・in-flightはJS null、実行後はJSON DTOを返す。
    #[napi]
    pub async fn run_license_validate_cycle(&self) -> Result<Option<String>> {
        let runtime = Arc::clone(&self.state.license);
        grimodex_license::run_validate_cycle(&runtime)
            .await
            .map(|dto| {
                serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
            })
            .transpose()
    }

    /// Electron main scheduler 専用の Change Feed freshness cycle。
    /// renderer IPC には登録せず、1 call で共有runtimeの有界batchを最大1件だけ
    /// 処理する。workspace未open・切替中・Safe Mode・通常のfeed空はJS nullを返し、
    /// C2-ZCのexpected NOT_READYだけはmain activation owner向けの小さなJSONを返す。
    #[napi]
    pub async fn run_narrative_freshness_cycle(&self) -> Result<Option<String>> {
        let state = Arc::clone(&self.state);
        // Freshness can be the only scheduled producer after it transfers a
        // failed execution to a descriptor. Reconcile that exact root before
        // asking the shared core for a new maintenance permit; otherwise a
        // RecoveryRequired state would make every subsequent Freshness tick
        // return early while no ordinary delivery tick is available to pump
        // recovery.
        let recovery_reconciliation = {
            let recovery_state = Arc::clone(&state);
            run_blocking(move || reconcile_maintenance_recovery_with_open_lock(&recovery_state))
                .await?
        };
        if recovery_reconciliation.is_some() {
            let snapshot = state
                .workspace_lifecycle
                .lifecycle_snapshot()
                .map_err(|error| Error::from_reason(error.to_string()))?;
            if matches!(
                snapshot.state,
                LifecycleState::RecoveryRequired { .. } | LifecycleState::Transition { .. }
            ) {
                return Ok(None);
            }
        }
        let _workspace_operation = state
            .begin_workspace_operation()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let mut lifecycle_permit = match state
            .workspace_lifecycle
            .begin_maintenance()
            .map_err(|error| Error::from_reason(error.to_string()))?
        {
            PermitAdmission::Admitted(mut permit) => {
                if let Err(error) = permit.start() {
                    permit
                        .cancel_before_start()
                        .map_err(|cleanup| Error::from_reason(cleanup.to_string()))?;
                    return Err(Error::from_reason(format!(
                        "NEX_MAINTENANCE_PENDING_START_REJECTED: {error}"
                    )));
                }
                permit
            }
            PermitAdmission::NotAdmitted { .. } => return Ok(None),
        };
        // Capture the exact authority before the worker starts. The worker may
        // fail after another owner has admitted a Transition, at which point
        // the Ready-only getter intentionally rejects `active_database()`.
        // Recovery still needs the original authority and binding to retire
        // the connection and create a proof-bearing descriptor.
        let (pinned_authority, pinned_binding) = match active_workspace_snapshot(&state.ws) {
            Ok(workspace) => {
                let binding =
                    narrative_maintenance_binding_for_authority(&state, &workspace.authority);
                (workspace.authority, binding)
            }
            Err(error) => {
                lifecycle_permit
                    .mark_joined()
                    .and_then(|_| lifecycle_permit.release().map(|_| ()))
                    .map_err(|cleanup| Error::from_reason(cleanup.to_string()))?;
                return Err(app_err_to_napi(error));
            }
        };
        // Keep the permit in the async supervisor. A cancelled blocking task
        // therefore cannot consume it before JoinError is observed.
        let worker_state = Arc::clone(&state);
        let worker_join = napi::tokio::task::spawn_blocking(move || {
            catch_unwind(AssertUnwindSafe(|| {
                run_narrative_freshness_cycle_body(&worker_state, || {})
            }))
        });
        match worker_join.await {
            Ok(Ok(result)) => {
                lifecycle_permit
                    .mark_joined()
                    .map_err(|error| Error::from_reason(error.to_string()))?;
                match result {
                    Ok(result) => {
                        lifecycle_permit
                            .release()
                            .map_err(|error| Error::from_reason(error.to_string()))?;
                        Ok(result)
                    }
                    Err(error) => {
                        let retirement = retire_authority_for_recovery_with_status(
                            &state,
                            Some(Arc::clone(&pinned_authority)),
                        );
                        if !retirement.baton_retained {
                            return Err(Error::from_reason(
                                "NEX_MAINTENANCE_RECOVERY_BATON_UNAVAILABLE",
                            ));
                        }
                        if retirement.connection_retired {
                            lifecycle_permit
                                .mark_connection_retired()
                                .map_err(|error| Error::from_reason(error.to_string()))?;
                        }
                        let descriptor_id = lifecycle_permit
                            .transfer_to_recovery()
                            .map_err(|error| Error::from_reason(error.to_string()))?;
                        record_maintenance_recovery_binding(
                            &state,
                            descriptor_id,
                            None,
                            Some(&pinned_binding),
                        );
                        tracing::error!(
                            target: "narrative.maintenance",
                            %error,
                            descriptor_id = descriptor_id.get(),
                            "freshness cycle failed after Join; responsibility transferred to recovery"
                        );
                        Ok(Some(
                            serde_json::json!({
                                "status": "workspace-unavailable",
                                "reason": "freshness-recovery-required",
                                "descriptorId": descriptor_id,
                            })
                            .to_string(),
                        ))
                    }
                }
            }
            Ok(Err(_)) | Err(_) => {
                let retirement = retire_authority_for_recovery_with_status(
                    &state,
                    Some(Arc::clone(&pinned_authority)),
                );
                lifecycle_permit
                    .mark_joined()
                    .map_err(|error| Error::from_reason(error.to_string()))?;
                if !retirement.baton_retained {
                    return Err(Error::from_reason(
                        "NEX_MAINTENANCE_RECOVERY_BATON_UNAVAILABLE",
                    ));
                }
                if retirement.connection_retired {
                    lifecycle_permit
                        .mark_connection_retired()
                        .map_err(|error| Error::from_reason(error.to_string()))?;
                }
                let descriptor_id = lifecycle_permit
                    .transfer_to_recovery()
                    .map_err(|error| Error::from_reason(error.to_string()))?;
                record_maintenance_recovery_binding(
                    &state,
                    descriptor_id,
                    None,
                    Some(&pinned_binding),
                );
                Ok(Some(
                    serde_json::json!({
                        "status": "workspace-unavailable",
                        "reason": "freshness-recovery-required",
                        "descriptorId": descriptor_id,
                    })
                    .to_string(),
                ))
            }
        }
    }

    /// Main-process-only enqueue snapshot for the serialized maintenance
    /// seam. This is synchronous by design: it reads the currently pinned
    /// authority and recovery gate under one short state boundary, so the
    /// scheduler can bind a request before it enters its pending queue.
    #[napi]
    pub fn get_narrative_maintenance_workspace_binding(&self) -> Result<Option<String>> {
        let _workspace_operation = self
            .state
            .begin_workspace_operation()
            .map_err(|error| app_err_to_napi(AppError::Anyhow(error)))?;
        let workspace = match active_workspace_snapshot(&self.state.ws) {
            Ok(workspace) => workspace,
            Err(
                AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
            ) => return Ok(None),
            Err(error) => return Err(app_err_to_napi(error)),
        };
        let authority_id = narrative_authority_id(&workspace.authority);
        let binding = self
            .state
            .narrative_maintenance_recovery_gate
            .binding_for_authority(&authority_id);
        serde_json::to_string(&binding)
            .map(Some)
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    /// Main-only, delivery-independent descriptor recovery preflight. This
    /// is intentionally callable before the main delivery ledger is touched:
    /// an existing recovery root must remain actionable even when all normal
    /// delivery records are retained at capacity.
    #[napi]
    pub async fn reconcile_narrative_maintenance_recovery(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            if let Some((descriptor_id, receipt)) =
                first_completed_maintenance_recovery_receipt(&state)
            {
                return Ok(serde_json::json!({
                    "status": "reconciled",
                    "reason": "maintenance-recovery-complete",
                    "descriptorId": descriptor_id,
                    "recoveredBinding": receipt.recovered_binding,
                    "activeBinding": receipt.active_binding,
                    "reboundBinding": receipt.rebound_binding,
                })
                .to_string());
            }
            match reconcile_maintenance_recovery_with_open_lock(&state)? {
                Some(reconciliation) => {
                    let active_binding = active_database(&state.ws).ok().map(|authority| {
                        narrative_maintenance_binding_for_authority(&state, &authority)
                    });
                    Ok(serde_json::json!({
                        "status": "reconciled",
                        "reason": reconciliation.reason,
                        "descriptorId": reconciliation.descriptor_id,
                        "recoveredBinding": reconciliation
                            .maintenance_binding
                            .as_ref()
                            .map(|(_, binding)| binding),
                        "activeBinding": active_binding,
                        "reboundBinding": reconciliation.rebound_binding,
                    })
                    .to_string())
                }
                None => Ok(serde_json::json!({"status": "none"}).to_string()),
            }
        })
        .await
    }

    /// Main-only ACK for the replayable descriptor recovery receipt.  The
    /// descriptor and its durable responsibility were already resolved before
    /// this call; ACK only retires the process-local notification so a
    /// Freshness preflight cannot consume it before the main scheduler has
    /// observed the exact recovered binding.
    #[napi]
    pub fn ack_narrative_maintenance_recovery(&self, descriptor_id: String) -> Result<String> {
        let descriptor_id = descriptor_id
            .parse::<u64>()
            .map_err(|_| Error::from_reason("NEX_MAINTENANCE_RECOVERY_DESCRIPTOR_INVALID"))?;
        let mut receipts = self
            .state
            .narrative_maintenance_recovery_receipts
            .lock()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let mut acknowledgements = self
            .state
            .narrative_maintenance_recovery_acks
            .lock()
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let receipt_was_present = receipts.remove(&descriptor_id).is_some();
        let acknowledged = receipt_was_present || acknowledgements.contains(descriptor_id);
        if receipt_was_present {
            acknowledgements.mark(descriptor_id);
        }
        Ok(serde_json::json!({
            "status": "acknowledged",
            "descriptorId": descriptor_id,
            "acknowledged": acknowledged,
        })
        .to_string())
    }

    /// Configure the one-shot, main-only product-journey seam. The payload is
    /// parsed into the shared Rust schema and validated again there; this
    /// method is intentionally not present in the renderer IPC router.
    #[napi]
    pub fn configure_narrative_maintenance_ci_seam(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let config: NarrativeMaintenanceCiConfig =
            from_wire("payload", payload).map_err(app_err_to_napi)?;
        self.state
            .narrative_maintenance_ci_seam
            .configure(config)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(serde_json::json!({ "status": "enabled" }).to_string())
    }

    /// Main-process-only workspace-wide maintenance discovery.
    ///
    /// The active `WorkspaceAuthority` is pinned once for the complete
    /// enumeration and planner pass. The returned binding is the recovery
    /// generation paired with that exact authority; callers must pass it back
    /// unchanged to `run_narrative_maintenance_cycle`. Renderer/preload never
    /// receives this method or supplies project/path/phase data.
    #[napi]
    pub async fn discover_narrative_maintenance_work(&self, reason: String) -> Result<String> {
        let wake_reason = narrative_maintenance::WakeReason::parse(&reason)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let snapshot = match active_workspace_snapshot(&state.ws) {
                Ok(snapshot) => snapshot,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                        "reason": "maintenance-workspace-unavailable",
                    })
                    .to_string());
                }
                Err(error) => return Err(error),
            };
            let authority_id = narrative_authority_id(&snapshot.authority);
            let binding = state
                .narrative_maintenance_recovery_gate
                .binding_for_authority(&authority_id);
            let ci_config = state.narrative_maintenance_ci_seam.config();
            // The binding gate and workspace state are separate locks. Re-pin
            // the active snapshot after binding so a swap in that interval
            // cannot return an old authority paired with a new generation.
            // Fail closed; main will park the wake and rediscover after open.
            let current_snapshot = match active_workspace_snapshot(&state.ws) {
                Ok(snapshot) => snapshot,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                        "reason": "maintenance-workspace-snapshot-changed",
                    })
                    .to_string());
                }
                Err(error) => return Err(error),
            };
            let current_binding = state
                .narrative_maintenance_recovery_gate
                .binding_for_authority(&narrative_authority_id(&current_snapshot.authority));
            if !Arc::ptr_eq(&snapshot.authority, &current_snapshot.authority)
                || binding != current_binding
            {
                return Ok(serde_json::json!({
                    "status": "workspace-unavailable",
                    "reason": "maintenance-workspace-binding-mismatch",
                })
                .to_string());
            }
            let discovery = narrative_maintenance::discover_all(
                snapshot.authority.db(),
                binding,
                wake_reason,
                ci_config.as_ref(),
            )
            .map_err(AppError::Anyhow)?;
            serde_json::to_string(&discovery).map_err(|error| AppError::Anyhow(error.into()))
        })
        .await
    }

    /// Electron main-only durable wake outbox reader. An Epoch rotation
    /// commits its wake identity in the same transaction as the rotation;
    /// this lists the wakes main has not yet acknowledged so a lost
    /// observer event can never strand a rotated Epoch without maintenance
    /// discovery. Returns a JSON array; an unavailable workspace is `[]`.
    #[napi]
    pub async fn list_narrative_maintenance_wake_outbox(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let workspace = match active_workspace_snapshot(&state.ws) {
                Ok(workspace) => workspace,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => return Ok("[]".to_string()),
                Err(error) => return Err(error),
            };
            let wakes = narrative_extraction::list_pending_maintenance_wakes(workspace.db())
                .map_err(AppError::Anyhow)?;
            serde_json::to_string(&wakes).map_err(|error| AppError::Anyhow(error.into()))
        })
        .await
    }

    /// Acknowledge durable wakes only after main has registered the exact
    /// discovery binding that listed them. A stale authority gets a typed
    /// non-ACK, never an acknowledgement against a replacement workspace.
    #[napi]
    pub async fn ack_narrative_maintenance_wake_outbox(
        &self,
        ids: Vec<String>,
        workspace_binding: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let requested_binding: MaintenanceWorkspaceBinding =
                from_wire("workspaceBinding", workspace_binding)?;
            requested_binding.validate().map_err(AppError::Anyhow)?;
            let _workspace_open_guard = state
                .ws
                .open_lock
                .lock()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
            let authority = match active_database(&state.ws) {
                Ok(authority) => authority,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                    })
                    .to_string())
                }
                Err(error) => return Err(error),
            };
            let current_binding = narrative_maintenance_binding_for_authority(&state, &authority);
            if current_binding != requested_binding {
                return Ok(serde_json::json!({
                    "status": "workspace-binding-mismatch",
                })
                .to_string());
            }
            let acked = narrative_extraction::ack_maintenance_wakes(authority.db(), &ids)
                .map_err(AppError::Anyhow)?;
            Ok(serde_json::json!({
                "status": "accepted",
                "acknowledged": u32::try_from(acked).unwrap_or(u32::MAX),
            })
            .to_string())
        })
        .await
    }

    /// Register one process-local maintenance attempt against the exact
    /// workspace recovery generation. This is main-only and has no durable
    /// schema; durable Run/Task/Attempt rows remain owned by the existing
    /// maintenance runtime.
    #[napi]
    pub async fn begin_narrative_maintenance_attempt(
        &self,
        attempt_id: String,
        workspace_binding: serde_json::Value,
    ) -> Result<String> {
        let binding: MaintenanceWorkspaceBinding =
            from_wire("workspaceBinding", workspace_binding).map_err(app_err_to_napi)?;
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let _open_guard = state
                .ws
                .open_lock
                .lock()
                .map_err(|error| {
                    AppError::Anyhow(anyhow::anyhow!(
                        "NEX_MAINTENANCE_OPEN_LOCK_UNAVAILABLE: {error}"
                    ))
                })?;
            // Main registers its process-local attempt before dispatch. A
            // descriptor may be the only owner while the workspace is in
            // RecoveryRequired, so reconcile the exact root before the
            // ordinary active_database lookup makes that path unreachable.
            let _ = reconcile_maintenance_recovery_descriptor(&state)?;
            let authority = active_database(&state.ws).map_err(|error| {
                AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_AUTHORITY_UNAVAILABLE: {error}"
                ))
            })?;
            let authority_id = narrative_authority_id(&authority);
            let current_binding = state
                .narrative_maintenance_recovery_gate
                .binding_for_authority(&authority_id);
            if current_binding != binding {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_ATTEMPT_BINDING_MISMATCH: attempt is bound to an old workspace generation"
                )));
            }
            state
                .narrative_maintenance_recovery_gate
                .register_attempt(&attempt_id, &binding)?;
            if let Err(error) = state
                .narrative_maintenance_attempts
                .begin(&attempt_id, &binding)
            {
                // Keep the recovery admission and the attempt registry
                // linearized: a failed process-local begin must not strand an
                // active-attempt entry that blocks the next workspace swap.
                state
                    .narrative_maintenance_recovery_gate
                    .release_attempt(&attempt_id);
                return Err(AppError::Anyhow(error));
            }
            Ok(serde_json::json!({
                "status": "open",
                "attemptId": attempt_id,
                "authorityId": binding.authority_id,
                "generation": binding.generation,
            })
            .to_string())
        })
        .await
    }

    /// Request cancellation and wait until the Native attempt has produced a
    /// terminal receipt. A late request after FinalizeGranted observes the
    /// already-successful receipt and cannot rewrite it.
    #[napi]
    pub async fn cancel_narrative_maintenance_attempt(
        &self,
        attempt_id: String,
        reason: String,
    ) -> Result<String> {
        let (immediate, admission) = self
            .state
            .narrative_maintenance_attempts
            .request_cancel_with_waiter(&attempt_id, &reason)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        let receipt = match immediate {
            Some(receipt) => receipt,
            None => {
                let admission = admission.ok_or_else(|| {
                    Error::from_reason(
                        "NEX_MAINTENANCE_ATTEMPT_WAIT_ADMISSION_MISSING: cancellation did not admit a terminal waiter",
                    )
                })?;
                self.state
                    .narrative_maintenance_attempts
                    .wait_for_terminal_with_admission(&attempt_id, admission)
                    .await
                    .map_err(|error| Error::from_reason(error.to_string()))?
            }
        };
        // A terminal receipt with failed cleanup is deliberately kept in the
        // recovery gate.  Releasing it would allow workspace swap or a later
        // foreground operation to reuse a connection whose transaction or
        // connection settings were not proven restored.
        if receipt.cleanup.status == "clean" && receipt.connection_reusable {
            self.state
                .narrative_maintenance_recovery_gate
                .release_attempt(&attempt_id);
        }
        serde_json::to_string(&receipt).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Retire a consumed Native terminal receipt.  This method is main-only
    /// and intentionally absent from the renderer/preload contract.  The
    /// registry refuses an ACK while an admitted owner or waiter still holds
    /// the receipt, so a late ACK cannot delete a result another caller is
    /// still waiting to observe.
    #[napi]
    pub fn ack_narrative_maintenance_attempt(&self, attempt_id: String) -> Result<String> {
        let acknowledged = self
            .state
            .narrative_maintenance_attempts
            .acknowledge_terminal(&attempt_id)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Ok(serde_json::json!({
            "status": "acknowledged",
            "attemptId": attempt_id,
            "acknowledged": acknowledged,
        })
        .to_string())
    }

    /// Electron main-only serialized system-work cycle.
    ///
    /// The request is validated in shared Rust, then executed against one
    /// pinned `WorkspaceAuthority` connection.  In particular, this method
    /// never reconstructs a `Database` from the workspace path: doing so
    /// would create the detached second writer that caused
    /// `SQLITE_BUSY_SNAPSHOT` in the old post-open worker.  A missing or
    /// switching workspace is a structured unavailable result so the main
    /// scheduler retains the durable trigger rather than treating it as a
    /// successful drain.
    #[napi]
    pub async fn run_narrative_maintenance_cycle(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        // Recovery is delivery-independent. Resolve an exact descriptor
        // before reserving a new execution so RecoveryRequired cannot reject
        // the pending-start owner while the only progress path sits behind
        // this call.
        let recovery_state = Arc::clone(&state);
        if let Some(reconciliation) =
            run_blocking(move || reconcile_maintenance_recovery_with_open_lock(&recovery_state))
                .await?
        {
            return Ok(serde_json::json!({
                "status": "workspace-unavailable",
                "reason": reconciliation.reason,
                "descriptorId": reconciliation.descriptor_id,
            })
            .to_string());
        }

        let _workspace_operation = state
            .begin_workspace_operation()
            .map_err(|error| Error::from_reason(error.to_string()))?;

        // Reserve the shared-core owner before spawn_blocking.  A transition
        // or shutdown racing the small pending-start window therefore sees
        // this execution and can request its stop without relying on a JS
        // Promise or a worker handle that does not exist yet.
        let lifecycle_permit = match state
            .workspace_lifecycle
            .begin_maintenance()
            .map_err(|error| Error::from_reason(error.to_string()))?
        {
            PermitAdmission::Admitted(permit) => permit,
            PermitAdmission::NotAdmitted { reason, snapshot } => {
                if matches!(snapshot.state, LifecycleState::NoWorkspace) {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                        "reason": "lifecycle-no-workspace",
                    })
                    .to_string());
                }
                return Ok(serde_json::json!({
                    "status": "not-admitted",
                    "reason": format!("lifecycle-{reason:?}"),
                    "stateRevision": snapshot.revision,
                })
                .to_string());
            }
        };
        let permit_return_slot = Arc::new(Mutex::new(Some(lifecycle_permit)));
        let permit_return_slot_for_worker = Arc::clone(&permit_return_slot);
        let admitted_sequence_slot = Arc::new(Mutex::new(None::<DeliverySequence>));
        let admitted_sequence_slot_for_worker = Arc::clone(&admitted_sequence_slot);
        let requested_attempt_id = payload
            .get("attemptId")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned);
        let requested_binding = payload
            .get("workspaceBinding")
            .cloned()
            .and_then(|value| serde_json::from_value::<MaintenanceWorkspaceBinding>(value).ok());
        let worker_state = Arc::clone(&state);
        let worker_join = napi::tokio::task::spawn_blocking(move || {
            let state = worker_state;
            let mut admitted_delivery_sequence = None;
            // The lifecycle permit outlives the operation body so the common
            // finalizer can make an explicit Join decision even when the body
            // returns early.  Drop is intentionally fail-closed.
            let mut lifecycle_permit = MaintenancePermitLease::new(permit_return_slot_for_worker);
            if lifecycle_permit.is_none() {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_PENDING_PERMIT_LOST"
                )));
            }
            let mut lifecycle_work_started = false;
            let mut worker_authority: Option<PinnedWorkspaceDb> = None;
            let mut outcome_attempt_id: Option<String> = None;
            let mut outcome_binding: Option<MaintenanceWorkspaceBinding> = None;
            let operation_result = match catch_unwind(AssertUnwindSafe(|| {
                (|| -> std::result::Result<String, AppError> {
                    let attempt_id = payload
                        .get("attemptId")
                        .and_then(serde_json::Value::as_str)
                        .map(ToOwned::to_owned);
                    outcome_attempt_id = attempt_id.clone();
                    let mut request_payload = payload;
                    if let Some(object) = request_payload.as_object_mut() {
                        object.remove("attemptId");
                    }
                    let request: MaintenanceCycleRequest = from_wire("payload", request_payload)?;
                    outcome_binding = request.workspace_binding.clone();
                    let normalized_work =
                        match narrative_extraction::preflight_maintenance_cycle_request(&request) {
                            Ok(work) => work,
                            Err(error) => {
                                // Request validation belongs to this invocation, not to
                                // the already-admitted lifecycle owner.  In particular,
                                // a malformed duplicate cycle carrying the same
                                // attemptId must not settle or release the original
                                // recovery-gate owner.
                                return Err(AppError::Anyhow(error));
                            }
                        };
                    // Descriptor-bound recovery is capacity-independent.  Resolve an
                    // existing exact root before touching the normal H+1 delivery
                    // ledger so a full 256-record transport cannot deadlock the only
                    // operation capable of releasing a responsibility cell.
                    let recovery_reconciliation =
                        { reconcile_maintenance_recovery_with_open_lock(&state)? };
                    if let Some(reconciliation) = recovery_reconciliation {
                        return Ok(serde_json::json!({
                            "status": "workspace-unavailable",
                            "reason": reconciliation.reason,
                            "descriptorId": reconciliation.descriptor_id,
                        })
                        .to_string());
                    }
                    if let Some(sequence) = request.delivery_sequence {
                        let delivery_sequence = DeliverySequence::new(sequence);
                        let fingerprint =
                            request.delivery_fingerprint.clone().ok_or_else(|| {
                                AppError::Anyhow(anyhow::anyhow!(
                            "NEX_MAINTENANCE_DELIVERY_FINGERPRINT_INVALID: fingerprint is required"
                        ))
                            })?;
                        match state
                            .workspace_lifecycle
                            .admit_delivery_at(delivery_sequence, fingerprint)?
                        {
                            DeliveryAdmissionOutcome::Accepted { sequence } => {
                                admitted_delivery_sequence = Some(sequence);
                                if let Ok(mut slot) = admitted_sequence_slot_for_worker.lock() {
                                    *slot = Some(sequence);
                                }
                            }
                            DeliveryAdmissionOutcome::Replay { result, .. } => {
                                // A duplicate sequence is a read of the existing
                                // Native delivery owner. Replaying a terminal result
                                // is safe; a still-pending owner remains unavailable
                                // until its supervisor publishes a terminal result.
                                return Ok(result.unwrap_or_else(|| {
                                    serde_json::json!({
                                        "status": "workspace-unavailable",
                                        "reason": "maintenance-delivery-replay-pending",
                                    })
                                    .to_string()
                                }));
                            }
                            DeliveryAdmissionOutcome::Full { .. } => {
                                return Ok(serde_json::json!({
                                    "status": "workspace-unavailable",
                                    "reason": "maintenance-delivery-capacity",
                                })
                                .to_string());
                            }
                            DeliveryAdmissionOutcome::SealedAbsent { .. }
                            | DeliveryAdmissionOutcome::OutOfOrder { .. }
                            | DeliveryAdmissionOutcome::Conflict { .. } => {
                                return Ok(serde_json::json!({
                                    "status": "workspace-unavailable",
                                    "reason": "maintenance-delivery-sequence-invalid",
                                })
                                .to_string());
                            }
                        }
                    }
                    let mut attempt_guard = if let Some(attempt_id) = attempt_id {
                        request.workspace_binding.as_ref().ok_or_else(|| {
                            AppError::Anyhow(anyhow::anyhow!(
                        "NEX_MAINTENANCE_ATTEMPT_BINDING_MISSING: attempt requires workspaceBinding"
                    ))
                        })?;
                        // Initial request identities may be stale or epoch-less. The
                        // shared cycle resolves each item against the pinned DB and
                        // registers that effective identity immediately before it is
                        // started. Do not seed the registry with the wire keys here;
                        // doing so would leave stale aliases in the terminal receipt
                        // and would make a valid normalized work look unknown.
                        let work_keys = std::iter::empty::<String>();
                        if let Err(error) = state
                            .narrative_maintenance_attempts
                            .start(&attempt_id, work_keys)
                        {
                            // `start` is an atomic owner admission.  A duplicate
                            // cycle is rejected without mutating the original owner;
                            // releasing the recovery gate here would otherwise let
                            // workspace swap race that still-running owner.
                            return Err(AppError::Anyhow(error));
                        }
                        Some(NarrativeMaintenanceAttemptGuard::new(
                            Arc::clone(&state),
                            attempt_id,
                        ))
                    } else {
                        None
                    };
                    let authority = match active_database(&state.ws) {
                        Ok(authority) => authority,
                        Err(
                            AppError::NoWorkspace
                            | AppError::WorkspaceSwitching
                            | AppError::SafeModeActive,
                        ) => {
                            return Ok(serde_json::json!({
                                "status": "workspace-unavailable",
                            })
                            .to_string());
                        }
                        Err(error) => return Err(error),
                    };
                    worker_authority = Some(Arc::clone(&authority));
                    if let Some(guard) = attempt_guard.as_mut() {
                        guard.bind_authority(Arc::clone(&authority));
                    }
                    let authority_id = narrative_authority_id(&authority);
                    let Some(request_binding) = request.workspace_binding.as_ref() else {
                        return Ok(serde_json::json!({
                            "status": "workspace-unavailable",
                            "reason": "maintenance-workspace-binding-missing",
                        })
                        .to_string());
                    };
                    let current_binding = state
                        .narrative_maintenance_recovery_gate
                        .binding_for_authority(&authority_id);
                    // Pinning an Arc is necessary but not sufficient: a workspace
                    // swap may begin between the first pin and this validation. Read
                    // the active snapshot again and fail closed if it is no longer
                    // the exact authority that was pinned for this cycle.
                    let current_snapshot = match active_workspace_snapshot(&state.ws) {
                        Ok(snapshot) => snapshot,
                        Err(
                            AppError::NoWorkspace
                            | AppError::WorkspaceSwitching
                            | AppError::SafeModeActive,
                        ) => {
                            return Ok(serde_json::json!({
                                "status": "workspace-unavailable",
                                "reason": "maintenance-workspace-snapshot-changed",
                            })
                            .to_string());
                        }
                        Err(error) => return Err(error),
                    };
                    if !std::sync::Arc::ptr_eq(&authority, &current_snapshot.authority)
                        || request_binding != &current_binding
                    {
                        return Ok(serde_json::json!({
                            "status": "workspace-unavailable",
                            "reason": "maintenance-workspace-binding-mismatch",
                        })
                        .to_string());
                    }

                    // The normal Open/Restore path publishes this binding before a
                    // maintenance request can arrive. Test-only and compatibility
                    // owners may install an already-verified authority directly, so
                    // observe that authority once before taking the shared execution
                    // permit. This does not infer identity from a renderer argument:
                    // `snapshot_for_workspace` reads the verified Native authority and
                    // its durable metadata.
                    state
                        .workspace_lifecycle
                        .ensure_authority_ready(&state.ws)?;
                    // The shared-core lifecycle permit was reserved by the async
                    // supervisor before spawn_blocking. Starting it here preserves a
                    // supervised pending-start interval without opening a second
                    // admission race inside the worker.
                    if let Some(permit) = lifecycle_permit.as_mut() {
                        if let Err(error) = permit.start() {
                            permit.cancel_before_start_in_place().map_err(|cleanup| {
                                AppError::Anyhow(anyhow::anyhow!(
                                    "NEX_MAINTENANCE_PENDING_START_CLEANUP_FAILED: {cleanup}"
                                ))
                            })?;
                            // cancel_before_start_in_place already removed the
                            // admission and execution membership; do not hand that
                            // released handle to the Join finalizer a second time.
                            let _ = lifecycle_permit.take();
                            return Err(AppError::Anyhow(anyhow::anyhow!(
                                "NEX_MAINTENANCE_PENDING_START_REJECTED: {error}"
                            )));
                        }
                        // Admission/start is the ownership boundary. Any DB work
                        // after this point (preempted-run cleanup, fault setup, or
                        // planning) is supervised and must transfer the permit on
                        // error instead of taking the clean-release path.
                        lifecycle_work_started = true;
                        permit.arm_scope_finalizer();
                    }

                    // Resolve the verified DB namespace before entering the outer
                    // maintenance connection scope. Run creation reservation is
                    // called from inside that scope's transaction and must not
                    // recursively acquire the same SQLite mutex.
                    let project_lifecycle_namespace =
                grimodex_db::narrative_extraction::project_lifecycle_namespace_for_database(
                    authority.db(),
                )?;

                    // Every short ledger read performed by recovery, foreground
                    // lookup, and post-cycle acknowledgement inherits the same
                    // no-wait policy as the phase-owned Graph scopes.
                    let _maintenance_no_wait =
                        authority.db().enter_maintenance_connection_no_wait();

                    // A phase-scoped no-wait acquisition may lose a foreground
                    // handoff after its Run was created.  Drain that exact Run owner
                    // before recovery/dispatch; a busy connection leaves the owner
                    // parked and returns an interrupted receipt so main requeues the
                    // delivery without startup-recovery retry accounting.
                    let pending_preempted_runs = state
                        .narrative_maintenance_preempted_runs
                        .pending_for_binding(request_binding);
                    for run_id in pending_preempted_runs {
                        match narrative_extraction::try_cancel_preempted_maintenance_run(
                            authority.db(),
                            &run_id,
                            "NEX_MAINTENANCE_CONNECTION_PREEMPTED: retrying deferred cleanup",
                        )
                        .map_err(AppError::Anyhow)?
                        {
                            true => state.narrative_maintenance_preempted_runs.remove(&run_id),
                            false => {
                                // No maintenance connection was acquired for this
                                // attempt. The pending Run owner is still a
                                // separate quiescence blocker, but this attempt's
                                // connection cleanup is clean and must not cause
                                // quarantine/reopen on its own.
                                return deferred_narrative_maintenance_result(
                                    &state,
                                    attempt_guard.as_mut(),
                                );
                            }
                        }
                    }
                    let ci_config = state.narrative_maintenance_ci_seam.config();
                    // Faults are claimed against the same immutable authority,
                    // generation, project, epoch, and canonical work identity that
                    // the recovery gate uses.  The shared Backfill owner creates the
                    // real lifecycle triplet; this adapter only supplies the typed
                    // one-shot seam and owns the deliberate process exit case.
                    if let Some(config) = ci_config.as_ref() {
                        if let Some(fault) = config.fault {
                            // Fault injection is a single-work product-journey seam.
                            // A mixed phase batch must go through the ordinary state
                            // machine so an ACK cannot drop the other queued work
                            // while the main owner deliberately halts for exit.
                            if normalized_work.len() == 1
                                && normalized_work[0].run_kind.as_str() == "backfill"
                            {
                                let item = &normalized_work[0];
                                // Recheck every actual normalized reason. A private
                                // sentinel reason must never make the planner claim a
                                // Backfill that the public state machine would not
                                // dispatch.
                                let planner_identity_matches = item.reasons.iter().try_fold(
                                    true,
                                    |matches, reason| -> anyhow::Result<bool> {
                                        let candidate = narrative_extraction::
                                    discover_durable_maintenance_work_with_config(
                                        authority.db(),
                                        &item.project_id,
                                        reason,
                                        Some(config),
                                    )?;
                                        Ok(matches
                                            && candidate.is_some_and(|candidate| {
                                                candidate.project_id == item.project_id
                                                    && candidate.run_kind == item.run_kind
                                                    && candidate.work_key == item.work_key
                                                    && candidate.semantic_epoch_id
                                                        == item.semantic_epoch_id
                                            }))
                                    },
                                )?;
                                if planner_identity_matches {
                                    // Re-pin immediately before reserving/writing. A
                                    // workspace replacement between the broad cycle
                                    // snapshot and this fault boundary fails closed.
                                    let write_snapshot = match active_workspace_snapshot(&state.ws)
                                    {
                                        Ok(snapshot) => snapshot,
                                        Err(
                                            AppError::NoWorkspace
                                            | AppError::WorkspaceSwitching
                                            | AppError::SafeModeActive,
                                        ) => {
                                            return Ok(serde_json::json!({
                                                "status": "workspace-unavailable",
                                                "reason": "maintenance-workspace-snapshot-changed",
                                            })
                                            .to_string());
                                        }
                                        Err(error) => return Err(error),
                                    };
                                    let write_binding = state
                                        .narrative_maintenance_recovery_gate
                                        .binding_for_authority(&narrative_authority_id(
                                            &write_snapshot.authority,
                                        ));
                                    if !std::sync::Arc::ptr_eq(
                                        &authority,
                                        &write_snapshot.authority,
                                    ) || request_binding != &write_binding
                                    {
                                        return Ok(serde_json::json!({
                                            "status": "workspace-unavailable",
                                            "reason": "maintenance-workspace-binding-mismatch",
                                        })
                                        .to_string());
                                    }
                                    if let Some(claim) = state
                                        .narrative_maintenance_ci_seam
                                        .claim_fault_for_binding(
                                            fault,
                                            request_binding,
                                            &item.project_id,
                                            item.run_kind.as_str(),
                                            item.semantic_epoch_id.as_deref(),
                                            &item.work_key,
                                        )
                                        .map_err(AppError::Anyhow)?
                                    {
                                        let expected_work = item.work_key_identity();
                                        let injected = match narrative_extraction::
                                    inject_legacy_backfill_fault_for_work(
                                        authority.db(),
                                        &expected_work,
                                        &item.reasons,
                                        claim.fault(),
                                    ) {
                                    Ok(outcome) => outcome,
                                    Err(error) => {
                                        state
                                            .narrative_maintenance_ci_seam
                                            .release_fault_claim(&claim);
                                        return Err(AppError::Anyhow(error));
                                    }
                                };
                                        match injected {
                                            LegacyBackfillFaultOutcome::NotInjected => {
                                                state
                                                    .narrative_maintenance_ci_seam
                                                    .release_fault_claim(&claim);
                                            }
                                            LegacyBackfillFaultOutcome::Failed {
                                                run_id,
                                                semantic_epoch_id,
                                                failure_code,
                                            } => {
                                                let fault_kind = claim.fault();
                                                state
                                                    .narrative_maintenance_ci_seam
                                                    .commit_fault_for_run(
                                                        &claim,
                                                        &run_id,
                                                        Some(&semantic_epoch_id),
                                                    )
                                                    .map_err(AppError::Anyhow)?;
                                                match fault_kind {
                                            NarrativeMaintenanceCiFault::ContractViolation => {
                                                // A terminal contract violation is
                                                // durably failed and projected to
                                                // Inbox by the shared owner. ACK it
                                                // as handled so main never enters
                                                // its generic delivery retry path.
                                                return Ok(serde_json::json!({
                                                    "status": "ci-terminal-fault-handled",
                                                    "fault": "contract-violation",
                                                    "runId": run_id,
                                                    "authorityId": request_binding.authority_id,
                                                    "generation": request_binding.generation,
                                                })
                                                .to_string());
                                            }
                                            NarrativeMaintenanceCiFault::TransientIo => {
                                                // Returning a typed error leaves
                                                // the exact work key queued. Its
                                                // next cycle rediscovers this
                                                // failed Run and applies the
                                                // bounded transient policy.
                                                return Err(AppError::Anyhow(anyhow::anyhow!(
                                                    "{failure_code}: injected maintenance fault"
                                                )));
                                            }
                                            NarrativeMaintenanceCiFault::ProcessInterruption => {
                                                return Err(AppError::Anyhow(anyhow::anyhow!(
                                                    "NEX_MAINTENANCE_CI_SEAM_FAULT_MISMATCH: process interruption returned a failed outcome"
                                                )));
                                            }
                                        }
                                            }
                                            LegacyBackfillFaultOutcome::Running {
                                                run_id,
                                                semantic_epoch_id,
                                            } => {
                                                let is_process_interruption = matches!(
                                            claim.fault(),
                                            NarrativeMaintenanceCiFault::ProcessInterruption
                                        );
                                                if !is_process_interruption {
                                                    state
                                                        .narrative_maintenance_ci_seam
                                                        .release_fault_claim(&claim);
                                                    return Err(AppError::Anyhow(anyhow::anyhow!(
                                                "NEX_MAINTENANCE_CI_SEAM_FAULT_MISMATCH: running fault outcome is not process interruption"
                                            )));
                                                }
                                                state
                                                    .narrative_maintenance_ci_seam
                                                    .commit_fault_for_run(
                                                        &claim,
                                                        &run_id,
                                                        Some(&semantic_epoch_id),
                                                    )
                                                    .map_err(AppError::Anyhow)?;
                                                // The config was validated at one-shot
                                                // setup; recheck the process-only gate at
                                                // the actual exit boundary as defense in
                                                // depth against a future state refactor.
                                                if config.is_packaged || config.ci != "true" {
                                                    return Err(AppError::Anyhow(anyhow::anyhow!(
                                                "NEX_MAINTENANCE_CI_SEAM_INACTIVE: process interruption requires an unpackaged CI launch"
                                            )));
                                                }
                                                return Ok(serde_json::json!({
                                                    "status": "ci-process-interruption-pending",
                                                    "fault": "process-interruption",
                                                    "runId": run_id,
                                                    "authorityId": request_binding.authority_id,
                                                    "generation": request_binding.generation,
                                                })
                                                .to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    let foreground_owner = if let Some(config) = ci_config.as_ref() {
                        if config.trigger
                            != Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake)
                        {
                            None
                        } else if let Some(binding) = request.workspace_binding.as_ref() {
                            let durable =
                                match narrative_extraction::find_running_foreground_system_work_run(
                                    authority.db(),
                                    config,
                                    binding,
                                ) {
                                    Ok(durable) => durable,
                                    Err(error) if is_narrative_maintenance_preemption(&error) => {
                                        return deferred_narrative_maintenance_result(
                                            &state,
                                            attempt_guard.as_mut(),
                                        )
                                    }
                                    Err(error) => return Err(AppError::Anyhow(error)),
                                };
                            match (
                                config.product_journey_barrier_id.as_deref(),
                                config.correlation.as_deref(),
                            ) {
                                (Some(barrier_id), Some(correlation)) => {
                                    durable.and_then(|barrier| {
                                        state
                                            .narrative_maintenance_foreground_barrier
                                            .pending_for_run_and_binding(
                                                &barrier.run_id,
                                                &barrier.project_id,
                                                &binding.authority_id,
                                                binding.generation,
                                                barrier_id,
                                                correlation,
                                            )
                                    })
                                }
                                _ => None,
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    let attempt_id_for_control =
                        attempt_guard.as_ref().map(|guard| guard.attempt_id.clone());
                    let state_for_control = Arc::clone(&state);
                    let creation_run_id = Arc::new(Mutex::new(None::<String>));
                    let creation_run_id_for_start = Arc::clone(&creation_run_id);
                    let creation_run_id_for_outcome = Arc::clone(&creation_run_id);
                    let creation_run_id_for_reset = Arc::clone(&creation_run_id);
                    let stop_signal_for_control = attempt_id_for_control
                        .as_deref()
                        .map(|attempt_id| {
                            state_for_control
                                .narrative_maintenance_attempts
                                .stop_signal(attempt_id)
                        })
                        .transpose()?;
                    let finalization_granted_signal_for_control = attempt_id_for_control
                        .as_deref()
                        .map(|attempt_id| {
                            state_for_control
                                .narrative_maintenance_attempts
                                .finalization_granted_signal(attempt_id)
                        })
                        .transpose()?;
                    let should_stop = || -> anyhow::Result<()> {
                        if let Some(permit) = lifecycle_permit.as_ref() {
                            if permit.stop_requested()? {
                                anyhow::bail!(
                            "NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED: transition is draining this execution"
                        );
                            }
                        }
                        if let Some(attempt_id) = attempt_id_for_control.as_deref() {
                            let signalled =
                                stop_signal_for_control.as_ref().is_some_and(|signal| {
                                    signal.load(std::sync::atomic::Ordering::Acquire)
                                });
                            if signalled
                                || state_for_control
                                    .narrative_maintenance_attempts
                                    .stop_requested(attempt_id)?
                            {
                                anyhow::bail!(
                            "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation requested at a Rust work boundary"
                        );
                            }
                        }
                        Ok(())
                    };
                    let work_completed =
                |item: &grimodex_db::narrative_extraction::DesiredWork| -> anyhow::Result<()> {
                    if let Some(attempt_id) = attempt_id_for_control.as_deref() {
                        let work_key = item.canonical_key();
                        state_for_control
                            .narrative_maintenance_attempts
                            .mark_work_succeeded(attempt_id, &work_key)?;
                    }
                    Ok(())
                };
                    let work_noop_completed =
                |item: &grimodex_db::narrative_extraction::DesiredWork| -> anyhow::Result<()> {
                    if let Some(attempt_id) = attempt_id_for_control.as_deref() {
                        let work_key = item.canonical_key();
                        state_for_control
                            .narrative_maintenance_attempts
                            .mark_work_completed(attempt_id, &work_key)?;
                    }
                    Ok(())
                };
                    let work_deferred =
                |item: &grimodex_db::narrative_extraction::DesiredWork| -> anyhow::Result<()> {
                    if let Some(attempt_id) = attempt_id_for_control.as_deref() {
                        let work_key = item.canonical_key();
                        state_for_control
                            .narrative_maintenance_attempts
                            .mark_work_deferred(attempt_id, &work_key)?;
                    }
                    Ok(())
                };
                    let defer_preempted_run = |run_id: &str| -> anyhow::Result<()> {
                        state
                            .narrative_maintenance_preempted_runs
                            .defer(run_id, request_binding)
                    };
                    let grant_finalize = |work_key: &str| -> anyhow::Result<()> {
                        if let Some(attempt_id) = attempt_id_for_control.as_deref() {
                            let granted = state_for_control
                                .narrative_maintenance_attempts
                                .grant_work_finalize(attempt_id, work_key)?;
                            anyhow::ensure!(
                        granted,
                        "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation won before work finalization"
                    );
                        }
                        Ok(())
                    };
                    let register_work =
                |item: &grimodex_db::narrative_extraction::DesiredWork| -> anyhow::Result<()> {
                    if let Some(attempt_id) = attempt_id_for_control.as_deref() {
                        state_for_control
                            .narrative_maintenance_attempts
                            .register_work(attempt_id, &item.canonical_key())?;
                    }
                    Ok(())
                };
                    let work_started =
                |item: &grimodex_db::narrative_extraction::DesiredWork| -> anyhow::Result<()> {
                    if let Some(attempt_id) = attempt_id_for_control.as_deref() {
                        let work_key = item.canonical_key();
                        state_for_control
                            .narrative_maintenance_attempts
                            .mark_work_started(attempt_id, &work_key)?;
                    }
                    Ok(())
                };
                    let attach_run = |ownership: grimodex_db::workspace_lifecycle::RunOwnership| {
                        lifecycle_permit
                            .as_ref()
                            .ok_or_else(|| {
                                anyhow::anyhow!("NEX_MAINTENANCE_LIFECYCLE_PERMIT_MISSING")
                            })?
                            .attach_run_ownership(ownership)
                            .map_err(|error| anyhow::anyhow!("{error}"))
                    };
                    let mark_run_creation_started = |run_id: &str| -> anyhow::Result<()> {
                        *creation_run_id_for_start.lock().map_err(|error| {
                            anyhow::anyhow!("creation tracking lock poisoned: {error}")
                        })? = Some(run_id.to_owned());
                        lifecycle_permit
                            .as_ref()
                            .ok_or_else(|| {
                                anyhow::anyhow!("NEX_MAINTENANCE_LIFECYCLE_PERMIT_MISSING")
                            })?
                            .mark_run_creation_started(run_id)
                            .map_err(|error| anyhow::anyhow!("{error}"))
                    };
                    let mark_run_reuse_selection_unknown =
                        |reservation_run_id: &str, selected_run_id: &str| -> anyhow::Result<()> {
                            *creation_run_id_for_start.lock().map_err(|error| {
                                anyhow::anyhow!("creation tracking lock poisoned: {error}")
                            })? = Some(reservation_run_id.to_owned());
                            lifecycle_permit
                                .as_ref()
                                .ok_or_else(|| {
                                    anyhow::anyhow!("NEX_MAINTENANCE_LIFECYCLE_PERMIT_MISSING")
                                })?
                                .mark_run_reuse_selection_unknown(
                                    reservation_run_id,
                                    selected_run_id,
                                )
                                .map_err(|error| anyhow::anyhow!("{error}"))
                        };
                    let mark_run_creation_outcome =
                |outcome: grimodex_db::workspace_lifecycle::RunCreationTransactionOutcome| {
                    let run_id = creation_run_id_for_outcome
                        .lock()
                        .map_err(|error| anyhow::anyhow!("creation tracking lock poisoned: {error}"))?
                        .clone();
                    if let Some(run_id) = run_id {
                        lifecycle_permit
                            .as_ref()
                            .ok_or_else(|| {
                                anyhow::anyhow!("NEX_MAINTENANCE_LIFECYCLE_PERMIT_MISSING")
                            })?
                            .mark_run_creation_outcome(&run_id, outcome)
                            .map_err(|error| anyhow::anyhow!("{error}"))?;
                    }
                    Ok(())
                };
                    let reset_run_creation_tracking = || -> anyhow::Result<()> {
                        *creation_run_id_for_reset.lock().map_err(|error| {
                            anyhow::anyhow!("creation tracking lock poisoned: {error}")
                        })? = None;
                        Ok(())
                    };
                    let reserve_run =
                        |ownership: grimodex_db::workspace_lifecycle::RunOwnership| {
                            let project_id = ownership.handle.project_id.clone();
                            let database_path = ownership.handle.database_path.clone();
                            let database_file_identity =
                                ownership.handle.database_file_identity.clone();
                            grimodex_db::narrative_extraction::try_reserve_project_creation_in_namespace(
                                &project_lifecycle_namespace,
                                &project_id,
                            )?;
                            lifecycle_permit
                    .as_ref()
                                .ok_or_else(|| {
                                    anyhow::anyhow!("NEX_MAINTENANCE_LIFECYCLE_PERMIT_MISSING")
                                })?
                    .attach_run_ownership(ownership)
                                .map_err(|error| {
                                    grimodex_db::narrative_extraction::release_project_creation_for_handle(
                                        &project_id,
                                        database_path.as_deref(),
                                        database_file_identity.as_deref(),
                                    );
                                    anyhow::anyhow!("{error}")
                                })
                        };
                    let attempt_control = MaintenanceCycleControl {
                        should_stop: &should_stop,
                        stop_signal: stop_signal_for_control.clone(),
                        finalization_granted_signal: finalization_granted_signal_for_control
                            .clone(),
                        defer_preempted_run: &defer_preempted_run,
                        grant_finalize: &grant_finalize,
                        register_work: &register_work,
                        work_started: &work_started,
                        work_completed: &work_completed,
                        work_noop_completed: &work_noop_completed,
                        work_deferred: &work_deferred,
                        attach_run: Some(&attach_run),
                        reserve_run: Some(&reserve_run),
                        mark_run_creation_started: Some(&mark_run_creation_started),
                        mark_run_reuse_selection_unknown: Some(&mark_run_reuse_selection_unknown),
                        mark_run_creation_outcome: Some(&mark_run_creation_outcome),
                        reset_run_creation_tracking: Some(&reset_run_creation_tracking),
                        mark_run_terminalized: None,
                    };
                    let cycle_result = {
                        narrative_extraction::run_system_work_cycle_with_modes_and_config_and_foreground_owner_with_control(
                    authority.db(),
                    &request,
                    |item| {
                        state
                            .narrative_maintenance_recovery_gate
                            .mode_for_binding(request_binding, &item.canonical_key())
                    },
                    ci_config.as_ref(),
                    foreground_owner.as_ref(),
                    Some(&attempt_control),
                )
                    };
                    let result = match cycle_result {
                        Ok(result) => result,
                        Err(error) if is_narrative_maintenance_preemption(&error) => {
                            return if attempt_guard.is_some() {
                                deferred_narrative_maintenance_result(
                                    &state,
                                    attempt_guard.as_mut(),
                                )
                            } else {
                                Err(AppError::Anyhow(error))
                            };
                        }
                        Err(error) => return Err(AppError::Anyhow(error)),
                    };
                    if let Some(guard) = attempt_guard.as_ref() {
                        // Dynamic discovery remains open until the shared cycle has
                        // returned.  Only now may an all-success work set acquire the
                        // attempt-level finalization state; a repeated effective key
                        // discovered after an earlier commit must remain cancellable.
                        guard.close_work_registration().map_err(AppError::Anyhow)?;
                    }
                    // Do not perform the post-cycle workspace revalidation or
                    // recovery-success bookkeeping after a stop has linearized.
                    should_stop()?;
                    // Backfill/Verify/Rebuild progress through several transactions,
                    // so the workspace can be switched mid-cycle. Re-resolve the
                    // active authority under the open lock before treating this
                    // cycle as an ACK: a late cycle pinned to a replaced workspace
                    // must not mark the global recovery gate recovered or remember a
                    // foreground barrier for the new workspace.
                    let current_workspace = match revalidate_narrative_workspace_after_cycle(
                        &state,
                        Arc::clone(&authority),
                        vec![current_snapshot.authority],
                        request_binding,
                        || {},
                    ) {
                        Ok(Some(current_workspace)) => current_workspace,
                        Ok(None) => {
                            return Ok(serde_json::json!({
                                "status": "workspace-unavailable",
                                "reason": "maintenance-workspace-changed-during-cycle",
                            })
                            .to_string())
                        }
                        Err(error) if is_narrative_maintenance_preemption(&error) => {
                            return deferred_narrative_maintenance_result(
                                &state,
                                attempt_guard.as_mut(),
                            )
                        }
                        Err(error) => return Err(error),
                    };
                    let current_authority = &current_workspace.authority;
                    if matches!(
                        result.status,
                        MaintenanceCycleStatus::Accepted | MaintenanceCycleStatus::Coalesced
                    ) {
                        if let Some(config) = ci_config.as_ref() {
                            if config.product_journey_barrier_id.is_some()
                                && config.correlation.is_some()
                            {
                                let barrier =
                            match narrative_extraction::find_running_foreground_system_work_run(
                                current_authority.db(),
                                config,
                                request_binding,
                            ) {
                                Ok(barrier) => barrier,
                                Err(error) if is_narrative_maintenance_preemption(&error) => {
                                    return deferred_narrative_maintenance_result(
                                        &state,
                                        attempt_guard.as_mut(),
                                    )
                                }
                                Err(error) => return Err(AppError::Anyhow(error)),
                            };
                                if let Some(barrier) = barrier {
                                    state
                                        .narrative_maintenance_foreground_barrier
                                        .remember(barrier)?;
                                }
                            }
                        }
                    }
                    let json = serde_json::to_string(&result).map_err(anyhow::Error::from)?;
                    if let Some(guard) = attempt_guard.as_mut() {
                        // Every phase scope has already performed the connection
                        // cleanup proof. Reading process-local health here avoids a
                        // second mutex acquisition after a foreground owner arrives.
                        if !authority.db().connection_reusable() {
                            let reason = authority
                                .db()
                                .connection_unusable_reason()
                                .unwrap_or_else(|| {
                                    "maintenance connection is quarantined".to_string()
                                });
                            return Err(AppError::Anyhow(anyhow::anyhow!(
                                "NEX_MAINTENANCE_CONNECTION_UNUSABLE: {reason}"
                            )));
                        }
                        guard.mark_cleanup_clean(&state).map_err(AppError::Anyhow)?;
                    }
                    // Only a fully validated, serialized, and completed cycle
                    // advances the recovery boundary. Invalid wire data or a failed
                    // adapter keeps the next attempt in StartupRecovery for each
                    // unacknowledged canonical WorkKey in this generation.
                    // Deferred/empty wakes do not mark any identity as recovered.
                    if matches!(
                        result.status,
                        MaintenanceCycleStatus::Accepted | MaintenanceCycleStatus::Coalesced
                    ) {
                        // Cancellation remains admissible until this final
                        // process-local bookkeeping has begun. Do not acknowledge a
                        // key for a cycle whose owner has already been stopped.
                        should_stop()?;
                        for item in &normalized_work {
                            should_stop()?;
                            // Mark the epoch-normalized identity the cycle actually
                            // recovered. If normalization fails, marking is skipped
                            // fail-closed: the key stays in StartupRecovery.
                            match narrative_extraction::recovery_canonical_key(
                                current_authority.db(),
                                item,
                            ) {
                                Ok(recovered_key) => {
                                    state
                                        .narrative_maintenance_recovery_gate
                                        .mark_recovered_for_binding(
                                            request_binding,
                                            &recovered_key,
                                        );
                                }
                                Err(error) => {
                                    if is_narrative_maintenance_preemption(&error) {
                                        return deferred_narrative_maintenance_result(
                                            &state,
                                            attempt_guard.as_mut(),
                                        );
                                    }
                                    tracing::warn!(
                                        target: "narrative.maintenance",
                                        %error,
                                        "failed to normalize recovery key; leaving identity unrecovered"
                                    );
                                }
                            }
                        }
                    }
                    if let Some(guard) = attempt_guard.as_mut() {
                        if matches!(result.status, MaintenanceCycleStatus::Deferred) {
                            // A foreground-held adapter deliberately leaves its
                            // durable Run/Task/Attempt running. Park the exact Native
                            // work execution as interrupted so the main scheduler can
                            // requeue it after the authoring barrier releases; never
                            // turn this status into strict attempt success.
                            guard.finalize_interrupted().map_err(AppError::Anyhow)?;
                        } else {
                            let armed = state
                                .narrative_maintenance_attempts
                                .arm_finalize_success(&guard.attempt_id)
                                .map_err(AppError::Anyhow)?;
                            if !armed {
                                guard.finalize_interrupted().map_err(AppError::Anyhow)?;
                                return Err(AppError::Anyhow(anyhow::anyhow!(
                            "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation won before final attempt publication"
                        )));
                            }
                            let finalized = guard.finalize_success().map_err(AppError::Anyhow)?;
                            if !finalized {
                                return Err(AppError::Anyhow(anyhow::anyhow!(
                            "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation won before finalization"
                        )));
                            }
                        }
                    }
                    Ok(json)
                })()
            })) {
                Ok(result) => result,
                Err(_) => Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_PANIC: maintenance worker panicked"
                ))),
            };
            let operation_result = match operation_result {
                Err(error) if is_narrative_maintenance_preemption(&error) => {
                    Ok(serde_json::json!({
                        "status": "accepted",
                        "hasMore": true,
                        "preempted": true,
                    })
                    .to_string())
                }
                other => other,
            };
            Ok(NarrativeMaintenanceWorkerOutcome {
                result: operation_result,
                lifecycle_permit: lifecycle_permit.take(),
                lifecycle_work_started,
                authority: worker_authority,
                attempt_id: outcome_attempt_id,
                workspace_binding: outcome_binding,
                // Keep the sequence with the supervisor. A delivery is
                // terminal only after Join and any descriptor handoff have
                // completed, otherwise a replay can observe a result that
                // lacks the descriptorId needed to recover the exact Run.
                admitted_delivery_sequence,
            })
        });
        // The supervisor is detached from the N-API caller future. Dropping a
        // Promise or closing a window therefore only drops this awaiter; the
        // Native task still observes Join and performs permit/descriptor and
        // delivery finalization against AppState.
        let supervisor_state = Arc::clone(&state);
        let supervisor = napi::tokio::task::spawn(async move {
            let worker = match worker_join.await {
                Ok(Ok(worker)) => worker,
                Ok(Err(error)) => {
                    let lifecycle_permit = permit_return_slot
                        .lock()
                        .ok()
                        .and_then(|mut slot| slot.take());
                    NarrativeMaintenanceWorkerOutcome {
                        result: Err(error),
                        lifecycle_permit,
                        lifecycle_work_started: true,
                        authority: active_database(&supervisor_state.ws).ok(),
                        attempt_id: requested_attempt_id.clone(),
                        workspace_binding: requested_binding.clone(),
                        admitted_delivery_sequence: admitted_sequence_slot
                            .lock()
                            .ok()
                            .and_then(|slot| *slot),
                    }
                }
                Err(join_error) => {
                    let orphaned_permit = permit_return_slot
                        .lock()
                        .ok()
                        .and_then(|mut slot| slot.take());
                    NarrativeMaintenanceWorkerOutcome {
                        result: Err(AppError::Anyhow(anyhow::anyhow!(
                            "NEX_MAINTENANCE_WORKER_JOIN_FAILED: {join_error}"
                        ))),
                        lifecycle_permit: orphaned_permit,
                        lifecycle_work_started: true,
                        authority: active_database(&supervisor_state.ws).ok(),
                        attempt_id: requested_attempt_id.clone(),
                        workspace_binding: requested_binding.clone(),
                        admitted_delivery_sequence: admitted_sequence_slot
                            .lock()
                            .ok()
                            .and_then(|slot| *slot),
                    }
                }
            };
            let mut worker = worker;
            (|| {
                let mut operation_result = worker.result;
                if let Some(mut permit) = worker.lifecycle_permit {
                    if worker.lifecycle_work_started && operation_result.is_err() {
                        if let Err(error) = &operation_result {
                            tracing::error!(
                                target: "narrative.maintenance",
                                %error,
                                "maintenance body failed after lifecycle Join; transferring ownership to recovery"
                            );
                        }
                        permit
                            .mark_joined()
                            .map_err(|error| Error::from_reason(error.to_string()))?;
                        let connection_retired = retire_authority_for_recovery(
                            &supervisor_state,
                            worker.authority.take(),
                        );
                        if connection_retired {
                            permit
                                .mark_connection_retired()
                                .map_err(|error| Error::from_reason(error.to_string()))?;
                        }
                        match permit.transfer_to_recovery() {
                            Ok(descriptor_id) => {
                                record_maintenance_recovery_binding(
                                    &supervisor_state,
                                    descriptor_id,
                                    worker.attempt_id.as_deref(),
                                    worker.workspace_binding.as_ref(),
                                );
                                operation_result = Ok(serde_json::json!({
                                    "status": "workspace-unavailable",
                                    "reason": "maintenance-recovery-required",
                                    "descriptorId": descriptor_id,
                                })
                                .to_string());
                            }
                            Err(error) => {
                                operation_result = Err(AppError::Anyhow(anyhow::anyhow!(
                                    "NEX_MAINTENANCE_LIFECYCLE_RECOVERY_TRANSFER_FAILED: {error}"
                                )));
                            }
                        }
                    } else {
                        permit
                            .mark_joined()
                            .and_then(|_| permit.release().map(|_| ()))
                            .map_err(|error| Error::from_reason(error.to_string()))?;
                    }
                }
                if let Some(sequence) = worker.admitted_delivery_sequence {
                    let terminal_result = match &operation_result {
                        Ok(result) => result.clone(),
                        Err(_) => serde_json::json!({
                            "status": "workspace-unavailable",
                            "reason": "maintenance-native-error",
                        })
                        .to_string(),
                    };
                    // Every accepted delivery reaches a terminal transport
                    // record only after the outer supervisor has observed Join
                    // and transferred any remaining durable responsibility.
                    // ACK still retires transport state only; it never settles
                    // an unfinished Run or descriptor.
                    if let Err(error) = supervisor_state
                        .workspace_lifecycle
                        .mark_delivery_terminal_with_result(sequence, terminal_result)
                    {
                        operation_result = Err(AppError::Anyhow(anyhow::anyhow!(error)));
                    }
                }
                operation_result.map_err(app_err_to_napi)
            })()
        });
        supervisor.await.map_err(join_err_to_napi)?
    }

    /// ACK only the Native delivery record after main has applied the
    /// structurally validated terminal result.  This retires transport state;
    /// it does not settle an unfinished Run or recovery descriptor.
    #[napi]
    pub async fn ack_narrative_maintenance_delivery(&self, sequence: u32) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let retired = state
                .workspace_lifecycle
                .ack_delivery(DeliverySequence::new(u64::from(sequence)))?;
            Ok(serde_json::json!({
                "status": if retired { "retired" } else { "pending" },
                "sequence": sequence,
            })
            .to_string())
        })
        .await
    }

    /// Resolve a lost admission reply without allocating another delivery
    /// record.  Main may fence only the current H+1 sequence.
    #[napi]
    pub async fn resolve_narrative_maintenance_delivery(&self, sequence: u32) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let result = state
                .workspace_lifecycle
                .resolve_or_fence(DeliverySequence::new(u64::from(sequence)))?;
            Ok(serde_json::to_string(&result)
                .map_err(anyhow::Error::from)?
                .to_string())
        })
        .await
    }

    /// Persist a scheduler delivery failure before Electron drops its
    /// process-local identity. The receipt is append-only and workspace-scoped
    /// so a later process can surface the exact failed trigger during startup.
    #[napi]
    pub async fn record_narrative_maintenance_delivery_failure(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let _mutation_guard = state
                .narrative_maintenance_mutation_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let invalid = |message: &str| AppError::Anyhow(anyhow::anyhow!("{message}"));
            let object = payload.as_object().ok_or_else(|| {
                invalid("NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: payload must be an object")
            })?;
            if object
                .get("schemaVersion")
                .and_then(serde_json::Value::as_u64)
                != Some(1)
            {
                return Err(invalid(
                    "NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: schemaVersion must be 1",
                ));
            }
            let scope = object
                .get("scope")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    invalid("NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: scope is required")
                })?;
            if !matches!(scope, "work" | "wake") {
                return Err(invalid(
                    "NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: scope is unsupported",
                ));
            }
            let project_id = object
                .get("projectId")
                .and_then(serde_json::Value::as_str)
                .filter(|value| {
                    !value.trim().is_empty()
                        && !value.contains('\0')
                        && !value.contains('/')
                        && !value.contains('\\')
                })
                .ok_or_else(|| {
                    invalid("NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: projectId is invalid")
                })?;
            let retry_count = object
                .get("retryCount")
                .and_then(serde_json::Value::as_u64)
                .filter(|value| *value > 0 && *value <= 1_000_000)
                .ok_or_else(|| {
                    invalid("NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: retryCount is invalid")
                })?;
            let error = object
                .get("error")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.trim().is_empty() && value.len() <= 16 * 1024)
                .ok_or_else(|| {
                    invalid("NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: error is invalid")
                })?;
            if scope == "work" {
                let run_kind = object
                    .get("runKind")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        invalid(
                            "NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: work runKind is required",
                        )
                    })?;
                if !matches!(
                    run_kind,
                    "backfill" | "dependency-verify" | "semantic-index-rebuild"
                ) {
                    return Err(invalid(
                        "NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: runKind is not automatic",
                    ));
                }
                object
                    .get("workKey")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.trim().is_empty() && value.len() <= 4096)
                    .ok_or_else(|| {
                        invalid("NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: workKey is required")
                    })?;
            }
            let workspace_binding = object
                .get("workspaceBinding")
                .filter(|binding| !binding.is_null())
                .ok_or_else(|| {
                    invalid(
                        "NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: workspaceBinding is required",
                    )
                })?;
            let requested_binding: MaintenanceWorkspaceBinding =
                serde_json::from_value(workspace_binding.clone()).map_err(|_| {
                    invalid("NEX_MAINTENANCE_DELIVERY_FAILURE_INVALID: workspaceBinding is invalid")
                })?;
            requested_binding.validate().map_err(AppError::Anyhow)?;

            // A receipt is an ACK boundary, not a best-effort audit line.
            // Hold the same open barrier that protects normal maintenance
            // execution and compare the submitted binding to the live
            // authority immediately before both durable writes. A stale
            // Electron scheduler receives a typed non-ACK and must retain its
            // original work rather than attributing it to a replacement DB.
            let _workspace_open_guard = state
                .ws
                .open_lock
                .lock()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
            let authority = match active_database(&state.ws) {
                Ok(authority) => authority,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                    })
                    .to_string())
                }
                Err(error) => return Err(error),
            };
            let current_binding = narrative_maintenance_binding_for_authority(&state, &authority);
            if current_binding != requested_binding {
                return Ok(serde_json::json!({
                    "status": "workspace-binding-mismatch",
                })
                .to_string());
            }
            let workspace_path = authority.path().to_path_buf();
            let receipt_id = Uuid::new_v4().to_string();
            let recorded_at = grimodex_core::now_rfc3339_millis();
            let directory = workspace_path.join(".grimodex");
            std::fs::create_dir_all(&directory)
                .map_err(|error| AppError::Anyhow(anyhow::Error::from(error)))?;
            let path = directory.join("narrative-maintenance-delivery-failures.jsonl");
            let record = serde_json::json!({
                "schemaVersion": 1,
                "receiptId": receipt_id,
                "recordedAt": recorded_at,
                "scope": scope,
                "projectId": project_id,
                "retryCount": retry_count,
                "error": error,
                "payload": payload,
            });
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .map_err(|error| AppError::Anyhow(anyhow::Error::from(error)))?;
            serde_json::to_writer(&mut file, &record)
                .map_err(|error| AppError::Anyhow(anyhow::Error::from(error)))?;
            file.write_all(b"\n")
                .map_err(|error| AppError::Anyhow(anyhow::Error::from(error)))?;
            file.sync_data()
                .map_err(|error| AppError::Anyhow(anyhow::Error::from(error)))?;
            // The JSONL record is the durable audit receipt; the native
            // outbox is the durable recovery trigger. Return `accepted` only
            // after both have completed. A crash between them may duplicate a
            // receipt on retry, but cannot make Electron drop work without a
            // durable rediscovery path.
            narrative_extraction::record_maintenance_delivery_failure_wake(
                authority.db(),
                project_id,
            )
            .map_err(AppError::Anyhow)?;
            Ok(serde_json::json!({
                "status": "accepted",
                "receiptId": record["receiptId"],
            })
            .to_string())
        })
        .await
    }

    /// Main-owned pre-response claim for one exact foreground product-journey
    /// Run. This only proves that the current authority owns a matching
    /// running marker and remembers it for the delayed release; it never
    /// changes the durable Run status. A false/malformed/error result at the
    /// Electron boundary must therefore arm no timer.
    #[napi]
    pub async fn claim_narrative_maintenance_foreground_barrier(
        &self,
        project_id: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            if project_id.trim().is_empty() {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_PROJECT_REQUIRED: projectId is required"
                )));
            }
            let Some(config) = state.narrative_maintenance_ci_seam.config() else {
                return Ok(serde_json::json!({ "status": "ignored" }).to_string());
            };
            if config.trigger != Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake)
                || config.product_journey_barrier_id.is_none()
                || config.correlation.is_none()
            {
                return Ok(serde_json::json!({ "status": "ignored" }).to_string());
            }
            // Serialize the exact claim/release boundary with open/restore.
            // `open_workspace` takes this lock before publishing a replacement
            // authority, so a swap cannot occur between the final pin check
            // and the durable barrier operation.
            let _workspace_open_guard = state
                .ws
                .open_lock
                .lock()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
            let authority = match active_database(&state.ws) {
                Ok(authority) => authority,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                    })
                    .to_string());
                }
                Err(error) => return Err(error),
            };
            let current_snapshot = match active_workspace_snapshot(&state.ws) {
                Ok(snapshot) => snapshot,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                    })
                    .to_string());
                }
                Err(error) => return Err(error),
            };
            if !Arc::ptr_eq(&authority, &current_snapshot.authority) {
                return Ok(serde_json::json!({
                    "status": "workspace-unavailable",
                    "reason": "maintenance-workspace-binding-mismatch",
                })
                .to_string());
            }
            let binding = narrative_maintenance_binding_for_authority(&state, &authority);
            let durable = narrative_extraction::find_running_foreground_system_work_run(
                authority.db(),
                &config,
                &binding,
            )?
            .filter(|barrier| barrier.project_id == project_id);
            let Some(durable) = durable else {
                return Ok(serde_json::json!({ "status": "not-held" }).to_string());
            };
            let pending = state
                .narrative_maintenance_foreground_barrier
                .pending_for_run_and_binding(
                    &durable.run_id,
                    &project_id,
                    &binding.authority_id,
                    binding.generation,
                    config
                        .product_journey_barrier_id
                        .as_deref()
                        .ok_or_else(|| {
                            AppError::Anyhow(anyhow::anyhow!("foreground barrier id is required"))
                        })?,
                    config.correlation.as_deref().ok_or_else(|| {
                        AppError::Anyhow(anyhow::anyhow!("foreground correlation is required"))
                    })?,
                );
            let barrier = match pending {
                Some(pending) if pending == durable => pending,
                Some(_) => {
                    return Ok(serde_json::json!({
                        "status": "not-held",
                    })
                    .to_string());
                }
                None => durable,
            };
            if barrier.project_id != project_id
                || barrier.marker.authority_id != binding.authority_id
                || barrier.marker.generation != binding.generation
            {
                return Ok(serde_json::json!({
                    "status": "workspace-unavailable",
                    "reason": "maintenance-workspace-binding-mismatch",
                })
                .to_string());
            }
            if barrier.marker.product_journey_barrier_id
                != config
                    .product_journey_barrier_id
                    .as_deref()
                    .unwrap_or_default()
                || barrier.marker.correlation != config.correlation.as_deref().unwrap_or_default()
            {
                return Ok(serde_json::json!({
                    "status": "not-held",
                })
                .to_string());
            }
            // Re-pin immediately before storing the claim. The release path
            // repeats this check, so a swap between claim and timer remains
            // fail-closed and cannot complete an old authority's Run.
            let latest_snapshot = match active_workspace_snapshot(&state.ws) {
                Ok(snapshot) => snapshot,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                    })
                    .to_string());
                }
                Err(error) => return Err(error),
            };
            let latest_binding = state
                .narrative_maintenance_recovery_gate
                .binding_for_authority(&narrative_authority_id(&latest_snapshot.authority));
            if !Arc::ptr_eq(&authority, &latest_snapshot.authority) || latest_binding != binding {
                return Ok(serde_json::json!({
                    "status": "workspace-unavailable",
                    "reason": "maintenance-workspace-binding-mismatch",
                })
                .to_string());
            }
            state
                .narrative_maintenance_foreground_barrier
                .remember(barrier.clone())?;
            Ok(serde_json::json!({
                "status": "claimed",
                "runId": barrier.run_id,
            })
            .to_string())
        })
        .await
    }

    /// Main-owned post-response release for one exact foreground product
    /// journey Run. The ordinary tree_node_patch has already committed before
    /// main schedules this call. The expected Run id is mandatory: a delayed
    /// callback from phase A must never complete a same-marker phase B Run.
    /// A failed transaction leaves the process-local barrier pending; a later
    /// patch retries it, while a restart can rediscover the durable marker from
    /// SQLite.
    #[napi]
    pub async fn release_narrative_maintenance_foreground_barrier(
        &self,
        project_id: String,
        expected_run_id: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            if project_id.trim().is_empty() || project_id != project_id.trim() {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_PROJECT_REQUIRED: projectId must be non-empty and trimmed"
                )));
            }
            if expected_run_id.trim().is_empty() || expected_run_id != expected_run_id.trim() {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_RUN_REQUIRED: expectedRunId must be non-empty and trimmed"
                )));
            }
            let Some(config) = state.narrative_maintenance_ci_seam.config() else {
                return Ok(serde_json::json!({ "status": "ignored" }).to_string());
            };
            if config.trigger != Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake)
                || config.product_journey_barrier_id.is_none()
                || config.correlation.is_none()
            {
                return Ok(serde_json::json!({ "status": "ignored" }).to_string());
            }
            let _workspace_open_guard = state
                .ws
                .open_lock
                .lock()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
            let Some(product_journey_barrier_id) = config.product_journey_barrier_id.as_deref()
            else {
                return Ok(serde_json::json!({ "status": "ignored" }).to_string());
            };
            let Some(correlation) = config.correlation.as_deref() else {
                return Ok(serde_json::json!({ "status": "ignored" }).to_string());
            };
            let authority = match active_database(&state.ws) {
                Ok(authority) => authority,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                    })
                    .to_string());
                }
                Err(error) => return Err(error),
            };
            let current_snapshot = match active_workspace_snapshot(&state.ws) {
                Ok(snapshot) => snapshot,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                    })
                    .to_string());
                }
                Err(error) => return Err(error),
            };
            if !Arc::ptr_eq(&authority, &current_snapshot.authority) {
                return Ok(serde_json::json!({
                    "status": "workspace-unavailable",
                    "reason": "maintenance-workspace-binding-mismatch",
                })
                .to_string());
            }
            let binding = narrative_maintenance_binding_for_authority(&state, &authority);
            let durable = narrative_extraction::find_running_foreground_system_work_run(
                authority.db(),
                &config,
                &binding,
            )?
            .filter(|barrier| {
                barrier.project_id == project_id && barrier.run_id == expected_run_id
            });
            let Some(durable) = durable else {
                return Ok(serde_json::json!({ "status": "not-held" }).to_string());
            };
            let pending = state
                .narrative_maintenance_foreground_barrier
                .pending_for_run_and_binding(
                    &expected_run_id,
                    &project_id,
                    &binding.authority_id,
                    binding.generation,
                    product_journey_barrier_id,
                    correlation,
                );
            let barrier = match pending {
                Some(pending) if pending == durable => pending,
                Some(_) => {
                    return Ok(serde_json::json!({
                        "status": "not-held",
                    })
                    .to_string());
                }
                None => durable,
            };
            if barrier.marker.authority_id != binding.authority_id
                || barrier.marker.generation != binding.generation
            {
                return Ok(serde_json::json!({
                    "status": "workspace-unavailable",
                    "reason": "maintenance-workspace-binding-mismatch",
                })
                .to_string());
            }
            if barrier.marker.product_journey_barrier_id
                != product_journey_barrier_id
                || barrier.marker.correlation != correlation
            {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_SYSTEM_WORK_BARRIER_MARKER_MISMATCH: pending marker does not match active product journey"
                )));
            }
            // Re-pin the authority immediately before the terminal write. A
            // workspace swap that raced the delayed callback must never let a
            // held Run from the old binding be released through the new one.
            let latest_snapshot = match active_workspace_snapshot(&state.ws) {
                Ok(snapshot) => snapshot,
                Err(
                    AppError::NoWorkspace | AppError::WorkspaceSwitching | AppError::SafeModeActive,
                ) => {
                    return Ok(serde_json::json!({
                        "status": "workspace-unavailable",
                    })
                    .to_string());
                }
                Err(error) => return Err(error),
            };
            let latest_binding = state
                .narrative_maintenance_recovery_gate
                .binding_for_authority(&narrative_authority_id(&latest_snapshot.authority));
            if !Arc::ptr_eq(&authority, &latest_snapshot.authority)
                || latest_binding != binding
            {
                return Ok(serde_json::json!({
                    "status": "workspace-unavailable",
                    "reason": "maintenance-workspace-binding-mismatch",
                })
                .to_string());
            }
            state
                .narrative_maintenance_foreground_barrier
                .remember(barrier.clone())?;
            narrative_extraction::complete_foreground_system_work_run(authority.db(), &barrier)?;
            state
                .narrative_maintenance_foreground_barrier
                .clear_if_run(&barrier.run_id);
            Ok(serde_json::json!({
                "status": "completed",
                "runId": barrier.run_id,
            })
            .to_string())
        })
        .await
    }

    /// drizzle-proxy (src/db/client.ts) の唯一の通り道 (§4.3 — これだけで
    /// CRUD の 9 割が生きる)。`params` は位置パラメータの JSON 配列、`method`
    /// は "run" | "get" | "all" | "values"。
    /// 返り値: mainが消費する内部種別marker付きのJSON文字列。mainはrendererへ
    /// 渡す前に `__grimodexDbResultKind` を除去する。
    #[napi]
    pub async fn db_execute(
        &self,
        sql: String,
        params: serde_json::Value,
        method: String,
        caller_identity: Option<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        let caller_identity = caller_identity_from_wire(caller_identity)?;
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let dispatch = state
                .profile_egress
                .begin_dispatch(caller_identity.as_ref())
                .map_err(AppError::Anyhow)?;
            let workspace =
                pin_profile_egress_workspace(&state, &dispatch, caller_identity.as_ref())?;
            let params = params_array(params)?;
            let restricted = state.profile_egress.status().restricted;
            reauthorize_profile_egress_workspace(
                &state,
                &dispatch,
                caller_identity.as_ref(),
                &workspace,
            )?;
            let execution = if restricted {
                workspace
                    .authority
                    .db()
                    .execute_renderer_profile_egress_with_result(&sql, &params, &method)?
            } else {
                // Keep direct standalone Backend use compatible before the
                // explicit first-restricted-publication transition.
                workspace
                    .authority
                    .db()
                    .execute_renderer_with_result(&sql, &params, &method)?
            };
            let reauthorization = reauthorize_profile_egress_workspace(
                &state,
                &dispatch,
                caller_identity.as_ref(),
                &workspace,
            );
            Ok(finish_profile_egress_db_dispatch(
                reauthorization,
                execution.rows,
                execution.statement_may_mutate,
            )?)
        })
        .await
    }

    /// 複数文を単一トランザクションで実行 (BEGIN IMMEDIATE、途中失敗で全
    /// ROLLBACK — grimodex-db の `execute_batch_tx`)。オートセーブの通り道。
    /// `statements` は `[{ sql, params, method }, …]`。
    /// 返り値: 最終文のrowsと、mainが消費する内部種別markerを載せたJSON文字列。
    #[napi]
    pub async fn db_execute_batch(
        &self,
        statements: serde_json::Value,
        caller_identity: Option<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        let caller_identity = caller_identity_from_wire(caller_identity)?;
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let dispatch = state
                .profile_egress
                .begin_dispatch(caller_identity.as_ref())
                .map_err(AppError::Anyhow)?;
            let workspace =
                pin_profile_egress_workspace(&state, &dispatch, caller_identity.as_ref())?;
            let statements: Vec<BatchStatement> = from_wire("statements", statements)?;
            let restricted = state.profile_egress.status().restricted;
            reauthorize_profile_egress_workspace(
                &state,
                &dispatch,
                caller_identity.as_ref(),
                &workspace,
            )?;
            let execution = if restricted {
                workspace
                    .authority
                    .db()
                    .execute_batch_tx_renderer_profile_egress_with_result(&statements)?
            } else {
                // Keep direct standalone Backend use compatible before the
                // explicit first-restricted-publication transition.
                workspace
                    .authority
                    .db()
                    .execute_batch_tx_renderer_with_result(&statements)?
            };
            let reauthorization = reauthorize_profile_egress_workspace(
                &state,
                &dispatch,
                caller_identity.as_ref(),
                &workspace,
            );
            Ok(finish_profile_egress_db_dispatch(
                reauthorization,
                execution.rows,
                execution.statement_may_mutate,
            )?)
        })
        .await
    }

    /// Read Native-owned Narrative runtime policy (Release Gate B Foundation).
    #[napi]
    pub async fn narrative_runtime_policy_get(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let policy = grimodex_db::load_narrative_runtime_policy_from_db(db)?;
                Ok(serde_json::to_string(&serde_json::json!({
                    "runtimeMode": policy.runtime_mode.as_str(),
                    "maintenanceEnabled": policy.maintenance_enabled,
                    "genericImportEnabled": policy.generic_import_enabled,
                    "backgroundAiEnabled": policy.background_ai_enabled,
                    "version": policy.version,
                    "effectiveMode": policy.effective_mode().as_str(),
                    "maintenancePreviewAllowed": policy.maintenance_preview_allowed(),
                }))?)
            })
        })
        .await
    }

    /// CAS update for Native-owned Narrative runtime policy.
    #[napi]
    pub async fn narrative_runtime_policy_set(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let input: grimodex_db::SetNarrativeRuntimePolicyInput = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let policy = grimodex_db::set_narrative_runtime_policy(db, input)?;
                Ok(serde_json::to_string(&serde_json::json!({
                    "runtimeMode": policy.runtime_mode.as_str(),
                    "maintenanceEnabled": policy.maintenance_enabled,
                    "genericImportEnabled": policy.generic_import_enabled,
                    "backgroundAiEnabled": policy.background_ai_enabled,
                    "version": policy.version,
                    "effectiveMode": policy.effective_mode().as_str(),
                    "maintenancePreviewAllowed": policy.maintenance_preview_allowed(),
                }))?)
            })
        })
        .await
    }

    /// Typed persistence commands for Editor-only visual stickies. The
    /// renderer sends document-shaped DTOs; SQL and typed owner derivation
    /// stay inside grimodex-db.
    #[napi]
    pub async fn editor_sticky_list(
        &self,
        project_id: String,
        document_key: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&editor_stickies::list(
                    db,
                    project_id,
                    document_key,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn editor_sticky_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: editor_stickies::CreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&editor_stickies::create(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn editor_sticky_update(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: editor_stickies::UpdatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&editor_stickies::update(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn editor_sticky_delete(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: editor_stickies::DeletePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| editor_stickies::delete(db, payload))
        })
        .await
    }

    /// Project-scoped lint diagnostic ignore-list commands. The renderer
    /// receives a domain DTO instead of owning SQL strings or generic DB
    /// parameters; all scene ownership checks happen in grimodex-db.
    #[napi]
    pub async fn lint_ignore_list(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                lint_ignores::encode(lint_ignores::list_for_project(db, project_id)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_ignore_list_scene(
        &self,
        project_id: String,
        scene_id: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                lint_ignores::encode(lint_ignores::list_for_scene(db, project_id, scene_id)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_ignore_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                lint_ignores::encode(lint_ignores::create(db, payload)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_ignore_delete(&self, project_id: String, id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| lint_ignores::delete(db, project_id, id))
        })
        .await
    }

    #[napi]
    pub async fn lint_ignore_copy(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CopyPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                lint_ignores::encode(lint_ignores::copy(db, payload)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_ignore_move(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: MovePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                lint_ignores::encode(lint_ignores::move_to_scene(db, payload)?)
            })
        })
        .await
    }

    /// Project-scoped term-dictionary commands. SQL and project ownership stay
    /// in grimodex-db; the renderer only sends domain DTOs.
    #[napi]
    pub async fn lint_term_dictionary_list(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                lint_terms::encode(lint_terms::list(db, project_id)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_term_dictionary_insert(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: LintTermInsertPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                lint_terms::encode(lint_terms::insert(db, payload)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_term_dictionary_update(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: LintTermUpdatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                lint_terms::encode(lint_terms::update(db, payload)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_term_dictionary_set_enabled(
        &self,
        project_id: String,
        id: String,
        enabled: bool,
        updated_at: i64,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                lint_terms::encode(lint_terms::set_enabled(
                    db, project_id, id, enabled, updated_at,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn lint_term_dictionary_delete(&self, project_id: String, id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| lint_terms::delete(db, project_id, id)))
            .await
    }

    /// Chronicle aggregate OCC reads and participant replacement. The latter
    /// advances the event version and replaces participants in one DB tx.
    #[napi]
    pub async fn event_get_version(&self, project_id: String, event_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&chronicle::get_event_version(
                    db, project_id, event_id,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn event_set_participants(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: SetParticipantsPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&chronicle::set_event_participants(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    /// Project Calendar create/update, single-row OCC (see `chronicle` module
    /// docs). Returns the persisted row as JSON, or JSON `null` on conflict.
    #[napi]
    pub async fn project_calendar_upsert(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: UpsertProjectCalendarPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&chronicle::upsert_project_calendar(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    /// Renderer domain aggregates that previously crossed the preload
    /// boundary as renderer-authored SQL batches.
    #[napi]
    pub async fn authorship_replace_lane(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ReplaceAuthorshipLanePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                domain_writes::replace_authorship_lane(db, payload)
            })
        })
        .await
    }

    #[napi]
    pub async fn entity_tags_set(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: SetEntityTagsPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| domain_writes::set_entity_tags(db, payload))
        })
        .await
    }

    #[napi]
    pub async fn codex_rename_undo(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CodexRenameUndoPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::undo_codex_rename(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn codex_rename_apply(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CodexRenameApplyPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::apply_codex_rename(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn scan_staging_project_create(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: CreateScanStagingProjectPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                domain_writes::create_scan_staging_project(db, payload)
            })
        })
        .await
    }

    #[napi]
    pub async fn scan_staging_project_publish(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ScanStagingProjectPublishPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &domain_writes::publish_scan_staging_project(db, payload)?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn project_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ProjectCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::project_create(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn project_patch(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ProjectPatchPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::project_patch(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn project_delete(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ProjectDeletePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| domain_writes::project_delete(db, payload))
        })
        .await
    }

    #[napi]
    pub async fn ai_tree_plan_apply(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ApplyAiTreePlanPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::apply_ai_tree_plan(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn ai_tree_plan_undo(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: UndoAiTreePlanPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&domain_writes::undo_ai_tree_plan(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    #[napi]
    pub async fn tree_node_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload: TreeNodeCreatePayload, context| {
                domain_writes::tree_node_create_with_authority(db, payload, Some(context))
            },
        )
        .await
    }

    #[napi]
    pub async fn tree_node_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload: TreeNodeDeletePayload, context| {
                domain_writes::tree_node_delete_with_authority(db, payload, Some(context))
            },
        )
        .await
    }

    #[napi]
    pub async fn tree_node_patch(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload: TreeNodePatchPayload, context| {
                domain_writes::tree_node_patch_with_authority(db, payload, Some(context))
            },
        )
        .await
    }

    #[napi]
    pub async fn temporal_scene_patch(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let temporal_payload: TemporalScenePatchPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::temporal_scene_patch(db, temporal_payload)?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn map_write_bundle(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: MapWritePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&map_writes::apply_map_write(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    /// Project snapshots are a typed aggregate: renderer computes the
    /// dependency-safe row plan while shared Rust owns all SQL, project
    /// ownership checks, and transaction boundaries.
    #[napi]
    pub async fn project_snapshot_create(&self, payload: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let payload: CreateProjectSnapshotPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                project_snapshots::create_project_snapshot(db, payload)
            })
        })
        .await
    }

    #[napi]
    pub async fn project_snapshot_restore_context(
        &self,
        project_id: String,
        snapshot_id: String,
        scopes: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let scopes: Vec<RestoreScope> = from_wire("scopes", scopes)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &project_snapshots::project_snapshot_restore_context(
                        db,
                        project_id,
                        snapshot_id,
                        scopes,
                    )?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn project_snapshot_apply_restore(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let payload: ApplyProjectSnapshotRestorePayload = from_wire("payload", payload)?;
            let project_id = payload.project_id.clone();
            let request_id = payload.request_id.clone();
            let _mutation_guard = state
                .narrative_maintenance_mutation_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // Snapshot restore mutates the active workspace over several
            // steps and then reports success against its binding. Serialize
            // the whole restore with workspace open/switch: a concurrent
            // switch must never observe a restore committed into the old
            // workspace after the new one became active, nor a success
            // response bound to a replaced authority.
            let _workspace_open_guard = state
                .ws
                .open_lock
                .lock()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
            let authority = active_database(&state.ws)?;
            let binding = narrative_maintenance_binding_for_authority(&state, &authority);
            let (result, replayed) = {
                let db = authority.db();
                let replayed =
                    idempotency_receipt_exists(db, "project_snapshot_restore", &request_id)?;
                let result = project_snapshots::apply_project_snapshot_restore(db, payload)?;
                (result, replayed)
            };
            if should_emit_narrative_epoch_rotated(replayed, !result.no_op) {
                emit_narrative_epoch_rotated(
                    &state,
                    &binding,
                    &project_id,
                    "project-snapshot-restore",
                );
            }
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Restore one persisted Scene revision. Safety revision, OCC body write,
    /// canonical audit event, Narrative Change Feed, and retry receipt share
    /// one Native transaction.
    #[napi]
    pub async fn revision_scene_restore(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let payload: RestoreSceneRevisionPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = revision_restore::restore_scene_revision(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// Scene content and every document-derived sidecar are committed in one
    /// SQLite transaction. The renderer performs one PM traversal and passes
    /// the typed snapshot as camelCase JSON.
    #[napi]
    pub async fn save_scene_body_bundle(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let payload: SaveSceneBodyBundlePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = scene_body::save_scene_body_bundle(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// CI-only deterministic runtime fixture writer. The per-launch owner
    /// token makes the command fail closed outside the performance harness;
    /// the shared DB layer validates and commits the typed graph in one tx.
    #[napi]
    pub async fn runtime_performance_seed(
        &self,
        owner_token: String,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            validate_runtime_performance_owner_token(&owner_token)?;
            runtime_performance_seed::validate_runtime_performance_seed_wire_value(&payload)?;
            let payload: RuntimePerformanceSeedPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result =
                    runtime_performance_seed::seed_runtime_performance_fixture(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// Compact the active workspace in place. Unlike raw renderer SQL, this
    /// command accepts no destination path and cannot become `VACUUM INTO`.
    #[napi]
    pub async fn vacuum_database(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            with_db_state(&state.ws, |db| db.vacuum())
        })
        .await
    }

    /// workspace を開く: migrate → swap → RAII SwitchingGuard →
    /// authority commit 後の低優先度 maintenance worker →
    /// recent-workspaces 更新 (`grimodex_db::open::open_workspace_sync` —
    /// Tauri コマンドと同一経路。A3 相互運用の根拠)。swap直後hookで
    /// Codex matcher破棄 + semantic 4cache epoch rotateを行う。
    /// 完了時に `workspace:opened` (FE 購読者なしのデバッグチャネル) を emit
    /// する (§7.1 の end-to-end 実証チャネルその 2)。
    /// 返り値: WorkspaceOpenOutcome JSON
    /// (`ready`/`migrated`/`recovery-required`/`safe-mode`)。
    #[napi]
    pub async fn open_workspace(&self, path: String) -> Result<String> {
        preflight_workspace_open_target(&path).map_err(app_err_to_napi)?;
        let _workspace_operation = self
            .state
            .begin_workspace_operation()
            .map_err(|error| app_err_to_napi(AppError::Anyhow(error)))?;
        let recovery_descriptor =
            workspace_transition_recovery_for_open(&self.state, &path).map_err(app_err_to_napi)?;
        if let Some(not_admitted) = begin_workspace_lifecycle_transition_wire_for_recovery(
            &self.state,
            AdmissionKind::Open,
            recovery_descriptor,
        )
        .map_err(app_err_to_napi)?
        {
            return Ok(not_admitted);
        }
        let state = Arc::clone(&self.state);
        let trace_enabled = native_workspace_open_trace_enabled();
        let trace_started_at = Instant::now();
        let mut trace = NativeWorkspaceOpenTrace::with_start(trace_started_at, trace_enabled);
        let blocking_pool_span = trace.begin_span(NativeWorkspaceOpenSpanName::BlockingPoolWait);
        let task = napi::tokio::task::spawn_blocking(move || {
            // The real workspace `open_lock` is acquired by the shared open
            // worker below.  Keep the core-side physical marker for the same
            // worker interval so no lifecycle path can publish/claim a
            // competing protected operation before this worker returns.
            let _physical_exclusive = match state
                .workspace_lifecycle
                .acquire_transition_physical_exclusive()
            {
                Ok(exclusive) => exclusive,
                Err(error) => return (trace, Err(error)),
            };
            trace.finish_span(blocking_pool_span);
            let state_for_hook = Arc::clone(&state);
            let workspace_binding = path.clone();
            let mut on_swapped = move |trace: &mut NativeWorkspaceOpenTrace| {
                rotate_ime_workspace_traced(&state_for_hook, Some(trace));
                state_for_hook
                    .profile_egress
                    .bind_workspace(Some(workspace_binding.clone()));

                let matcher_span = trace.begin_span(NativeWorkspaceOpenSpanName::MatcherLockWait);
                let mut matcher = match state_for_hook.codex_matcher.lock() {
                    Ok(matcher) => matcher,
                    Err(poisoned) => poisoned.into_inner(),
                };
                trace.finish_span(matcher_span);
                *matcher = None;

                let semantic_span = trace.begin_span(NativeWorkspaceOpenSpanName::SemanticRotate);
                state_for_hook.semantic.rotate_workspace_epoch();
                trace.finish_span(semantic_span);
                state_for_hook
                    .narrative_maintenance_recovery_gate
                    .mark_workspace_swapped();
            };
            let mut admission_guard =
                NarrativeMaintenanceAdmissionReopenGuard::new(Arc::clone(&state));
            let mut before_swap = || {
                let owns_close = close_narrative_maintenance_for_workspace_swap(&state, true)?;
                if owns_close {
                    admission_guard.arm();
                }
                #[cfg(test)]
                if owns_close {
                    state
                        .narrative_maintenance_recovery_gate
                        .panic_after_admission_close_for_test();
                }
                Ok(())
            };
            let opened_result = catch_unwind(AssertUnwindSafe(|| {
                open_workspace_sync_traced_with_pre_swap(
                    &state.ws,
                    &state.gs,
                    &path,
                    &mut trace,
                    &mut on_swapped,
                    Some(&mut before_swap),
                )
            }));
            // End the closure's `&mut` borrows of the admission guard and
            // traces before the post-open match reuses them. (`drop` on a
            // non-`Drop` closure is rejected by clippy; a move ends the
            // borrow region the same way.)
            let _ = before_swap;
            let result = match opened_result {
                Ok(Ok(opened)) => finish_workspace_open_success(
                    &state,
                    &path,
                    opened,
                    &mut trace,
                    &mut admission_guard,
                ),
                Ok(Err(error)) => {
                    // The pre-swap admission close also covers errors before
                    // authority publication. Reopen against whichever old
                    // binding is still active so a failed open cannot strand
                    // all future maintenance begins behind a closed gate.
                    match admission_guard.complete_admission_handoff() {
                        Ok(()) => Err(error),
                        Err(reopen_error) => Err(reopen_error),
                    }
                }
                Err(_) => {
                    let reopen_result = admission_guard.complete_admission_handoff();
                    match reopen_result {
                        Ok(()) => {
                            // Return the panic as a worker outcome. The outer
                            // supervisor publishes RecoveryRequired only after
                            // this blocking closure has joined; this branch
                            // must never fabricate Join/activation from inside
                            // the still-running worker.
                            match recover_workspace_open_lock_after_panic(&state) {
                                Ok(()) => Err(AppError::Anyhow(anyhow::anyhow!(
                                    "NEX_WORKSPACE_OPEN_PANIC: workspace open panicked"
                                ))),
                                Err(error) => Err(error),
                            }
                        }
                        Err(error) => Err(AppError::Anyhow(anyhow::anyhow!(
                            "NEX_WORKSPACE_OPEN_PANIC_REOPEN_FAILED: {error}"
                        ))),
                    }
                }
            };
            (trace, result)
        })
        .await;

        // Once the blocking opener has returned an error, the supervisor has
        // no proof that the old authority remained untouched.  JoinError,
        // panic, and an ordinary post-admission error all take the same
        // fail-closed RecoveryRequired projection; error text is not a
        // lifecycle classifier.
        let needs_recovery;
        let result = match task {
            Ok((mut trace, result)) => {
                needs_recovery = result.is_err();
                let terminal = if result.is_ok() {
                    NativeWorkspaceOpenResult::Ready
                } else {
                    NativeWorkspaceOpenResult::Failed
                };
                trace.emit_terminal(terminal);
                result.map_err(app_err_to_napi)
            }
            Err(error) => {
                needs_recovery = true;
                let mut trace =
                    NativeWorkspaceOpenTrace::with_start(trace_started_at, trace_enabled);
                trace.emit_terminal(NativeWorkspaceOpenResult::Failed);
                Err(join_err_to_napi(error))
            }
        };

        // The compatibility adapter derives the terminal projection from the
        // actual published authority / Safe Mode state. An operation failure
        // is preserved even if the observer itself cannot emit after a
        // poisoned lock.
        let lifecycle = if needs_recovery {
            publish_workspace_lifecycle_recovery_after_join(&self.state)
        } else {
            publish_workspace_lifecycle_from_workspace(&self.state)
        };
        if result.is_err() {
            let _ = lifecycle;
            result
        } else {
            let lifecycle = lifecycle.map_err(app_err_to_napi)?;
            // The transition has joined, activated, and released every
            // participant. Future post-effect launches may bind again; the
            // old detached runs remain cancelled in their own terminal path.
            self.state.post_effect_abort.clear_abort_all();
            result.and_then(|wire| attach_workspace_lifecycle_proof(wire, &lifecycle))
        }
    }

    /// Main-only, strict lifecycle snapshot. This deliberately does not call
    /// `active_database`: recovery-only and transition states must remain
    /// observable while no authority is published.
    #[napi]
    pub async fn get_workspace_lifecycle_view(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let view = state
                .workspace_lifecycle
                .snapshot_for_workspace(&state.ws)?;
            WorkspaceLifecycleViewAdapter::serialize(&view)
        })
        .await
    }

    /// Request the idempotent Native lifecycle shutdown and publish `Closed`
    /// only after every admitted Open/Restore worker has returned.  The core
    /// still refuses the terminal transition while delivery records,
    /// descriptors, or maintenance permits remain unresolved, so a timeout
    /// or an interrupted worker cannot be mistaken for terminal proof.
    #[napi]
    pub async fn shutdown_workspace_lifecycle(&self) -> Result<String> {
        // The shared core closes new lifecycle admission before the Native
        // observation wait.  The AppState flag below remains the fast
        // foreground guard, while `publish_closed` is the terminal proof.
        let _ = self.state.workspace_lifecycle.request_shutdown();
        self.state.request_workspace_shutdown();
        // Cancellation is independent of the Native lifecycle observation
        // budget.  These registries are not represented by AppState's short
        // operation counter, but their pinned participants must still drain
        // before the core can publish Closed.
        self.state.post_effect_abort.abort_all();
        self.state.semantic.semantic_cancel_background();
        let _ = self.state.related_scenes.stop_for_workspace_transition();

        // Native owns the lifecycle proof and therefore waits idempotently
        // until its participants actually leave. The 30-second observation
        // budget belongs to Electron main's shutdown coordinator; applying a
        // second deadline here would turn an unfinished Native owner into a
        // misleading operation error and change the terminal proof contract.
        self.state.wait_workspace_operations().await;
        loop {
            let participants = self
                .state
                .workspace_lifecycle
                .workspace_participant_count()
                .map_err(|error| Error::from_reason(error.to_string()))?;
            if participants == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let view = publish_workspace_lifecycle_closed(&state)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            WorkspaceLifecycleViewAdapter::serialize(&view)
        })
        .await
    }

    /// 既存 workspace 判定 (commands/workspace.rs の同名コマンドと同一実装)。
    /// 軽量 stat のみなので設計どおり同期のまま (§4.2「純関数の validate 除く」)。
    #[napi]
    pub fn validate_workspace_path(&self, path: String) -> bool {
        let p = PathBuf::from(&path);
        p.exists() && p.is_dir() && p.join("grimodex.db").exists()
    }

    /// Electron main専用の内部境界。standalone MCP sidecarへ渡す現在の
    /// workspace directoryを返す。renderer commandとしては公開せず、mainの
    /// `get_mcp_config` handlerだけが利用する。
    #[napi]
    pub async fn get_active_workspace_path(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let path = active_workspace_path(&state.ws)?;
            path.into_os_string().into_string().map_err(|_| {
                AppError::Anyhow(anyhow::anyhow!("Active workspace path is not valid UTF-8"))
            })
        })
        .await
    }

    /// Main-only Codex App Server binding lookup. This method is intentionally
    /// not registered in `NAPI_COMMANDS`: renderer cannot select an external
    /// thread or bypass the project/session ownership check.
    #[napi]
    pub async fn get_chat_runtime_thread_binding(
        &self,
        project_id: String,
        session_id: String,
        runtime: String,
        expected_workspace_path: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_codex_workspace(&workspace, &expected_workspace_path)?;
            let binding = workspace.db().get_chat_runtime_thread_binding(
                &project_id,
                &session_id,
                &runtime,
            )?;
            Ok(serde_json::to_string(&binding).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Main-only Codex App Server binding upsert. The shared DB layer verifies
    /// that session_id belongs to project_id and that the external id is not
    /// already attached to another runtime session.
    #[napi]
    pub async fn upsert_chat_runtime_thread_binding(
        &self,
        binding: serde_json::Value,
        expected_workspace_path: String,
    ) -> Result<()> {
        let binding =
            from_wire::<grimodex_db::runtime_threads::RuntimeThreadBinding>("binding", binding)
                .map_err(app_err_to_napi)?;
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_codex_workspace(&workspace, &expected_workspace_path)?;
            workspace
                .db()
                .upsert_chat_runtime_thread_binding(&binding)?;
            Ok(())
        })
        .await
    }

    /// Main-only compare-and-swap bridge for committing a completed Codex turn's
    /// pending history revision. A stale or competing completion returns `false`.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub async fn advance_chat_runtime_thread_history_revision(
        &self,
        expected_workspace_path: String,
        project_id: String,
        session_id: String,
        runtime: String,
        external_thread_id: String,
        last_turn_id: String,
        pending_history_revision: String,
        next_history_revision: String,
        updated_at: String,
    ) -> Result<bool> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_codex_workspace(&workspace, &expected_workspace_path)?;
            Ok(workspace
                .db()
                .advance_chat_runtime_thread_history_revision(
                    &project_id,
                    &session_id,
                    &runtime,
                    &external_thread_id,
                    &last_turn_id,
                    &pending_history_revision,
                    &next_history_revision,
                    &updated_at,
                )?)
        })
        .await
    }

    /// Main-only Codex App Server binding deletion with project/session guard.
    #[napi]
    pub async fn delete_chat_runtime_thread_binding(
        &self,
        project_id: String,
        session_id: String,
        runtime: String,
        expected_workspace_path: String,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_codex_workspace(&workspace, &expected_workspace_path)?;
            workspace.db().delete_chat_runtime_thread_binding(
                &project_id,
                &session_id,
                &runtime,
            )?;
            Ok(())
        })
        .await
    }

    /// アクティブworkspaceの復元候補を新しい順で返す。
    /// 返り値は `BackupInfo[]` のcamelCase JSON文字列。
    #[napi]
    pub async fn list_backups(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let backups = list_backups(&state.ws)?;
            Ok(serde_json::to_string(&backups).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// バックアップを検証・安全退避・原子置換し、同じworkspaceを再openする。
    /// 再open時にDB由来のCodex matcherを破棄し、semantic 4-cache epochも
    /// rotateして復元前DBへのlate writeを不可視にする。
    #[napi]
    pub async fn restore_backup(&self, file_name: String) -> Result<String> {
        let _workspace_operation = match self.state.begin_workspace_operation() {
            Ok(operation) => operation,
            Err(error) => {
                return restore_not_admitted_outcome(
                    &self.state,
                    "workspace-operation-not-admitted",
                )
                .map_err(|_| app_err_to_napi(AppError::Anyhow(error)));
            }
        };
        // The legacy/native admission marker is retained only as a compatibility
        // guard while all new lifecycle ownership lives in the shared core. If
        // another workspace owner already closed that marker, do not admit a
        // second core transition and later reinterpret its failed body as an
        // Unchanged result. The existing owner must publish its terminal proof
        // before this request can be retried.
        if self
            .state
            .narrative_maintenance_recovery_gate
            .maintenance_admission_is_closed()
        {
            return restore_not_admitted_outcome(&self.state, "maintenance-admission-closed");
        }
        let not_admitted =
            begin_workspace_lifecycle_transition_wire(&self.state, AdmissionKind::Restore)
                .map_err(app_err_to_napi)?;
        if let Some(wire) = not_admitted {
            let reason_code = serde_json::from_str::<serde_json::Value>(&wire)
                .ok()
                .and_then(|value| {
                    value
                        .get("reasonCode")
                        .and_then(serde_json::Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_else(|| "lifecycle-not-admitted".to_owned());
            return restore_not_admitted_outcome(&self.state, &reason_code);
        }
        // The transition admission must win before reading any owner state,
        // so a concurrent Restore reports the lifecycle rejection rather than
        // the ordinary Transition DB-access error. Once this exact owner is
        // admitted, read its pinned authority through the narrow swap-owner
        // boundary: the normal active-workspace getter intentionally rejects
        // during Transition, and converting that rejection to `None` would
        // clear profile egress authorization during replacement.
        let workspace_binding = match workspace_swap_owner_authority(&self.state, true) {
            Ok(authority) => authority.path().to_string_lossy().into_owned(),
            Err(_error) => {
                // Admission succeeded, so an owner lookup failure must not
                // strand the shared core in Transition. There is no blocking
                // worker to join in this preflight branch; publish the
                // fail-closed recovery outcome explicitly.
                let lifecycle = publish_workspace_lifecycle_recovery_after_join(&self.state)
                    .map_err(app_err_to_napi)?;
                return serialize_restore_outcome(
                    "recovery-required",
                    "unknown",
                    "none",
                    &lifecycle,
                    None,
                    Some("restore-authority-unavailable"),
                );
            }
        };
        let state = Arc::clone(&self.state);
        let result = run_blocking(move || {
            let _physical_exclusive = state
                .workspace_lifecycle
                .acquire_transition_physical_exclusive()?;
            if state
                .narrative_maintenance_recovery_gate
                .maintenance_admission_is_closed()
            {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_MAINTENANCE_ADMISSION_CLOSED: another workspace operation owns the swap"
                )));
            }
            let mut admission_guard =
                NarrativeMaintenanceAdmissionReopenGuard::new(Arc::clone(&state));
            let owns_close = close_narrative_maintenance_for_workspace_swap(&state, false)?;
            if owns_close {
                admission_guard.arm();
            }
            // Restore owns the admission close while it waits for the shared
            // open lock. The restore core receives this same guard, so a
            // concurrent workspace open cannot borrow the closed gate and
            // later make the restore re-resolve a different workspace.
            let open_guard = state
                .ws
                .open_lock
                .lock()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
            let state_for_hook = Arc::clone(&state);
            let workspace_binding = workspace_binding.clone();
            let restore_result = catch_unwind(AssertUnwindSafe(|| {
                #[cfg(test)]
                if owns_close {
                    state
                        .narrative_maintenance_recovery_gate
                        .panic_after_admission_close_for_test();
                }
                restore_backup_core_with_open_lock(&state.ws, &open_guard, &file_name, move || {
                    rotate_ime_workspace(&state_for_hook);
                    state_for_hook
                        .profile_egress
                        .bind_workspace(Some(workspace_binding.clone()));
                    let mut matcher = match state_for_hook.codex_matcher.lock() {
                        Ok(matcher) => matcher,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    *matcher = None;
                    state_for_hook.semantic.rotate_workspace_epoch();
                    // Restore publishes a replacement authority through a
                    // separate shared path; advance the maintenance gate here as
                    // well so a late old-authority ACK cannot win the handoff.
                    state_for_hook
                        .narrative_maintenance_recovery_gate
                        .mark_workspace_swapped();
                })
            }));
            let restore_result = match restore_result {
                Ok(result) => result,
                Err(_) => {
                    let handoff = admission_guard.complete_admission_handoff();
                    let reopen = recover_workspace_open_lock_after_panic(&state);
                    let detail = match (handoff, reopen) {
                        (Ok(()), Ok(())) => "workspace restore panicked".to_owned(),
                        (handoff, reopen) => format!(
                            "workspace restore panicked; handoff={:?}; reopen={:?}",
                            handoff.err(),
                            reopen.err()
                        ),
                    };
                    return Err(AppError::Anyhow(anyhow::anyhow!(
                        "NEX_WORKSPACE_RESTORE_PANIC: {detail}"
                    )));
                }
            };
            // A restore can only run against a live authority and therefore
            // must own the admission close. If validation fails before the
            // authority is replaced, explicitly hand the close back now;
            // Drop is deliberately fail-closed and is not a lifecycle proof.
            if let Err(error) = restore_result {
                match admission_guard.complete_admission_handoff() {
                    Ok(()) => return Err(error),
                    Err(handoff_error) => {
                        return Err(AppError::Anyhow(anyhow::anyhow!(
                            "{error}; restore admission handoff failed: {handoff_error}"
                        )))
                    }
                }
            }
            // The restore callback has published the replacement authority.
            // Resolve exact preempted Runs through that new connection before
            // reopening maintenance admission.
            if let Err(error) = drain_preempted_maintenance_runs_after_workspace_swap(&state) {
                // The restore has completed and still owns open_lock here.
                // Hand the closed gate to the next serialized workspace open
                // with the exact replacement binding before returning the
                // recovery error; do not leave a terminal Restore owner.
                let recovery_binding = active_database(&state.ws).ok().map(|authority| {
                    state
                        .narrative_maintenance_recovery_gate
                        .binding_for_authority(&narrative_authority_id(&authority))
                });
                let handoff = state
                    .narrative_maintenance_recovery_gate
                    .handoff_restore_failure_to_workspace_swap(recovery_binding.as_ref());
                return match handoff {
                    Ok(()) => {
                        admission_guard.disarm();
                        Err(error)
                    }
                    Err(handoff_error) => Err(AppError::Anyhow(anyhow::anyhow!(
                        "{error}; restore recovery handoff failed: {handoff_error}"
                    ))),
                };
            }
            admission_guard.complete_admission_handoff()?;
            // The logical transition is still held until the outer Native
            // supervisor observes this blocking worker's Join. Read the path
            // through that owner boundary instead of the ordinary DB entry,
            // which correctly rejects Transition for unrelated callers.
            let path = workspace_swap_owner_authority(&state, true)?
                .path()
                .to_string_lossy()
                .into_owned();
            state.events.emit(
                "workspace:opened",
                serde_json::json!({ "path": path, "reason": "restore" }),
            );
            Ok(())
        })
        .await;

        let force_recovery = result
            .as_ref()
            .err()
            .is_some_and(|error| error.to_string().contains("NEX_WORKSPACE_RESTORE_PANIC"));
        let lifecycle = if force_recovery {
            publish_workspace_lifecycle_recovery_after_join(&self.state)
        } else {
            publish_workspace_lifecycle_from_workspace(&self.state)
        }
        .map_err(app_err_to_napi)?;
        let terminal_kind = self
            .state
            .workspace_lifecycle
            .take_last_terminal_kind()
            .map_err(app_err_to_napi)?;

        if result.is_ok() {
            self.state.post_effect_abort.clear_abort_all();
            return match lifecycle.status {
                WorkspaceLifecycleStatus::Ready => serialize_restore_outcome(
                    "restored",
                    "succeeded",
                    "replaced",
                    &lifecycle,
                    restore_activation_for_view(&lifecycle),
                    None,
                ),
                WorkspaceLifecycleStatus::RecoveryRequired => serialize_restore_outcome(
                    "recovery-required",
                    "unknown",
                    "replaced",
                    &lifecycle,
                    None,
                    Some("restore-activation-recovery-required"),
                ),
                WorkspaceLifecycleStatus::Closed => serialize_restore_outcome(
                    "closed",
                    "unknown",
                    "none",
                    &lifecycle,
                    None,
                    Some("workspace-closed-during-restore"),
                ),
                WorkspaceLifecycleStatus::Transition => Err(napi::Error::from_reason(
                    "restore lifecycle did not reach a terminal state",
                )),
            };
        }

        match lifecycle.status {
            WorkspaceLifecycleStatus::Ready => match terminal_kind {
                Some(LifecycleTerminalKind::Unchanged) => {
                    serialize_restore_outcome("unchanged", "failed", "none", &lifecycle, None, None)
                }
                Some(LifecycleTerminalKind::Activated) => serialize_restore_outcome(
                    "activated",
                    "failed",
                    "retained",
                    &lifecycle,
                    restore_activation_for_view(&lifecycle),
                    Some("restore-failed-after-authority-activation"),
                ),
                _ => Err(napi::Error::from_reason(
                    "restore failed without an unchanged or activated lifecycle proof",
                )),
            },
            WorkspaceLifecycleStatus::RecoveryRequired => serialize_restore_outcome(
                "recovery-required",
                "unknown",
                "none",
                &lifecycle,
                None,
                Some("restore-operation-recovery-required"),
            ),
            WorkspaceLifecycleStatus::Closed => serialize_restore_outcome(
                "closed",
                "unknown",
                "none",
                &lifecycle,
                None,
                Some("workspace-closed-during-restore"),
            ),
            WorkspaceLifecycleStatus::Transition => Err(napi::Error::from_reason(
                "restore failed without a terminal lifecycle proof",
            )),
        }
    }

    /// Safe Mode中の復元候補をopaque idだけで列挙する。
    #[napi]
    pub async fn list_recovery_candidates(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let candidates = list_safe_mode_candidates(&state.ws)?;
            Ok(serde_json::to_string(&candidates).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// candidate idを検証し、復元前の候補メタデータを返す。
    #[napi]
    pub async fn verify_recovery_candidate(&self, candidate_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let candidate = verify_safe_mode_candidate(&state.ws, &candidate_id)?;
            Ok(serde_json::to_string(&candidate).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Safe Mode候補を復元する。復元後はrendererがopen_workspaceを再実行する。
    #[napi]
    pub async fn restore_recovery_candidate(&self, candidate_id: String) -> Result<()> {
        let _workspace_operation = self
            .state
            .begin_workspace_operation()
            .map_err(|error| app_err_to_napi(AppError::Anyhow(error)))?;
        begin_workspace_lifecycle_recovery(&self.state).map_err(app_err_to_napi)?;
        let state = Arc::clone(&self.state);
        let result = run_blocking(move || {
            let _physical_exclusive = state
                .workspace_lifecycle
                .acquire_transition_physical_exclusive()?;
            restore_safe_mode_candidate(&state.ws, &candidate_id)
        })
        .await;
        let lifecycle = publish_workspace_lifecycle_from_workspace(&self.state);
        if result.is_err() {
            let _ = lifecycle;
            result
        } else {
            lifecycle.map_err(app_err_to_napi)?;
            self.state.post_effect_abort.clear_abort_all();
            result
        }
    }

    /// 現在の破損live DBをworkspace内の隔離名へ移動し、そのfile nameを返す。
    #[napi]
    pub async fn quarantine_live_database(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let file_name = quarantine_live_database(&state.ws)?;
            Ok(serde_json::to_string(&file_name).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Safe Mode診断JSONを書き出し、そのpath文字列を返す。
    #[napi]
    pub async fn export_safe_mode_diagnostics(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let path = export_safe_mode_diagnostics(&state.ws)?;
            Ok(serde_json::to_string(&path).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// 起動時に必ず呼ばれる (workspace/store.ts:152)。
    /// 返り値: `GlobalSettings` の JSON 文字列 (camelCase — Tauri ワイヤと同形)。
    #[napi]
    pub async fn get_global_settings(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _guard = state
                .gs
                .write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let settings = workspace::read_global_settings(&state.gs.path);
            Ok(serde_json::to_string(&settings).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// `settings` は GlobalSettings 全体 (camelCase オブジェクト)。tmp+rename の
    /// 原子的書き込みと write_lock 直列化は Tauri コマンドと同一経路。
    #[napi]
    pub async fn save_global_settings(&self, settings: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let settings: GlobalSettings = from_wire("settings", settings)?;
            let _guard = state
                .gs
                .write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            workspace::write_global_settings(&state.gs.path, &settings)?;
            Ok(())
        })
        .await
    }

    /// AppData配下に一意なsample-workspace世代を共有coreで公開する。
    /// GlobalSettingsのwrite_lockをget/save/openと共有し、同時seedも同じ
    /// critical sectionへ入る。公開済み世代はアクティブDB/MCPが保持し得るため削除しない。
    #[napi]
    pub async fn seed_sample_workspace(
        &self,
        language: String,
        ai_policy: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let result = sample_seed::seed_sample_workspace(&state.gs, &language, &ai_policy)?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Hosted Web Editorがローカル保存したversioned handoffを検証し、
    /// AppData配下の新しいworkspace世代として公開する。現在のactive workspaceは
    /// 触らず、rendererが通常のopen_workspace経路で明示的に切り替える。
    #[napi]
    pub async fn import_web_editor_workspace(&self, handoff_json: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let result = web_editor_handoff::import_web_editor_workspace(&state.gs, &handoff_json)?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// 監査チェーン append (commands/timelapse.rs の写像。編集ループ常連の
    /// 軽量 DB 書き込み。§4.3)。`events` は camelCase の AppendChangeEvent 配列
    /// (Tauri の camelCase→snake_case 自動変換は serde の rename_all が担う)。
    /// 返り値: `AppendResult` (`{"insertedCount":…,"tailSequence":…,"tailHash":…}`)
    /// の JSON 文字列。
    #[napi]
    pub async fn timelapse_append_batch(
        &self,
        project_id: String,
        session_id: String,
        events: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let events: Vec<AppendChangeEvent> = from_wire("events", events)?;
            with_db_state(&state.ws, |db| {
                let result = db.append_renderer_change_events(&project_id, &session_id, &events)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// Append missing genesis editor-body baselines in one native transaction.
    /// Any existing same-entity snapshot (including a later rebaseline) makes
    /// that entity ineligible. The renderer supplies identity only; trusted
    /// workspace tables own payload, domain, entityType, and project membership.
    #[napi]
    pub async fn timelapse_genesis_baselines_append(
        &self,
        expected_workspace_path: String,
        project_id: String,
        kind: String,
        entity_ids: Vec<String>,
        anchor_timestamp: i64,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_timelapse_workspace(&workspace, &expected_workspace_path)?;
            let kind = TimelapseGenesisBaselineKind::parse(&kind)?;
            let summary = workspace.db().append_timelapse_genesis_baselines(
                &project_id,
                kind,
                &entity_ids,
                anchor_timestamp,
            )?;
            Ok(serde_json::to_string(&summary).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Append body baselines at the current canonical tail. Renderer callers
    /// provide identities only; Native resolves ownership and body payload
    /// from the trusted workspace tables inside one immediate transaction.
    #[napi]
    pub async fn timelapse_body_baselines_append(
        &self,
        expected_workspace_path: String,
        project_id: String,
        targets: serde_json::Value,
        expected_anchor_sequence: Option<i64>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let wires: Vec<TimelapseBodyBaselineTargetWire> = from_wire("targets", targets)?;
            let targets = wires
                .into_iter()
                .map(|target| {
                    let kind = TimelapseGenesisBaselineKind::parse(&target.kind)?;
                    Ok::<_, anyhow::Error>(match kind {
                        TimelapseGenesisBaselineKind::Scene => {
                            TimelapseBodySnapshotTarget::scene(target.id)
                        }
                        TimelapseGenesisBaselineKind::Codex => {
                            TimelapseBodySnapshotTarget::codex(target.id)
                        }
                        TimelapseGenesisBaselineKind::Snippet => {
                            TimelapseBodySnapshotTarget::snippet(target.id)
                        }
                    })
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_timelapse_workspace(&workspace, &expected_workspace_path)?;
            let summary = workspace.db().append_timelapse_body_baselines(
                &project_id,
                &targets,
                expected_anchor_sequence,
            )?;
            Ok(serde_json::to_string(&summary).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Logically reset timelapse history for the authorized project in one
    /// transaction. Canonical `change_events` and their hash chain remain
    /// intact; project `state_snapshots` are deleted and Native advances the
    /// trusted `resetSequence` cutoff. The summary reports the logical event
    /// count hidden by the new cutoff and the snapshots deleted.
    #[napi]
    pub async fn timelapse_history_purge(
        &self,
        expected_workspace_path: String,
        project_id: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_timelapse_workspace(&workspace, &expected_workspace_path)?;
            let summary = workspace.db().purge_timelapse_history(&project_id)?;
            Ok(serde_json::to_string(&summary).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Set `timelapse.enabled` under the same exact workspace binding used by
    /// the protected timelapse writers. This prevents a switch from redirecting
    /// an enable/rollback to a project with the same id in another database.
    #[napi]
    pub async fn timelapse_enabled_set(
        &self,
        expected_workspace_path: String,
        project_id: String,
        enabled: bool,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_timelapse_workspace(&workspace, &expected_workspace_path)?;
            let summary = workspace.db().set_timelapse_enabled(&project_id, enabled)?;
            Ok(serde_json::to_string(&summary).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Record a renderer UI snapshot under the fixed
    /// `layout/workspace/workspace` scope. Native derives the anchor timestamp
    /// and checks the optional observed canonical tail.
    #[napi]
    pub async fn timelapse_layout_snapshot_record(
        &self,
        expected_workspace_path: String,
        project_id: String,
        payload: serde_json::Value,
        expected_anchor_sequence: Option<i64>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_timelapse_workspace(&workspace, &expected_workspace_path)?;
            let payload = serde_json::to_string(&payload).map_err(anyhow::Error::from)?;
            let summary = workspace.db().append_timelapse_layout_snapshot(
                &project_id,
                &payload,
                expected_anchor_sequence,
            )?;
            Ok(serde_json::to_string(&summary).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Append a durable batch to the complete AI-use audit ledger. The
    /// renderer snapshots `expected_workspace_path` before dispatch; every
    /// subsequent event must still target that exact workspace. A workspace
    /// switch therefore leaves a visible non-terminal execution instead of
    /// writing its terminal event into the newly active project database.
    #[napi]
    pub async fn ai_audit_append_batch(
        &self,
        expected_workspace_path: String,
        project_id: Option<String>,
        events: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let events: Vec<AppendAiAuditEvent> = from_wire("events", events)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_ai_audit_workspace(&workspace, &expected_workspace_path)?;
            let result = workspace
                .db()
                .append_ai_audit_events_for_scope(project_id.as_deref(), &events)?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Validate the durable CLI lifecycle and atomically append the
    /// main-owned one-shot dispatch claim before the shell manager can spawn.
    #[allow(clippy::too_many_arguments)]
    #[napi]
    pub async fn ai_audit_claim_cli_dispatch(
        &self,
        expected_workspace_path: String,
        project_id: Option<String>,
        execution_id: String,
        operation_id: String,
        parent_execution_id: Option<String>,
        path_id: String,
        expected_request_sha256: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_ai_audit_workspace(&workspace, &expected_workspace_path)?;
            let result = workspace.db().claim_cli_ai_audit_dispatch(
                project_id.as_deref(),
                &execution_id,
                &operation_id,
                parent_execution_id.as_deref(),
                &path_id,
                &expected_request_sha256,
            )?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Read one immutable high-water snapshot. Rows appended after the
    /// selected high-water sequence are deliberately excluded from export.
    #[napi]
    pub async fn ai_audit_read_snapshot(
        &self,
        expected_workspace_path: String,
        project_id: Option<String>,
        after_sequence: Option<i64>,
        high_water_sequence: Option<i64>,
        limit: Option<i64>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_ai_audit_workspace(&workspace, &expected_workspace_path)?;
            let snapshot = workspace.db().read_ai_audit_snapshot_for_scope(
                project_id.as_deref(),
                after_sequence,
                high_water_sequence,
                limit,
            )?;
            Ok(serde_json::to_string(&snapshot).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Verify payload digests, event hashes, sequence continuity, and the
    /// project-global previous-hash chain through an optional high-water mark.
    #[napi]
    pub async fn ai_audit_verify(
        &self,
        expected_workspace_path: String,
        project_id: Option<String>,
        high_water_sequence: Option<i64>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_ai_audit_workspace(&workspace, &expected_workspace_path)?;
            let result = workspace
                .db()
                .verify_ai_audit_chain_for_scope(project_id.as_deref(), high_water_sequence)?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// 現在の Codex 読みを `<userData>/ime/projects/<projectId>.json` へ再出力する。
    /// options は typed IPC と同じ camelCase `ImeExportOptions`。DB 読み取りと
    /// ファイル I/O の双方を Node main thread の外で実行する。
    #[napi]
    pub async fn ime_export_refresh(
        &self,
        project_id: String,
        expected_workspace_path: String,
        options: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        let options: ImeExportOptions = from_wire("options", options).map_err(app_err_to_napi)?;
        let (workspace, request) =
            pin_ime_workspace_request(&state, &expected_workspace_path, |gate, generation| {
                gate.register_refresh_for_generation(&project_id, &options, generation)
            })
            .map_err(app_err_to_napi)?;
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let options = authoritative_ime_options(&state, &options)?;
            if !state.ime_request_gate.is_current(&request) {
                let status = get_ime_export_status(&state.ime_root, options.mode)?;
                return Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?);
            }
            let status = refresh_project_export(
                workspace.db().as_ref(),
                &state.ime_root,
                &project_id,
                &options,
            )?;
            Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// IME consumer が参照する active project を切り替える。`None` は明示的な
    /// deactivation であり、renderer からの null をそのまま受ける。
    #[napi]
    pub async fn ime_export_set_active_project(
        &self,
        project_id: Option<String>,
        expected_workspace_path: Option<String>,
        mode: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        let mode: ImeIntegrationMode =
            from_wire("mode", serde_json::Value::String(mode)).map_err(app_err_to_napi)?;
        let request = if project_id.is_some() {
            let expected_workspace_path = expected_workspace_path.ok_or_else(|| {
                Error::from_reason(
                    "expectedWorkspacePath is required when activating an IME project",
                )
            })?;
            let (_, request) = pin_ime_workspace_request(
                &state,
                &expected_workspace_path,
                ImeExportRequestGate::register_active_for_generation,
            )
            .map_err(app_err_to_napi)?;
            request
        } else {
            state.ime_request_gate.register_active()
        };
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let mode = authoritative_ime_mode(&state, mode)?;
            if !state.ime_request_gate.is_current(&request) {
                let status = get_ime_export_status(&state.ime_root, mode)?;
                return Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?);
            }
            let status = set_active_project(&state.ime_root, project_id.as_deref(), mode)?;
            Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Electron の will-quit 専用。blocking pool の処理をタイムアウトで
    /// 打ち切ると state.json が旧 project を指したまま終了し得るため、ここだけ
    /// 同期的に writer mutex を待ち、active pointer の解除完了を保証する。
    #[napi]
    pub fn ime_export_deactivate_on_exit(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        let request = state.ime_request_gate.register_active();
        let _guard = state
            .ime_write_lock
            .lock()
            .map_err(|e| app_err_to_napi(AppError::Anyhow(anyhow::anyhow!("{e}"))))?;
        if !state.ime_request_gate.is_current(&request) {
            return Ok(());
        }
        set_active_project(&state.ime_root, None, ImeIntegrationMode::On)
            .map(|_| ())
            .map_err(|error| app_err_to_napi(AppError::Anyhow(error)))
    }

    /// consumer handshake と現在の export 状態を返す。
    #[napi]
    pub async fn ime_export_get_status(&self, mode: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let fallback: ImeIntegrationMode = from_wire("mode", serde_json::Value::String(mode))?;
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let mode = authoritative_ime_mode(&state, fallback)?;
            let status = get_ime_export_status(&state.ime_root, mode)?;
            Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// consumer handshake は保持し、project snapshots と active state を消去する。
    #[napi]
    pub async fn ime_export_clear_all(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        let request = state.ime_request_gate.register_clear();
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            if !state.ime_request_gate.is_current(&request) {
                return Ok(());
            }
            let result = clear_all_exports(&state.ime_root).map_err(AppError::from);
            state.ime_request_gate.finish_clear(&request);
            result
        })
        .await
    }

    /// 単一 project の snapshot を削除し、必要なら active state も解除する。
    #[napi]
    pub async fn ime_export_remove_project(
        &self,
        project_id: String,
        expected_workspace_path: String,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        let (workspace, request) =
            pin_ime_workspace_request(&state, &expected_workspace_path, |gate, generation| {
                gate.register_remove_for_generation(&project_id, generation)
            })
            .map_err(app_err_to_napi)?;
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            if !state.ime_request_gate.is_current(&request) {
                if !state
                    .ime_request_gate
                    .is_workspace_generation_current(&request)
                {
                    return Err(AppError::Anyhow(anyhow::anyhow!(
                        "IME_WORKSPACE_CHANGED: snapshot cleanup must be retried"
                    )));
                }
                return Ok(());
            }
            remove_project_export_if_absent(workspace.db().as_ref(), &state.ime_root, &project_id)?;
            Ok(())
        })
        .await
    }

    /// 文字屑ゴミ箱: 作成 (commands/trash_bin.rs の写像 — 実装本体は
    /// `grimodex_db::trash_bin` を Tauri コマンドと共用)。trash_bin 5 コマンドは
    /// workspace 読み込み時に `trash_bin_list` が必ず呼ばれるため、垂直スライスに
    /// 含めないと Electron 起動のたびにゴミ箱エラートーストが出る (§4.3)。
    /// `payload` は camelCase の TrashBinCreatePayload。
    /// 返り値: 作成行 (`SELECT *`、列名は snake_case) の JSON 文字列。
    #[napi]
    pub async fn trash_bin_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: TrashBinCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = trash_bin::create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// Structural Trash restore. Domain rows, canonical Change Event,
    /// Narrative Change Feed, Trash consumption, and retry receipt commit as
    /// one Native-owned transaction.
    #[napi]
    pub async fn trash_bin_restore(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: TrashBinRestorePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = trash_bin::restore(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// 文字屑ゴミ箱: 一覧 (deleted_at 降順、`limit` 省略時 50 件)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn trash_bin_list(&self, project_id: String, limit: Option<i64>) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = trash_bin::list(db, project_id, limit)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// 文字屑ゴミ箱: 1 件削除 (拾い上げ成功時にも呼ばれる)。
    #[napi]
    pub async fn trash_bin_delete(&self, id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| trash_bin::delete(db, id))).await
    }

    /// 文字屑ゴミ箱: project 内全削除。
    #[napi]
    pub async fn trash_bin_clear_all(&self, project_id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| trash_bin::clear_all(db, project_id)))
            .await
    }

    /// 文字屑ゴミ箱: 期日切れ・件数超過の刈り取り (起動時に呼ばれる)。
    /// 返り値: 残件数 (i64) の JSON 文字列。
    #[napi]
    pub async fn trash_bin_prune(
        &self,
        project_id: String,
        retention_days: i64,
        max_count: i64,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let count = trash_bin::prune(db, project_id, retention_days, max_count)?;
                Ok(serde_json::to_string(&count)?)
            })
        })
        .await
    }

    /// FTS optimize (commands/integrity.rs の写像 — 実装は grimodex-db の
    /// `Database::fts_optimize` を Tauri と共用)。明示的なメンテナンス用であり、
    /// workspace open からは自動実行しない。
    #[napi]
    pub async fn fts_optimize(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| db.fts_optimize())).await
    }

    /// FTS 全再構築 (設定画面のデータカテゴリから明示実行)。
    #[napi]
    pub async fn fts_rebuild(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| db.fts_rebuild())).await
    }

    /// 英語 FTS の再構築 (英語プロジェクト作成時に fail-soft で呼ばれる)。
    #[napi]
    pub async fn fts_rebuild_en(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| db.rebuild_en_fts())).await
    }

    /// FTS 検索 (チャット recall / コマンドセンター検索 — 編集ループ常連)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn fts_search(
        &self,
        project_id: String,
        query: String,
        scope: String,
        limit: u32,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = db.search_fts(&project_id, &query, &scope, limit)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// 整合性チェック (IntegrityCheckDialog)。
    /// 返り値: レポート object の JSON 文字列。
    #[napi]
    pub async fn integrity_check(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let report = db.integrity_check(&project_id)?;
                Ok(serde_json::to_string(&report)?)
            })
        })
        .await
    }

    /// 整合性修復 (IntegrityCheckDialog — 長時間になりうるが spawn_blocking
    /// なので Node main thread は塞がない)。
    /// 返り値: レポート object の JSON 文字列。
    #[napi]
    pub async fn repair_integrity(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let payload: RepairIntegrityPayload = from_wire("payload", payload)?;
            let project_id = payload.project_id.clone();
            let request_id = payload.request_id.clone();
            let _mutation_guard = state
                .narrative_maintenance_mutation_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            // Same serialization contract as snapshot restore: integrity
            // repair rotates the Semantic Epoch, so the repair and its
            // rotation event must be excluded against workspace open/switch.
            let _workspace_open_guard = state
                .ws
                .open_lock
                .lock()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
            let authority = active_database(&state.ws)?;
            let binding = narrative_maintenance_binding_for_authority(&state, &authority);
            let (report, replayed) = {
                let db = authority.db();
                let replayed = idempotency_receipt_exists(db, "repair_integrity", &request_id)?;
                let report = db.repair_integrity(payload)?;
                (report, replayed)
            };
            let changed = report.codex_sources_fixed > 0
                || report.snippet_sources_fixed > 0
                || report.snippet_scenes_fixed > 0
                || report.change_event_uid.is_some();
            if should_emit_narrative_epoch_rotated(replayed, changed) {
                emit_narrative_epoch_rotated(&state, &binding, &project_id, "integrity-repair");
            }
            Ok(serde_json::to_string(&report).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Linter 本体 (commands/lint.rs の写像 — grimodex-lint を Tauri と共用)。
    /// State 非依存だが、UniDic コールドロード (初回 >数秒) + CPU バウンドなので
    /// spawn_blocking。エラーは AppError ではなく **LintError の {type,data}
    /// JSON** を reason に載せる (convert::lint_err_to_napi — ipcContract の
    /// lint_text アダプタが object reject へ復元する)。
    /// 返り値: `LintResponse` の JSON 文字列。
    #[napi]
    pub async fn lint_text(
        &self,
        blocks: serde_json::Value,
        language: String,
        scope: serde_json::Value,
        config: serde_json::Value,
        disables: Option<serde_json::Value>,
    ) -> Result<String> {
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            let blocks: Vec<grimodex_lint::LintBlock> =
                from_wire("blocks", blocks).map_err(app_err_to_napi)?;
            let scope: grimodex_lint::LintScope =
                from_wire("scope", scope).map_err(app_err_to_napi)?;
            let config: grimodex_lint::LintConfig =
                from_wire("config", config).map_err(app_err_to_napi)?;
            let disables: Vec<grimodex_lint::DisableDirective> = match disables {
                Some(v) => from_wire("disables", v).map_err(app_err_to_napi)?,
                None => Vec::new(),
            };
            // 言語分岐は commands/lint.rs と同一 (InvalidLanguage も LintError ワイヤ)
            let lang = match language.as_str() {
                "ja" => grimodex_lint::Language::Japanese,
                "en" => grimodex_lint::Language::English,
                other => {
                    return Err(lint_err_to_napi(
                        &grimodex_lint::LintError::InvalidLanguage(other.to_string()),
                    ))
                }
            };
            let response = grimodex_lint::lint(&blocks, lang, scope, &config, &disables)
                .map_err(|e| lint_err_to_napi(&e))?;
            serde_json::to_string(&response)
                .map_err(|e| Error::from_reason(format!("failed to serialize LintResponse: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// 段落プレーンテキストの文節分割 (commands/reorder.rs の写像)。
    /// UniDic コールドロードで初回 10s 超えうる (FE 側 SLOW_COMMANDS 登録済み)。
    /// 返り値: `[{start, end, surface}, …]` (UTF-16 offset) の JSON 文字列。
    #[napi]
    pub async fn segment_bunsetsu(&self, text: String) -> Result<String> {
        #[derive(serde::Serialize)]
        struct BunsetsuDto {
            start: u32,
            end: u32,
            surface: String,
        }
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            // サイズ上限とエラー文言は commands/reorder.rs と同一
            if text.len() > grimodex_lint::MAX_INPUT_BYTES {
                return Err(Error::from_reason(format!(
                    "text exceeds maximum length of {} bytes",
                    grimodex_lint::MAX_INPUT_BYTES
                )));
            }
            let chunks = grimodex_lint::bunsetsu::segment_bunsetsu(&text)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            let dtos: Vec<BunsetsuDto> = chunks
                .into_iter()
                .map(|c| BunsetsuDto {
                    start: c.start,
                    end: c.end,
                    surface: c.surface,
                })
                .collect();
            serde_json::to_string(&dtos)
                .map_err(|e| Error::from_reason(format!("failed to serialize bunsetsu: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// システムフォント列挙 (commands/fonts.rs の写像 — 実装本体は
    /// grimodex-fonts を Tauri と共用)。OS のフォントディレクトリスキャンは
    /// 数百 ms かかりうるため spawn_blocking。
    /// 返り値: family 名配列 (昇順・重複排除) の JSON 文字列。
    #[napi]
    pub async fn list_system_fonts(&self) -> Result<String> {
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            let families = grimodex_fonts::list_system_fonts();
            serde_json::to_string(&families)
                .map_err(|e| Error::from_reason(format!("failed to serialize fonts: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// Codex 名寄せマッチャの再構築 (commands/codex_matching.rs の写像 —
    /// 本体は grimodex-core::codex_matching を Tauri と共用)。`entries` は
    /// camelCase の MatchEntry 配列 (rustMatcher.ts が entryType/excludedAliases
    /// で送る)。Aho-Corasick 構築は CPU バウンドなので spawn_blocking。
    /// rebuild と match_text は AppState.codex_matcher の**同一インスタンス**を
    /// 見る (Tauri の CodexMatcherState 相当)。
    #[napi]
    pub async fn codex_rebuild_matcher(&self, entries: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        napi::tokio::task::spawn_blocking(move || -> Result<()> {
            let entries: Vec<MatchEntry> =
                from_wire("entries", entries).map_err(app_err_to_napi)?;
            let matcher =
                CachedMatcher::build(&entries).map_err(|e| Error::from_reason(format!("{e}")))?;
            let mut guard = state
                .codex_matcher
                .lock()
                .map_err(|e| Error::from_reason(format!("{e}")))?;
            *guard = Some(matcher);
            Ok(())
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// `text` を現在のマッチャで名寄せする (commands/codex_matching.rs の写像)。
    /// マッチャ未構築時は空配列 (Tauri 実装と同一の fail-soft)。高頻度 IPC だが
    /// 作法統一のため async + spawn_blocking。
    /// 返り値: `CodexMatch` (UTF-16 offset、camelCase) 配列の JSON 文字列。
    #[napi]
    pub async fn codex_match_text(
        &self,
        text: String,
        exclude_entry_ids: Vec<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            let guard = state
                .codex_matcher
                .lock()
                .map_err(|e| Error::from_reason(format!("{e}")))?;
            let matches: Vec<CodexMatch> = match guard.as_ref() {
                None => vec![],
                Some(matcher) => matcher.match_text(&text, &exclude_entry_ids),
            };
            serde_json::to_string(&matches)
                .map_err(|e| Error::from_reason(format!("failed to serialize matches: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// Canonical Source View から決定的な Entity Seed を抽出する。
    /// workspace/DB 状態を一切参照せず、strict DTO validation 後に blocking pool で
    /// UniDic 解析を行う。返り値は camelCase Entity Seed response の JSON 文字列。
    #[napi(ts_return_type = "Promise<string>")]
    pub fn extract_codex_entity_seeds(
        &self,
        request: napi::JsObject,
    ) -> Result<AsyncTask<ExtractCodexEntitySeedsTask>> {
        let request = entity_seed_request_from_js(request).map_err(|error| error.reason);
        Ok(AsyncTask::new(ExtractCodexEntitySeedsTask { request }))
    }

    /// 本文から未知の固有名詞候補を抽出する
    /// (`grimodex_semantic::codex_candidates` を Tauri と共用)。
    ///
    /// workspace DB は blocking pool へ投入する**前**に一度だけ pin する。これにより
    /// 待ち行列中に workspace が切り替わってもコマンド途中で別 DB を解決せず、開始時
    /// snapshot の scenes/known names を読む。共有コアは DB phase を単一 connection
    /// lock に閉じ、UniDic + Aho-Corasick の CPU phase は lock 外で実行する。
    /// 返り値: camelCase `CodexCandidate[]` の JSON 文字列。
    #[napi]
    pub async fn extract_codex_candidates(
        &self,
        project_id: String,
        min_count: Option<u32>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        let workspace_operation = state
            .begin_workspace_operation()
            .map_err(|error| app_err_to_napi(AppError::Anyhow(error)))?;
        let workspace_participant = state
            .ws
            .lifecycle_core()
            .begin_workspace_participant()
            .map_err(|error| app_err_to_napi(AppError::Anyhow(anyhow::anyhow!(error))))?;
        let db = grimodex_db::state::active_database(&state.ws).map_err(app_err_to_napi)?;
        let min_count = min_count.map(|value| value as usize);
        run_blocking(move || {
            let _workspace_operation = workspace_operation;
            let _workspace_participant = workspace_participant;
            let candidates = grimodex_semantic::codex_candidates::extract_codex_candidates(
                &db,
                &project_id,
                min_count,
            )?;
            Ok(serde_json::to_string(&candidates).map_err(anyhow::Error::from)?)
        })
        .await
    }

    #[napi]
    pub async fn related_scenes_begin(&self, payload: serde_json::Value) -> Result<String> {
        let dto = serde_json::from_value(payload)
            .map_err(|_| Error::from_reason("RELATED_SCENES_INVALID_REQUEST"))?;
        let result = related_scenes::begin(Arc::clone(&self.state), dto)
            .await
            .map_err(|_| Error::from_reason("RELATED_SCENES_UNAVAILABLE"))?;
        Ok(result.to_string())
    }

    #[napi]
    pub async fn related_scenes_continue(
        &self,
        owner_key: String,
        operation_ticket: String,
    ) -> Result<String> {
        related_scenes::continue_query(Arc::clone(&self.state), owner_key, operation_ticket)
            .await
            .map(|value| value.to_string())
            .map_err(|_| Error::from_reason("RELATED_SCENES_UNAVAILABLE"))
    }

    #[napi]
    pub async fn related_scenes_release(
        &self,
        owner_key: String,
        operation_ticket: String,
    ) -> Result<String> {
        related_scenes::release(&self.state, &owner_key, &operation_ticket)
            .map(|value| value.to_string())
            .map_err(|_| Error::from_reason("RELATED_SCENES_UNAVAILABLE"))
    }

    #[napi]
    pub async fn related_scenes_release_owner(&self, owner_key: String) -> Result<String> {
        related_scenes::release_owner(&self.state, &owner_key)
            .map(|value| value.to_string())
            .map_err(|_| Error::from_reason("RELATED_SCENES_UNAVAILABLE"))
    }

    #[napi]
    pub async fn related_scenes_reconcile(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        napi::tokio::task::spawn_blocking(move || {
            related_scenes::reconcile(&state).map(|value| value.to_string())
        })
        .await
        .map_err(join_err_to_napi)?
        .map_err(|_| Error::from_reason("RELATED_SCENES_UNAVAILABLE"))
    }

    #[napi]
    pub async fn nir1_evidence_qualify(
        &self,
        owner_key: String,
        navigation_identity: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        napi::tokio::task::spawn_blocking(move || {
            related_scenes::qualify_evidence(&state, &owner_key, &navigation_identity)
                .map(|value| value.to_string())
        })
        .await
        .map_err(join_err_to_napi)?
        .map_err(|_| Error::from_reason("RELATED_SCENES_UNAVAILABLE"))
    }

    /// Read a bounded, request-local NIR-1 Entity/Relation graph.  The
    /// workspace path is checked against the pinned Native authority before
    /// the read transaction begins; the renderer cannot choose a different
    /// DB by changing the project or seed fields.
    #[napi]
    pub async fn nir1_graph_query(&self, payload: serde_json::Value) -> Result<String> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            expected_workspace_path: String,
            project_id: String,
            query_scene_id: String,
            seed_entity_id: String,
        }

        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let request: Request = from_wire("payload", payload)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_narrative_extraction_workspace(&workspace, &request.expected_workspace_path)?;
            let graph_request = narrative_extraction::Nir1GraphRequest {
                project_id: request.project_id,
                query_scene_id: request.query_scene_id,
                seed_entity_id: request.seed_entity_id,
            };
            let response = workspace.authority.db().with_read_transaction(|conn| {
                narrative_extraction::read_nir1_graph(conn, &graph_request)
            })?;
            Ok(serde_json::to_string(&response).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Pack typed NIR-1 context units without persisting or forwarding them.
    /// The request is deliberately a pure Native operation so renderer-side
    /// selection cannot bypass the Raw/Evidence atomicity rules.
    #[napi]
    pub async fn nir1_pack_context(&self, payload: serde_json::Value) -> Result<String> {
        run_blocking(move || {
            let request: grimodex_core::narrative_nir1::PackingRequest =
                from_wire("payload", payload)?;
            let packed = grimodex_core::narrative_nir1::pack_context(request)
                .map_err(anyhow::Error::from)?;
            Ok(serde_json::to_string(&packed).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Persist one Native-bound NIR-1 Entity/Relation Revision as an
    /// unreviewed Proposal. The existing human decision endpoint is the only
    /// path that can make it eligible for a later cold read.
    #[napi]
    pub async fn nir1_entity_relation_revision_create(
        &self,
        payload: serde_json::Value,
        workspace_binding: serde_json::Value,
    ) -> Result<String> {
        narrative_extraction_bound_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            workspace_binding,
            narrative_extraction::narrative_extraction_create_nir1_entity_relation_revision,
        )
        .await
    }

    /// Resolve live Entity/Relation identities and atomically persist the
    /// dedicated typed review Run plus its unreviewed Revision.  The Native
    /// workspace binding covers the whole transaction; a failed preparation
    /// cannot leave a resumable Run without a typed Revision.
    #[napi]
    pub async fn nir1_entity_relation_revision_prepare(
        &self,
        payload: serde_json::Value,
        workspace_binding: serde_json::Value,
    ) -> Result<String> {
        let raw = narrative_extraction_bound_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            workspace_binding,
            narrative_extraction::narrative_extraction_prepare_nir1_entity_relation_revision,
        )
        .await?;
        let value =
            serde_json::from_str(&raw).map_err(|error| Error::from_reason(error.to_string()))?;
        let receipt = narrative_extraction::nir1_entity_relation_revision_prepare_receipt(value)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        serde_json::to_string(&receipt).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Re-open one typed NIR-1 Revision from the currently pinned workspace.
    /// The workspace path is an authority check only; the project and
    /// Revision identities are rechecked inside the same read transaction.
    #[napi]
    pub async fn nir1_entity_relation_revision_read(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            expected_workspace_path: String,
            project_id: String,
            revision_id: String,
        }

        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let request: Request = from_wire("payload", payload)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_narrative_extraction_workspace(&workspace, &request.expected_workspace_path)?;
            let response = workspace.authority.db().with_read_transaction(|conn| {
                narrative_extraction::read_nir1_entity_relation_revision(
                    conn,
                    &request.project_id,
                    &request.revision_id,
                )
            })?;
            let response =
                narrative_extraction::nir1_entity_relation_revision_read_for_renderer(response)?;
            Ok(serde_json::to_string(&response).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Read the current draft or explicitly human-approved typed Revision for
    /// one dedicated review Run after a cold reopen.  Generic review bundle
    /// storage is intentionally not consulted.
    #[napi]
    pub async fn nir1_entity_relation_revision_read_current(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            expected_workspace_path: String,
            project_id: String,
            run_id: String,
        }

        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let request: Request = from_wire("payload", payload)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_narrative_extraction_workspace(&workspace, &request.expected_workspace_path)?;
            let response = workspace.authority.db().with_read_transaction(|conn| {
                narrative_extraction::read_nir1_entity_relation_revision_current(
                    conn,
                    &request.project_id,
                    &request.run_id,
                )
            })?;
            let response =
                narrative_extraction::nir1_entity_relation_revision_current_read_for_renderer(
                    response,
                )?;
            Ok(serde_json::to_string(&response).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Find and reopen the current typed review Run for a launcher target.
    /// Native filters the sealed typed Revision metadata before any ordering
    /// limit, then publishes only the dedicated renderer projection (or the
    /// target Run's unavailable reason).
    #[napi]
    pub async fn nir1_entity_relation_revision_restore(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            expected_workspace_path: String,
            project_id: String,
            entity_id: String,
            #[serde(default)]
            relation_id: Option<String>,
        }

        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let request: Request = from_wire("payload", payload)?;
            if request.expected_workspace_path.trim().is_empty()
                || request.expected_workspace_path.trim() != request.expected_workspace_path
            {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NIR1_ENTITY_RELATION_RESTORE_INVALID: expectedWorkspacePath must be non-empty and unpadded"
                )));
            }
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_narrative_extraction_workspace(
                &workspace,
                &request.expected_workspace_path,
            )?;
            let response = workspace.authority.db().with_read_transaction(|conn| {
                let Some(target) = narrative_extraction::find_nir1_entity_relation_revision_run(
                    conn,
                    &request.project_id,
                    &request.entity_id,
                    request.relation_id.as_deref(),
                )?
                else {
                    return Ok(serde_json::Value::Null);
                };
                let current = narrative_extraction::read_nir1_entity_relation_revision_current_for_revision(
                    conn,
                    &request.project_id,
                    &target.revision_id,
                )?;
                let current =
                    narrative_extraction::nir1_entity_relation_revision_current_read_for_renderer(
                        current,
                    )?;
                Ok(serde_json::json!({
                    "runId": target.run_id,
                    "response": current,
                }))
            })?;
            Ok(serde_json::to_string(&response).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Read the Native-owned A1 scene Scope binding and registry from the
    /// workspace selected at IPC arrival. The renderer supplies identity only;
    /// the active workspace path remains the Native authority check.
    #[napi]
    pub async fn narrative_scene_scope_read(&self, payload: serde_json::Value) -> Result<String> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            expected_workspace_path: String,
            project_id: String,
            scene_id: String,
        }

        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let request: Request = from_wire("payload", payload)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_narrative_extraction_workspace(&workspace, &request.expected_workspace_path)?;
            let response = workspace.authority.db().with_read_transaction(|conn| {
                narrative_extraction::read_narrative_scene_scope(
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )
            })?;
            Ok(serde_json::to_string(&response).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Atomically update one A1 scene Scope binding with Native OCC and the
    /// existing Change Feed/invalidation writer.
    #[napi]
    pub async fn narrative_scene_scope_update(&self, payload: serde_json::Value) -> Result<String> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            expected_workspace_path: String,
            payload: narrative_extraction::NarrativeSceneScopeUpdatePayload,
        }

        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let request: Request = from_wire("payload", payload)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_narrative_extraction_workspace(&workspace, &request.expected_workspace_path)?;
            let response = narrative_extraction::update_narrative_scene_scope(
                workspace.authority.db(),
                request.payload,
            )?;
            Ok(serde_json::to_string(&response).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Atomically update the project Scope vocabulary registry. Scene bindings
    /// are revalidated against the new registry inside the same transaction.
    #[napi]
    pub async fn narrative_scene_scope_registry_update(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Request {
            expected_workspace_path: String,
            payload: narrative_extraction::NarrativeSceneScopeRegistryUpdatePayload,
        }

        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let request: Request = from_wire("payload", payload)?;
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_narrative_extraction_workspace(&workspace, &request.expected_workspace_path)?;
            let response = narrative_extraction::update_narrative_scene_scope_registry(
                workspace.authority.db(),
                request.payload,
            )?;
            Ok(serde_json::to_string(&response).map_err(anyhow::Error::from)?)
        })
        .await
    }

    // ─────────────────────── semantic Phase 3 Batch 4 ───────────────────
    // 全DB commandはrun_semantic_wireがinvoke開始時のDB Arc + 4cache epochを
    // 一貫pinする。各closureは共有runtimeだけを呼び、workspaceを再解決しない。

    /// Rebuild可能なsemantic background indexingを協調停止する。
    /// 4-cache epochをrotateし、既にpin済みのscene/bulk jobはitem/chunk境界で
    /// `IPC_DERIVED_CANCELLED` を返す。途中生成したindex payloadはcommitしない。
    /// 返り値は新generationのJSON数値。
    #[napi]
    pub async fn semantic_cancel_background(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let generation = state.semantic.semantic_cancel_background();
            Ok(serde_json::to_string(&generation).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// モデルが無ければbackground downloadを開始し、状態文字列を即返す。
    /// resource欠落はBackend constructorを失敗させず、このsemantic surfaceでのみ
    /// installed/unavailable/downloading または明示エラーとして扱う。
    #[napi]
    pub async fn semantic_download_model(&self, language: String) -> Result<String> {
        let start = self
            .state
            .semantic
            .semantic_download_model(&language)
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        let status = start.status().to_string();
        if let grimodex_semantic::runtime::ModelDownloadStart::Start(job) = start {
            napi::tokio::spawn(async move {
                // job自身が成功/失敗をdone eventへ載せ、Dropでinflightを必ず解除する。
                let _ = job.run().await;
            });
        }
        serde_json::to_string(&status).map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub async fn semantic_index_scene(
        &self,
        expected_workspace_path: String,
        project_id: String,
        scene_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.semantic_index_scene(request, &project_id, &scene_id),
        )
        .await
    }

    #[napi]
    pub async fn semantic_search(
        &self,
        expected_workspace_path: String,
        project_id: String,
        query: String,
        limit: u32,
        scene_scope: Option<String>,
        description_mode: Option<bool>,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| {
                runtime.semantic_search(
                    request,
                    &project_id,
                    &query,
                    limit as usize,
                    scene_scope.as_deref(),
                    description_mode,
                )
            },
        )
        .await
    }

    /// Score a frozen Semantic Recall candidate set for diagnostic shadow or
    /// opt-in apply. This command neither reads the active workspace nor owns
    /// admission; it only returns logits, hashes, and truncation counters.
    #[napi]
    pub async fn semantic_reranker_shadow_score(
        &self,
        request: serde_json::Value,
    ) -> Result<String> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct CandidateDto {
            candidate_id: String,
            text: String,
        }

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct RequestDto {
            request_id: String,
            expected_workspace_path: String,
            project_id: String,
            audit_path_id: String,
            language: String,
            user_message: String,
            scene_tail: String,
            candidates: Vec<CandidateDto>,
        }

        let dto: RequestDto = serde_json::from_value(request)
            .map_err(|error| Error::from_reason(format!("invalid reranker request: {error}")))?;
        if dto.request_id.trim().is_empty() {
            return Err(Error::from_reason(
                "invalid reranker request: requestId must not be empty",
            ));
        }
        if dto.project_id.trim().is_empty() {
            return Err(Error::from_reason(
                "invalid reranker request: projectId must not be empty",
            ));
        }
        if !matches!(
            dto.audit_path_id.as_str(),
            "semantic_reranker" | "semantic_reranker_shadow"
        ) {
            return Err(Error::from_reason(
                "invalid reranker request: auditPathId must be semantic_reranker or semantic_reranker_shadow",
            ));
        }
        let state = Arc::clone(&self.state);
        let workspace_operation = state
            .begin_workspace_operation()
            .map_err(|error| app_err_to_napi(AppError::Anyhow(error)))?;
        let workspace_participant = state
            .ws
            .lifecycle_core()
            .begin_workspace_participant()
            .map_err(|error| app_err_to_napi(AppError::Anyhow(anyhow::anyhow!(error))))?;
        let pinned_request = pin_scoped_semantic_request(&state, &dto.expected_workspace_path)?;
        let pinned_database = pinned_request.database();
        napi::tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
            let _workspace_operation = workspace_operation;
            let _workspace_participant = workspace_participant;
            let request = grimodex_semantic::reranker::RerankerRequest {
                language: dto.language,
                user_message: dto.user_message,
                scene_tail: dto.scene_tail,
                candidates: dto
                    .candidates
                    .into_iter()
                    .map(|candidate| grimodex_semantic::reranker::RerankerCandidate {
                        candidate_id: candidate.candidate_id,
                        text: candidate.text,
                    })
                    .collect(),
            };
            let spec = *request.validate()?;
            let (normalized_query, _, _) = request.normalized_query();
            let appender: Arc<dyn grimodex_semantic::audit::SemanticAuditAppender> =
                pinned_database.clone();
            let mut audit = grimodex_semantic::audit::SemanticAuditSession::start(
                appender,
                grimodex_semantic::audit::SemanticAuditContext {
                    project_id: Some(dto.project_id.clone()),
                    operation_id: dto.request_id.clone(),
                    parent_execution_id: None,
                    path_id: dto.audit_path_id.clone(),
                    inference_kind: "reranker.cross-encoder".into(),
                    model: serde_json::json!({
                        "engine": "onnx-runtime",
                        "executionProvider": "cpu",
                        "identityCapture": "expected-before-local-artifact-load",
                        "tokenizerIdentityStatus": "pending-effective-receipt",
                        "modelId": spec.model_id,
                        "modelRevision": spec.revision,
                        "artifactSha256": spec.artifact_sha256,
                        "manifestSha256": spec.manifest_sha256,
                        "maxPairTokens": spec.max_pair_tokens,
                        "batchSize": spec.batch_size,
                        "threadCount": spec.thread_count,
                        "needsTokenTypeIds": spec.needs_token_type_ids,
                    }),
                    input: serde_json::json!({
                        "requestId": dto.request_id,
                        "language": request.language,
                        "userMessage": request.user_message,
                        "sceneTail": request.scene_tail,
                        "normalizedQuery": normalized_query,
                        "candidates": request.candidates.iter().map(|candidate| serde_json::json!({
                            "candidateId": candidate.candidate_id,
                            "text": candidate.text,
                        })).collect::<Vec<_>>(),
                    }),
                    metadata: serde_json::json!({
                        "projectId": dto.project_id,
                        "auditPathId": dto.audit_path_id,
                        "candidateCount": request.candidates.len(),
                    }),
                },
            )?;
            let mut lane_entered = false;
            let lane_result =
                try_with_semantic_reranker_lane(&state.semantic_reranker, |runtime| {
                    lane_entered = true;
                    let prepared = match runtime.prepare_score(&request) {
                        Ok(prepared) => prepared,
                        Err(error) => return audit.fail_preparation(error),
                    };
                    let model_identity = prepared.model_identity();
                    let effective_model = serde_json::json!({
                        "engine": "onnx-runtime",
                        "executionProvider": "cpu",
                        "identityCapture": "actual-loaded-artifacts",
                        "tokenizerIdentityStatus": "loaded-and-fingerprinted",
                        "modelId": model_identity.model_id,
                        "modelRevision": model_identity.model_revision,
                        "artifactSha256": model_identity.artifact_sha256,
                        "manifestSha256": model_identity.manifest_sha256,
                        "tokenizerIdentity": model_identity.tokenizer_identity,
                        "maxPairTokens": spec.max_pair_tokens,
                        "batchSize": spec.batch_size,
                        "threadCount": spec.thread_count,
                        "needsTokenTypeIds": spec.needs_token_type_ids,
                    });
                    if let Err(error) =
                        audit.record_effective_model_before_inference(effective_model)
                    {
                        return audit.fail_preparation(error);
                    }
                    audit.dispatch_and_run(
                        || runtime.score_prepared(request, prepared),
                        |result| {
                            serde_json::to_value(result).unwrap_or_else(|error| {
                                serde_json::json!({
                                    "captureState": "partial",
                                    "limitations": [format!("reranker-result-serialization: {error}")],
                                })
                            })
                        },
                    )
                });
            let result = match lane_result {
                Ok(result) => result,
                Err(error) if !lane_entered => return audit.fail_preparation(error),
                Err(error) => return Err(error),
            };
            Ok(serde_json::to_string(&result)?)
        })
        .await
        .map_err(join_err_to_napi)?
        .map_err(|error| Error::from_reason(format!("{error:#}")))
    }

    #[napi]
    pub async fn codex_index_entry(
        &self,
        expected_workspace_path: String,
        project_id: String,
        entry_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.codex_index_entry(request, &project_id, &entry_id),
        )
        .await
    }

    #[napi]
    pub async fn codex_semantic_search(
        &self,
        expected_workspace_path: String,
        project_id: String,
        query: String,
        limit: u32,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| {
                runtime.codex_semantic_search(request, &project_id, &query, limit as usize)
            },
        )
        .await
    }

    #[napi]
    pub async fn codex_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.codex_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn codex_reindex_all(
        &self,
        expected_workspace_path: String,
        project_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.codex_reindex_all(request, &project_id),
        )
        .await
    }

    #[napi]
    pub async fn events_index_entry(
        &self,
        expected_workspace_path: String,
        project_id: String,
        event_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.events_index_entry(request, &project_id, &event_id),
        )
        .await
    }

    #[napi]
    pub async fn events_semantic_search(
        &self,
        expected_workspace_path: String,
        project_id: String,
        query: String,
        limit: u32,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| {
                runtime.events_semantic_search(request, &project_id, &query, limit as usize)
            },
        )
        .await
    }

    #[napi]
    pub async fn events_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.events_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn events_reindex_all(
        &self,
        expected_workspace_path: String,
        project_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.events_reindex_all(request, &project_id),
        )
        .await
    }

    #[napi]
    pub async fn chat_index_message(
        &self,
        expected_workspace_path: String,
        project_id: String,
        message_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.chat_index_message(request, &project_id, &message_id),
        )
        .await
    }

    #[napi]
    pub async fn chat_message_search(
        &self,
        expected_workspace_path: String,
        project_id: String,
        query: String,
        limit: u32,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| {
                runtime.chat_message_search(request, &project_id, &query, limit as usize)
            },
        )
        .await
    }

    #[napi]
    pub async fn chat_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.chat_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn chat_reindex_all(
        &self,
        expected_workspace_path: String,
        project_id: String,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| runtime.chat_reindex_all(request, &project_id),
        )
        .await
    }

    #[napi]
    pub async fn semantic_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn semantic_reindex_all(
        &self,
        expected_workspace_path: String,
        project_id: String,
        run_id: Option<String>,
    ) -> Result<String> {
        run_scoped_semantic_wire(
            Arc::clone(&self.state),
            expected_workspace_path,
            move |runtime, request| {
                runtime.semantic_reindex_all(request, &project_id, run_id.as_deref())
            },
        )
        .await
    }

    #[napi]
    pub async fn semantic_chunk_context(
        &self,
        scene_id: String,
        char_start: u32,
        char_end: u32,
        padding: u32,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_chunk_context(
                request,
                &scene_id,
                char_start as usize,
                char_end as usize,
                padding as usize,
            )
        })
        .await
    }

    #[napi]
    pub async fn semantic_debug_dump(
        &self,
        project_id: String,
        scene_id: Option<String>,
        limit: Option<u32>,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_debug_dump(
                request,
                &project_id,
                scene_id.as_deref(),
                limit.map(|value| value as usize),
            )
        })
        .await
    }

    // ─────────────────────── plot_threads (Phase 3 バッチ1 — grimodex-db の
    // plot_threads モジュールを Tauri と共用。commands/plot_threads.rs の写像) ──
    //
    // Value / Vec<Value> 返しは生の SQLite 行 (列名 snake_case)。patch 型の
    // Option<Option<String>> 3 値は from_wire (serde_json::from_value) が Tauri の
    // 引数 deserialize と同一挙動で受ける。link_create / link_update の XPROJ
    // ガードは shared impl 内でサーバサイド維持される (§4.3 — db_execute への
    // 分解禁止)。

    /// プロットスレッド作成 (commands/plot_threads.rs::plot_thread_create の写像)。
    /// `payload` は camelCase の PlotThreadCreatePayload。
    /// 返り値: 作成行 (`SELECT *`、列名 snake_case) の JSON 文字列。
    #[napi]
    pub async fn plot_thread_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド更新 (空 patch 時は現行行を返す)。`patch` は camelCase の
    /// PlotThreadPatch (color / description は Option<Option<String>>)。
    /// 返り値: 更新後行の JSON 文字列。
    #[napi]
    pub async fn plot_thread_update(&self, id: String, patch: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let patch: PlotThreadPatch = from_wire("patch", patch)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::update(db, id, patch)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド削除。
    #[napi]
    pub async fn plot_thread_delete(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotDeletePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&plot_threads::delete(db, payload)?)?)
            })
        })
        .await
    }

    /// プロジェクトのスレッド一覧 (sort_order 昇順)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn plot_thread_list(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = plot_threads::list(db, project_id)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// スレッド↔シーンのリンク作成 (XPROJ ガード + phase_type 検証を含む)。
    /// `payload` は camelCase の PlotThreadLinkCreatePayload。
    /// 返り値: 作成行の JSON 文字列。
    #[napi]
    pub async fn plot_thread_link_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadLinkCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::link_create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド分岐/合流作成。request ledger・XPROJ 検証・entity
    /// insert を共有 Rust の単一 transaction で実行する。
    #[napi]
    pub async fn plot_thread_branch_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadBranchCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::branch_create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド分岐/合流更新 (OCC baseVersion 任意)。
    #[napi]
    pub async fn plot_thread_branch_update(
        &self,
        id: String,
        patch: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let patch: PlotThreadBranchPatch = from_wire("patch", patch)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::branch_update(db, id, patch)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド分岐/合流削除 (OCC baseVersion 任意)。
    #[napi]
    pub async fn plot_thread_branch_delete(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotDeletePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&plot_threads::branch_delete(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    /// Marker move + branch create/update/delete. Full before/after snapshots,
    /// durable replay identity, and all writes share one Rust transaction.
    #[napi]
    pub async fn plot_thread_move_marker_bundle(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadMoveMarkerBundlePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = plot_threads::move_marker_bundle(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// History snapshot restore. Parent/children and request ledger commit in
    /// one shared-Rust transaction.
    #[napi]
    pub async fn plot_thread_restore_snapshot(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadRestoreSnapshotPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = plot_threads::restore_snapshot(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// Atomic marker + dependent-branch delete with durable replay identity.
    #[napi]
    pub async fn plot_thread_delete_snapshot(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadDeleteSnapshotPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let result = plot_threads::delete_snapshot(db, payload)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// リンク更新 (別スレッドへの移動時は XPROJ ガード。空 patch 時は現行行)。
    /// `patch` は camelCase の PlotThreadLinkPatch (note / sortOrder は
    /// Option<Option<String>>)。
    /// 返り値: 更新後行の JSON 文字列。
    #[napi]
    pub async fn plot_thread_link_update(
        &self,
        id: String,
        patch: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let patch: PlotThreadLinkPatch = from_wire("patch", patch)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::link_update(db, id, patch)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// リンク削除。
    #[napi]
    pub async fn plot_thread_link_delete(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotDeletePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(&plot_threads::link_delete(
                    db, payload,
                )?)?)
            })
        })
        .await
    }

    /// プロジェクトの全リンク (thread の project で JOIN 絞り込み)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn plot_thread_list_links(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = plot_threads::list_links(db, project_id)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    // ─────────────────────── foreshadow (Phase 3 バッチ1 — grimodex-db の
    // foreshadow モジュールを Tauri と共用。commands/foreshadow.rs の写像) ──
    //
    // Value / Vec<Value> / 応答 struct は raw snake_case 行 or camelCase struct。
    // patch 型の Option<Option<T>> 3 値 + i64（save_anchors の from/to_pos、
    // setup_create_ai の pos 群）は from_wire (normalize_integer_numbers 込み) が
    // Tauri の引数 deserialize と同一挙動で受ける。到達不能だった旧
    // foreshadow_list は両ランタイムから撤去済み。

    /// 伏線作成 (load_bearing 検証を含む)。`payload` は camelCase の
    /// ForeshadowCreatePayload。返り値: 作成行 (snake_case) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload: ForeshadowCreatePayload, context| {
                foreshadow::create_with_renderer_authority(db, payload, Some(context))
            },
        )
        .await
    }

    /// 伏線更新 (空 patch 時は現行行)。`patch` は ForeshadowPatch (多数の
    /// Option<Option<T>>)。返り値: 更新後行の JSON 文字列。
    #[napi]
    pub async fn foreshadow_update(&self, id: String, patch: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "patch",
            patch,
            move |db, patch: ForeshadowPatch, context| {
                foreshadow::update_with_renderer_authority(db, id, patch, Some(context))
            },
        )
        .await
    }

    /// 伏線削除。呼び出し元が観測した version と一致するときだけ削除し、
    /// 削除した aggregate の receipt を返す。
    #[napi]
    pub async fn foreshadow_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload: ForeshadowDeletePayload, context| {
                foreshadow::delete_with_renderer_authority(db, payload, Some(context))
            },
        )
        .await
    }

    /// 伏線 + setup ラベル行を 1 ロックで取得。返り値: ForeshadowListWithLabels
    /// Response (camelCase struct、内部行は snake_case) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_list_with_labels(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::list_with_labels(db, project_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// 未解決 (open) 伏線 + setup ラベル行を 1 ロックで取得。
    #[napi]
    pub async fn foreshadow_list_open_for_context(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::list_open_for_context(db, project_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// シーンの setup/payoff 伏線 id。返り値: ForeshadowSceneInfoResponse
    /// (camelCase Vec<String>) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_scene_info(&self, scene_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::get_scene_info(db, scene_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// シーンの伏線コンテキスト (3 クエリ、JOIN)。返り値: ForeshadowSceneContext
    /// Response の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_scene_context(&self, scene_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::get_scene_context(db, scene_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// codex エントリに紐づく伏線一覧。返り値: ForeshadowListWithLabelsResponse
    /// の JSON 文字列。
    #[napi]
    pub async fn foreshadow_list_by_codex_entry(&self, codex_entry_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::list_by_codex_entry(db, codex_entry_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// チャプターの伏線統計 (最重 read、5 クエリ)。返り値: ForeshadowChapterStats
    /// Bundle の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_chapter_stats(&self, chapter_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::get_chapter_stats(db, chapter_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// setup 単体取得。返り値: 行 (snake_case) or null の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_setup(&self, setup_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let row = foreshadow::get_setup(db, setup_id)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// setup 更新 (空 patch は no-op)。`patch` は ForeshadowSetupPatch
    /// (Option<Option<T>>)。
    #[napi]
    pub async fn foreshadow_update_setup(
        &self,
        id: String,
        patch: serde_json::Value,
    ) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "patch",
            patch,
            move |db, patch: ForeshadowSetupPatch, context| {
                foreshadow::update_setup_with_renderer_authority(db, id, patch, context)
            },
        )
        .await
    }

    /// 伏線 + その setup 群を取得。返り値: `{"foreshadow":…,"setups":[…]}`
    /// (キーは literal、内部行は snake_case) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get(&self, id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let detail = foreshadow::get(db, id)?;
                Ok(serde_json::to_string(&detail)?)
            })
        })
        .await
    }

    /// 伏線↔codex リンク作成 (INSERT OR IGNORE)。
    #[napi]
    pub async fn foreshadow_link_codex(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            foreshadow::link_codex_with_renderer_authority,
        )
        .await
    }

    /// 伏線↔codex リンク削除。
    #[napi]
    pub async fn foreshadow_unlink_codex(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            foreshadow::unlink_codex_with_renderer_authority,
        )
        .await
    }

    /// 伏線に紐づく codex エントリ一覧。返り値: codex_entries.* 行 (snake_case)
    /// の JSON 文字列。
    #[napi]
    pub async fn foreshadow_list_linked_codex(&self, foreshadow_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = foreshadow::list_linked_codex(db, foreshadow_id)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// setup の強度を直接更新 (`strength` は null で列クリア)。
    #[napi]
    pub async fn foreshadow_set_setup_strength(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            foreshadow::set_setup_strength_with_renderer_authority,
        )
        .await
    }

    /// AI 由来 setup の upsert。`input` は camelCase の SetupCreateAiInput
    /// (fromPos/toPos は i64、lastEvaluatedAt は Option<i64> — from_wire が正規化)。
    #[napi]
    pub async fn foreshadow_setup_create_ai(&self, input: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "input",
            input,
            foreshadow::setup_create_ai_with_renderer_authority,
        )
        .await
    }

    /// orphan setup の解決 (reanchor / delete / reinsert)。`payload` は camelCase
    /// の OrphanResolvePayload (fromPos/toPos は Option<i64>)。
    /// 返り値: setup id と authoritative Foreshadow 行を含む receipt の JSON 文字列。
    #[napi]
    pub async fn foreshadow_resolve_orphan(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            foreshadow::resolve_orphan_with_renderer_authority,
        )
        .await
    }

    /// シーンのアンカーを一括保存 (batch tx)。`setups` / `payoffs` は camelCase
    /// の配列 (from/to_pos は i64)。`doc_content_size` は空 doc 判定の i64 ガード
    /// (<=2 で bulk-orphan)。
    #[napi]
    pub async fn foreshadow_save_anchors_for_scene(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                foreshadow::save_anchors_for_scene_with_renderer_authority(db, payload, context)
                    .map(serde_json::Value::Array)
            },
        )
        .await
    }

    /// シーンのアンカー mark を取得 (0 座標・orphan を除外)。返り値:
    /// AnchorMarkOutput 配列 (camelCase: from/to/markName/attrs) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_load_anchors_for_scene(&self, scene_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let marks = foreshadow::load_anchors_for_scene(db, scene_id)?;
                Ok(serde_json::to_string(&marks)?)
            })
        })
        .await
    }

    // ─────────────────────── agent_writes (Phase 3 バッチ1 — grimodex-db の
    // agent_writes モジュールを Tauri と共用。tracked write = BEGIN IMMEDIATE →
    // entity mutation + authorship_spans + undo_journal + change_events →
    // commit_or_rollback が各 impl 内で閉じる。XPROJ ガード / 楽観ロック /
    // undo-redo はサーバサイド維持) ──────────────────────────────────────────
    //
    // 19 コマンドはすべて FE が単一の `{ payload }` を送る。返り値は
    // AgentWriteResult / ProseStageResult (camelCase)。agent_write_cmd 定形で写像。

    #[napi]
    pub async fn agent_codex_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_codex_create_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_codex_update(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_codex_update_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_codex_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::agent_writes::renderer_codex_delete_impl,
        )
        .await
    }

    /// Human/import/history renderer Codex writer. Agent tool calls use the
    /// capability-bound `agent_codex_*` surface above; this alias keeps the
    /// non-Agent renderer writer contract separate at the IPC boundary while
    /// sharing the same tracked native implementation.
    #[napi]
    pub async fn codex_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_codex_create_impl,
        )
        .await
    }

    #[napi]
    pub async fn codex_update(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_codex_update_impl,
        )
        .await
    }

    #[napi]
    pub async fn codex_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::agent_writes::renderer_codex_delete_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_codex_mutate(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::codex_writes::renderer_agent_codex_mutate_impl,
        )
        .await
    }

    /// Human/import/history/restore Codex aggregate writer. This is a distinct
    /// N-API method from the capability-bound Agent command and shares only
    /// the typed Native mutation core.
    #[napi]
    pub async fn codex_mutate(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::codex_writes::renderer_codex_mutate_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_write_bundle(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_write_bundle_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_snippet_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_agent_snippet_create_impl,
        )
        .await
    }

    /// Human/import/restore Snippet create. The shared writer commits the
    /// domain row, Undo Journal, canonical Change Event, Narrative Change
    /// Feed, and idempotency receipt in one SQLite transaction.
    #[napi]
    pub async fn snippet_create(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::snippet_writes::create,
        )
        .await
    }

    /// OCC-guarded canonical Snippet update.
    #[napi]
    pub async fn snippet_update(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::snippet_writes::update,
        )
        .await
    }

    /// OCC-guarded canonical Snippet delete.
    #[napi]
    pub async fn snippet_delete(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            grimodex_db::snippet_writes::delete,
        )
        .await
    }

    #[napi]
    pub async fn agent_propose_scene_body(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_propose_scene_body_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_accept_prose_stage(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_accept_prose_stage_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_discard_prose_stage(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_discard_prose_stage_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_apply_undo_journal(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: agent_writes::AgentUndoJournalPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &agent_writes::agent_undo_journal_impl(db, payload)?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn agent_foreshadow_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::renderer_agent_foreshadow_create_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_foreshadow_update(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::renderer_agent_foreshadow_update_impl(db, payload, context)
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_event_create_with_authority_impl(db, payload, Some(context))
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_update(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_update_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_event_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_delete_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_chronicle_bulk_mutate(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                grimodex_db::chronicle_bulk::agent_chronicle_bulk_mutate_with_authority_impl(
                    db,
                    payload,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_set_participants(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_set_participants_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_scene_event_link(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p, context| {
                agent_writes::agent_scene_event_mutate_with_authority_impl(
                    db,
                    p,
                    true,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_scene_event_link_batch(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_scene_event_link_batch_with_authority_impl(
                    db,
                    payload,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_scene_event_unlink(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p, context| {
                agent_writes::agent_scene_event_mutate_with_authority_impl(
                    db,
                    p,
                    false,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_relation_add(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p, context| {
                agent_writes::agent_event_relation_mutate_with_authority_impl(
                    db,
                    p,
                    true,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_relation_remove(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p, context| {
                agent_writes::agent_event_relation_mutate_with_authority_impl(
                    db,
                    p,
                    false,
                    Some(context),
                )
            },
        )
        .await
    }

    // Human/import/history/restore Chronicle aliases. Each method enters the
    // same shared writer core as its Agent counterpart, but Main binds these
    // command names to non-Agent authority routes.
    #[napi]
    pub async fn event_create(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_event_create_with_authority_impl(db, payload, Some(context))
            },
        )
        .await
    }

    #[napi]
    pub async fn event_update(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_update_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn event_delete(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_delete_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn chronicle_bulk_mutate(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                grimodex_db::chronicle_bulk::agent_chronicle_bulk_mutate_with_authority_impl(
                    db,
                    payload,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn event_participants_set(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_set_participants_with_authority_impl,
        )
        .await
    }

    #[napi]
    pub async fn scene_event_link(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_scene_event_mutate_with_authority_impl(
                    db,
                    payload,
                    true,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn scene_event_link_batch(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_scene_event_link_batch_with_authority_impl(
                    db,
                    payload,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn scene_event_unlink(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_scene_event_mutate_with_authority_impl(
                    db,
                    payload,
                    false,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn event_relation_add(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_event_relation_mutate_with_authority_impl(
                    db,
                    payload,
                    true,
                    Some(context),
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn event_relation_remove(&self, payload: serde_json::Value) -> Result<String> {
        canonical_agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, context| {
                agent_writes::agent_event_relation_mutate_with_authority_impl(
                    db,
                    payload,
                    false,
                    Some(context),
                )
            },
        )
        .await
    }

    // ─────────────────────── narrative_extraction (Chronicle Vertical Slice PR2 —
    // persistent run / task / proposal runtime; payload → JSON string) ─────────

    /// Capture the exact active Native workspace authority for a long-running
    /// extraction. The expected path is renderer-captured scope, not a path
    /// selector: Native rejects a mismatch and always owns the returned
    /// authority id/generation.
    #[napi]
    pub async fn narrative_extraction_capture_workspace_binding(
        &self,
        expected_workspace_path: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            if expected_workspace_path.is_empty()
                || expected_workspace_path.trim() != expected_workspace_path
            {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_CHRONICLE_WORKSPACE_PATH_REQUIRED: expectedWorkspacePath must be a non-empty exact path"
                )));
            }
            let workspace = active_workspace_snapshot(&state.ws)?;
            validate_narrative_extraction_workspace(
                &workspace,
                &expected_workspace_path,
            )?;
            let binding =
                narrative_extraction_binding_for_authority(&state, &workspace.authority);

            // Workspace state and the process generation use separate locks.
            // Re-pin after binding so a replacement in between cannot return
            // an old authority paired with the replacement generation.
            let current_workspace = active_workspace_snapshot(&state.ws)?;
            let current_binding =
                narrative_extraction_binding_for_authority(&state, &current_workspace.authority);
            if !Arc::ptr_eq(&workspace.authority, &current_workspace.authority)
                || binding != current_binding
            {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED: Workspace authority changed while capturing extraction binding"
                )));
            }
            serde_json::to_string(&binding).map_err(|error| AppError::Anyhow(error.into()))
        })
        .await
    }

    #[napi]
    pub async fn narrative_extraction_create_run(
        &self,
        payload: serde_json::Value,
        workspace_binding: serde_json::Value,
    ) -> Result<String> {
        narrative_extraction_bound_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            workspace_binding,
            narrative_extraction::narrative_extraction_create_run,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_get_run(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: RunRefPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::narrative_extraction_get_run(
                        db,
                        dto.run_id,
                        dto.project_id,
                    )?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn narrative_extraction_list_resumable_runs(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: ListResumableRunsPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::narrative_extraction_list_resumable_runs(db, dto)?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn narrative_extraction_is_run_resumable_for_review(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: IsRunResumableForReviewPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::narrative_extraction_is_run_resumable_for_review(
                        db, dto,
                    )?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn narrative_extraction_list_chronicle_task_resume_candidates(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: ListChronicleTaskResumeCandidatesPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::narrative_extraction_list_chronicle_task_resume_candidates(
                        db, dto,
                    )?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn narrative_extraction_cancel_run(
        &self,
        payload: serde_json::Value,
        workspace_binding: serde_json::Value,
    ) -> Result<String> {
        narrative_extraction_bound_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            workspace_binding,
            narrative_extraction::narrative_extraction_cancel_run,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_claim_task(
        &self,
        payload: serde_json::Value,
        workspace_binding: serde_json::Value,
    ) -> Result<String> {
        narrative_extraction_bound_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            workspace_binding,
            narrative_extraction::narrative_extraction_claim_task,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_finish_task(
        &self,
        payload: serde_json::Value,
        workspace_binding: serde_json::Value,
    ) -> Result<String> {
        narrative_extraction_bound_foreground_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            workspace_binding,
            narrative_extraction::narrative_extraction_finish_task_with_control,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_fail_task(
        &self,
        payload: serde_json::Value,
        workspace_binding: serde_json::Value,
    ) -> Result<String> {
        narrative_extraction_bound_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            workspace_binding,
            narrative_extraction::narrative_extraction_fail_task,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_save_proposal_set(
        &self,
        payload: serde_json::Value,
        workspace_binding: serde_json::Value,
    ) -> Result<String> {
        narrative_extraction_bound_foreground_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            workspace_binding,
            narrative_extraction::narrative_extraction_save_proposal_set_with_control,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_create_human_derived_revision(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let wire: CreateHumanDerivedRevisionWirePayload =
                from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto(
                        db,
                        &wire.project_id,
                        wire.request,
                    )?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn narrative_extraction_get_run_review_bundle(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: RunRefPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                Ok(serde_json::to_string(
                    &narrative_extraction::narrative_extraction_get_run_review_bundle(db, dto)?,
                )?)
            })
        })
        .await
    }

    #[napi]
    pub async fn narrative_extraction_append_revision(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        foreground_commit_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_append_revision_with_control,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_append_decision(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_append_decision,
        )
        .await
    }

    /// Human review has a separate Native endpoint so an AI/automation
    /// caller cannot turn `createdBy` into a human authority grant.
    #[napi]
    pub async fn narrative_extraction_append_human_decision(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_append_human_decision,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_revise_and_decide(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        foreground_commit_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, control| {
                narrative_extraction::narrative_extraction_revise_and_decide_with_control(
                    db, payload, control,
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_revise_and_decide_as_human(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        foreground_commit_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, control| {
                narrative_extraction::narrative_extraction_revise_and_decide_as_human_with_control(
                    db, payload, control,
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_set_human_field_lock(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_set_human_field_lock,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_prepare_commit(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        foreground_commit_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, control| {
                narrative_extraction::narrative_extraction_prepare_commit_with_control(
                    db, payload, control,
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_apply_commit(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        foreground_commit_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, payload, control| {
                narrative_extraction::narrative_extraction_apply_commit_with_control(
                    db, payload, control,
                )
            },
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_get_commit_status(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_get_commit_status,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_undo_commit(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_undo_commit,
        )
        .await
    }

    #[napi]
    pub async fn narrative_extraction_redo_commit(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            narrative_extraction::narrative_extraction_redo_commit,
        )
        .await
    }

    // ─────────────────────── Gate C2 Run Kind Policy: the five named
    // operations replacing the old two-value
    // rebuildNarrativeDependencyIndex(mode: verify|repair)
    // (policies/narrative/narrative-run-kind-policy.json's apiSplit). Same
    // toolchain caveat as the block above: not through `cargo check` or
    // `napi build`, index.d.ts not regenerated. ───────────────────────────

    /// `dependency-verify`: a read-only diagnostic across the Durable
    /// Dependency Graph and Rebuildable Derived State for one project,
    /// recorded under a real Run.
    ///
    /// The diagnostic itself writes nothing to the tables it reads; the
    /// Run and its stored result exist so a later `dependency-repair` can
    /// prove *which* Verify result its sealed plan came from (the policy's
    /// `verify-first` precondition -- see `seal_repair_plan`). The response
    /// therefore carries `runId`/`reportDigest` alongside the report, not
    /// the bare report.
    ///
    /// Owns its own transactions internally, so this goes through the live
    /// `Database` rather than `with_db_state`'s single-closure shape.
    #[napi]
    pub async fn verify_narrative_dependency_graph(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: VerifyNarrativeDependencyGraphPayload = from_wire("payload", payload)?;
            let project_id = dto.project_id.clone();
            let outcome = run_manual_narrative_maintenance(
                Arc::clone(&state),
                project_id.clone(),
                AutomaticRunKind::Verify,
                dto.attempt_id.clone(),
                |db, control, work_key| {
                    narrative_extraction::run_dependency_verify_for_project_with_coordinates_and_control(
                        db,
                        &project_id,
                        None,
                        Some(control),
                        work_key,
                    )
                    .map(ManualNarrativeMaintenanceCompletion::DurableSuccess)
                },
            )?;
            Ok(serde_json::to_string(&outcome).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// `dependency-rebuild-derived`: discards and recomputes every
    /// Rebuildable Derived State row from the Durable Graph and current
    /// Source state, for every Consumer in the project. Owns its own
    /// transaction(s) internally (see the shared crate's own doc
    /// comment), so this calls it directly against the live `Database`
    /// rather than through `with_db_state`'s single-closure shape.
    #[napi]
    pub async fn rebuild_narrative_derived_state(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: RebuildNarrativeDerivedStatePayload = from_wire("payload", payload)?;
            let outcome = run_manual_narrative_maintenance(
                Arc::clone(&state),
                dto.project_id.clone(),
                AutomaticRunKind::RebuildDerived,
                dto.attempt_id.clone(),
                |db, control, work_key| {
                    narrative_extraction::rebuild_narrative_derived_state_for_project_with_control(
                        db,
                        &dto.project_id,
                        Some(control),
                        work_key,
                    )
                    .map(|outcome| {
                        if matches!(&outcome, RebuildDerivedStateOutcome::AlreadyRunning { .. }) {
                            ManualNarrativeMaintenanceCompletion::Noop(outcome)
                        } else {
                            ManualNarrativeMaintenanceCompletion::DurableSuccess(outcome)
                        }
                    })
                },
            )?;
            let wire = match outcome {
                RebuildDerivedStateOutcome::AlreadyRunning { run_id } => serde_json::json!({
                    "outcome": "alreadyRunning",
                    "runId": run_id,
                }),
                RebuildDerivedStateOutcome::Ran { run_id, summary } => serde_json::json!({
                    "outcome": "ran",
                    "runId": run_id,
                    "consumersEvaluated": summary.consumers_evaluated,
                    "edgesEvaluated": summary.edges_evaluated,
                    // Nonzero only under version skew: a Consumer declared
                    // under a kind this build does not implement is skipped
                    // rather than failing the Run, so the count has to reach
                    // the surface or the pass would read as complete.
                    "consumersSkippedUnresolvableScope":
                        summary.consumers_skipped_unresolvable_scope,
                    "edgesSkippedUnresolvableScope":
                        summary.edges_skipped_unresolvable_scope,
                }),
            };
            Ok(serde_json::to_string(&wire).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Read-only: status of the most recent Legacy Dependency Backfill Run
    /// for one project, if any.
    #[napi]
    pub async fn get_narrative_backfill_status(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: GetNarrativeBackfillStatusPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let status = db.with_conn(|conn| {
                    narrative_extraction::get_backfill_status_for_project(conn, &dto.project_id)
                })?;
                Ok(serde_json::to_string(&status)?)
            })
        })
        .await
    }

    /// Manual retry for Legacy Dependency Backfill
    /// (`dependency-backfill`'s `manualRetryRole:
    /// failure-recovery-only`) -- the automatic post-open bootstrap
    /// trigger already retries on the next Workspace open when a prior
    /// attempt failed (a `failed` Run is not reused); this triggers that
    /// same retry immediately, without waiting for a reopen. A no-op
    /// (`outcome: "alreadyRun"`) when the project already has a
    /// `pending`/`running`/`completed` Backfill Run -- there is nothing
    /// to retry.
    #[napi]
    pub async fn retry_narrative_legacy_backfill(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: RetryNarrativeLegacyBackfillPayload = from_wire("payload", payload)?;
            let outcome = run_manual_narrative_maintenance(
                Arc::clone(&state),
                dto.project_id.clone(),
                AutomaticRunKind::Backfill,
                None,
                |db, control, work_key| {
                    narrative_extraction::bootstrap_legacy_dependency_backfill_for_project_with_control(
                        db,
                        &dto.project_id,
                        Some(control),
                        work_key,
                    )
                    .map(|outcome| match outcome {
                        LegacyBackfillBootstrapOutcome::AlreadyRun { run_id } => {
                            ManualNarrativeMaintenanceCompletion::Noop(
                                LegacyBackfillBootstrapOutcome::AlreadyRun { run_id },
                            )
                        }
                        LegacyBackfillBootstrapOutcome::Ran { run_id, summary } => {
                            ManualNarrativeMaintenanceCompletion::DurableSuccess(
                                LegacyBackfillBootstrapOutcome::Ran { run_id, summary },
                            )
                        }
                    })
                },
            )?;
            let wire = match outcome {
                LegacyBackfillBootstrapOutcome::AlreadyRun { run_id } => serde_json::json!({
                    "outcome": "alreadyRun",
                    "runId": run_id,
                }),
                LegacyBackfillBootstrapOutcome::Ran { run_id, summary } => serde_json::json!({
                    "outcome": "ran",
                    "runId": run_id,
                    "epochCreated": summary.epoch_created,
                    "contributionsCreated": summary.contributions_created,
                    "edgesCreated": summary.edges_created,
                    "applicationsWithoutRunId": summary.applications_without_run_id,
                }),
            };
            Ok(serde_json::to_string(&wire).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// `dependency-repair`, manual-only. `apply: false` (the default)
    /// seals a repair plan against the project's *current* Semantic
    /// Epoch and returns it as a preview -- the policy's
    /// `change-count-preview` precondition -- without executing
    /// anything. `apply: true` executes: `planDigest` must match the
    /// digest a preview call just returned (binds the confirmation to
    /// the exact plan a human saw, not a blind re-seal that could differ
    /// if the Durable Graph changed in between) and `leaseOwner` claims
    /// the exclusive Repair lease. Every precondition failure
    /// (`NEX_REPAIR_*`) is a typed, `?`-propagated error from the shared
    /// crate or an explicit one constructed here -- never a silent
    /// fallback.
    #[napi]
    pub async fn repair_narrative_dependency_declarations(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _workspace_operation = state
                .begin_workspace_operation()
                .map_err(AppError::Anyhow)?;
            let dto: RepairNarrativeDependencyDeclarationsPayload = from_wire("payload", payload)?;
            // The policy's `exclusive-workspace-lease` precondition: from
            // backup through mutation commit, a Repair apply must be
            // serialized with workspace open/switch, snapshot restore, and
            // the other maintenance mutations. The per-project Repair row
            // lease only excludes concurrent Repairs; these process-level
            // locks exclude the operations that could swap or mutate the
            // workspace the backup is protecting. (Preview takes them too —
            // it is cheap and keeps the sealed preview bound to a stable
            // authority.)
            let _mutation_guard = state
                .narrative_maintenance_mutation_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let _workspace_open_guard = state
                .ws
                .open_lock
                .lock()
                .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
            let authority = active_database(&state.ws)?;
            let db = authority.db();

            // Preview seals a plan to show the human what would change.
            // Apply must NOT start by sealing: a retry whose first attempt
            // succeeded but whose response was lost would re-seal against
            // an already-repaired graph and fail, never reaching the stored
            // outcome. `..._for_request` resolves the request first.
            if !dto.apply {
                let current_epoch_id = db
                    .with_conn(|conn| {
                        narrative_extraction::get_current_epoch(conn, &dto.project_id)
                    })?
                    .ok_or_else(|| {
                        AppError::Anyhow(anyhow::anyhow!(
                            "NEX_REPAIR_NO_EPOCH: project '{}' has no Semantic Epoch",
                            dto.project_id
                        ))
                    })?
                    .id;
                let plan = db.with_conn(|conn| {
                    narrative_extraction::seal_repair_plan(
                        conn,
                        &dto.project_id,
                        &dto.verify_run_id,
                        &current_epoch_id,
                    )
                })?;
                let preview = serde_json::json!({
                    "mode": "preview",
                    "plan": plan,
                });
                return Ok(serde_json::to_string(&preview).map_err(anyhow::Error::from)?);
            }

            let Some(plan_digest) = dto.plan_digest.as_deref() else {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_REPAIR_PLAN_DIGEST_REQUIRED: planDigest is required when apply is true"
                )));
            };
            let Some(lease_owner) = dto.lease_owner.as_deref() else {
                return Err(AppError::Anyhow(anyhow::anyhow!(
                    "NEX_REPAIR_LEASE_OWNER_REQUIRED: leaseOwner is required when apply is true"
                )));
            };

            let workspace_path = active_workspace_path(&state.ws)?;
            let outcome =
                narrative_extraction::repair_narrative_dependency_declarations_for_request(
                    db,
                    &workspace_path,
                    &dto.project_id,
                    &dto.verify_run_id,
                    plan_digest,
                    lease_owner,
                    true,
                    &dto.request_id,
                    &dto.actor_id,
                )?;
            let applied = serde_json::json!({
                "mode": "applied",
                "outcome": outcome,
            });
            Ok(serde_json::to_string(&applied).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Set (upsert) a Maintenance Attention disposition. Never touches the
    /// Change Feed: `narrative_maintenance_attention` is durable,
    /// non-epoch-bound, `backflowPolicy: "forbid"` user state.
    #[napi]
    pub async fn narrative_maintenance_attention_set(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: NarrativeMaintenanceAttentionSetPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let disposition = AttentionDisposition::try_from(dto.disposition.as_str())?;
                let set_at = grimodex_core::now_rfc3339_millis();
                // Caller-owned transaction: the OCC read and the write must
                // not be separable, or a racing window could slip between
                // them and the version check would prove nothing.
                let outcome = narrative_extraction::set_attention(
                    db,
                    narrative_extraction::SetAttentionRequest {
                        project_id: &dto.project_id,
                        finding_key: &dto.finding_key,
                        disposition,
                        material_basis_digest: &dto.material_basis_digest,
                        snoozed_until: dto.snoozed_until.as_deref(),
                        set_at: &set_at,
                        actor_id: &dto.actor_id,
                        request_id: &dto.request_id,
                        reason: dto.reason.as_deref(),
                        expected_version: dto.expected_version,
                    },
                )?;
                Ok(serde_json::to_string(&outcome)?)
            })
        })
        .await
    }

    /// Clear a Maintenance Attention disposition under the caller's OCC
    /// token. Clearing an absent row is a no-op success only when the caller
    /// expected it to be absent (`expectedVersion: 0`); a row that has moved
    /// on since the caller read it fails with
    /// `NEX_ATTENTION_VERSION_CONFLICT` rather than being deleted silently.
    #[napi]
    pub async fn narrative_maintenance_attention_clear(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: NarrativeMaintenanceAttentionClearPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let outcome = narrative_extraction::clear_attention(
                    db,
                    &dto.project_id,
                    &dto.finding_key,
                    &dto.actor_id,
                    &dto.request_id,
                    dto.expected_version,
                )?;
                Ok(serde_json::to_string(&outcome)?)
            })
        })
        .await
    }

    /// Read-only: assemble the Maintenance Inbox for one project as of now.
    #[napi]
    pub async fn narrative_maintenance_inbox_list(
        &self,
        payload: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let dto: NarrativeMaintenanceInboxListPayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let now = grimodex_core::now_rfc3339_millis();
                let entries = db.with_conn(|conn| {
                    narrative_extraction::build_maintenance_inbox(conn, &dto.project_id, &now)
                })?;
                Ok(serde_json::to_string(&entries)?)
            })
        })
        .await
    }

    // ─────────────────────── post_effect (Phase 3 バッチ1 — pure-db 読み書き。
    // grimodex-db の post_effect モジュールを Tauri と共用。SCENE_LENS_FOR_PROJECT_SQL
    // 契約 / XPROJ ガード / snake_case ReplyToAnnotationArgs を維持。start_run 系と
    // abort・dead 2 件はバッチ3 以降) ──────────────────────────────────────────

    /// 校閲 run 一覧 (limit 省略時 20 / offset 省略時 0 はサーバサイド既定)。
    #[napi]
    pub async fn list_post_effect_runs(
        &self,
        project_id: String,
        effect_type: Option<String>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows =
                    post_effect::list_post_effect_runs(db, project_id, effect_type, limit, offset)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// Outline 用: scene ごとに最新 run の lens (`runCompletedAt` 付き) を返す。
    #[napi]
    pub async fn list_scene_lens_for_project(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = post_effect::list_scene_lens_for_project(db, project_id)?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// シーンの annotation + relation を返す (`{annotations,relations}`)。
    #[napi]
    pub async fn list_annotations_for_scene(
        &self,
        project_id: String,
        scene_id: String,
        status: Option<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = post_effect::list_annotations_for_scene(db, project_id, scene_id, status)?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// プロジェクトの annotation を返す (`{annotations}`)。
    #[napi]
    pub async fn list_annotations_for_project(
        &self,
        project_id: String,
        status: Option<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = post_effect::list_annotations_for_project(db, project_id, status)?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// annotation の status を更新 (XPROJ ガード付き、conn 直呼び)。
    #[napi]
    pub async fn update_annotation_status(
        &self,
        annotation_id: String,
        status: String,
        project_id: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = db.with_conn(|conn| {
                    post_effect::update_annotation_status_inner(
                        conn,
                        &annotation_id,
                        &status,
                        &project_id,
                    )
                })?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// 疑似コメントへの返信を追加 (`args` は snake_case の ReplyToAnnotationArgs)。
    #[napi]
    pub async fn reply_to_annotation(&self, args: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let args: ReplyToAnnotationArgs = from_wire("args", args)?;
            with_db_state(&state.ws, |db| {
                let v = db.with_conn(|conn| post_effect::reply_to_annotation_inner(conn, &args))?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// シーンの annotation を保存 (raw snake_case 配列、range_start/end は i64)。
    #[napi]
    pub async fn save_post_effect_annotations(
        &self,
        project_id: String,
        scene_id: String,
        annotations: serde_json::Value,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let annotations: Vec<serde_json::Value> = from_wire("annotations", annotations)?;
            with_db_state(&state.ws, |db| {
                post_effect::save_post_effect_annotations(db, project_id, scene_id, annotations)
            })
        })
        .await
    }

    // ─────────────────────── post_effect runner (Phase 3d — shared Rust
    // engine + EventQueue 4ch + run_id単位abort registry) ─────────────────

    /// 単一sceneの校閲runを開始し、AI完了を待たず `{run_id,from_cache}` を返す。
    /// `settings` とsecretはElectron mainが同じinvokeで取得したsnapshot。API key
    /// 未登録 (`None`) と保存済み空文字 (`Some("")`) を区別し、lookup errorも
    /// cache hitを壊さないよう背景taskまで遅延させる。
    #[napi]
    pub async fn start_post_effect_run(
        &self,
        mut args: serde_json::Value,
        settings: serde_json::Value,
        api_key: Option<String>,
        api_key_error: Option<String>,
    ) -> Result<String> {
        let caller_identity = caller_identity_from_args(&args)?;
        let dispatch = begin_profile_egress_dispatch(&self.state, caller_identity.as_ref())?;
        let expected_workspace_path = args
            .as_object_mut()
            .and_then(|object| object.remove("expectedWorkspacePath"))
            .and_then(|value| value.as_str().map(str::to_owned))
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                Error::from_reason("invalid args: expectedWorkspacePath must be a non-empty string")
            })?;
        let args: grimodex_post_effect::StartPostEffectRunArgs =
            from_wire("args", args).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let ai_dispatch = dispatch.clone();
        let runtime = NodePostEffectRuntime::new_scoped(
            Arc::clone(&self.state),
            &expected_workspace_path,
            dispatch,
        )
        .map_err(app_err_to_napi)?;
        let ai = NodePostEffectAiClient::new(settings, api_key, api_key_error)
            .with_dispatch(ai_dispatch);
        let result = grimodex_post_effect::start_post_effect_run(runtime, ai, args)
            .await
            .map_err(app_err_to_napi)?;
        serde_json::to_string(&result).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 複数sceneの校閲run。処理はscene境界でabort registryを確認し、イベントは
    /// `post_effect:{progress,partial,done,error}` をEventQueueへ配信する。
    #[napi]
    pub async fn start_post_effect_run_multi(
        &self,
        mut args: serde_json::Value,
        settings: serde_json::Value,
        api_key: Option<String>,
        api_key_error: Option<String>,
    ) -> Result<String> {
        let caller_identity = caller_identity_from_args(&args)?;
        let dispatch = begin_profile_egress_dispatch(&self.state, caller_identity.as_ref())?;
        let expected_workspace_path = args
            .as_object_mut()
            .and_then(|object| object.remove("expectedWorkspacePath"))
            .and_then(|value| value.as_str().map(str::to_owned))
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                Error::from_reason("invalid args: expectedWorkspacePath must be a non-empty string")
            })?;
        let args: grimodex_post_effect::StartPostEffectRunMultiArgs =
            from_wire("args", args).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let ai_dispatch = dispatch.clone();
        let runtime = NodePostEffectRuntime::new_scoped(
            Arc::clone(&self.state),
            &expected_workspace_path,
            dispatch,
        )
        .map_err(app_err_to_napi)?;
        let ai = NodePostEffectAiClient::new(settings, api_key, api_key_error)
            .with_dispatch(ai_dispatch);
        let result = grimodex_post_effect::start_post_effect_run_multi(runtime, ai, args)
            .await
            .map_err(app_err_to_napi)?;
        serde_json::to_string(&result).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 同一BackendのregistryとDB rowを一緒に更新する。DB上のproject ownershipを
    /// 確認できたrunning runだけにabort flagを立てるため、cross-project/late abort
    /// は別runや将来runへ波及しない。
    #[napi]
    pub async fn abort_post_effect_run(&self, run_id: String, project_id: String) -> Result<()> {
        let runtime = NodePostEffectRuntime::new(Arc::clone(&self.state));
        run_blocking(move || {
            grimodex_post_effect::abort_post_effect_run(&runtime, &run_id, &project_id)
        })
        .await
    }

    // ─────────────────────── AI チャット (Phase 3 バッチ3a — grimodex-ai を
    // Tauri と共用。HTTP/SSE/provider 分岐はクレート内で完結し、ストリーミングの
    // emit は EventQueue(=StreamEmitter) 経由で TSFn → 全窓 broadcast へ載る) ──
    //
    // **キーは注入**: Tauri の resolve_api_key(keyring) と異なり、napi は main の
    // safeStorage で解決した平文キーを `api_key` 引数で受ける。パラメータ準備
    // (apply_provider_override / build_chat_params 等) は Tauri と同一の pure helper。

    /// AI 設定を読む (Tauri の get_ai_settings と同一 — ai-settings.json、キー非含有)。
    /// 返り値: `AiSettings` の JSON 文字列 (camelCase)。
    #[napi]
    pub async fn get_ai_settings(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let settings = grimodex_ai::read_ai_settings(&state.ai_settings_path);
            Ok(serde_json::to_string(&settings).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// AI 設定を `<appData>/ai-settings.json` へ保存する (Tauri の
    /// `save_ai_settings` と同一)。API キーは別の safeStorage 経路なので含まない。
    #[napi]
    pub async fn save_ai_settings(&self, settings: serde_json::Value) -> Result<()> {
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            grimodex_ai::write_ai_settings(&state.ai_settings_path, &settings)?;
            Ok(())
        })
        .await
    }

    /// 非ストリーミングのチャット送信 (Tauri の send_chat_message と同一ロジック。
    /// キーは注入)。`args` は camelCase の ChatRequest、`api_key` は解決済み平文。
    /// `settings` は **呼び側 (dispatchInvoke) が getAiSettings で1回だけ読んだ AiSettings
    /// スナップショット** — キー解決と送信を同一スナップショットで行い、Tauri の
    /// 単一 read_ai_settings と同じ原子性を保つ (2 度読みの TOCTOU 回避)。
    /// 返り値: `ChatResponse` の JSON 文字列 (camelCase)。
    #[napi]
    pub async fn send_chat_message(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: ChatRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let dispatch = begin_profile_egress_dispatch(&self.state, req.caller_identity.as_ref())?;
        let audit_context = req.audit_context.clone();
        let audit_workspace =
            pin_native_ai_audit_workspace(&self.state, &audit_context).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let settings_for_call = grimodex_ai::apply_provider_override(
            settings,
            req.model.as_deref(),
            req.provider,
            req.endpoint_id.as_deref(),
        );
        grimodex_ai::validate_expected_ollama_endpoint(
            &settings_for_call.provider,
            &settings_for_call.ollama_endpoint,
            req.expected_ollama_endpoint.as_deref(),
        )
        .map_err(native_ai_error_to_napi)?;
        let variant = req.api_variant.as_deref();
        let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
        let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
        let resolved_variant =
            grimodex_ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
        let mut params = grimodex_ai::build_chat_params(
            &settings_for_call,
            &api_key,
            extra_body,
            retry_429,
            grimodex_ai::AiNovelistMode::Chat,
            resolved_variant,
            req.thinking,
            req.effort,
            req.reasoning_enabled,
            req.reasoning_effort,
            req.system_cache_segments,
            req.system_volatile_tail,
            None,
        );
        params.request_max_output_tokens = req.request_max_output_tokens;
        attach_native_ai_http_observer(
            &mut params,
            &settings_for_call,
            &audit_workspace,
            audit_context,
        );
        let msgs: Vec<(&str, &str)> = req
            .messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect();
        dispatch
            .ensure_open()
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        let result = grimodex_ai::send_chat(&params, &msgs)
            .await
            .map_err(native_ai_error_to_napi)?;
        serde_json::to_string(&result)
            .map_err(|e| Error::from_reason(format!("failed to serialize ChatResponse: {e}")))
    }

    /// ストリーミングのチャット送信 (Tauri の send_chat_message_stream と同一)。
    /// チャンクは `chat:stream-chunk` / 完了は `chat:stream-done` を EventQueue へ emit。
    /// 失敗時は `chat:stream-error` を emit してから reject する (Tauri と同一契約 —
    /// FE の fire-and-forget .catch と listen error の両経路を保つ)。
    /// `streamId` は audit execution ID と一致必須。ストリームごとの cancellation
    /// registry へ登録し、他の同時ストリームとは隔離する。全 emit に同じ ID を付ける。
    #[napi]
    pub async fn send_chat_message_stream(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<()> {
        let req: ChatRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let stream_id = req.stream_id.as_deref().unwrap_or_default();
        if stream_id.trim().is_empty()
            || stream_id != stream_id.trim()
            || stream_id != req.audit_context.execution_id
        {
            return Err(Error::from_reason(
                "streamId must be trimmed and equal auditContext.executionId".to_string(),
            ));
        }
        let stream_id = stream_id.to_string();
        let cancellation = self
            .state
            .chat_streams
            .register(&stream_id)
            .map_err(native_ai_error_to_napi)?;
        let dispatch =
            match begin_profile_egress_dispatch(&self.state, req.caller_identity.as_ref()) {
                Ok(dispatch) => dispatch,
                Err(error) => {
                    self.state.chat_streams.complete(&stream_id, &cancellation);
                    return Err(error);
                }
            };
        let outcome: Result<()> = async {
            let audit_context = req.audit_context.clone();
            let audit_workspace = pin_native_ai_audit_workspace(&self.state, &audit_context)
                .map_err(app_err_to_napi)?;
            let settings: grimodex_ai::AiSettings =
                from_wire("settings", settings).map_err(app_err_to_napi)?;
            let flag = cancellation.abort_flag();
            let emitter =
                CorrelatedStreamEmitter::new(self.state.events.clone(), stream_id.clone());
            let settings_for_call = grimodex_ai::apply_provider_override(
                settings,
                req.model.as_deref(),
                req.provider,
                req.endpoint_id.as_deref(),
            );
            grimodex_ai::validate_expected_ollama_endpoint(
                &settings_for_call.provider,
                &settings_for_call.ollama_endpoint,
                req.expected_ollama_endpoint.as_deref(),
            )
            .map_err(native_ai_error_to_napi)?;
            let variant = req.api_variant.as_deref();
            let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
            let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
            let resolved_variant = grimodex_ai::resolve_api_variant(
                variant,
                &settings_for_call,
                &settings_for_call.model,
            );
            let mut params = grimodex_ai::build_chat_params(
                &settings_for_call,
                &api_key,
                extra_body,
                retry_429,
                grimodex_ai::AiNovelistMode::Chat,
                resolved_variant,
                req.thinking,
                req.effort,
                req.reasoning_enabled,
                req.reasoning_effort,
                req.system_cache_segments,
                req.system_volatile_tail,
                None,
            );
            params.request_max_output_tokens = req.request_max_output_tokens;
            attach_native_ai_http_observer(
                &mut params,
                &settings_for_call,
                &audit_workspace,
                audit_context,
            );
            let msgs: Vec<(&str, &str)> = req
                .messages
                .iter()
                .map(|m| (m.role.as_str(), m.content.as_str()))
                .collect();
            dispatch
                .ensure_open()
                .map_err(|error| Error::from_reason(format!("{error:#}")))?;
            let result =
                grimodex_ai::send_chat_stream(&params, &msgs, flag, &emitter, "chat").await;
            if let Err(e) = result {
                let napi_error = native_ai_error_to_napi(e);
                let sanitized_error = napi_error.reason.clone();
                grimodex_ai::emit::StreamEmitter::emit(
                    &emitter,
                    "chat:stream-error",
                    serde_json::json!({ "message": sanitized_error }),
                );
                return Err(napi_error);
            }
            Ok(())
        }
        .await;
        self.state.chat_streams.complete(&stream_id, &cancellation);
        outcome
    }

    /// 指定 `streamId` のチャットだけを中止し、そのローカル処理が quiesce するまで待つ。
    /// 未登録 ID は将来の同 ID 登録だけに効く bounded tombstone となり false を返す。
    #[napi]
    pub async fn abort_chat_stream(&self, stream_id: String) -> Result<bool> {
        self.state
            .chat_streams
            .abort(&stream_id)
            .await
            .map_err(native_ai_error_to_napi)
    }

    /// インライン AI のストリーミング送信。`inline-ai:stream-*` へ emit し、
    /// AI のべりすとでは Completion mode を使う。チャットとは別の per-stream
    /// cancellation registry を使い、全 emit に audit execution ID を付ける。
    #[napi]
    pub async fn send_inline_ai_stream(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<()> {
        let req: InlineAiRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        if req.stream_id.trim().is_empty()
            || req.stream_id != req.stream_id.trim()
            || req.stream_id != req.audit_context.execution_id
        {
            return Err(Error::from_reason(
                "streamId must be trimmed and equal auditContext.executionId".to_string(),
            ));
        }
        let stream_id = req.stream_id.clone();
        let cancellation = self
            .state
            .inline_ai_streams
            .register(&stream_id)
            .map_err(native_ai_error_to_napi)?;
        let dispatch =
            match begin_profile_egress_dispatch(&self.state, req.caller_identity.as_ref()) {
                Ok(dispatch) => dispatch,
                Err(error) => {
                    self.state
                        .inline_ai_streams
                        .complete(&stream_id, &cancellation);
                    return Err(error);
                }
            };
        let outcome: Result<()> = async {
            let audit_context = req.audit_context.clone();
            let audit_workspace = pin_native_ai_audit_workspace(&self.state, &audit_context)
                .map_err(app_err_to_napi)?;
            let settings: grimodex_ai::AiSettings =
                from_wire("settings", settings).map_err(app_err_to_napi)?;

            let flag = cancellation.abort_flag();
            let emitter =
                CorrelatedStreamEmitter::new(self.state.events.clone(), stream_id.clone());
            let settings_for_call = grimodex_ai::apply_provider_override(
                settings,
                req.model.as_deref(),
                req.provider,
                req.endpoint_id.as_deref(),
            );
            let effective_variant = grimodex_ai::inline_effective_variant(
                &settings_for_call,
                req.api_variant.as_deref(),
            );
            let variant = effective_variant.as_deref();
            let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
            let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
            let resolved_variant = grimodex_ai::resolve_api_variant(
                variant,
                &settings_for_call,
                &settings_for_call.model,
            );
            let mut params = grimodex_ai::build_chat_params(
                &settings_for_call,
                &api_key,
                extra_body,
                retry_429,
                grimodex_ai::AiNovelistMode::Completion,
                resolved_variant,
                req.thinking,
                req.effort,
                req.reasoning_enabled,
                req.reasoning_effort,
                None,
                None,
                None,
            );
            attach_native_ai_http_observer(
                &mut params,
                &settings_for_call,
                &audit_workspace,
                audit_context,
            );
            let msgs: Vec<(&str, &str)> = req
                .messages
                .iter()
                .map(|m| (m.role.as_str(), m.content.as_str()))
                .collect();
            dispatch
                .ensure_open()
                .map_err(|error| Error::from_reason(format!("{error:#}")))?;
            let result =
                grimodex_ai::send_chat_stream(&params, &msgs, flag, &emitter, "inline-ai").await;
            if let Err(e) = result {
                let napi_error = native_ai_error_to_napi(e);
                let sanitized_error = napi_error.reason.clone();
                grimodex_ai::emit::StreamEmitter::emit(
                    &emitter,
                    "inline-ai:stream-error",
                    serde_json::json!({ "message": sanitized_error }),
                );
                return Err(napi_error);
            }
            Ok(())
        }
        .await;
        self.state
            .inline_ai_streams
            .complete(&stream_id, &cancellation);
        outcome
    }

    /// 指定 `streamId` のインライン AI だけを中止し、ローカル quiescence まで待つ。
    /// 未登録 ID は将来の同 ID 登録だけに効く bounded tombstone となり false を返す。
    #[napi]
    pub async fn abort_inline_ai_stream(&self, stream_id: String) -> Result<bool> {
        self.state
            .inline_ai_streams
            .abort(&stream_id)
            .await
            .map_err(native_ai_error_to_napi)
    }

    /// Tool Use 対応の Agent 送信。tool protocol 解決・Hermes/native の安全ゲートを
    /// 含む `grimodex_ai::send_chat_with_tools` をTauriと共用する。
    #[napi]
    pub async fn send_agent_message(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: AgentRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let dispatch = begin_profile_egress_dispatch(&self.state, req.caller_identity.as_ref())?;
        let audit_context = req.audit_context.clone();
        let audit_workspace =
            pin_native_ai_audit_workspace(&self.state, &audit_context).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let settings_for_call = grimodex_ai::apply_provider_override(
            settings,
            req.model.as_deref(),
            req.provider,
            req.endpoint_id.as_deref(),
        );
        grimodex_ai::validate_expected_ollama_endpoint(
            &settings_for_call.provider,
            &settings_for_call.ollama_endpoint,
            req.expected_ollama_endpoint.as_deref(),
        )
        .map_err(native_ai_error_to_napi)?;
        let variant = req.api_variant.as_deref();
        let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
        let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
        let resolved_variant =
            grimodex_ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
        let mut params = grimodex_ai::build_chat_params(
            &settings_for_call,
            &api_key,
            extra_body,
            retry_429,
            grimodex_ai::AiNovelistMode::Chat,
            resolved_variant,
            req.thinking,
            req.effort,
            req.reasoning_enabled,
            req.reasoning_effort,
            req.system_cache_segments,
            req.system_volatile_tail,
            req.web_search,
        );
        params.request_max_output_tokens = req.request_max_output_tokens;
        if let Some(resolved_tool_protocol) = req.resolved_tool_protocol {
            params.resolved_tool_protocol = resolved_tool_protocol;
        }
        attach_native_ai_http_observer(
            &mut params,
            &settings_for_call,
            &audit_workspace,
            audit_context,
        );
        dispatch
            .ensure_open()
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        let result = grimodex_ai::send_chat_with_tools(&params, &req.messages, &req.tools)
            .await
            .map_err(native_ai_error_to_napi)?;
        serde_json::to_string(&result)
            .map_err(|e| Error::from_reason(format!("failed to serialize ChatResponse: {e}")))
    }

    /// provider のモデル一覧を取得する。`settings` はmainが1回読んだsnapshot、
    /// `api_key` はsafeStorageにキーが無い場合も空文字で注入される。
    #[napi]
    pub async fn list_ai_models(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: ListAiModelsRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let dispatch = begin_profile_egress_dispatch(&self.state, req.caller_identity.as_ref())?;
        let mut settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        if let Some(endpoint_id) = req.endpoint_id.as_deref().filter(|id| !id.is_empty()) {
            if settings.has_openai_compatible_endpoint(endpoint_id) {
                settings.active_openai_compatible_endpoint_id = Some(endpoint_id.to_string());
            }
        }
        grimodex_ai::validate_expected_ollama_endpoint(
            &req.provider,
            &settings.ollama_endpoint,
            req.expected_ollama_endpoint.as_deref(),
        )
        .map_err(native_ai_error_to_napi)?;
        dispatch
            .ensure_open()
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        let models = grimodex_ai::fetch_models_for(
            &req.provider,
            &api_key,
            settings.endpoints(),
            req.selected_model_id
                .as_deref()
                .filter(|model| !model.trim().is_empty()),
        )
        .await
        .map_err(native_ai_error_to_napi)?;
        serde_json::to_string(&models)
            .map_err(|e| Error::from_reason(format!("failed to serialize AI models: {e}")))
    }

    /// 最小リクエストでAI接続を確認する。variant解決はテスト対象providerを設定へ
    /// 反映してから行い、OpenAI互換endpointの既定variantを正しく選ぶ。
    #[napi]
    pub async fn test_ai_connection(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: TestAiConnectionRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let dispatch = begin_profile_egress_dispatch(&self.state, req.caller_identity.as_ref())?;
        let audit_context = req.audit_context.clone();
        let audit_workspace =
            pin_native_ai_audit_workspace(&self.state, &audit_context).map_err(app_err_to_napi)?;
        let mut settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        settings.provider = req.provider.clone();
        settings.model = req.model.clone();
        if let Some(endpoint_id) = req.endpoint_id.as_deref().filter(|id| !id.is_empty()) {
            if settings.has_openai_compatible_endpoint(endpoint_id) {
                settings.active_openai_compatible_endpoint_id = Some(endpoint_id.to_string());
            }
        }
        let variant =
            grimodex_ai::resolve_api_variant(req.api_variant.as_deref(), &settings, &req.model);
        let route = NativeAiHttpAuditRoute {
            provider: req.provider.to_string(),
            model: req.model.clone(),
            api_variant: variant.clone(),
            endpoint_id: matches!(req.provider, grimodex_ai::AiProvider::OpenaiCompatible)
                .then(|| settings.active_openai_compatible_endpoint_id.clone())
                .flatten(),
        };
        let effective_request_configuration = NativeAiEffectiveRequestConfiguration {
            ai_novelist_mode: "chat",
            request_max_output_tokens: if matches!(
                req.provider,
                grimodex_ai::AiProvider::OpenAI | grimodex_ai::AiProvider::Sakana
            ) {
                1_024
            } else {
                32
            },
            resolved_tool_protocol: "native",
            retry_429: false,
            extra_body: None,
            openrouter_provider_pin: None,
            fusion: None,
        };
        let appender: Arc<dyn NativeAiAuditAppender> = audit_workspace.db().clone();
        let observer = NativeAiHttpAuditObserver {
            appender,
            context: audit_context,
            route,
            effective_request_configuration,
        };
        dispatch
            .ensure_open()
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        grimodex_ai::test_connection_with_observer(
            &req.provider,
            &req.model,
            &api_key,
            settings.endpoints(),
            variant.as_deref(),
            Some(&observer),
        )
        .await
        .map_err(native_ai_error_to_napi)
    }

    /// main 起動時に 1 回登録する (§7.1)。コールバックは
    /// `(channel: string, payloadJson: string)` の 2 引数。登録前に emit された
    /// イベント (`backend:ready`) は登録時に emit 順で flush される。
    /// TSFn は unref 済み — 登録が Node のイベントループを生かし続けることは
    /// ない (プロセス終了を妨げない)。
    #[napi]
    pub fn on_event(&self, env: Env, callback: JsFunction) -> Result<()> {
        let mut tsfn: EventTsfn = callback.create_threadsafe_function(
            0,
            |ctx: ThreadSafeCallContext<(String, String)>| {
                let channel = ctx.env.create_string(&ctx.value.0)?;
                let payload = ctx.env.create_string(&ctx.value.1)?;
                Ok(vec![channel, payload])
            },
        )?;
        tsfn.unref(&env)?;
        self.state.events.register(tsfn);
        Ok(())
    }
}

#[cfg(test)]
mod native_ai_http_audit_tests {
    use super::*;
    use grimodex_ai::HttpRetryObserver;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn test_context(workspace_path: &std::path::Path) -> NativeAiAuditContext {
        NativeAiAuditContext {
            expected_workspace_path: workspace_path.to_string_lossy().into_owned(),
            project_id: Some("project-a".to_string()),
            operation_id: "operation-a".to_string(),
            execution_id: "execution-a".to_string(),
            parent_execution_id: Some("parent-a".to_string()),
            path_id: "chat_nonstream".to_string(),
        }
    }

    fn test_route() -> NativeAiHttpAuditRoute {
        NativeAiHttpAuditRoute {
            provider: "openai-compatible".to_string(),
            model: "model-a".to_string(),
            api_variant: Some("responses".to_string()),
            endpoint_id: Some("endpoint-a".to_string()),
        }
    }

    fn test_effective_request_configuration() -> NativeAiEffectiveRequestConfiguration {
        NativeAiEffectiveRequestConfiguration {
            ai_novelist_mode: "chat",
            request_max_output_tokens: 4_096,
            resolved_tool_protocol: "native",
            retry_429: true,
            extra_body: None,
            openrouter_provider_pin: None,
            fusion: None,
        }
    }

    #[test]
    fn native_http_observer_persists_correlated_transport_attempt_sequence() -> anyhow::Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-http-audit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir)?;
        let database = Arc::new(Database::new(&dir.join("grimodex.db"))?);
        database.migrate()?;
        database.with_conn(|connection| {
            connection.execute(
                "INSERT INTO projects (id, title, language) VALUES (?1, 'Audit', 'ja')",
                ["project-a"],
            )?;
            Ok(())
        })?;
        let context = test_context(&dir);
        database.append_ai_audit_events(
            "project-a",
            &[
                native_ai_transport_event(
                    &context,
                    0,
                    "renderer-start",
                    "execution.started",
                    1,
                    serde_json::json!({ "captureState": "complete" }),
                ),
                native_ai_transport_event(
                    &context,
                    0,
                    "renderer-prepared",
                    "request.prepared",
                    2,
                    serde_json::json!({
                        "captureState": "complete",
                        "credentialsExcluded": true,
                        "request": { "body": { "prompt": "renderer-observed" } },
                    }),
                ),
                native_ai_transport_event(
                    &context,
                    0,
                    "renderer-dispatched",
                    "request.dispatched",
                    3,
                    serde_json::json!({ "captureState": "complete" }),
                ),
            ],
        )?;
        let appender: Arc<dyn NativeAiAuditAppender> = database.clone();
        let observer = NativeAiHttpAuditObserver {
            appender,
            context: context.clone(),
            route: test_route(),
            effective_request_configuration: test_effective_request_configuration(),
        };

        let effective_body = serde_json::json!({
            "model": "model-a",
            "max_output_tokens": 4_096,
            "input": [{ "role": "user", "content": "exact prompt" }],
        });
        observer.request_prepared(&grimodex_ai::HttpPreparedRequest {
            body: Some(effective_body.clone()),
        })?;

        observer.attempt_started(&grimodex_ai::HttpAttemptStarted {
            attempt_number: 1,
            send_ordinal: 1,
            is_retry: false,
            reuses_initial_payload: false,
            endpoint: Some(grimodex_ai::HttpAttemptEndpoint {
                origin: "https://api.example.test".to_string(),
                host: "api.example.test".to_string(),
            }),
        })?;
        observer.attempt_finished(&grimodex_ai::HttpAttemptFinished {
            attempt_number: 1,
            actual_send_count: Some(1),
            status: Some(429),
            retry_enabled: true,
            retry_after_observed_ms: Some(2_000),
            retry_delay_ms: Some(2_000),
            retry_delay_source: Some(grimodex_ai::HttpRetryDelaySource::RetryAfter),
            will_retry: true,
            retry_exhausted: false,
            retry_payload_clone_unavailable: false,
            local_abort_observed: false,
            provider_abort_receipt_observed: false,
            is_final: false,
        })?;
        observer.attempt_started(&grimodex_ai::HttpAttemptStarted {
            attempt_number: 2,
            send_ordinal: 2,
            is_retry: true,
            reuses_initial_payload: true,
            endpoint: Some(grimodex_ai::HttpAttemptEndpoint {
                origin: "https://api.example.test".to_string(),
                host: "api.example.test".to_string(),
            }),
        })?;
        observer.attempt_finished(&grimodex_ai::HttpAttemptFinished {
            attempt_number: 2,
            actual_send_count: Some(2),
            status: Some(200),
            retry_enabled: true,
            retry_after_observed_ms: None,
            retry_delay_ms: None,
            retry_delay_source: None,
            will_retry: false,
            retry_exhausted: false,
            retry_payload_clone_unavailable: false,
            local_abort_observed: false,
            provider_abort_receipt_observed: false,
            is_final: true,
        })?;

        let snapshot = database.read_ai_audit_snapshot_for_scope(
            context.project_id.as_deref(),
            Some(3),
            None,
            None,
        )?;
        assert_eq!(
            snapshot
                .events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            [
                "request.prepared",
                "transport.attempt.started",
                "transport.attempt.finished",
                "execution.retrying",
                "transport.attempt.started",
                "transport.attempt.finished",
            ]
        );
        for event in &snapshot.events {
            assert_eq!(event.execution_id, context.execution_id);
            assert_eq!(event.operation_id, context.operation_id);
            assert_eq!(event.parent_execution_id, context.parent_execution_id);
            assert_eq!(event.path_id, context.path_id);
        }
        let effective_request = &snapshot.events[0];
        assert_eq!(
            effective_request.event_id,
            native_ai_effective_request_event_id(&context)
        );
        assert_eq!(effective_request.payload["captureState"], "complete");
        assert_eq!(effective_request.payload["effectiveRequestReceipt"], true);
        assert_eq!(effective_request.payload["request"]["body"], effective_body);
        assert_eq!(
            effective_request.payload["effectiveRequestConfiguration"]["source"],
            "finalized-reqwest-json-value"
        );
        assert_eq!(effective_request.payload["workspacePinned"], true);
        assert_eq!(
            effective_request.payload["limitations"],
            serde_json::json!([])
        );

        let started = &snapshot.events[1].payload;
        assert_eq!(started["attemptNumber"], 1);
        assert_eq!(started["sendOrdinal"], 1);
        assert_eq!(started["sendPhase"], "pre-send");
        assert!(started.get("actualHttpSendCount").is_none());
        assert_eq!(started["route"]["provider"], "openai-compatible");
        assert_eq!(started["route"]["model"], "model-a");
        assert_eq!(started["route"]["apiVariant"], "responses");
        assert_eq!(started["route"]["endpointId"], "endpoint-a");
        assert_eq!(
            started["route"]["endpointOrigin"],
            "https://api.example.test"
        );
        assert_eq!(
            started["requestContentReference"]["eventType"],
            "request.prepared"
        );
        assert_eq!(
            started["requestContentReference"]["eventId"],
            native_ai_effective_request_event_id(&context)
        );
        assert_eq!(started["captureState"], "complete");
        assert_eq!(
            started["effectiveRequestConfiguration"]["source"],
            "native-chat-params"
        );
        assert_eq!(
            started["effectiveRequestConfiguration"]["credentialsExcluded"],
            true
        );
        assert_eq!(
            started["effectiveRequestConfiguration"]["providerBodyDuplicated"],
            false
        );
        assert_eq!(
            started["effectiveRequestConfiguration"]["aiNovelistMode"],
            "chat"
        );
        assert_eq!(
            started["effectiveRequestConfiguration"]["resolvedToolProtocol"],
            "native"
        );
        assert_eq!(started["effectiveRequestConfiguration"]["retry429"], true);
        let first_finished = &snapshot.events[2].payload;
        assert_eq!(first_finished["sendPhase"], "send-invoked");
        assert_eq!(first_finished["status"], 429);
        assert_eq!(first_finished["willRetry"], true);
        assert_eq!(first_finished["retryAfterObservedMs"], 2_000);
        assert_eq!(first_finished["retryDelayMs"], 2_000);
        assert_eq!(first_finished["retryDelaySource"], "retry-after");
        assert_eq!(snapshot.events[3].payload["reason"], "http-429");
        assert_eq!(snapshot.events[3].payload["nextAttemptNumber"], 2);
        assert_eq!(snapshot.events[4].payload["reusesInitialPayload"], true);
        let final_finished = &snapshot.events[5].payload;
        assert_eq!(final_finished["status"], 200);
        assert_eq!(final_finished["finalStatus"], 200);
        assert_eq!(final_finished["willRetry"], false);
        assert_eq!(final_finished["retryExhausted"], false);
        assert_eq!(final_finished["isFinal"], true);

        let durable_json = serde_json::to_string(&snapshot)?;
        for forbidden in ["authorization", "api_key", "password", "secret-value"] {
            assert!(!durable_json.to_ascii_lowercase().contains(forbidden));
        }

        drop(observer);
        drop(database);
        let _ = std::fs::remove_dir_all(dir);
        Ok(())
    }

    #[derive(Default)]
    struct CommitThenLoseReplyAppender {
        calls: AtomicUsize,
        committed: Mutex<Vec<AppendAiAuditEvent>>,
    }

    fn assert_same_event(left: &AppendAiAuditEvent, right: &AppendAiAuditEvent) {
        assert_eq!(left.event_id, right.event_id);
        assert_eq!(left.execution_id, right.execution_id);
        assert_eq!(left.operation_id, right.operation_id);
        assert_eq!(left.parent_execution_id, right.parent_execution_id);
        assert_eq!(left.path_id, right.path_id);
        assert_eq!(left.event_type, right.event_type);
        assert_eq!(left.timestamp, right.timestamp);
        assert_eq!(left.payload, right.payload);
    }

    impl NativeAiAuditAppender for CommitThenLoseReplyAppender {
        fn append(
            &self,
            _project_id: Option<&str>,
            events: &[AppendAiAuditEvent],
        ) -> anyhow::Result<()> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst);
            let mut committed = self
                .committed
                .lock()
                .map_err(|_| anyhow::anyhow!("committed event mutex poisoned"))?;
            for event in events {
                if let Some(existing) = committed
                    .iter()
                    .find(|existing| existing.event_id == event.event_id)
                {
                    assert_same_event(existing, event);
                } else {
                    committed.push(event.clone());
                }
            }
            if call == 0 {
                anyhow::bail!("injected reply loss after commit");
            }
            Ok(())
        }
    }

    #[test]
    fn native_http_observer_retries_exact_event_after_commit_reply_loss() -> anyhow::Result<()> {
        let appender = Arc::new(CommitThenLoseReplyAppender::default());
        let context = test_context(std::path::Path::new("/workspace"));
        let observer = NativeAiHttpAuditObserver {
            appender: appender.clone(),
            context,
            route: test_route(),
            effective_request_configuration: test_effective_request_configuration(),
        };

        observer.request_prepared(&grimodex_ai::HttpPreparedRequest {
            body: Some(serde_json::json!({
                "model": "model-a",
                "messages": [{ "role": "user", "content": "exact prompt" }],
            })),
        })?;

        assert_eq!(appender.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            appender
                .committed
                .lock()
                .map_err(|_| anyhow::anyhow!("committed event mutex poisoned"))?
                .len(),
            1
        );
        Ok(())
    }

    #[test]
    fn native_route_is_derived_from_the_same_effective_params_snapshot() {
        let settings = grimodex_ai::AiSettings {
            provider: grimodex_ai::AiProvider::OpenaiCompatible,
            model: "effective-model".to_string(),
            active_openai_compatible_endpoint_id: Some("effective-endpoint".to_string()),
            openai_compatible_endpoints: vec![grimodex_ai::OpenaiCompatibleEndpoint {
                id: "effective-endpoint".to_string(),
                base_url: "https://gateway.example.test/v1".to_string(),
                api_variant: Some("responses".to_string()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let resolved_variant = grimodex_ai::resolve_api_variant(None, &settings, &settings.model);
        let params = grimodex_ai::build_chat_params(
            &settings,
            "secret-not-copied-to-route",
            None,
            false,
            grimodex_ai::AiNovelistMode::Chat,
            resolved_variant,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        let mut params = params;
        params.request_max_output_tokens = Some(2_048);
        params.resolved_tool_protocol = grimodex_ai::ResolvedToolProtocol::Hermes;

        let route = NativeAiHttpAuditRoute::from_params(&settings, &params);
        let effective = NativeAiEffectiveRequestConfiguration::from_params(&params);
        assert_eq!(route.provider, params.provider.to_string());
        assert_eq!(route.model, params.model);
        assert_eq!(route.api_variant.as_deref(), params.api_variant.as_deref());
        assert_eq!(route.endpoint_id.as_deref(), Some("effective-endpoint"));
        assert_eq!(
            params.endpoints.openai_compat_custom,
            "https://gateway.example.test/v1"
        );
        assert!(!format!("{route:?}").contains(params.api_key));
        assert_eq!(effective.ai_novelist_mode, "chat");
        assert_eq!(effective.request_max_output_tokens, 2_048);
        assert_eq!(effective.resolved_tool_protocol, "hermes");
        assert!(!effective.retry_429);
        assert_eq!(effective.extra_body, None);
        assert_eq!(effective.openrouter_provider_pin, None);
        assert_eq!(effective.fusion, None);
        assert!(!format!("{effective:?}").contains(params.api_key));
    }

    #[test]
    fn native_effective_configuration_projects_ai_novelist_wire_settings_without_credentials() {
        let settings = grimodex_ai::AiSettings {
            provider: grimodex_ai::AiProvider::AiNovelist,
            model: "derrida_03".to_string(),
            ai_novelist: grimodex_ai::AiNovelistSettings {
                sampling: Some(serde_json::json!({
                    "top_a": 0.42,
                    "tailfree": 0.91,
                    "api_key": "settings-secret-must-not-be-captured",
                })),
                multilingual_mode: Some(true),
                ..Default::default()
            },
            ..Default::default()
        };
        let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings, Some("legacy"));
        let mut params = grimodex_ai::build_chat_params(
            &settings,
            "transport-secret-must-not-be-captured",
            extra_body,
            true,
            grimodex_ai::AiNovelistMode::Completion,
            Some("legacy".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        params.request_max_output_tokens = Some(777);

        let effective = NativeAiEffectiveRequestConfiguration::from_params(&params);
        assert_eq!(effective.ai_novelist_mode, "completion");
        assert_eq!(effective.request_max_output_tokens, 777);
        assert_eq!(effective.resolved_tool_protocol, "native");
        assert!(effective.retry_429);
        assert_eq!(
            effective.extra_body,
            Some(serde_json::json!({
                "top_a": 0.42,
                "tailfree": 0.91,
                "multilingualmode": true,
            }))
        );
        let audit_debug = format!("{effective:?}");
        assert!(!audit_debug.contains("settings-secret"));
        assert!(!audit_debug.contains("transport-secret"));
        assert!(!audit_debug.contains("api_key"));

        let fallback_params = grimodex_ai::build_chat_params(
            &settings,
            "transport-secret-must-not-be-captured",
            None,
            true,
            grimodex_ai::AiNovelistMode::Chat,
            Some("legacy".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(
            NativeAiEffectiveRequestConfiguration::from_params(&fallback_params)
                .request_max_output_tokens,
            grimodex_ai::ai_novelist::length_for(&settings.model)
        );
    }

    #[derive(Default)]
    struct RecordingNativeAiAuditAppender {
        events: Mutex<Vec<AppendAiAuditEvent>>,
    }

    impl NativeAiAuditAppender for RecordingNativeAiAuditAppender {
        fn append(
            &self,
            _project_id: Option<&str>,
            events: &[AppendAiAuditEvent],
        ) -> anyhow::Result<()> {
            self.events
                .lock()
                .map_err(|_| anyhow::anyhow!("recorded event mutex poisoned"))?
                .extend_from_slice(events);
            Ok(())
        }
    }

    #[test]
    fn native_effective_receipt_persists_exact_anthropic_body() -> anyhow::Result<()> {
        let appender = Arc::new(RecordingNativeAiAuditAppender::default());
        let context = test_context(std::path::Path::new("/workspace"));
        let observer = NativeAiHttpAuditObserver {
            appender: appender.clone(),
            context: context.clone(),
            route: NativeAiHttpAuditRoute {
                provider: "anthropic".to_string(),
                model: "claude-opus-4-5".to_string(),
                api_variant: None,
                endpoint_id: None,
            },
            effective_request_configuration: test_effective_request_configuration(),
        };
        let body = serde_json::json!({
            "model": "claude-opus-4-5",
            "max_tokens": 12_345,
            "system": [
                {
                    "type": "text",
                    "text": "stable system",
                    "cache_control": { "type": "ephemeral" },
                },
                { "type": "text", "text": "volatile scene" },
            ],
            "messages": [{ "role": "user", "content": "exact user prompt" }],
            "tools": [{
                "name": "search_codex",
                "description": "search",
                "input_schema": { "type": "object" },
            }],
            "thinking": { "type": "enabled", "budget_tokens": 4_096 },
            "output_config": { "effort": "high" },
            "stream": true,
        });

        observer.request_prepared(&grimodex_ai::HttpPreparedRequest {
            body: Some(body.clone()),
        })?;

        let events = appender
            .events
            .lock()
            .map_err(|_| anyhow::anyhow!("recorded event mutex poisoned"))?;
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.event_type, "request.prepared");
        assert_eq!(
            event.event_id,
            native_ai_effective_request_event_id(&context)
        );
        assert_eq!(event.payload["captureState"], "complete");
        assert_eq!(event.payload["request"]["body"], body);
        assert_eq!(
            event.payload["effectiveRequestConfiguration"]["serializationFidelity"],
            "json-value"
        );
        assert_eq!(
            event.payload["effectiveRequestConfiguration"]
                ["serializationWhitespaceAndKeyOrderPreserved"],
            false
        );
        assert_eq!(event.payload["route"]["provider"], "anthropic");
        assert_eq!(event.payload["credentialsExcluded"], true);
        assert_eq!(event.payload["limitations"], serde_json::json!([]));
        let durable = serde_json::to_string(&event.payload)?;
        for forbidden in ["x-api-key", "authorization", "transport-secret"] {
            assert!(!durable.to_ascii_lowercase().contains(forbidden));
        }
        Ok(())
    }

    #[derive(Default)]
    struct AlwaysFailNativeAiAuditAppender {
        calls: AtomicUsize,
    }

    impl NativeAiAuditAppender for AlwaysFailNativeAiAuditAppender {
        fn append(
            &self,
            _project_id: Option<&str>,
            _events: &[AppendAiAuditEvent],
        ) -> anyhow::Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            anyhow::bail!("injected durable append failure")
        }
    }

    #[test]
    fn native_effective_receipt_failure_remains_fail_closed_after_bounded_retry() {
        let appender = Arc::new(AlwaysFailNativeAiAuditAppender::default());
        let observer = NativeAiHttpAuditObserver {
            appender: appender.clone(),
            context: test_context(std::path::Path::new("/workspace")),
            route: test_route(),
            effective_request_configuration: test_effective_request_configuration(),
        };

        let error = observer
            .request_prepared(&grimodex_ai::HttpPreparedRequest {
                body: Some(serde_json::json!({ "model": "model-a" })),
            })
            .expect_err("two durable append failures must reject dispatch");
        assert!(error
            .to_string()
            .contains("append native effective request.prepared failed after bounded retry"));
        assert_eq!(appender.calls.load(Ordering::SeqCst), 2);
    }

    fn fusion_started_payload(
        fusion: grimodex_ai::FusionConfig,
    ) -> anyhow::Result<serde_json::Value> {
        let settings = grimodex_ai::AiSettings {
            provider: grimodex_ai::AiProvider::OpenRouter,
            model: "openrouter/fusion".to_string(),
            openrouter_provider_pin: Some(" anthropic ".to_string()),
            fusion,
            ..Default::default()
        };
        let params = grimodex_ai::build_chat_params(
            &settings,
            "transport-secret-must-not-be-captured",
            None,
            false,
            grimodex_ai::AiNovelistMode::Chat,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        let appender = Arc::new(RecordingNativeAiAuditAppender::default());
        let observer = NativeAiHttpAuditObserver {
            appender: appender.clone(),
            context: test_context(std::path::Path::new("/workspace")),
            route: NativeAiHttpAuditRoute::from_params(&settings, &params),
            effective_request_configuration: NativeAiEffectiveRequestConfiguration::from_params(
                &params,
            ),
        };
        observer.attempt_started(&grimodex_ai::HttpAttemptStarted {
            attempt_number: 1,
            send_ordinal: 1,
            is_retry: false,
            reuses_initial_payload: false,
            endpoint: Some(grimodex_ai::HttpAttemptEndpoint {
                origin: "https://openrouter.ai".to_string(),
                host: "openrouter.ai".to_string(),
            }),
        })?;
        let events = appender
            .events
            .lock()
            .map_err(|_| anyhow::anyhow!("recorded event mutex poisoned"))?;
        let payload = events
            .first()
            .ok_or_else(|| anyhow::anyhow!("missing recorded started event"))?
            .payload
            .clone();
        Ok(payload)
    }

    #[test]
    fn native_fusion_configuration_is_complete_only_for_explicit_panel_and_judge(
    ) -> anyhow::Result<()> {
        let explicit = fusion_started_payload(grimodex_ai::FusionConfig {
            enabled: true,
            analysis_models: vec![
                " openai/gpt-5.2 ".to_string(),
                "".to_string(),
                "anthropic/claude-opus-4.5".to_string(),
            ],
            judge_model: Some(" google/gemini-3-pro-preview ".to_string()),
        })?;
        assert_eq!(explicit["captureState"], "complete");
        assert_eq!(explicit["limitations"], serde_json::json!([]));
        assert_eq!(
            explicit["effectiveRequestConfiguration"]["openrouterProviderPin"],
            "anthropic"
        );
        assert_eq!(
            explicit["effectiveRequestConfiguration"]["fusion"],
            serde_json::json!({
                "enabled": true,
                "customConfigurationApplied": true,
                "configurationComplete": true,
                "analysisModels": [
                    "openai/gpt-5.2",
                    "anthropic/claude-opus-4.5",
                ],
                "judgeModel": "google/gemini-3-pro-preview",
                "providerSelectedFusionPanelObserved": false,
            })
        );

        let provider_default = fusion_started_payload(grimodex_ai::FusionConfig::default())?;
        assert_eq!(provider_default["captureState"], "partial");
        assert_eq!(
            provider_default["effectiveRequestConfiguration"]["fusion"],
            serde_json::json!({
                "enabled": false,
                "customConfigurationApplied": false,
                "configurationComplete": false,
                "analysisModels": [],
                "judgeModel": null,
                "providerSelectedFusionPanelObserved": false,
            })
        );
        assert_eq!(
            provider_default["limitations"],
            serde_json::json!([
                "openrouter-fusion-provider-selected-panel-unobservable",
                "openrouter-fusion-provider-selected-judge-unobservable",
            ])
        );
        Ok(())
    }

    #[test]
    fn native_ai_diagnostic_redacts_url_assignment_json_and_header_credentials() {
        let raw = concat!(
            "HTTP attempt audit failed at ",
            "https://url-user:url-pass@example.test/v1/chat?api_key=url-secret#fragment ",
            "token=assignment-secret ",
            "OPENAI_API_KEY = \"quoted-api-secret\" ",
            "AWS_ACCESS_KEY_ID = 'access-id-secret' ",
            "provider_private_key = \"private-key-secret\" ",
            "openaiAuth = 'auth-alias-secret' ",
            r#"{"api_key":"api-secret","cookie":"cookie-secret","AWS_SECRET_ACCESS_KEY":"access-key-secret","providerAuth":"json-auth-secret","message":"keep diagnostic"}"#,
            "\nAuthorization: Bearer header-secret",
            "\nX-Api-Key: provider-header-secret",
            "\nkeep final diagnostic"
        );
        let error = anyhow::anyhow!("{}", raw);
        let sanitized = native_ai_error_to_napi(error).reason;

        for secret in [
            "url-user",
            "url-pass",
            "url-secret",
            "fragment",
            "assignment-secret",
            "quoted-api-secret",
            "access-id-secret",
            "private-key-secret",
            "auth-alias-secret",
            "api-secret",
            "cookie-secret",
            "access-key-secret",
            "json-auth-secret",
            "header-secret",
            "provider-header-secret",
        ] {
            assert!(!sanitized.contains(secret), "leaked {secret}: {sanitized}");
        }
        assert!(sanitized.contains("https://example.test/v1/chat"));
        assert!(sanitized.contains("keep diagnostic"));
        assert!(sanitized.contains("keep final diagnostic"));
        assert!(sanitized.contains("[REDACTED:credential]"));
    }
}

#[cfg(test)]
mod ime_workspace_tests {
    use super::*;
    use grimodex_db::Database;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn workspace_rotation_waits_for_the_snapshot_writer_then_invalidates_it() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-ime-workspace-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let resources = dir.join("resources");
        let state = Arc::new(
            AppState::new(&dir.to_string_lossy(), &resources.to_string_lossy()).expect("app state"),
        );
        let options = ImeExportOptions {
            mode: ImeIntegrationMode::On,
            exclude_hidden: false,
            include_profile: true,
        };
        let old_request = state
            .ime_request_gate
            .register_refresh("default-project", &options);
        let writer = state.ime_write_lock.lock().expect("writer lock");
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let state_for_thread = Arc::clone(&state);
        let thread = std::thread::spawn(move || {
            started_tx.send(()).expect("started");
            rotate_ime_workspace(&state_for_thread);
            done_tx.send(()).expect("done");
        });

        started_rx.recv().expect("rotation started");
        assert!(
            done_rx.recv_timeout(Duration::from_millis(30)).is_err(),
            "rotation must not pass the writer barrier"
        );
        drop(writer);
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("rotation completes after writer release");
        thread.join().expect("rotation thread");

        assert!(!state.ime_request_gate.is_current(&old_request));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mismatched_workspace_path_does_not_invalidate_a_legitimate_request() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-ime-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let resources = dir.join("resources");
        let state =
            AppState::new(&dir.to_string_lossy(), &resources.to_string_lossy()).expect("app state");
        let workspace_path = dir.join("workspace-a");
        std::fs::create_dir_all(&workspace_path).expect("workspace dir");
        let db = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        let authority =
            grimodex_db::WorkspaceAuthority::from_database_for_test(db, workspace_path.clone())
                .expect("authority");
        install_test_workspace(&state, authority);
        let options = ImeExportOptions {
            mode: ImeIntegrationMode::On,
            exclude_hidden: false,
            include_profile: true,
        };
        let legitimate = state
            .ime_request_gate
            .register_refresh("default-project", &options);

        let result = pin_ime_workspace_request(
            &state,
            &dir.join("workspace-b").to_string_lossy(),
            |gate, generation| {
                gate.register_refresh_for_generation("default-project", &options, generation)
            },
        );

        assert!(result.is_err());
        assert!(state.ime_request_gate.is_current(&legitimate));
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_workspace_validation_canonicalizes_both_path_representations() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-codex-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let resources = dir.join("resources");
        let state =
            AppState::new(&dir.to_string_lossy(), &resources.to_string_lossy()).expect("app state");
        let workspace_path = dir.join("workspace");
        let nested = workspace_path.join("nested");
        std::fs::create_dir_all(&nested).expect("workspace dirs");
        let db = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        let authority =
            grimodex_db::WorkspaceAuthority::from_database_for_test(db, workspace_path.clone())
                .expect("authority");
        install_test_workspace(&state, authority);
        let snapshot = active_workspace_snapshot(&state.ws).expect("workspace snapshot");
        let equivalent_but_noncanonical = nested.join("..");

        validate_codex_workspace(&snapshot, &equivalent_but_noncanonical.to_string_lossy())
            .expect("equivalent workspace path");

        drop(snapshot);
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod timelapse_genesis_baseline_tests {
    use super::*;
    use grimodex_db::Database;

    fn backend_with_scene() -> (Backend, std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "grimodex-node-timelapse-genesis-{}",
            uuid::Uuid::new_v4()
        ));
        let workspace_path = root.join("workspace");
        let nested = workspace_path.join("nested");
        std::fs::create_dir_all(&nested).expect("workspace dirs");
        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("schema");
        database
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title, language)
                     VALUES ('project-a', 'A', 'ja')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, node_type, title, content)
                     VALUES ('scene-a', 'project-a', 'scene', 'Scene A',
                             '{\"type\":\"doc\",\"content\":[]}')",
                    [],
                )?;
                Ok(())
            })
            .expect("seed database");
        let authority = grimodex_db::WorkspaceAuthority::from_database_for_test(
            database,
            workspace_path.clone(),
        )
        .expect("authority");
        let resources = root.join("resources");
        let state = AppState::new(&root.to_string_lossy(), &resources.to_string_lossy())
            .expect("app state");
        install_test_workspace(&state, authority);
        (
            Backend {
                state: Arc::new(state),
            },
            root,
            workspace_path,
        )
    }

    #[tokio::test]
    async fn adapter_pins_canonical_workspace_and_serializes_typed_summary() {
        let (backend, root, workspace_path) = backend_with_scene();
        let equivalent_path = workspace_path.join("nested").join("..");
        let wire = backend
            .timelapse_genesis_baselines_append(
                equivalent_path.to_string_lossy().into_owned(),
                "project-a".into(),
                "scene".into(),
                vec!["scene-a".into()],
                123,
            )
            .await
            .expect("append baseline");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&wire).expect("summary JSON"),
            serde_json::json!({
                "insertedCount": 1,
                "skippedExistingBaselineCount": 0,
                "skippedExistingBodyStepCount": 0,
            })
        );

        let wrong_workspace = root.join("wrong-workspace");
        std::fs::create_dir_all(&wrong_workspace).expect("wrong workspace dir");
        let error = backend
            .timelapse_genesis_baselines_append(
                wrong_workspace.to_string_lossy().into_owned(),
                "project-a".into(),
                "scene".into(),
                vec!["scene-a".into()],
                124,
            )
            .await
            .expect_err("wrong workspace must fail closed");
        assert!(
            error
                .to_string()
                .contains("TIMELAPSE_GENESIS_BASELINE_WORKSPACE_CHANGED"),
            "unexpected error: {error}"
        );
        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn typed_timelapse_commands_bind_workspace_and_preserve_native_scopes() {
        let (backend, root, workspace_path) = backend_with_scene();
        let expected_workspace_path = workspace_path.to_string_lossy().into_owned();
        let equivalent_path = workspace_path.join("nested").join("..");

        let body_wire = backend
            .timelapse_body_baselines_append(
                equivalent_path.to_string_lossy().into_owned(),
                "project-a".into(),
                serde_json::json!([{ "kind": "scene", "id": "scene-a" }]),
                None,
            )
            .await
            .expect("append body baseline through N-API");
        let body_summary =
            serde_json::from_str::<serde_json::Value>(&body_wire).expect("body summary JSON");
        assert_eq!(body_summary["insertedCount"], serde_json::json!(1));
        assert_eq!(body_summary["skippedExistingCount"], serde_json::json!(0));
        assert_eq!(body_summary["anchorSequence"], serde_json::json!(0));
        assert!(body_summary["anchorTimestamp"].is_i64());

        let layout_wire = backend
            .timelapse_layout_snapshot_record(
                expected_workspace_path.clone(),
                "project-a".into(),
                serde_json::json!({
                    "layout": { "regions": {} },
                    "activePresetId": null,
                    "hiddenStripePanels": ["chat"],
                }),
                Some(0),
            )
            .await
            .expect("append layout snapshot through N-API");
        let layout_summary =
            serde_json::from_str::<serde_json::Value>(&layout_wire).expect("layout summary JSON");
        assert_eq!(layout_summary["inserted"], serde_json::json!(true));
        assert_eq!(layout_summary["anchorSequence"], serde_json::json!(0));

        let enabled_wire = backend
            .timelapse_enabled_set(expected_workspace_path.clone(), "project-a".into(), true)
            .await
            .expect("set timelapse flag through N-API");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&enabled_wire).expect("enabled summary JSON"),
            serde_json::json!({ "enabled": true })
        );

        let snapshot = active_workspace_snapshot(&backend.state.ws).expect("active workspace");
        snapshot
            .db()
            .with_conn(|conn| {
                let body_scope: (String, String, String) = conn.query_row(
                    "SELECT domain, entity_type, entity_id FROM state_snapshots
                      WHERE project_id = 'project-a' AND domain = 'editor'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                assert_eq!(
                    body_scope,
                    ("editor".into(), "scene".into(), "scene-a".into())
                );
                let layout_scope: (String, String, String) = conn.query_row(
                    "SELECT domain, entity_type, entity_id FROM state_snapshots
                      WHERE project_id = 'project-a' AND domain = 'layout'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                assert_eq!(
                    layout_scope,
                    ("layout".into(), "workspace".into(), "workspace".into())
                );
                let enabled: String = conn.query_row(
                    "SELECT value FROM project_settings
                      WHERE project_id = 'project-a' AND key = 'timelapse.enabled'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(enabled, "true");
                Ok(())
            })
            .expect("verify N-API writer scopes");

        let wrong_workspace = root.join("wrong-workspace");
        std::fs::create_dir_all(&wrong_workspace).expect("wrong workspace dir");
        let error = backend
            .timelapse_history_purge(
                wrong_workspace.to_string_lossy().into_owned(),
                "project-a".into(),
            )
            .await
            .expect_err("wrong workspace must fail closed for purge");
        assert!(
            error
                .to_string()
                .contains("TIMELAPSE_GENESIS_BASELINE_WORKSPACE_CHANGED"),
            "unexpected workspace binding error: {error}"
        );
        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod semantic_reranker_lane_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn occupied_lane_returns_busy_without_queuing_later_inference() {
        let lane = Arc::new(Mutex::new(()));
        let first_inference = lane.lock().expect("first inference owns lane");
        let inference_starts = Arc::new(AtomicUsize::new(0));
        let lane_for_second = Arc::clone(&lane);
        let starts_for_second = Arc::clone(&inference_starts);
        let (result_tx, result_rx) = mpsc::channel();

        let second = thread::spawn(move || {
            let result = try_with_semantic_reranker_lane(&lane_for_second, |_| {
                starts_for_second.fetch_add(1, Ordering::SeqCst);
                Ok::<_, anyhow::Error>(())
            })
            .map_err(|error| format!("{error:#}"));
            result_tx.send(result).expect("send second result");
        });

        let error = result_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("occupied lane must reject immediately")
            .expect_err("second inference must be rejected as busy");
        assert!(
            error.starts_with("RERANKER_BUSY:"),
            "stable marker must cross the N-API wire: {error}"
        );
        assert_eq!(
            inference_starts.load(Ordering::SeqCst),
            0,
            "busy request must not enter inference"
        );

        drop(first_inference);
        second.join().expect("second request thread");
        assert_eq!(
            inference_starts.load(Ordering::SeqCst),
            0,
            "releasing the first inference must not start rejected work later"
        );
    }

    #[tokio::test]
    async fn pinned_project_db_records_exact_reranker_input_before_model_load_failure() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-reranker-audit-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let workspace_path = dir.join("workspace");
        std::fs::create_dir_all(&workspace_path).expect("workspace dir");
        let expected_workspace_path = workspace_path.to_string_lossy().into_owned();
        let database = Arc::new(
            grimodex_db::Database::new(&workspace_path.join("grimodex.db"))
                .expect("open audit database"),
        );
        database.migrate().expect("migrate audit database");
        database
            .with_conn(|connection| {
                connection.execute(
                    "INSERT INTO projects (id, title, language) VALUES (?1, 'Audit', 'ja')",
                    ["project-a"],
                )?;
                Ok(())
            })
            .expect("seed project");

        let resources = dir.join("missing-semantic-resources");
        let state =
            AppState::new(&dir.to_string_lossy(), &resources.to_string_lossy()).expect("app state");
        let database = Arc::into_inner(database).expect("database Arc must be unique");
        let authority =
            grimodex_db::WorkspaceAuthority::from_database_for_test(database, workspace_path)
                .expect("authority");
        install_test_workspace(&state, authority);
        let backend = Backend {
            state: Arc::new(state),
        };

        let error = backend
            .semantic_reranker_shadow_score(serde_json::json!({
                "requestId": "request-a",
                "expectedWorkspacePath": expected_workspace_path,
                "projectId": "project-a",
                "auditPathId": "semantic_reranker_shadow",
                "language": "ja",
                "userMessage": "exact user message",
                "sceneTail": "exact scene tail",
                "candidates": [{
                    "candidateId": "scene-a:0:10",
                    "text": "exact candidate text",
                }],
            }))
            .await
            .expect_err("missing model resources fail after audit");
        assert!(
            error.to_string().contains("resources are not configured"),
            "unexpected reranker preparation error: {error}"
        );

        let snapshot = {
            let guard = backend.state.ws.inner.lock().expect("workspace lock");
            let active = guard.as_ref().expect("workspace still open");
            active
                .db()
                .read_ai_audit_snapshot("project-a", None, None, None)
                .expect("read native reranker audit")
        };
        assert_eq!(
            snapshot
                .events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            [
                "execution.started",
                "request.prepared",
                "request.dispatched",
                "execution.failed",
            ]
        );
        let prepared = &snapshot.events[1];
        assert_eq!(prepared.path_id, "semantic_reranker_shadow");
        assert_eq!(
            prepared.payload["input"]["userMessage"],
            "exact user message"
        );
        assert_eq!(prepared.payload["input"]["sceneTail"], "exact scene tail");
        assert_eq!(
            prepared.payload["input"]["normalizedQuery"],
            "exact user message\nexact scene tail"
        );
        assert_eq!(
            prepared.payload["input"]["candidates"][0]["text"],
            "exact candidate text"
        );
        assert_eq!(
            prepared.payload["model"]["modelId"],
            "hotchpotch/japanese-reranker-xsmall-v2"
        );
        assert_eq!(prepared.payload["captureState"], "partial");
        assert_eq!(
            prepared.payload["model"]["tokenizerIdentityStatus"],
            "pending-effective-receipt"
        );
        assert_eq!(
            prepared.payload["tokenizationCapture"]["realizedTokenIds"],
            "not-retained"
        );
        assert_eq!(
            prepared.payload["tokenizationCapture"]["specialTokenExpansion"],
            "not-retained"
        );
        assert_eq!(
            prepared.payload["tokenizationCapture"]["postTruncationTokenSequence"],
            "not-retained"
        );
        let failed = &snapshot.events[3];
        assert_eq!(failed.payload["captureState"], "complete");
        assert_eq!(
            failed.payload["phase"],
            "local-inference-artifact-preparation"
        );
        assert_eq!(failed.payload["modelDispatched"], false);
        assert_eq!(failed.payload["onnxSessionRunObserved"], false);

        drop(backend);
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod narrative_maintenance_epoch_event_tests {
    use super::*;

    #[test]
    fn emission_requires_a_first_successful_changed_mutation() {
        assert!(should_emit_narrative_epoch_rotated(false, true));
        assert!(!should_emit_narrative_epoch_rotated(true, true));
        assert!(!should_emit_narrative_epoch_rotated(false, false));
        assert!(!should_emit_narrative_epoch_rotated(true, false));
    }

    #[test]
    fn cleanup_quarantine_cannot_be_classified_as_transient_preemption() {
        let cleanup = "NIR1_MAINTENANCE_CONNECTION_OPERATION_FAILED: ".to_string()
            + "NEX_VALIDATION_TERMINATED:foreground-preempted: waiter arrived; "
            + "NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: rollback failed";
        assert!(is_narrative_maintenance_cleanup_failure(&cleanup));
        assert!(!is_narrative_maintenance_preemption(&cleanup));
        assert!(is_narrative_maintenance_preemption(
            &"NEX_VALIDATION_TERMINATED:foreground-preempted: waiter arrived".to_string()
        ));
    }
}

#[cfg(test)]
mod narrative_maintenance_admission_unwind_tests {
    use super::*;
    use grimodex_db::narrative_extraction::LEGACY_BACKFILL_WORK_KEY;
    use grimodex_db::state::WorkspaceAuthority;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    fn backend_with_active_workspace(label: &str) -> (Backend, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "grimodex-maintenance-admission-production-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let workspace_path = root.join("workspace");
        let metadata_dir = workspace_path.join(".grimodex");
        std::fs::create_dir_all(&metadata_dir).expect("workspace metadata directory");
        std::fs::write(
            metadata_dir.join("workspace.json"),
            serde_json::json!({
                "id": format!("workspace-{label}"),
                "created_at": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .expect("workspace metadata");
        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        let authority = WorkspaceAuthority::from_database_for_test(database, workspace_path)
            .expect("workspace authority");
        let state = AppState::new(
            &root.to_string_lossy(),
            &root.join("resources").to_string_lossy(),
        )
        .expect("app state");
        state
            .narrative_maintenance_recovery_gate
            .mark_workspace_swapped();
        install_test_workspace(&state, authority);
        (
            Backend {
                state: Arc::new(state),
            },
            root,
        )
    }

    async fn begin_and_cancel_after_panic(
        backend: &Backend,
        attempt_id: &str,
        binding: serde_json::Value,
    ) {
        let begin: serde_json::Value = serde_json::from_str(
            &backend
                .begin_narrative_maintenance_attempt(attempt_id.to_string(), binding)
                .await
                .expect("actual begin after workspace panic"),
        )
        .expect("begin receipt JSON");
        assert_eq!(begin["status"], "open");
        assert_eq!(begin["attemptId"], attempt_id);
        let terminal: serde_json::Value = serde_json::from_str(
            &backend
                .cancel_narrative_maintenance_attempt(attempt_id.to_string(), "closed".to_string())
                .await
                .expect("close actual begin after workspace panic"),
        )
        .expect("terminal receipt JSON");
        assert_eq!(terminal["state"], "interrupted");
        assert_eq!(terminal["connectionReusable"], true);
    }

    #[tokio::test]
    async fn native_registry_and_real_db_coalesced_work_uses_noop_completion() {
        let (backend, root) = backend_with_active_workspace("coalesced-noop");
        let authority = active_database(&backend.state.ws).expect("active authority");
        authority
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json,
                         spec_digest, status, coverage_json, created_at, started_at,
                         completed_at, version, run_kind, semantic_epoch_id, work_key)
                     VALUES ('coalesced-run', 'project-1', 'maintenance', '{}', '{}',
                             'sha256:coalesced', 'running', '{}',
                             '2026-01-01T00:00:00.000Z',
                             '2026-01-01T00:00:00.000Z', NULL, 0, 'backfill',
                             NULL, ?1)",
                    [LEGACY_BACKFILL_WORK_KEY],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed running durable work");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        let canonical_key =
            format!("narrative-maintenance:v1/backfill/project-1/{LEGACY_BACKFILL_WORK_KEY}");
        backend
            .state
            .narrative_maintenance_recovery_gate
            .mark_recovered_for_binding(&binding, &canonical_key);
        drop(authority);

        let attempt_id = "attempt-coalesced-noop";
        backend
            .begin_narrative_maintenance_attempt(
                attempt_id.to_string(),
                serde_json::to_value(&binding).expect("binding JSON"),
            )
            .await
            .expect("begin Native attempt");
        let cycle: serde_json::Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "attemptId": attempt_id,
                    "work": [{
                        "projectId": "project-1",
                        "runKind": "backfill",
                        "workKey": LEGACY_BACKFILL_WORK_KEY,
                        "semanticEpochId": null,
                        "reasons": ["same-process-coalesced"]
                    }],
                    "wakeProjectIds": [],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("coalesced Native cycle"),
        )
        .expect("cycle JSON");
        assert_eq!(cycle["status"], "coalesced");

        let receipt: serde_json::Value = serde_json::from_str(
            &backend
                .cancel_narrative_maintenance_attempt(attempt_id.to_string(), "closed".to_string())
                .await
                .expect("terminal coalesced receipt"),
        )
        .expect("receipt JSON");
        assert_eq!(receipt["state"], "succeeded");
        assert_eq!(receipt["works"][0]["status"], "succeeded");
        assert_eq!(receipt["connectionReusable"], true);
        let authority = active_database(&backend.state.ws).expect("active authority after cycle");
        let durable_status: String = authority
            .db()
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM narrative_extraction_runs WHERE id = 'coalesced-run'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read coalesced durable run");
        assert_eq!(
            durable_status, "running",
            "no-op must not terminalize the live Run"
        );
        drop(authority);
        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn native_registry_and_real_db_repeated_key_preserves_first_success() {
        let (backend, root) = backend_with_active_workspace("repeated-key-db");
        let authority = active_database(&backend.state.ws).expect("active authority");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        let attempt_id = "attempt-repeated-key-db";
        let key = "narrative-maintenance:v1/dependency-verify/project-1/work:epoch-current";

        backend
            .begin_narrative_maintenance_attempt(
                attempt_id.to_string(),
                serde_json::to_value(&binding).expect("binding JSON"),
            )
            .await
            .expect("begin Native attempt");
        backend
            .state
            .narrative_maintenance_attempts
            .start(attempt_id, std::iter::empty::<String>())
            .expect("start native attempt");
        backend
            .state
            .narrative_maintenance_attempts
            .register_work(attempt_id, key)
            .expect("register first execution");
        backend
            .state
            .narrative_maintenance_attempts
            .mark_work_started(attempt_id, key)
            .expect("start first execution");
        authority
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO projects (id, title) VALUES ('project-1', 'Project')",
                    [],
                )?;
                conn.execute(
                    "INSERT OR REPLACE INTO project_settings (project_id, key, value)
                     VALUES ('project-1', 'maintenance.repeated-key', 'first-success')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("first execution durable write");
        assert!(backend
            .state
            .narrative_maintenance_attempts
            .grant_work_finalize(attempt_id, key)
            .expect("grant first execution"));
        backend
            .state
            .narrative_maintenance_attempts
            .mark_work_succeeded(attempt_id, key)
            .expect("complete first execution");

        // Rediscovery registers a second queue execution with the same
        // effective identity. Cancellation wins before its adapter grant,
        // while the first durable DB result remains successful.
        backend
            .state
            .narrative_maintenance_attempts
            .register_work(attempt_id, key)
            .expect("register repeated execution");
        backend
            .state
            .narrative_maintenance_attempts
            .mark_work_started(attempt_id, key)
            .expect("start repeated execution");
        assert!(backend
            .state
            .narrative_maintenance_attempts
            .request_cancel(attempt_id, "cancel-before-second-finalize")
            .expect("cancel repeated execution")
            .is_none());
        assert!(!backend
            .state
            .narrative_maintenance_attempts
            .grant_work_finalize(attempt_id, key)
            .expect("second finalization must be denied"));
        backend
            .state
            .narrative_maintenance_attempts
            .set_cleanup_outcome(
                attempt_id,
                NarrativeMaintenanceCleanupOutcome {
                    status: "clean".to_string(),
                    error: None,
                },
                true,
            )
            .expect("record DB cleanup");
        let receipt = backend
            .state
            .narrative_maintenance_attempts
            .settle(attempt_id, false, None)
            .expect("settle repeated execution");
        assert_eq!(receipt.state, "interrupted");
        assert_eq!(receipt.works.len(), 2);
        assert_eq!(receipt.works[0].work_key, key);
        assert_eq!(receipt.works[0].status, "succeeded");
        assert_eq!(receipt.works[1].work_key, key);
        assert_eq!(receipt.works[1].status, "interrupted");
        let durable_value: String = authority
            .db()
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT value FROM project_settings
                      WHERE project_id = 'project-1' AND key = 'maintenance.repeated-key'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read first durable DB result");
        assert_eq!(durable_value, "first-success");
        drop(authority);
        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn malformed_duplicate_cycle_keeps_the_original_native_owner_admitted() {
        let (backend, root) = backend_with_active_workspace("malformed-duplicate");
        let authority = active_database(&backend.state.ws).expect("active authority");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        drop(authority);
        let attempt_id = "attempt-malformed-duplicate";
        backend
            .begin_narrative_maintenance_attempt(
                attempt_id.to_string(),
                serde_json::to_value(&binding).expect("binding JSON"),
            )
            .await
            .expect("begin Native attempt");

        let error = backend
            .run_narrative_maintenance_cycle(serde_json::json!({
                "attemptId": attempt_id,
                "work": [{
                    "projectId": "project-1",
                    "runKind": "backfill",
                    "workKey": LEGACY_BACKFILL_WORK_KEY,
                    "semanticEpochId": null,
                    "reasons": ["workspace-opened"]
                }],
                "wakeProjectIds": ["project-1"],
                "workspaceBinding": binding,
            }))
            .await
            .expect_err("mixed duplicate request must fail preflight");
        assert!(
            error.to_string().contains("WAKE_MIXED_ACK_SCOPE"),
            "unexpected malformed duplicate error: {error}"
        );
        let swap_error = backend
            .state
            .narrative_maintenance_recovery_gate
            .close_for_workspace_swap()
            .expect_err("malformed duplicate must not release original owner");
        assert!(swap_error.to_string().contains("ATTEMPT_ACTIVE"));

        let cycle: serde_json::Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "attemptId": attempt_id,
                    "work": [],
                    "wakeProjectIds": [],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("original owner cycle remains usable"),
        )
        .expect("cycle JSON");
        assert_eq!(cycle["status"], "accepted");
        backend
            .state
            .narrative_maintenance_recovery_gate
            .close_for_workspace_swap()
            .expect("successful owner releases the recovery gate");
        backend
            .state
            .narrative_maintenance_recovery_gate
            .reopen_admission(Some(&binding))
            .expect("reopen after ownership test");

        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn admission_stays_closed_when_open_owner_unwinds_until_explicit_handoff() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-maintenance-admission-unwind-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let state = Arc::new(
            AppState::new(
                &root.to_string_lossy(),
                &root.join("resources").to_string_lossy(),
            )
            .expect("app state"),
        );
        state
            .narrative_maintenance_recovery_gate
            .close_for_workspace_swap()
            .expect("close admission");

        let result = catch_unwind(AssertUnwindSafe({
            let state = Arc::clone(&state);
            move || {
                let mut guard = NarrativeMaintenanceAdmissionReopenGuard::new(Arc::clone(&state));
                guard.arm();
                panic!("injected post-close open panic");
            }
        }));
        assert!(result.is_err());
        assert!(state
            .narrative_maintenance_recovery_gate
            .maintenance_admission_is_closed());
        state
            .narrative_maintenance_recovery_gate
            .reopen_admission(None)
            .expect("explicit supervisor handoff reopens admission");
        assert!(!state
            .narrative_maintenance_recovery_gate
            .maintenance_admission_is_closed());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_restore_interleaving_rejects_second_before_open_lock() {
        let (backend, root) = backend_with_active_workspace("restore-interleaving");
        let authority = active_database(&backend.state.ws).expect("active authority");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        let backups_dir = root.join("workspace/backups");
        std::fs::create_dir_all(&backups_dir).expect("backups directory");
        let backup_name = "grimodex-maintenance-interleaving.db";
        authority
            .db()
            .backup_to(&backups_dir.join(backup_name))
            .expect("restore candidate");
        drop(authority);

        // Hold the shared restore/open lock on a dedicated thread so the
        // first restore remains in the interval after its admission close
        // but before authority mutation. This makes the second restore's
        // pre-lock decision and the maintenance begin race deterministic.
        // The guard lives on the holder thread (never across an await),
        // so the test also satisfies clippy::await_holding_lock.
        let backend = Arc::new(backend);
        let (open_held_tx, open_held_rx) = std::sync::mpsc::channel();
        let (open_release_tx, open_release_rx) = std::sync::mpsc::channel::<()>();
        let holder_backend = Arc::clone(&backend);
        let open_holder = std::thread::spawn(move || {
            let _open_guard = holder_backend.state.ws.open_lock.lock().expect("open lock");
            open_held_tx.send(()).expect("open lock held signal");
            open_release_rx.recv().expect("open lock release signal");
        });
        open_held_rx.recv().expect("open lock held");
        let first_backend = Arc::clone(&backend);
        let first = napi::tokio::spawn(async move {
            first_backend.restore_backup(backup_name.to_string()).await
        });
        let mut admission_closed = false;
        for _ in 0..10_000 {
            if backend
                .state
                .narrative_maintenance_recovery_gate
                .maintenance_admission_is_closed()
            {
                admission_closed = true;
                break;
            }
            napi::tokio::task::yield_now().await;
        }
        assert!(
            admission_closed,
            "first restore must close admission before waiting for open_lock"
        );

        let (second_tx, second_rx) = std::sync::mpsc::channel();
        let second_backend = Arc::clone(&backend);
        let second = napi::tokio::spawn(async move {
            let result = second_backend.restore_backup(backup_name.to_string()).await;
            second_tx
                .send(
                    result
                        .as_ref()
                        .map(|_| ())
                        .map_err(|error| error.to_string()),
                )
                .expect("second restore result receiver");
            result
        });
        let second_prelock = second_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("second restore must be rejected before waiting for open_lock");
        let begin_error = backend
            .state
            .narrative_maintenance_recovery_gate
            .register_attempt("restore-interleaving-maintenance", &binding)
            .expect_err("maintenance begin must remain closed during first restore");
        assert!(
            begin_error
                .to_string()
                .contains("NEX_MAINTENANCE_ADMISSION_CLOSED"),
            "unexpected maintenance begin error: {begin_error}"
        );
        assert!(
            second_prelock.as_ref().is_ok(),
            "second restore must return a strict rejection outcome: {second_prelock:?}"
        );

        open_release_tx.send(()).expect("open lock release");
        let first_outcome = first
            .await
            .expect("first restore task")
            .expect("first restore response");
        let first_json: serde_json::Value =
            serde_json::from_str(&first_outcome).expect("first restore outcome JSON");
        assert_eq!(first_json["status"], "restored");
        let second_outcome = second
            .await
            .expect("second restore task")
            .expect("second restore response");
        let second_json: serde_json::Value =
            serde_json::from_str(&second_outcome).expect("second restore outcome JSON");
        assert_eq!(second_json["status"], "not-admitted");
        assert_eq!(second_json["operationOutcome"], "unknown");
        assert!(!backend
            .state
            .narrative_maintenance_recovery_gate
            .maintenance_admission_is_closed());

        open_holder.join().expect("open lock holder");
        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn production_restore_error_reopens_admission_and_preserves_binding() {
        let (backend, root) = backend_with_active_workspace("restore-error");
        let before = backend
            .get_narrative_maintenance_workspace_binding()
            .expect("read binding before restore")
            .expect("active binding before restore");

        let outcome = backend
            .restore_backup("grimodex-missing-backup.db".to_string())
            .await
            .expect("missing backup must return a strict failed outcome");
        let outcome: serde_json::Value = serde_json::from_str(&outcome).expect("restore outcome");
        assert_eq!(outcome["status"], "unchanged");
        assert_eq!(outcome["operationOutcome"], "failed");
        assert_eq!(outcome["contentEffect"], "none");
        assert!(
            !backend
                .state
                .narrative_maintenance_recovery_gate
                .maintenance_admission_is_closed(),
            "restore failure must reopen production maintenance admission"
        );
        let after = backend
            .get_narrative_maintenance_workspace_binding()
            .expect("read binding after restore")
            .expect("active binding after restore");
        assert_eq!(after, before, "failed restore must retain the old binding");

        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn restore_core_borrows_open_lock_until_owner_finishes_postprocessing() {
        let (backend, root) = backend_with_active_workspace("restore-lock-lifetime");
        let open_guard = backend.state.ws.open_lock.lock().expect("open lock");
        let error = restore_backup_core_with_open_lock(
            &backend.state.ws,
            &open_guard,
            "missing-while-lock-is-held.db",
            || {},
        )
        .expect_err("missing backup must fail without consuming the owner's guard");
        assert!(!error.to_string().is_empty());

        std::thread::scope(|scope| {
            let ws = &backend.state.ws;
            let waiter =
                scope.spawn(|| matches!(ws.open_lock.try_lock(), Err(TryLockError::WouldBlock)));
            assert!(waiter.join().expect("open-lock waiter thread"));
        });
        drop(open_guard);
        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn production_restore_recovery_handoff_is_consumed_by_next_open() {
        let (backend, root) = backend_with_active_workspace("restore-recovery-handoff");
        let authority = active_database(&backend.state.ws).expect("active authority");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        drop(authority);

        backend
            .state
            .narrative_maintenance_recovery_gate
            .close_for_restore()
            .expect("restore owns admission");
        backend
            .state
            .narrative_maintenance_recovery_gate
            .mark_workspace_swapped();
        let replacement_binding = {
            let authority = active_database(&backend.state.ws).expect("replacement authority");
            narrative_maintenance_binding_for_authority(&backend.state, &authority)
        };
        assert_eq!(replacement_binding.authority_id, binding.authority_id);
        backend
            .state
            .narrative_maintenance_recovery_gate
            .handoff_restore_failure_to_workspace_swap(Some(&replacement_binding))
            .expect("handoff completed restore to recovery owner");
        assert!(backend
            .state
            .narrative_maintenance_recovery_gate
            .restore_recovery_pending());

        backend
            .open_workspace(root.join("workspace").to_string_lossy().into_owned())
            .await
            .expect("next serialized open consumes restore recovery handoff");
        assert!(!backend
            .state
            .narrative_maintenance_recovery_gate
            .maintenance_admission_is_closed());
        assert!(!backend
            .state
            .narrative_maintenance_recovery_gate
            .restore_recovery_pending());

        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn production_open_retries_handed_off_run_while_switching_owner_holds_lock() {
        let (backend, root) = backend_with_active_workspace("open-pending-run-retry");
        let authority = active_database(&backend.state.ws).expect("active authority");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        drop(authority);

        // Model the state left after a replacement authority failed to drain
        // an exact Run: the gate remains closed and the process-local owner
        // retains the old generation.  The next real open enters its
        // pre-swap callback with switching=true, so it must use the
        // open_lock owner path rather than active_database().
        backend
            .state
            .narrative_maintenance_preempted_runs
            .defer("pending-open-retry-run", &binding)
            .expect("retain handed-off Run");
        backend
            .state
            .narrative_maintenance_recovery_gate
            .close_for_workspace_swap()
            .expect("leave admission closed for retry");

        backend
            .open_workspace(root.join("workspace").to_string_lossy().into_owned())
            .await
            .expect("second open must reach replacement Run recovery");
        assert!(!backend
            .state
            .narrative_maintenance_recovery_gate
            .maintenance_admission_is_closed());
        assert!(backend
            .state
            .narrative_maintenance_preempted_runs
            .pending_for_authority(&binding.authority_id)
            .is_empty());

        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn production_restore_cannot_borrow_a_closed_open_recovery_gate() {
        let (backend, root) = backend_with_active_workspace("restore-closed-open-gate");
        let authority = active_database(&backend.state.ws).expect("active authority");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        drop(authority);

        backend
            .state
            .narrative_maintenance_preempted_runs
            .defer("restore-must-not-borrow-run", &binding)
            .expect("retain pending Run");
        backend
            .state
            .narrative_maintenance_recovery_gate
            .close_for_workspace_swap()
            .expect("model an open-owned closed gate");

        let outcome = backend
            .restore_backup("missing-while-open-recovery-pending.db".to_string())
            .await
            .expect("restore must return a strict NotAdmitted outcome");
        let outcome: serde_json::Value = serde_json::from_str(&outcome).expect("restore outcome");
        assert_eq!(outcome["status"], "not-admitted");
        assert_eq!(outcome["operationOutcome"], "unknown");
        assert_eq!(outcome["reasonCode"], "maintenance-admission-closed");
        assert!(backend
            .state
            .narrative_maintenance_preempted_runs
            .pending_for_authority(&binding.authority_id)
            .contains(&("restore-must-not-borrow-run".to_string(), binding)));

        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn production_open_rejects_active_attempt_without_closing_admission() {
        let (backend, root) = backend_with_active_workspace("open-active");
        let binding = {
            let authority = active_database(&backend.state.ws).expect("active authority");
            narrative_maintenance_binding_for_authority(&backend.state, &authority)
        };
        backend
            .begin_narrative_maintenance_attempt(
                "active-open-attempt".to_string(),
                serde_json::to_value(&binding).expect("binding JSON"),
            )
            .await
            .expect("register active attempt");

        let candidate = root.join("replacement");
        let error = backend
            .open_workspace(candidate.to_string_lossy().into_owned())
            .await
            .expect_err("open must reject while maintenance is active");
        assert!(
            error.to_string().contains("NEX_MAINTENANCE_ATTEMPT_ACTIVE"),
            "unexpected active-attempt error: {error}"
        );
        assert!(
            !backend
                .state
                .narrative_maintenance_recovery_gate
                .maintenance_admission_is_closed(),
            "rejected open must leave production admission open"
        );
        let terminal: serde_json::Value = serde_json::from_str(
            &backend
                .cancel_narrative_maintenance_attempt(
                    "active-open-attempt".to_string(),
                    "open-rejected".to_string(),
                )
                .await
                .expect("cancel rejected-open attempt"),
        )
        .expect("terminal receipt JSON");
        assert_eq!(terminal["state"], "interrupted");

        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn production_open_panic_after_close_publishes_recovery_after_join() {
        let (backend, root) = backend_with_active_workspace("open-panic");
        backend
            .state
            .narrative_maintenance_recovery_gate
            .arm_panic_after_admission_close_for_test();

        let error = backend
            .open_workspace(root.join("replacement").to_string_lossy().into_owned())
            .await
            .expect_err("injected open panic must reject the invoke");
        assert!(
            !error.to_string().is_empty(),
            "panic must surface as an error"
        );
        assert!(!backend.state.ws.switching.load(Ordering::SeqCst));
        assert!(
            !backend
                .state
                .narrative_maintenance_recovery_gate
                .maintenance_admission_is_closed(),
            "open panic must reopen production admission"
        );
        let lifecycle: serde_json::Value = serde_json::from_str(
            &backend
                .get_workspace_lifecycle_view()
                .await
                .expect("read post-panic lifecycle view"),
        )
        .expect("lifecycle view JSON");
        assert_eq!(
            lifecycle["status"], "recovery-required",
            "lifecycle={lifecycle}"
        );
        assert!(active_database(&backend.state.ws).is_err());

        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn production_restore_panic_after_close_reopens_binding_and_switching() {
        let (backend, root) = backend_with_active_workspace("restore-panic");
        let before = backend
            .get_narrative_maintenance_workspace_binding()
            .expect("read binding before restore")
            .expect("active binding before restore");
        let authority = active_database(&backend.state.ws).expect("active authority");
        let before_identity = authority.identity();
        let backups_dir = root.join("workspace/backups");
        std::fs::create_dir_all(&backups_dir).expect("backups directory");
        let backup_name = "grimodex-maintenance-panic.db";
        authority
            .db()
            .backup_to(&backups_dir.join(backup_name))
            .expect("restore candidate");
        drop(authority);
        backend
            .state
            .narrative_maintenance_recovery_gate
            .arm_panic_after_admission_close_for_test();

        let outcome = backend
            .restore_backup(backup_name.to_string())
            .await
            .expect("injected restore panic must return a strict recovery outcome");
        let outcome: serde_json::Value = serde_json::from_str(&outcome).expect("restore outcome");
        assert_eq!(outcome["status"], "recovery-required");
        assert_eq!(outcome["operationOutcome"], "unknown");
        assert!(!backend.state.ws.switching.load(Ordering::SeqCst));
        assert!(
            !backend
                .state
                .narrative_maintenance_recovery_gate
                .maintenance_admission_is_closed(),
            "restore panic must reopen production admission"
        );
        let after_authority = workspace_swap_owner_authority(&backend.state, true)
            .expect("surviving authority remains owned by recovery");
        assert_eq!(after_authority.identity(), before_identity);
        let after = serde_json::to_string(&narrative_maintenance_binding_for_authority(
            &backend.state,
            &after_authority,
        ))
        .expect("serialize recovery binding");
        drop(after_authority);
        assert_eq!(after, before);
        assert!(backend
            .get_narrative_maintenance_workspace_binding()
            .is_err());

        // RecoveryRequired is restore-only: the explicit Open path consumes
        // the recovery owner and proves that the poisoned open lock was
        // cleared before normal maintenance can resume.
        let reopened = backend
            .open_workspace(root.join("workspace").to_string_lossy().into_owned())
            .await
            .expect("explicit Open after caught restore panic");
        let reopened: serde_json::Value = serde_json::from_str(&reopened).expect("ready JSON");
        assert!(matches!(
            reopened["status"].as_str(),
            Some("ready" | "migrated")
        ));
        let replacement_binding = backend
            .get_narrative_maintenance_workspace_binding()
            .expect("read replacement binding")
            .expect("replacement binding");
        begin_and_cancel_after_panic(
            &backend,
            "post-restore-panic-replacement-begin",
            serde_json::from_str(&replacement_binding).expect("replacement binding JSON"),
        )
        .await;

        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod native_open_restore_only_tests {
    use super::*;
    use grimodex_db::recovery::SafeModeSession;
    use std::path::Path;
    use std::sync::Arc;

    fn restore_only_state(root: &Path, error_code: Option<&str>) -> Arc<AppState> {
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace directory");
        let state = Arc::new(
            AppState::new(
                &root.to_string_lossy(),
                &root.join("resources").to_string_lossy(),
            )
            .expect("app state"),
        );
        let session = SafeModeSession::from_workspace(
            workspace,
            "WORKSPACE_SAFE_MODE: native restore-only regression".to_string(),
            error_code.map(str::to_string),
            None,
        )
        .expect("restore-only session");
        state.ws.safe_mode.enter(session).expect("enter Safe Mode");
        state
    }

    #[test]
    fn invalid_open_target_is_rejected_before_ready_authority_is_admitted_out() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-node-open-preflight-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("test root");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace directory");
        let database = Database::new(&workspace.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        let authority = WorkspaceAuthority::from_database_for_test(database, workspace.clone())
            .expect("authority");
        let state = Arc::new(
            AppState::new(
                &root.to_string_lossy(),
                &root.join("resources").to_string_lossy(),
            )
            .expect("app state"),
        );
        install_test_workspace(&state, authority);
        let before = state
            .workspace_lifecycle
            .lifecycle_snapshot()
            .expect("snapshot");
        let invalid_target = root.join("a-file");
        std::fs::write(&invalid_target, b"not a workspace").expect("invalid target");

        let error = preflight_workspace_open_target(&invalid_target.to_string_lossy())
            .expect_err("regular file cannot be an Open target");
        assert!(error
            .to_string()
            .contains("NEX_WORKSPACE_OPEN_TARGET_NOT_DIRECTORY"));
        let after = state
            .workspace_lifecycle
            .lifecycle_snapshot()
            .expect("snapshot");
        assert_eq!(after.state, before.state);
        assert_eq!(after.revision, before.revision);

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn production_open_returns_safe_mode_without_reopening_admission() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-node-open-safe-mode-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("test root");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).expect("workspace directory");
        let database = Database::new(&workspace.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        database
            .with_conn(|conn| {
                conn.pragma_update(None, "user_version", grimodex_core::SCHEMA_VERSION + 1)?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("newer schema fixture");
        drop(database);

        let state = Arc::new(
            AppState::new(
                &root.to_string_lossy(),
                &root.join("resources").to_string_lossy(),
            )
            .expect("app state"),
        );
        let backend = Backend {
            state: Arc::clone(&state),
        };

        let result = backend
            .open_workspace(workspace.to_string_lossy().into_owned())
            .await
            .expect("Safe Mode is a structured open outcome");
        let result: serde_json::Value = serde_json::from_str(&result).expect("Safe Mode JSON");
        assert_eq!(result["status"], "safe-mode");
        assert!(result["reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("newer")));
        assert!(state.ws.safe_mode.is_active());
        assert!(state
            .narrative_maintenance_recovery_gate
            .maintenance_admission_is_closed());

        // The restore-only result intentionally leaves the gate closed. A
        // later valid open must be able to consume that closed state, publish
        // the new authority, and reopen admission for the next maintenance
        // attempt.
        {
            let database =
                Database::new(&workspace.join("grimodex.db")).expect("open Safe Mode database");
            database
                .with_conn(|conn| {
                    conn.pragma_update(None, "user_version", grimodex_core::SCHEMA_VERSION)?;
                    Ok::<_, anyhow::Error>(())
                })
                .expect("restore current schema version");
        }
        let reopened = backend
            .open_workspace(workspace.to_string_lossy().into_owned())
            .await
            .expect("valid open after Safe Mode");
        let reopened: serde_json::Value = serde_json::from_str(&reopened).expect("ready JSON");
        assert!(matches!(
            reopened["status"].as_str(),
            Some("ready" | "migrated")
        ));
        assert!(!state
            .narrative_maintenance_recovery_gate
            .maintenance_admission_is_closed());
        let binding: serde_json::Value = serde_json::from_str(
            &backend
                .get_narrative_maintenance_workspace_binding()
                .expect("read reopened binding")
                .expect("reopened binding"),
        )
        .expect("reopened binding JSON");
        let begin: serde_json::Value = serde_json::from_str(
            &backend
                .begin_narrative_maintenance_attempt("post-safe-mode-reopen".to_string(), binding)
                .await
                .expect("begin maintenance after Safe Mode recovery"),
        )
        .expect("maintenance begin JSON");
        assert_eq!(begin["status"], "open");
        let terminal: serde_json::Value = serde_json::from_str(
            &backend
                .cancel_narrative_maintenance_attempt(
                    "post-safe-mode-reopen".to_string(),
                    "closed".to_string(),
                )
                .await
                .expect("cancel maintenance after Safe Mode recovery"),
        )
        .expect("maintenance terminal JSON");
        assert_eq!(terminal["connectionReusable"], true);

        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn production_open_preserves_recovery_required_without_reopening_admission() {
        let root = std::env::temp_dir().join(format!(
            "grimodex-node-open-recovery-required-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let state = restore_only_state(&root, Some("MIGRATION_REOPEN_FAILED"));
        state
            .narrative_maintenance_recovery_gate
            .close_for_workspace_swap()
            .expect("close admission");
        let mut trace = NativeWorkspaceOpenTrace::new(false);
        let mut admission_guard = NarrativeMaintenanceAdmissionReopenGuard::new(Arc::clone(&state));
        let path = root.join("workspace");
        let result = finish_workspace_open_success(
            &state,
            &path.to_string_lossy(),
            grimodex_db::recovery::WorkspaceOpenOutcome::RecoveryRequired {
                reason: "WORKSPACE_SAFE_MODE: migration failed after live replace".to_string(),
                error_code: "MIGRATION_REOPEN_FAILED".to_string(),
                snapshot_id: Some("rc_snapshot".to_string()),
                candidates: Vec::new(),
            },
            &mut trace,
            &mut admission_guard,
        )
        .expect("RecoveryRequired is a structured open outcome");
        let result: serde_json::Value =
            serde_json::from_str(&result).expect("RecoveryRequired JSON");
        assert_eq!(result["status"], "recovery-required");
        assert_eq!(result["errorCode"], "MIGRATION_REOPEN_FAILED");
        assert_eq!(result["snapshotId"], "rc_snapshot");
        assert!(state.ws.safe_mode.is_active());
        assert!(state
            .narrative_maintenance_recovery_gate
            .maintenance_admission_is_closed());

        // RecoveryRequired is also a restore-only binding. Once the recovery
        // target has been repaired on disk, the next valid open must consume
        // the intentionally closed admission and make the live binding usable
        // again.
        let workspace = root.join("workspace");
        let database = Database::new(&workspace.join("grimodex.db")).expect("recovery database");
        database.migrate().expect("migrate recovery database");
        drop(database);
        let backend = Backend {
            state: Arc::clone(&state),
        };
        let reopened = backend
            .open_workspace(workspace.to_string_lossy().into_owned())
            .await
            .expect("valid open after RecoveryRequired");
        let reopened: serde_json::Value = serde_json::from_str(&reopened).expect("ready JSON");
        assert!(matches!(
            reopened["status"].as_str(),
            Some("ready" | "migrated")
        ));
        assert!(!state
            .narrative_maintenance_recovery_gate
            .maintenance_admission_is_closed());
        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod narrative_maintenance_fault_red_tests {
    use super::*;
    use grimodex_db::narrative_extraction::maintenance_runtime::NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN;
    use grimodex_db::state::WorkspaceAuthority;
    use serde_json::Value;
    use std::path::PathBuf;
    use std::sync::Arc;

    struct TestRoot(PathBuf);

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "grimodex-node-fault-red-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ))
    }

    fn backend_with_fresh_workspace(label: &str) -> (TestRoot, Backend, PathBuf) {
        let root = test_root(label);
        // Declare the guard before constructing Backend/WorkspaceAuthority so
        // an assertion panic drops the database owner before cleanup runs.
        let cleanup = TestRoot(root.clone());
        let workspace_path = root.join("workspace");
        let resources = root.join("resources");
        std::fs::create_dir_all(workspace_path.join(".grimodex"))
            .expect("workspace metadata directory");
        std::fs::write(
            workspace_path.join(".grimodex/workspace.json"),
            serde_json::json!({
                "id": format!("workspace-{label}"),
                "created_at": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .expect("workspace metadata");
        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        database
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed project");
        let authority = WorkspaceAuthority::from_database_for_test(database, workspace_path)
            .expect("workspace authority");
        let state = AppState::new(&root.to_string_lossy(), &resources.to_string_lossy())
            .expect("app state");
        state
            .narrative_maintenance_recovery_gate
            .mark_workspace_swapped();
        install_test_workspace(&state, Arc::clone(&authority));
        (
            cleanup,
            Backend {
                state: Arc::new(state),
            },
            root,
        )
    }

    #[tokio::test]
    async fn public_napi_fault_cycle_must_consume_discovered_fresh_workspace_backfill() {
        let (cleanup, backend, root_path) = backend_with_fresh_workspace("public-discovery");
        backend
            .state
            .narrative_maintenance_ci_seam
            .configure(NarrativeMaintenanceCiConfig {
                is_packaged: false,
                ci: "true".to_string(),
                owner_token: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN.to_string(),
                fault: Some(NarrativeMaintenanceCiFault::ContractViolation),
                trigger: None,
                setup: None,
                freshness_hold_project_id: None,
                product_journey_barrier_id: None,
                correlation: None,
            })
            .expect("configure fault seam");

        let discovery: Value = serde_json::from_str(
            &backend
                .discover_narrative_maintenance_work("workspace-opened".to_string())
                .await
                .expect("public discovery"),
        )
        .expect("discovery JSON");
        let discovered_work = discovery["pages"][0]["work"][0].clone();
        assert!(
            discovered_work["projectId"]
                .as_str()
                .is_some_and(|project_id| !project_id.is_empty()),
            "public discovery must return a concrete project identity"
        );
        assert_eq!(discovered_work["runKind"], "backfill");
        assert_eq!(discovered_work["semanticEpochId"], Value::Null);

        let cycle: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [discovered_work],
                    "wakeProjectIds": [],
                    "workspaceBinding": discovery["workspaceBinding"].clone(),
                }))
                .await
                .expect("public fault cycle"),
        )
        .expect("cycle JSON");
        assert_eq!(
            cycle["status"], "ci-terminal-fault-handled",
            "the configured fault must be reached through public discovery output"
        );

        let ack_run_id = cycle["runId"]
            .as_str()
            .expect("terminal fault ACK carries the durable Run id");
        let authority = active_database(&backend.state.ws).expect("active authority");
        let lifecycle: (String, String, String, Option<String>, i64, i64, i64) = authority
            .db()
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT r.status, t.status, a.status, a.failure_code,
                            (SELECT COUNT(*)
                               FROM narrative_extraction_runs rr
                              WHERE rr.id = r.id),
                            (SELECT COUNT(*)
                               FROM narrative_extraction_tasks tt
                              WHERE tt.run_id = r.id),
                            (SELECT COUNT(*)
                               FROM narrative_extraction_attempts aa
                               JOIN narrative_extraction_tasks at ON at.id = aa.task_id
                              WHERE at.run_id = r.id)
                       FROM narrative_extraction_runs r
                       JOIN narrative_extraction_tasks t ON t.run_id = r.id
                       JOIN narrative_extraction_attempts a ON a.task_id = t.id
                      WHERE r.id = ?1",
                    [ack_run_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    },
                )
                .map_err(Into::into)
            })
            .expect("read injected lifecycle");
        assert_eq!(lifecycle.0, "failed");
        assert_eq!(lifecycle.1, "failed");
        assert_eq!(lifecycle.2, "failed");
        assert_eq!(
            lifecycle.3.as_deref(),
            Some("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION")
        );
        assert_eq!((lifecycle.4, lifecycle.5, lifecycle.6), (1, 1, 1));

        drop(authority);
        drop(backend);
        drop(cleanup);
        assert!(!root_path.exists(), "fault seam fixture must clean up");
    }

    #[tokio::test]
    async fn native_empty_durable_wake_returns_authoritative_zero_work_receipt() {
        let (cleanup, backend, root_path) = backend_with_fresh_workspace("empty-wake");
        let authority = active_database(&backend.state.ws).expect("active authority");
        // Keep the wake durable and valid at the database boundary while
        // making discovery intentionally empty.  A missing project would
        // fail the project foreign-key contract before the Native receipt is
        // produced; the existing project-1 is marked as Scan staging, which
        // is the canonical no-work admission path.
        authority
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO project_settings (project_id, key, value)
                     VALUES ('project-1', 'scan.import.state', 'staging')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("mark project as scan-staging");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        let attempt_id = format!("attempt-empty-wake-{}", uuid::Uuid::new_v4());
        let begin: Value = serde_json::from_str(
            &backend
                .begin_narrative_maintenance_attempt(
                    attempt_id.clone(),
                    serde_json::to_value(&binding).expect("binding JSON"),
                )
                .await
                .expect("begin native attempt"),
        )
        .expect("begin receipt JSON");
        assert_eq!(begin["status"], "open");
        assert_eq!(begin["attemptId"], attempt_id);

        let cycle: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "attemptId": attempt_id,
                    "work": [],
                    "wakeProjectIds": ["project-1"],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("empty durable wake"),
        )
        .expect("cycle JSON");
        assert_eq!(cycle["status"], "accepted");

        let receipt: Value = serde_json::from_str(
            &backend
                .cancel_narrative_maintenance_attempt(attempt_id.clone(), "closed".to_string())
                .await
                .expect("native terminal receipt"),
        )
        .expect("terminal receipt JSON");
        assert_eq!(receipt["attemptId"], attempt_id);
        assert_eq!(receipt["state"], "succeeded");
        assert_eq!(receipt["works"], serde_json::json!([]));
        assert_eq!(
            receipt["workspaceBinding"],
            serde_json::to_value(binding).unwrap()
        );
        assert_eq!(receipt["connectionReusable"], true);

        drop(authority);
        drop(backend);
        drop(cleanup);
        assert!(!root_path.exists(), "empty wake fixture must clean up");
    }
}

#[cfg(test)]
mod narrative_maintenance_foreground_release_tests {
    use super::*;
    use grimodex_db::narrative_extraction::maintenance_runtime::NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN;
    use grimodex_db::narrative_extraction::NarrativeMaintenanceCiTrigger;
    use grimodex_db::state::{PinnedWorkspaceDb, WorkspaceAuthority};
    use serde_json::Value;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "grimodex-node-foreground-release-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ))
    }

    fn backend_with_workspace(label: &str) -> (Backend, PathBuf) {
        let root = test_root(label);
        let workspace_path = root.join("workspace");
        let resources = root.join("resources");
        std::fs::create_dir_all(&workspace_path).expect("workspace directory");
        let metadata_dir = workspace_path.join(".grimodex");
        std::fs::create_dir_all(&metadata_dir).expect("workspace metadata directory");
        std::fs::write(
            metadata_dir.join("workspace.json"),
            serde_json::json!({
                "id": format!("workspace-{label}"),
                "created_at": "2026-01-01T00:00:00.000Z"
            })
            .to_string(),
        )
        .expect("workspace metadata");
        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        database
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_semantic_epochs
                        (id, project_id, epoch_number, reason, created_at)
                     VALUES ('epoch-1', 'project-1', 0, 'initial',
                             '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed project and epoch");
        let authority = WorkspaceAuthority::from_database_for_test(database, workspace_path)
            .expect("workspace authority");
        let state = AppState::new(&root.to_string_lossy(), &resources.to_string_lossy())
            .expect("app state");
        // `open_workspace` invokes this hook after publishing the authority;
        // the fixture mirrors that production initial-open handoff rather
        // than manufacturing a binding for the release test.
        state
            .narrative_maintenance_recovery_gate
            .mark_workspace_swapped();
        install_test_workspace(&state, Arc::clone(&authority));
        (
            Backend {
                state: Arc::new(state),
            },
            root,
        )
    }

    fn configure_foreground_seam(backend: &Backend) {
        backend
            .state
            .narrative_maintenance_ci_seam
            .configure(NarrativeMaintenanceCiConfig {
                is_packaged: false,
                ci: "true".to_string(),
                owner_token: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN.to_string(),
                fault: None,
                trigger: Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake),
                setup: None,
                freshness_hold_project_id: None,
                product_journey_barrier_id: Some("barrier-test".to_string()),
                correlation: Some("correlation-test".to_string()),
            })
            .expect("configure foreground seam");
    }

    #[tokio::test]
    async fn delivery_failure_receipt_and_wake_ack_require_the_exact_live_binding() {
        let (backend, root) = backend_with_workspace("delivery-failure-binding-cas");
        let binding: Value = serde_json::from_str(
            &backend
                .get_narrative_maintenance_workspace_binding()
                .expect("read workspace binding")
                .expect("active workspace binding"),
        )
        .expect("binding JSON");
        let stale_binding = serde_json::json!({
            "authorityId": "stale-authority",
            "generation": binding["generation"].as_u64().expect("generation"),
        });
        let failure_payload = |workspace_binding: Value| {
            serde_json::json!({
                "schemaVersion": 1,
                "scope": "work",
                "projectId": "project-1",
                "runKind": "dependency-verify",
                "workKey": "dependency-verify:epoch-1",
                "semanticEpochId": "epoch-1",
                "workspaceBinding": workspace_binding,
                "retryCount": 4,
                "error": "NEX_MAINTENANCE_TRANSIENT: injected delivery failure",
            })
        };

        let stale: Value = serde_json::from_str(
            &backend
                .record_narrative_maintenance_delivery_failure(failure_payload(
                    stale_binding.clone(),
                ))
                .await
                .expect("typed stale-binding response"),
        )
        .expect("stale-binding JSON");
        assert_eq!(
            stale,
            serde_json::json!({ "status": "workspace-binding-mismatch" })
        );
        let listed: Vec<Value> = serde_json::from_str(
            &backend
                .list_narrative_maintenance_wake_outbox()
                .await
                .expect("list wakes after stale receipt"),
        )
        .expect("wake list JSON");
        assert!(
            listed.is_empty(),
            "stale receipt must write neither audit ACK nor wake"
        );
        assert!(
            !root
                .join("workspace/.grimodex/narrative-maintenance-delivery-failures.jsonl")
                .exists(),
            "stale receipt must not append a JSONL record"
        );

        let accepted: Value = serde_json::from_str(
            &backend
                .record_narrative_maintenance_delivery_failure(failure_payload(binding.clone()))
                .await
                .expect("accepted receipt"),
        )
        .expect("accepted receipt JSON");
        assert_eq!(accepted["status"], "accepted");
        assert!(accepted["receiptId"].as_str().is_some());
        let listed: Vec<Value> = serde_json::from_str(
            &backend
                .list_narrative_maintenance_wake_outbox()
                .await
                .expect("list durable recovery wake"),
        )
        .expect("wake list JSON");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["projectId"], "project-1");
        assert_eq!(listed[0]["operation"], "maintenance-delivery-failure");
        assert_eq!(listed[0]["reason"], "maintenance-delivery-failure");
        let wake_id = listed[0]["id"].as_str().expect("wake id").to_string();

        let stale_ack: Value = serde_json::from_str(
            &backend
                .ack_narrative_maintenance_wake_outbox(vec![wake_id.clone()], stale_binding)
                .await
                .expect("typed stale ACK response"),
        )
        .expect("stale ACK JSON");
        assert_eq!(
            stale_ack,
            serde_json::json!({ "status": "workspace-binding-mismatch" })
        );
        let still_pending: Vec<Value> = serde_json::from_str(
            &backend
                .list_narrative_maintenance_wake_outbox()
                .await
                .expect("list retained wake"),
        )
        .expect("wake list JSON");
        assert_eq!(still_pending.len(), 1, "stale ACK must retain durable wake");

        let ack: Value = serde_json::from_str(
            &backend
                .ack_narrative_maintenance_wake_outbox(vec![wake_id], binding)
                .await
                .expect("accepted ACK"),
        )
        .expect("ACK JSON");
        assert_eq!(
            ack,
            serde_json::json!({ "status": "accepted", "acknowledged": 1 })
        );
        drop(backend);
        let _ = std::fs::remove_dir_all(root);
    }

    async fn start_foreground_run(backend: &Backend) -> (String, PinnedWorkspaceDb) {
        configure_foreground_seam(backend);
        let authority = active_database(&backend.state.ws).expect("active authority");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        let result: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [{
                        "projectId": "project-1",
                        "runKind": "dependency-verify",
                        "workKey": "dependency-verify:epoch-1",
                        "semanticEpochId": "epoch-1",
                        "reasons": ["workspace-opened"]
                    }],
                    "wakeProjectIds": [],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("foreground cycle"),
        )
        .expect("cycle response JSON");
        // A foreground-held cycle deliberately defers its response while the
        // durable Run remains running for the exact release callback. Main
        // parks this Native delivery until that authoring barrier is released.
        assert_eq!(result["status"], "deferred");
        let config = backend
            .state
            .narrative_maintenance_ci_seam
            .config()
            .expect("configured seam");
        let barrier = narrative_extraction::find_running_foreground_system_work_run(
            &authority,
            &config,
            &narrative_maintenance_binding_for_authority(&backend.state, &authority),
        )
        .expect("find persisted barrier")
        .expect("foreground Run remains running");
        (barrier.run_id, authority)
    }

    fn run_status(authority: &PinnedWorkspaceDb, run_id: &str) -> String {
        authority
            .db()
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM narrative_extraction_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("run status")
    }

    fn duplicate_running_foreground_run(
        authority: &PinnedWorkspaceDb,
        source_run_id: &str,
        duplicate_run_id: &str,
    ) {
        authority
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
                         outcome_summary_json, created_at, started_at, completed_at, version,
                         run_kind, consumer_id, semantic_epoch_id, work_key, terminal_reason_code,
                         superseded_by_run_id, request_id, idempotency_domain,
                         request_payload_digest, actor_id)
                     SELECT ?1, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                            snapshot_digest, catalog_digest, registry_digest, 'running', coverage_json,
                            outcome_summary_json, created_at, started_at, NULL, version,
                            run_kind, consumer_id, semantic_epoch_id, work_key, NULL,
                            NULL, request_id, idempotency_domain, request_payload_digest, actor_id
                       FROM narrative_extraction_runs
                      WHERE id = ?2",
                    [duplicate_run_id, source_run_id],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("duplicate exact foreground marker Run");
    }

    fn rewrite_foreground_marker_authority(
        authority: &PinnedWorkspaceDb,
        run_id: &str,
        authority_id: &str,
    ) {
        authority
            .db()
            .with_conn(|conn| {
                let spec_json: String = conn.query_row(
                    "SELECT spec_json FROM narrative_extraction_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get(0),
                )?;
                let mut spec: Value = serde_json::from_str(&spec_json)?;
                spec["systemWork"]["authorityId"] = Value::String(authority_id.to_string());
                let updated_spec = serde_json::to_string(&spec)?;
                conn.execute(
                    "UPDATE narrative_extraction_runs SET spec_json = ?1 WHERE id = ?2",
                    [updated_spec.as_str(), run_id],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("rewrite foreground marker authority");
    }

    fn rewrite_foreground_marker_correlation(
        authority: &PinnedWorkspaceDb,
        run_id: &str,
        correlation: &str,
    ) {
        authority
            .db()
            .with_conn(|conn| {
                let spec_json: String = conn.query_row(
                    "SELECT spec_json FROM narrative_extraction_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get(0),
                )?;
                let mut spec: Value = serde_json::from_str(&spec_json)?;
                spec["systemWork"]["correlation"] = Value::String(correlation.to_string());
                let updated_spec = serde_json::to_string(&spec)?;
                conn.execute(
                    "UPDATE narrative_extraction_runs SET spec_json = ?1 WHERE id = ?2",
                    [updated_spec.as_str(), run_id],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("rewrite foreground marker correlation");
    }

    fn run_terminal_reason(authority: &PinnedWorkspaceDb, run_id: &str) -> Option<String> {
        authority
            .db()
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT terminal_reason_code FROM narrative_extraction_runs WHERE id = ?1",
                    [run_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("run terminal reason")
    }

    fn seed_verify_rebuild_work(authority: &PinnedWorkspaceDb) {
        authority
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_dependency_edges
                        (id, project_id, consumer_kind, consumer_key,
                         source_object_identity, read_set_json, created_at)
                     VALUES ('edge-rebuild-seam', 'project-1',
                             'narrative-extraction-run', 'run-1',
                             'project:scene:missing', '[]',
                             '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed Verify rebuild follow-up");
    }

    fn seed_project_epoch(authority: &PinnedWorkspaceDb, project_id: &str, epoch_id: &str) {
        authority
            .db()
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO projects (id, title) VALUES (?1, ?2)",
                    [project_id, project_id],
                )?;
                conn.execute(
                    "INSERT INTO narrative_semantic_epochs
                        (id, project_id, epoch_number, reason, created_at)
                     VALUES (?1, ?2, 0, 'initial',
                             '2026-01-01T00:00:00.000Z')",
                    [epoch_id, project_id],
                )?;
                Ok::<_, anyhow::Error>(())
            })
            .expect("seed project epoch");
    }

    fn backend_from_existing_workspace(root: &std::path::Path) -> Backend {
        let workspace_path = root.join("workspace");
        let resources = root.join("resources");
        let database = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        database.migrate().expect("database migration");
        let authority = WorkspaceAuthority::from_database_for_test(database, workspace_path)
            .expect("workspace authority");
        let state = AppState::new(&root.to_string_lossy(), &resources.to_string_lossy())
            .expect("fresh app state");
        // Same production initial-open handoff as `Backend::open_workspace`:
        // a fresh process starts a fresh generation before binding the DB.
        state
            .narrative_maintenance_recovery_gate
            .mark_workspace_swapped();
        install_test_workspace(&state, authority);
        Backend {
            state: Arc::new(state),
        }
    }

    #[tokio::test]
    async fn napi_release_is_exact_for_project_and_duplicate_safe() {
        let (backend, root) = backend_with_workspace("exact");
        let (run_id, authority) = start_foreground_run(&backend).await;
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        let binding_wire = serde_json::to_string(&binding).expect("binding JSON");
        let binding_json: Value = serde_json::from_str(&binding_wire).expect("binding JSON value");
        assert!(binding_json["generation"]
            .as_u64()
            .is_some_and(|generation| { generation > 0 && generation <= ((1u64 << 53) - 1) }));

        let unrelated = backend
            .release_narrative_maintenance_foreground_barrier(
                "project-other".to_string(),
                run_id.clone(),
            )
            .await
            .expect("unrelated project is ignored");
        let unrelated: Value = serde_json::from_str(&unrelated).expect("unrelated JSON");
        assert_eq!(unrelated["status"], "not-held");
        assert_eq!(run_status(&authority, &run_id), "running");

        let wrong_run = backend
            .release_narrative_maintenance_foreground_barrier(
                "project-1".to_string(),
                "wrong-run".to_string(),
            )
            .await
            .expect("wrong Run id is ignored");
        let wrong_run: Value = serde_json::from_str(&wrong_run).expect("wrong Run JSON");
        assert_eq!(wrong_run["status"], "not-held");
        assert_eq!(run_status(&authority, &run_id), "running");

        let completed = backend
            .release_narrative_maintenance_foreground_barrier(
                "project-1".to_string(),
                run_id.clone(),
            )
            .await
            .expect("exact project release");
        let completed: Value = serde_json::from_str(&completed).expect("completion JSON");
        assert_eq!(completed["status"], "completed");
        assert_eq!(completed["runId"], run_id);
        assert_eq!(run_status(&authority, &run_id), "completed");

        let duplicate = backend
            .release_narrative_maintenance_foreground_barrier(
                "project-1".to_string(),
                run_id.clone(),
            )
            .await
            .expect("duplicate exact release is idempotent");
        let duplicate: Value = serde_json::from_str(&duplicate).expect("duplicate JSON");
        assert_eq!(duplicate["status"], "not-held");
        assert_eq!(run_status(&authority, &run_id), "completed");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn napi_claim_is_exact_and_wrong_project_does_not_arm_release() {
        let (backend, root) = backend_with_workspace("claim");
        let (run_id, authority) = start_foreground_run(&backend).await;

        let wrong = backend
            .claim_narrative_maintenance_foreground_barrier("project-other".to_string())
            .await
            .expect("wrong project claim response");
        let wrong: Value = serde_json::from_str(&wrong).expect("wrong claim JSON");
        assert_eq!(wrong["status"], "not-held");
        assert_eq!(run_status(&authority, &run_id), "running");

        let exact = backend
            .claim_narrative_maintenance_foreground_barrier("project-1".to_string())
            .await
            .expect("exact project claim response");
        let exact: Value = serde_json::from_str(&exact).expect("exact claim JSON");
        assert_eq!(exact["status"], "claimed");
        assert_eq!(exact["runId"], run_id);
        assert_eq!(run_status(&authority, &run_id), "running");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn napi_duplicate_claim_cannot_release_same_marker_replacement_run() {
        let (backend, root) = backend_with_workspace("duplicate-claim");
        let (run_a, authority) = start_foreground_run(&backend).await;

        for _ in 0..2 {
            let claim = backend
                .claim_narrative_maintenance_foreground_barrier("project-1".to_string())
                .await
                .expect("duplicate exact claim response");
            let claim: Value = serde_json::from_str(&claim).expect("claim JSON");
            assert_eq!(claim["status"], "claimed");
            assert_eq!(claim["runId"], run_a);
        }

        let completed = backend
            .release_narrative_maintenance_foreground_barrier(
                "project-1".to_string(),
                run_a.clone(),
            )
            .await
            .expect("first timer completes Run A");
        let completed: Value = serde_json::from_str(&completed).expect("completion JSON");
        assert_eq!(completed["status"], "completed");
        assert_eq!(run_status(&authority, &run_a), "completed");

        duplicate_running_foreground_run(&authority, &run_a, "run-b");
        assert_eq!(run_status(&authority, "run-b"), "running");

        let stale_timer = backend
            .release_narrative_maintenance_foreground_barrier("project-1".to_string(), run_a)
            .await
            .expect("second timer must fail closed on the old Run id");
        let stale_timer: Value = serde_json::from_str(&stale_timer).expect("stale JSON");
        assert_eq!(stale_timer["status"], "not-held");
        assert_eq!(run_status(&authority, "run-b"), "running");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn napi_first_foreground_cycle_keeps_its_marked_run_until_exact_release() {
        let (backend, root) = backend_with_workspace("runtime-seam");
        let authority = active_database(&backend.state.ws).expect("active authority");
        grimodex_db::narrative_extraction::bootstrap_legacy_dependency_backfill_for_project(
            &authority,
            "project-1",
        )
        .expect("seed completed Backfill boundary");
        seed_verify_rebuild_work(&authority);
        configure_foreground_seam(&backend);
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);

        let cycle: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [{
                        "projectId": "project-1",
                        "runKind": "dependency-verify",
                        "workKey": "dependency-verify:epoch-1",
                        "semanticEpochId": "epoch-1",
                        "reasons": ["workspace-opened"]
                    }],
                    "wakeProjectIds": [],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("foreground cycle"),
        )
        .expect("cycle response JSON");
        // The successful foreground adapter keeps its durable lifecycle held;
        // the N-API contract therefore returns Deferred with no extra work
        // advertised until the exact barrier release completes.
        assert_eq!(cycle["status"], "deferred");
        assert_eq!(cycle["hasMore"], false);

        let rows: Vec<(String, String, String)> = authority
            .db()
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT id, status, spec_json
                       FROM narrative_extraction_runs
                      WHERE project_id = 'project-1'
                        AND run_kind = 'dependency-verify'
                        AND work_key = 'dependency-verify:epoch-1'
                      ORDER BY created_at ASC, id ASC",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .expect("read Verify rows");
        assert_eq!(
            rows.len(),
            1,
            "the first cycle must not dispatch a replacement"
        );
        assert_eq!(rows[0].1, "running");
        let spec: Value = serde_json::from_str(&rows[0].2).expect("Verify spec JSON");
        assert!(
            spec.get("systemWork").is_some(),
            "Run must retain its marker"
        );
        assert_eq!(run_terminal_reason(&authority, &rows[0].0), None);

        let follow_up: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [],
                    "wakeProjectIds": ["project-1"],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("same-process follow-up cycle"),
        )
        .expect("follow-up cycle JSON");
        // Rediscovery still observes the exact foreground owner, so this
        // cycle remains parked until the matching barrier release.
        assert_eq!(follow_up["status"], "deferred");
        assert_eq!(follow_up["hasMore"], false);

        let follow_up_rows: Vec<(String, String)> = authority
            .db()
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT id, status
                       FROM narrative_extraction_runs
                      WHERE project_id = 'project-1'
                        AND run_kind = 'dependency-verify'
                      ORDER BY created_at ASC, id ASC",
                )?;
                let rows = statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .expect("read follow-up Verify rows");
        assert_eq!(
            follow_up_rows,
            vec![(rows[0].0.clone(), "running".to_string())]
        );

        let claimed: Value = serde_json::from_str(
            &backend
                .claim_narrative_maintenance_foreground_barrier("project-1".to_string())
                .await
                .expect("exact foreground claim"),
        )
        .expect("claim JSON");
        assert_eq!(claimed["status"], "claimed");
        assert_eq!(claimed["runId"], rows[0].0);

        let released: Value = serde_json::from_str(
            &backend
                .release_narrative_maintenance_foreground_barrier(
                    "project-1".to_string(),
                    rows[0].0.clone(),
                )
                .await
                .expect("exact foreground release"),
        )
        .expect("release JSON");
        assert_eq!(released["status"], "completed");
        assert_eq!(released["runId"], rows[0].0);
        assert_eq!(run_status(&authority, &rows[0].0), "completed");

        let next = narrative_extraction::discover_durable_maintenance_work(
            &authority,
            "project-1",
            "durable-wake",
        )
        .expect("discover after exact release")
        .expect("Verify report must advance to Rebuild");
        assert_eq!(
            next.run_kind,
            grimodex_db::narrative_extraction::AutomaticRunKind::RebuildDerived
        );
        assert_eq!(next.semantic_epoch_id.as_deref(), Some("epoch-1"));

        // The completed marked Verify consumed the one-shot foreground slot
        // for this barrier/correlation.  A later public cycle must still
        // discover and execute the Rebuild phase, but its Run must remain
        // ordinary and unmarked.
        let next_cycle: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [],
                    "wakeProjectIds": ["project-1"],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("public follow-up cycle"),
        )
        .expect("public follow-up cycle JSON");
        assert_eq!(next_cycle["status"], "accepted");

        let all_rows: Vec<(String, String, String, String)> = authority
            .db()
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT id, run_kind, status, spec_json
                       FROM narrative_extraction_runs
                      WHERE project_id = 'project-1'
                      ORDER BY created_at ASC, id ASC",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .expect("read completed phase chain");
        let rebuild_rows: Vec<_> = all_rows
            .iter()
            .filter(|(_, run_kind, _, _)| run_kind == "semantic-index-rebuild")
            .collect();
        assert_eq!(rebuild_rows.len(), 1);
        assert_eq!(rebuild_rows[0].2, "completed");
        let rebuild_spec: Value =
            serde_json::from_str(&rebuild_rows[0].3).expect("Rebuild spec JSON");
        assert!(
            rebuild_spec.get("systemWork").is_none(),
            "follow-up Rebuild must not receive a second foreground marker"
        );

        let mut marked_run_ids = Vec::new();
        for (run_id, _, _, spec_json) in &all_rows {
            let spec: Value = serde_json::from_str(spec_json).expect("phase spec JSON");
            if spec.get("systemWork").is_some() {
                marked_run_ids.push(run_id.clone());
            }
        }
        assert_eq!(
            marked_run_ids,
            vec![rows[0].0.clone()],
            "the completed first marker must be the sole marker for this correlation"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn napi_held_a_blocks_marker_on_b_only_cycle_but_remains_releasable() {
        let (backend, root) = backend_with_workspace("held-a-b-only");
        let (run_a, authority) = start_foreground_run(&backend).await;
        seed_project_epoch(&authority, "project-2", "epoch-2");
        grimodex_db::narrative_extraction::bootstrap_legacy_dependency_backfill_for_project(
            &authority,
            "project-2",
        )
        .expect("seed B completed Backfill boundary");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);

        let b_cycle: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [{
                        "projectId": "project-2",
                        "runKind": "dependency-verify",
                        "workKey": "dependency-verify:epoch-2",
                        "semanticEpochId": "epoch-2",
                        "reasons": ["workspace-opened"]
                    }],
                    "wakeProjectIds": [],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("B-only cycle must execute ordinarily"),
        )
        .expect("B-only cycle JSON");
        assert_eq!(b_cycle["status"], "accepted");

        let b_rows: Vec<(String, String, String)> = authority
            .db()
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT id, status, spec_json
                       FROM narrative_extraction_runs
                      WHERE project_id = 'project-2'
                        AND run_kind = 'dependency-verify'
                      ORDER BY created_at ASC, id ASC",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .expect("read B ledger");
        assert_eq!(b_rows.len(), 1, "B must not spin replacement Runs");
        assert_eq!(b_rows[0].1, "completed");
        let b_spec: Value = serde_json::from_str(&b_rows[0].2).expect("B spec JSON");
        assert!(
            b_spec.get("systemWork").is_none(),
            "B must not claim A's foreground marker"
        );
        assert_eq!(run_status(&authority, &run_a), "running");

        let claimed: Value = serde_json::from_str(
            &backend
                .claim_narrative_maintenance_foreground_barrier("project-1".to_string())
                .await
                .expect("A remains claimable"),
        )
        .expect("A claim JSON");
        assert_eq!(claimed["status"], "claimed");
        assert_eq!(claimed["runId"], run_a);
        let released: Value = serde_json::from_str(
            &backend
                .release_narrative_maintenance_foreground_barrier(
                    "project-1".to_string(),
                    run_a.clone(),
                )
                .await
                .expect("A remains releasable"),
        )
        .expect("A release JSON");
        assert_eq!(released["status"], "completed");
        assert_eq!(run_status(&authority, &run_a), "completed");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn napi_other_authority_marker_does_not_reserve_current_slot() {
        let (backend, root) = backend_with_workspace("other-authority-slot");
        let (run_other, authority) = start_foreground_run(&backend).await;
        rewrite_foreground_marker_authority(&authority, &run_other, "authority:other");
        seed_project_epoch(&authority, "project-2", "epoch-2");
        grimodex_db::narrative_extraction::bootstrap_legacy_dependency_backfill_for_project(
            &authority,
            "project-2",
        )
        .expect("seed B completed Backfill boundary");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);

        let b_cycle: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [{
                        "projectId": "project-2",
                        "runKind": "dependency-verify",
                        "workKey": "dependency-verify:epoch-2",
                        "semanticEpochId": "epoch-2",
                        "reasons": ["workspace-opened"]
                    }],
                    "wakeProjectIds": [],
                    "workspaceBinding": binding.clone(),
                }))
                .await
                .expect("other-authority cycle"),
        )
        .expect("other-authority cycle JSON");
        // B claims the current authority's foreground slot and therefore
        // holds its durable lifecycle for the exact release callback.
        assert_eq!(b_cycle["status"], "deferred");
        assert_eq!(b_cycle["hasMore"], false);

        let b_row: (String, String, String) = authority
            .db()
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT id, status, spec_json
                       FROM narrative_extraction_runs
                      WHERE project_id = 'project-2'
                        AND run_kind = 'dependency-verify'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(Into::into)
            })
            .expect("read B marker row");
        assert_eq!(b_row.1, "running");
        let b_spec: Value = serde_json::from_str(&b_row.2).expect("B spec JSON");
        assert_eq!(
            b_spec["systemWork"]["authorityId"], binding.authority_id,
            "current authority may claim the slot when the durable marker belongs elsewhere"
        );
        assert_eq!(run_status(&authority, &run_other), "running");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn napi_foreground_owner_selects_current_run_when_stale_pending_exists() {
        let (backend, root) = backend_with_workspace("stale-pending-current");
        let (run_a, authority) = start_foreground_run(&backend).await;
        let config = backend
            .state
            .narrative_maintenance_ci_seam
            .config()
            .expect("configured seam");
        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        let stale = narrative_extraction::find_running_foreground_system_work_run(
            &authority, &config, &binding,
        )
        .expect("find initial marker")
        .expect("initial marker is running");

        let released: Value = serde_json::from_str(
            &backend
                .release_narrative_maintenance_foreground_barrier(
                    "project-1".to_string(),
                    run_a.clone(),
                )
                .await
                .expect("release initial Run"),
        )
        .expect("initial release JSON");
        assert_eq!(released["status"], "completed");
        backend
            .state
            .narrative_maintenance_foreground_barrier
            .remember(stale)
            .expect("retain stale process-local handle");

        rewrite_foreground_marker_correlation(&authority, &run_a, "correlation-stale");
        duplicate_running_foreground_run(&authority, &run_a, "run-current");
        rewrite_foreground_marker_correlation(&authority, "run-current", "correlation-test");
        let current = narrative_extraction::find_running_foreground_system_work_run(
            &authority, &config, &binding,
        )
        .expect("find replacement marker")
        .expect("replacement marker is running");
        assert_eq!(current.run_id, "run-current");
        backend
            .state
            .narrative_maintenance_foreground_barrier
            .remember(current.clone())
            .expect("retain current process-local handle");

        let follow_up: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [],
                    "wakeProjectIds": ["project-1"],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("current owner follow-up cycle"),
        )
        .expect("follow-up JSON");
        // The selected replacement Run is still foreground-held; an empty
        // wake remains deferred until that exact owner is released.
        assert_eq!(follow_up["status"], "deferred");
        assert_eq!(follow_up["hasMore"], false);
        assert_eq!(run_status(&authority, "run-current"), "running");
        assert_eq!(
            narrative_extraction::find_running_foreground_system_work_run(
                &authority,
                &config,
                &narrative_maintenance_binding_for_authority(&backend.state, &authority),
            )
            .expect("find current marker after follow-up")
            .expect("current marker remains running")
            .run_id,
            "run-current"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn napi_duplicate_terminal_and_running_markers_fail_closed() {
        let (backend, root) = backend_with_workspace("duplicate-terminal-running");
        let (run_a, authority) = start_foreground_run(&backend).await;
        let released: Value = serde_json::from_str(
            &backend
                .release_narrative_maintenance_foreground_barrier(
                    "project-1".to_string(),
                    run_a.clone(),
                )
                .await
                .expect("release first marker"),
        )
        .expect("release JSON");
        assert_eq!(released["status"], "completed");
        duplicate_running_foreground_run(&authority, &run_a, "run-duplicate");

        let binding = narrative_maintenance_binding_for_authority(&backend.state, &authority);
        let result: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [],
                    "wakeProjectIds": ["project-1"],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("duplicate exact markers must transfer responsibility"),
        )
        .expect("recovery transfer JSON");
        assert_eq!(result["status"], "workspace-unavailable");
        assert_eq!(result["reason"], "maintenance-recovery-required");
        assert!(result["descriptorId"].is_number());
        assert!(
            authority
                .db()
                .with_conn(|_| Ok::<_, anyhow::Error>(()))
                .is_err(),
            "the original authority must be quarantined before recovery handoff"
        );
        let replacement_db = Database::new(&root.join("workspace/grimodex.db"))
            .expect("replacement authority database");
        let replacement_authority =
            WorkspaceAuthority::from_database_for_test(replacement_db, root.join("workspace"))
                .expect("replacement authority");
        assert_eq!(run_status(&replacement_authority, &run_a), "completed");
        assert_eq!(
            run_status(&replacement_authority, "run-duplicate"),
            "running"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn napi_release_rejects_old_binding_after_workspace_replacement() {
        let (backend, root) = backend_with_workspace("swap");
        let (run_id, old_authority) = start_foreground_run(&backend).await;
        let new_workspace = root.join("replacement");
        std::fs::create_dir_all(&new_workspace).expect("replacement directory");
        let new_database = Database::new(&new_workspace.join("grimodex.db")).expect("new DB");
        new_database.migrate().expect("new DB migration");
        let new_authority = WorkspaceAuthority::from_database_for_test(new_database, new_workspace)
            .expect("new workspace authority");
        backend
            .state
            .narrative_maintenance_recovery_gate
            .mark_workspace_swapped();
        install_test_workspace(&backend.state, new_authority);

        let ignored = backend
            .release_narrative_maintenance_foreground_barrier(
                "project-1".to_string(),
                run_id.clone(),
            )
            .await
            .expect("old binding is ignored");
        let ignored: Value = serde_json::from_str(&ignored).expect("ignored JSON");
        assert_eq!(ignored["status"], "not-held");
        assert_eq!(run_status(&old_authority, &run_id), "running");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn napi_restart_honors_startup_recovery_backoff_before_creating_new_run() {
        let (backend, root) = backend_with_workspace("rediscovery");
        let (run_id, authority) = start_foreground_run(&backend).await;
        drop(authority);
        drop(backend);
        let backend = backend_from_existing_workspace(&root);
        configure_foreground_seam(&backend);
        let restarted_authority = active_database(&backend.state.ws).expect("restarted authority");

        // A fresh Backend has a new process-local recovery generation even
        // though the workspace metadata/authority ID is stable.  Release
        // must not treat the old durable marker as an overlapping foreground
        // write; StartupRecovery owns it first.
        let before_recovery = backend
            .release_narrative_maintenance_foreground_barrier(
                "project-1".to_string(),
                run_id.clone(),
            )
            .await
            .expect("old marker is not releasable after restart");
        let before_recovery: Value =
            serde_json::from_str(&before_recovery).expect("pre-recovery JSON");
        assert_eq!(before_recovery["status"], "not-held");
        assert_eq!(run_status(&restarted_authority, &run_id), "running");

        grimodex_db::narrative_extraction::bootstrap_legacy_dependency_backfill_for_project(
            &restarted_authority,
            "project-1",
        )
        .expect("seed completed Backfill boundary");

        let binding =
            narrative_maintenance_binding_for_authority(&backend.state, &restarted_authority);
        let cycle: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [{
                        "projectId": "project-1",
                        "runKind": "dependency-verify",
                        "workKey": "dependency-verify:epoch-1",
                        "semanticEpochId": "epoch-1",
                        "reasons": ["workspace-opened"]
                    }],
                    "wakeProjectIds": [],
                    "workspaceBinding": binding,
                }))
                .await
                .expect("startup recovery cycle"),
        )
        .expect("recovery cycle JSON");
        assert_eq!(cycle["status"], "accepted");
        assert_eq!(cycle["hasMore"], true);
        assert_eq!(run_status(&restarted_authority, &run_id), "failed");
        assert_eq!(
            run_terminal_reason(&restarted_authority, &run_id).as_deref(),
            Some("NEX_MAINTENANCE_INTERRUPTED")
        );

        let (failed_at, retry_at, rows_before_retry): (String, String, i64) = restarted_authority
            .db()
            .with_conn(|conn| {
                let (failed_at, retry_at) = conn.query_row(
                    "SELECT r.completed_at, a.next_attempt_at
                           FROM narrative_extraction_runs r
                           JOIN narrative_extraction_tasks t ON t.run_id = r.id
                           JOIN narrative_extraction_attempts a ON a.task_id = t.id
                          WHERE r.id = ?1 AND a.status = 'failed'
                       ORDER BY a.attempt_number DESC
                          LIMIT 1",
                    [&run_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                let rows_before_retry = conn.query_row(
                    "SELECT COUNT(*)
                           FROM narrative_extraction_runs
                          WHERE project_id = 'project-1'
                            AND run_kind = 'dependency-verify'",
                    [],
                    |row| row.get(0),
                )?;
                Ok::<_, anyhow::Error>((failed_at, retry_at, rows_before_retry))
            })
            .expect("read interrupted retry boundary");
        assert_eq!(
            rows_before_retry, 1,
            "startup recovery must not bypass the durable retry boundary"
        );
        assert!(
            retry_at > failed_at,
            "interruption retry must have a later not-before instant"
        );

        tokio::time::sleep(std::time::Duration::from_millis(
            grimodex_db::narrative_extraction::maintenance_runtime::retry_backoff_ms(1)
                .saturating_add(100),
        ))
        .await;

        let retry_binding =
            narrative_maintenance_binding_for_authority(&backend.state, &restarted_authority);
        let retry_cycle: Value = serde_json::from_str(
            &backend
                .run_narrative_maintenance_cycle(serde_json::json!({
                    "work": [{
                        "projectId": "project-1",
                        "runKind": "dependency-verify",
                        "workKey": "dependency-verify:epoch-1",
                        "semanticEpochId": "epoch-1",
                        "reasons": ["workspace-opened"]
                    }],
                    "wakeProjectIds": [],
                    "workspaceBinding": retry_binding,
                }))
                .await
                .expect("post-backoff recovery cycle"),
        )
        .expect("post-backoff cycle JSON");
        assert_eq!(retry_cycle["status"], "accepted");

        let config = backend
            .state
            .narrative_maintenance_ci_seam
            .config()
            .expect("configured seam");
        let replacement = narrative_extraction::find_running_foreground_system_work_run(
            &restarted_authority,
            &config,
            &narrative_maintenance_binding_for_authority(&backend.state, &restarted_authority),
        )
        .expect("inspect replacement marker");
        assert!(
            replacement.is_none(),
            "startup recovery must not create a duplicate foreground marker"
        );
        let replacement_rows: Vec<(String, String, String)> = restarted_authority
            .db()
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT id, status, spec_json
                       FROM narrative_extraction_runs
                      WHERE project_id = 'project-1'
                        AND run_kind = 'dependency-verify'
                      ORDER BY created_at ASC, id ASC",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .expect("read restart recovery rows");
        assert_eq!(replacement_rows.len(), 2);
        let replacement = replacement_rows
            .iter()
            .find(|(id, _, _)| id != &run_id)
            .expect("startup recovery creates one ordinary replacement");
        assert_eq!(replacement.1, "completed");
        let replacement_spec: Value =
            serde_json::from_str(&replacement.2).expect("replacement spec JSON");
        assert!(
            replacement_spec.get("systemWork").is_none(),
            "restart replacement must be unmarked"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
