//! Legacy Application backfill into the Semantic Build Graph (Gate C2 Wave 2
//! Lane K).
//!
//! Before Gate C2 (`narrative_semantic_epochs` / `narrative_dependency_edges`
//! / `narrative_application_contributions`, SCHEMA_VERSION 23), an "applied
//! Proposal Revision" was already a first-class, immutable concept --
//! `docs/adr/005-narrative-semantic-core-boundary.md`'s "Existing but
//! limited" Application-level Dependency: one row per applied entity in
//! `narrative_proposal_applications`, keyed to its owning (equally
//! immutable) `narrative_apply_commits` row (`commit.rs`). Those rows
//! predate the Semantic Build Graph entirely, so they have no Semantic
//! Epoch to be evaluated against and no Contribution bookkeeping (Lane H,
//! `application_contributions.rs`) for downstream Freshness / Undo fan-out
//! to walk.
//!
//! This module is the one-time, idempotent migration job that seeds:
//!
//!   1. an `initial` Semantic Epoch (epoch 0) for a project that has none
//!      yet -- nothing in the Build Graph can be evaluated without a
//!      generation boundary to evaluate against (`semantic_epoch.rs`, Lane
//!      A);
//!   2. one Contribution row per pre-existing Application, state
//!      `unchanged` -- "not yet evaluated", not "confirmed current". A
//!      later Freshness pass (Lane F's evaluator, out of scope here) is
//!      what actually determines whether a legacy Application's target is
//!      still faithful to what it wrote; and
//!   3. one generic Dependency Edge per pre-existing
//!      `narrative_projection_dependencies` row, so the Generic Graph
//!      (`dependency_edges.rs`) carries the same Source knowledge Legacy
//!      Freshness (`narrative_projection_freshness`) already has. Consumer
//!      identity is `(APPLICATION_CONSUMER_KIND, application_id)`, with the
//!      fresh Backfill Run stored in `owning_run_id`. A commit with a `NULL`
//!      `run_id` (predates the Run/Task/Attempt execution-state model entirely)
//!      has no durable projection lineage to backfill an Edge under; its
//!      Contribution row is still seeded, just with no matching Edge, and
//!      it is counted separately in the summary rather than silently
//!      dropped.
//!
//! `target_object_identity` goes through
//! `contribution_target_identity_for_application`, so a backfilled row and a
//! live Apply row describing the same object share one identity. This module
//! used to build `"{kind}:{id}"` straight from `applied_entity_kind`,
//! deferring the vocabulary difference (`event` vs `chronicle-event`,
//! `codex_entry` vs `codex-entry`) to "a Freshness-evaluator concern". That
//! was wrong: the two writers were producing strings that could never join,
//! and `codex.detail.value.set` was worse than a spelling difference -- it
//! named the detail-value row where the live path names the owning Codex
//! Entry, so even the ids differed. `field_path` uses
//! `LEGACY_BACKFILL_FIELD_PATH`, a sentinel marking "whole entity,
//! field-level detail unknown": these Applications predate per-field
//! Contribution tracking, so there is no real field path to recover.
//!
//! All three writes are layered directly on existing Lane primitives
//! (`create_epoch_in_tx`, `record_contribution_in_tx`,
//! `record_dependency_edge_in_tx`); this module adds no SQL beyond the read
//! queries that enumerate existing Applications and their legacy Freshness
//! dependencies. Like its dependencies, it is an ambient-transaction helper
//! -- the caller owns `BEGIN`/`COMMIT`.
//!
//! Idempotency: epoch creation is guarded by `get_current_epoch` (only
//! mints epoch 0 when the project has none yet), `record_contribution_in_tx`
//! upserts on `(project_id, application_id, target_object_identity,
//! field_path)`, and `record_dependency_edge_in_tx` upserts on `(project_id,
//! consumer_kind, consumer_key, source_object_identity)` -- so re-running
//! this backfill for a project that already ran it creates no duplicate
//! rows. `contributions_created`/`edges_created` in the returned summary
//! both report 0 on that second run.

use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::application_contributions::{
    contribution_target_identity_for_application, record_contribution_in_tx,
    reproject_user_ownership_from_authority_in_tx, ContributionField, ContributionProvenance,
    ContributionTargetState, UNRESOLVED_TARGET_PREFIX,
};
use super::dependency_edges::{
    canonical_source_object_identity, record_dependency_edge_in_tx, APPLICATION_CONSUMER_KIND,
};
use super::digest_plan;
use super::maintenance_lifecycle::{
    canonical_failure_message, complete_maintenance_run_in_tx, create_maintenance_run_in_tx,
    fail_maintenance_run_in_tx, hold_maintenance_run_in_tx, load_maintenance_run_in_tx,
    MaintenanceFailureKind,
};
use super::maintenance_runtime::{
    discover_durable_maintenance_work_in_tx, validate_phase_success_outcome, AutomaticRunKind,
    NarrativeMaintenanceCiFault, WorkKey,
};
use super::repository::{record_run_outcome_in_tx, SystemRunWorkKeyReuse};
use super::semantic_epoch::{create_epoch_in_tx, get_current_epoch};
use super::task_leases::with_immediate_transaction;
use super::terminal_failure::{
    project_terminal_failure_for_run_in_tx, resolve_terminal_failure_for_run_in_tx,
};
use crate::Database;

/// Generation of the production legacy dependency writer. This is the
/// writer-owned value consumed by the bundled producer registry; it changes
/// with the declaration semantics, not merely with a policy fixture.
pub(crate) const LEGACY_DEPENDENCY_PRODUCER_GENERATION: &str = "legacy-dependency-backfill:v3";

/// Work key every project's Legacy Dependency Backfill Run is created
/// under (Run Kind Policy `dependency-backfill`). One logical Backfill per
/// project per algorithm version -- see
/// [`bootstrap_legacy_dependency_backfill_for_project`]. It is deliberately
/// the same writer-owned generation value: the trailing `:v<n>` is load-
/// bearing and moves with [`LEGACY_BACKFILL_ALGORITHM_VERSION`], so a
/// completed Run from an older transform cannot be reused under a new
/// producer coordinate.
pub(crate) const LEGACY_BACKFILL_WORK_KEY: &str = LEGACY_DEPENDENCY_PRODUCER_GENERATION;

/// Sealed into the Run's `spec_json` per the Run Kind Policy's
/// `sealedParameters`. This backfill has no legacy schema-version/
/// high-water-mark to seal (its whole input is "every existing
/// `narrative_proposal_applications`/`narrative_projection_dependencies`
/// row", not a bounded/versioned slice), so `backfillAlgorithmVersion` is
/// the one parameter worth sealing: bump it if this transform's write
/// shape ever changes in a way that would make an older completed Run
/// unsafe to treat as equivalent to a fresh one. `"3"` since the writer now
/// emits Application-grained Edges owned by the fresh Backfill Run.
pub(crate) const LEGACY_BACKFILL_ALGORITHM_VERSION: &str = "3";

/// Validate the durable completion marker owned by the Backfill phase.
///
/// A `completed` Run with the right key/spec is not sufficient evidence that
/// the Backfill crossed its once-boundary: the terminal outcome must be the
/// current transform, bound to a project-owned Semantic Epoch, and carry the
/// complete summary shape. Discovery, recovery, and the direct Admin retry
/// all call this helper so they cannot disagree about whether a Run is safe to
/// reuse.
pub(crate) struct CompletedBackfillMarker<'a> {
    pub(crate) run_kind: &'a str,
    pub(crate) status: &'a str,
    pub(crate) spec_json: Option<&'a str>,
    pub(crate) semantic_epoch_id: Option<&'a str>,
    pub(crate) work_key: Option<&'a str>,
    pub(crate) completed_at: Option<&'a str>,
    pub(crate) outcome_summary_json: Option<&'a str>,
}

/// Parse the timestamp formats used by both current system Runs and legacy
/// SQLite rows. Marker reuse must use this same supported-instant contract as
/// discovery/recovery instead of trusting a non-empty arbitrary string.
pub(crate) fn parse_maintenance_instant(value: &str) -> anyhow::Result<DateTime<Utc>> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&Utc));
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
        .map(|parsed| DateTime::<Utc>::from_naive_utc_and_offset(parsed, Utc))
        .map_err(|_| {
            anyhow::anyhow!(
                "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: lifecycle timestamp '{value}' is not a supported instant"
            )
        })
}

pub(crate) fn is_valid_completed_backfill_marker(
    conn: &Connection,
    project_id: &str,
    marker: &CompletedBackfillMarker<'_>,
) -> anyhow::Result<bool> {
    if marker.run_kind != "backfill"
        || marker.status != "completed"
        || marker.work_key != Some(LEGACY_BACKFILL_WORK_KEY)
    {
        return Ok(false);
    }
    let Some(completed_at) = marker
        .completed_at
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(false);
    };
    if parse_maintenance_instant(completed_at).is_err() {
        return Ok(false);
    }
    let Some(epoch_id) = marker.semantic_epoch_id.filter(|value| !value.is_empty()) else {
        return Ok(false);
    };
    let epoch_belongs_to_project: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM narrative_semantic_epochs
              WHERE id = ?1 AND project_id = ?2
         )",
        params![epoch_id, project_id],
        |row| row.get::<_, i64>(0),
    )? != 0;
    if !epoch_belongs_to_project {
        return Ok(false);
    }

    let Some(spec_json) = marker.spec_json else {
        return Ok(false);
    };
    let Ok(spec) = serde_json::from_str::<serde_json::Value>(spec_json) else {
        return Ok(false);
    };
    if spec
        .get("backfillAlgorithmVersion")
        .and_then(|value| value.as_str())
        != Some(LEGACY_BACKFILL_ALGORITHM_VERSION)
    {
        return Ok(false);
    }

    let Some(outcome_json) = marker.outcome_summary_json else {
        return Ok(false);
    };
    let Ok(outcome) = serde_json::from_str::<serde_json::Value>(outcome_json) else {
        return Ok(false);
    };
    if outcome
        .get("maintenancePhase")
        .and_then(|value| value.as_str())
        != Some("backfill-complete")
        || outcome
            .get("backfillAlgorithmVersion")
            .and_then(|value| value.as_str())
            != Some(LEGACY_BACKFILL_ALGORITHM_VERSION)
        || outcome
            .get("semanticEpochId")
            .and_then(|value| value.as_str())
            != Some(epoch_id)
    {
        return Ok(false);
    }
    let Some(summary) = outcome.get("summary").and_then(|value| value.as_object()) else {
        return Ok(false);
    };
    Ok(summary
        .get("epoch_created")
        .and_then(|value| value.as_bool())
        .is_some()
        && summary
            .get("contributions_created")
            .and_then(|value| value.as_u64())
            .is_some()
        && summary
            .get("edges_created")
            .and_then(|value| value.as_u64())
            .is_some()
        && summary
            .get("applications_without_run_id")
            .and_then(|value| value.as_u64())
            .is_some())
}

/// Outcome of [`bootstrap_legacy_dependency_backfill_for_project`].
#[derive(Debug)]
pub enum LegacyBackfillBootstrapOutcome {
    /// A Backfill Run for this project already existed
    /// (`pending`/`running`/`completed`); this call did nothing further.
    AlreadyRun { run_id: String },
    /// This call created a fresh Run and ran the transform under it.
    Ran {
        run_id: String,
        summary: BackfillSummary,
    },
}

/// Result of consuming the typed CI fault at the native phase boundary.
///
/// The lifecycle owner creates the real Backfill Run before returning any
/// injected result.  `Failed` therefore represents a durable failed
/// Run/Task/Attempt triplet, while `Running` is the durable boundary used by
/// the N-API owner immediately before its deliberate process exit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyBackfillFaultOutcome {
    /// A valid completed or already-running Backfill owns this work, so the
    /// one-shot fault must not attach itself to another Run.
    NotInjected,
    /// A synthetic phase failure was finalized durably.
    Failed {
        run_id: String,
        semantic_epoch_id: String,
        failure_code: String,
    },
    /// Phase 1 committed a running lifecycle; the native owner may exit.
    Running {
        run_id: String,
        semantic_epoch_id: String,
    },
}

/// Consume a typed fault for one planner-validated Backfill identity.
///
/// The caller supplies the exact normalized WorkKey and all wake reasons that
/// accompanied it. Planner rechecks, current-Epoch validation, lifecycle
/// creation, and terminalization all run under one IMMEDIATE transaction on
/// the pinned authority connection. A stale epoch therefore rolls back before
/// a Run/Task/Attempt can be created under a different epoch.
pub fn inject_legacy_backfill_fault_for_work(
    db: &Database,
    expected_work: &WorkKey,
    reasons: &[String],
    fault: NarrativeMaintenanceCiFault,
) -> anyhow::Result<LegacyBackfillFaultOutcome> {
    anyhow::ensure!(
        expected_work.run_kind == AutomaticRunKind::Backfill,
        "NEX_MAINTENANCE_FAULT_WORK_IDENTITY_MISMATCH: fault seam only supports Backfill"
    );
    anyhow::ensure!(
        expected_work.work_key == LEGACY_BACKFILL_WORK_KEY,
        "NEX_MAINTENANCE_FAULT_WORK_IDENTITY_MISMATCH: Backfill work key is not canonical"
    );
    anyhow::ensure!(
        !reasons.is_empty(),
        "NEX_MAINTENANCE_FAULT_WORK_IDENTITY_MISMATCH: at least one planner reason is required"
    );

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let current_epoch_id = get_current_epoch(conn, &expected_work.project_id)?
                .map(|epoch| epoch.id);
            match (
                expected_work.semantic_epoch_id.as_deref(),
                current_epoch_id.as_deref(),
            ) {
                (Some(expected), Some(current)) => anyhow::ensure!(
                    expected == current,
                    "NEX_MAINTENANCE_FAULT_EPOCH_MISMATCH: current Semantic Epoch changed before fault injection"
                ),
                (Some(_), None) => anyhow::bail!(
                    "NEX_MAINTENANCE_FAULT_EPOCH_MISSING: expected Semantic Epoch is not current"
                ),
                (None, Some(_)) => anyhow::bail!(
                    "NEX_MAINTENANCE_FAULT_EPOCH_MISMATCH: an epoch-less Backfill is no longer current"
                ),
                (None, None) => {}
            }

            let normalized_reasons = reasons
                .iter()
                .map(|reason| {
                    let reason = reason.trim();
                    anyhow::ensure!(
                        !reason.is_empty() && !reason.contains(['/', '\\']),
                        "NEX_MAINTENANCE_FAULT_REASON_INVALID: planner reason is not canonical"
                    );
                    Ok::<_, anyhow::Error>(reason.to_string())
                })
                .collect::<anyhow::Result<Vec<_>>>()?;

            // A valid completed marker is durable evidence that this logical
            // Backfill has already crossed its once-only boundary. It is a
            // deterministic no-op for a real Backfill wake, even when a stale
            // product wake asks again. Validate that reason vocabulary first
            // so a private sentinel cannot turn the seam into a silent success.
            if find_valid_completed_backfill_run_id(conn, &expected_work.project_id)?.is_some() {
                anyhow::ensure!(
                    normalized_reasons.iter().all(|reason| matches!(
                        reason.as_str(),
                        "workspace-opened" | "legacy-backfill-required" | "durable-wake"
                    )),
                    "NEX_MAINTENANCE_FAULT_PLANNER_MISMATCH: completed Backfill cannot consume a crafted wake reason"
                );
                return Ok(LegacyBackfillFaultOutcome::NotInjected);
            }

            // Every normalized reason must independently rediscover the exact
            // requested identity. This rejects crafted reasons while allowing
            // the legitimate coalesced set (workspace-opened, durable-wake,
            // and legacy-backfill-required) to share one fault claim.
            for reason in &normalized_reasons {
                let planned = discover_durable_maintenance_work_in_tx(
                    conn,
                    &expected_work.project_id,
                    reason,
                    None,
                )?;
                anyhow::ensure!(
                    planned.is_some_and(|candidate| {
                        candidate.work_key_identity() == expected_work.clone()
                    }),
                    "NEX_MAINTENANCE_FAULT_PLANNER_MISMATCH: planner did not return the requested Backfill identity"
                );
            }

            let semantic_epoch_id = match current_epoch_id {
                Some(epoch_id) => epoch_id,
                None => create_epoch_in_tx(conn, &expected_work.project_id, "initial", None)?,
            };
            let spec = json!({ "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION });
            let spec_digest = format!("sha256:{}", digest_plan(&spec));
            let handle = create_maintenance_run_in_tx(
                conn,
                &expected_work.project_id,
                expected_work.run_kind.as_str(),
                &semantic_epoch_id,
                LEGACY_DEPENDENCY_PRODUCER_GENERATION,
                &spec,
                &spec_digest,
                SystemRunWorkKeyReuse::RunningOnly,
            )?;
            if handle.reused {
                return Ok(LegacyBackfillFaultOutcome::NotInjected);
            }

            match fault {
                NarrativeMaintenanceCiFault::ProcessInterruption => {
                    Ok(LegacyBackfillFaultOutcome::Running {
                        run_id: handle.run_id,
                        semantic_epoch_id,
                    })
                }
                NarrativeMaintenanceCiFault::TransientIo
                | NarrativeMaintenanceCiFault::ContractViolation => {
                    let failure_code = match fault {
                        NarrativeMaintenanceCiFault::TransientIo => "NEX_MAINTENANCE_TRANSIENT",
                        NarrativeMaintenanceCiFault::ContractViolation => {
                            "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"
                        }
                        NarrativeMaintenanceCiFault::ProcessInterruption => unreachable!(),
                    };
                    let failure_message = format!("{failure_code}: injected maintenance fault");
                    let transform_result: anyhow::Result<BackfillSummary> =
                        Err(anyhow::anyhow!(failure_message));
                    finalize_legacy_backfill_run_in_tx(
                        conn,
                        &expected_work.project_id,
                        &handle.run_id,
                        Some(&semantic_epoch_id),
                        &transform_result,
                    )?;
                    Ok(LegacyBackfillFaultOutcome::Failed {
                        run_id: handle.run_id,
                        semantic_epoch_id,
                        failure_code: failure_code.to_string(),
                    })
                }
            }
        })
    })
}

/// Consume one typed CI fault at the same Backfill lifecycle boundary used by
/// the production phase owner.  This helper is intentionally native-only
/// plumbing: it never exits the process and it never fabricates a Run outside
/// `create_maintenance_run_in_tx`.
pub fn inject_legacy_backfill_fault_for_project(
    db: &Database,
    project_id: &str,
    fault: NarrativeMaintenanceCiFault,
) -> anyhow::Result<LegacyBackfillFaultOutcome> {
    let semantic_epoch_id = db.with_conn(|conn| {
        get_current_epoch(conn, project_id).map(|epoch| epoch.map(|epoch| epoch.id))
    })?;
    let expected_work = match semantic_epoch_id {
        Some(epoch_id) => WorkKey::new_for_epoch(
            project_id,
            AutomaticRunKind::Backfill,
            LEGACY_BACKFILL_WORK_KEY,
            epoch_id,
        )?,
        None => WorkKey::new(
            project_id,
            AutomaticRunKind::Backfill,
            LEGACY_BACKFILL_WORK_KEY,
        )?,
    };
    inject_legacy_backfill_fault_for_work(
        db,
        &expected_work,
        &["workspace-opened".to_string()],
        fault,
    )
}

/// Field path recorded for every backfilled Contribution. Legacy
/// Applications predate per-field Contribution tracking, so there is no
/// specific JSON pointer to recover -- this sentinel stands for "the whole
/// entity this Application wrote, granularity unknown".
pub(crate) const LEGACY_BACKFILL_FIELD_PATH: &str = "/legacy-application";

/// Outcome of one `backfill_project_semantic_build_graph_in_tx` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackfillSummary {
    /// Whether this call minted the project's `initial` Semantic Epoch.
    /// `false` means the project already had at least one epoch.
    pub epoch_created: bool,
    /// Number of `narrative_application_contributions` rows this call
    /// actually inserted. Re-running against an already-backfilled project
    /// reports 0 here (the upserts still run, they just match existing
    /// rows), not the total number of legacy Applications seen.
    pub contributions_created: usize,
    /// Number of `narrative_dependency_edges` rows this call actually
    /// inserted (see `contributions_created`'s same re-run caveat: an
    /// upsert against an already-backfilled Edge reports 0 here, not the
    /// total number of legacy dependency rows seen).
    pub edges_created: usize,
    /// Legacy Applications seen whose owning `narrative_apply_commits` row
    /// has a `NULL` `run_id` -- predates the Run/Task/Attempt execution-state
    /// model. Their v3 Application Edge is still owned by the fresh Backfill
    /// Run; this count reports how many lacked the older durable lineage the
    /// C2-ZB migration requires.
    pub applications_without_run_id: usize,
}

struct LegacyApplication {
    id: String,
    commit_id: String,
    proposal_id: String,
    revision_id: String,
    applied_entity_kind: String,
    applied_entity_id: String,
    run_id: Option<String>,
}

struct LegacyProjectionDependency {
    source_kind: String,
    source_key: String,
    observed_revision_token: String,
}

/// Entry point for Legacy Dependency Backfill (Run Kind Policy
/// `dependency-backfill`), run once per Project. Unlike
/// [`backfill_project_semantic_build_graph_in_tx`], this owns its own
/// transaction(s) -- callers must not already be inside one.
///
/// Production callers include the Admin IPC `retryNarrativeLegacyBackfill`
/// and the C2-5B live phase owner. The latter supplies the same live
/// `Database` authority as Verify/Rebuild, so the automatic-once path does
/// not create a second connection that could fail a foreground deferred
/// transaction with `SQLITE_BUSY_SNAPSHOT`.
///
/// Three phases, each its own transaction, so a Phase 2 failure cannot
/// erase the Phase 1 Run record it should be explaining:
///
///   1. Strict completed-marker reuse check, then Run creation
///      (`create_system_run_in_tx` with running-only generic reuse) under a
///      freshly ensured/created Semantic Epoch. A completed Run is reused
///      only when its terminal outcome proves the Backfill boundary; a
///      `pending`/`running` Run is coalesced by the generic work-key check.
///   2. Run the transform itself
///      (`backfill_project_semantic_build_graph_in_tx`) in its own
///      transaction, so a failure rolls back only its own partial writes,
///      never the Run record from phase 1.
///   3. Finalize the Run's status to `completed`/`failed` based on phase
///      2's outcome, in yet another transaction -- always attempted, even
///      on phase 2 failure, so a failed attempt is visible via a `failed`
///      Run row rather than stuck at `running` forever.
///
/// A `failed` Run is not reused by phase 1's running-only check, so a later
/// invocation retries it. The C2-5B phase owner rediscovers this
/// durable work on the next wake/restart and applies the policy's bounded
/// retry classes (SQLite busy, process interruption, app shutdown, lease
/// timeout, and transient I/O); an operator can still invoke this entry point
/// explicitly through the Admin IPC.
/// A structurally-broken project
/// (`NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION`) fails the same way on
/// every invocation; Lane C projects that terminal evidence into the
/// Maintenance Inbox without changing current Freshness or Attention.
///
/// If a process terminates between phase 1 and phase 3, the shared
/// maintenance recovery ledger terminalizes the interrupted Run before the
/// phase owner rediscovers it. This keeps Backfill's once-boundary semantics
/// while allowing a retryable failure to be scheduled without creating a
/// second active Run.
pub fn bootstrap_legacy_dependency_backfill_for_project(
    db: &Database,
    project_id: &str,
) -> anyhow::Result<LegacyBackfillBootstrapOutcome> {
    let now = grimodex_core::now_rfc3339_millis();

    let (run_id, reused) = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let epoch_id = match get_current_epoch(conn, project_id)? {
                Some(epoch) => epoch.id,
                None => create_epoch_in_tx(conn, project_id, "initial", None)?,
            };
            let spec = json!({ "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION });
            let spec_digest = format!("sha256:{}", digest_plan(&spec));
            if let Some(run_id) = find_valid_completed_backfill_run_id(conn, project_id)? {
                return Ok((run_id, true));
            }
            let handle = create_maintenance_run_in_tx(
                conn,
                project_id,
                "backfill",
                &epoch_id,
                LEGACY_DEPENDENCY_PRODUCER_GENERATION,
                &spec,
                &spec_digest,
                // Completed rows are reused only through the strict marker
                // check above. A malformed completed row must not be returned
                // by generic work-key deduplication, or recovery would keep
                // rediscovering it without ever dispatching a fresh Backfill.
                SystemRunWorkKeyReuse::RunningOnly,
            )?;
            Ok((handle.run_id, handle.reused))
        })
    })?;

    if reused {
        return Ok(LegacyBackfillBootstrapOutcome::AlreadyRun { run_id });
    }

    let transform_result = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            backfill_project_semantic_build_graph_in_tx_for_run(conn, project_id, &now, &run_id)
        })
    });

    let finalize_result = finalize_legacy_backfill_run(db, project_id, &run_id, &transform_result);
    if let Err(finalize_error) = finalize_result {
        return Err(anyhow::anyhow!(
            "legacy dependency backfill: failed to finalize run '{run_id}' with durable terminal evidence: {finalize_error}"
        ));
    }

    match transform_result {
        Ok(summary) => Ok(LegacyBackfillBootstrapOutcome::Ran { run_id, summary }),
        Err(error) => Err(error),
    }
}

fn find_valid_completed_backfill_run_id(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Option<String>> {
    let mut statement = conn.prepare(
        "SELECT id, run_kind, status, spec_json, semantic_epoch_id, work_key,
                completed_at, outcome_summary_json
           FROM narrative_extraction_runs
          WHERE project_id = ?1 AND run_kind = 'backfill'
            AND work_key = ?2 AND status = 'completed'
          ORDER BY created_at DESC",
    )?;
    let rows = statement.query_map(params![project_id, LEGACY_BACKFILL_WORK_KEY], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
        ))
    })?;
    for row in rows {
        let (run_id, run_kind, status, spec_json, epoch_id, work_key, completed_at, outcome_json) =
            row?;
        if is_valid_completed_backfill_marker(
            conn,
            project_id,
            &CompletedBackfillMarker {
                run_kind: &run_kind,
                status: &status,
                spec_json: spec_json.as_deref(),
                semantic_epoch_id: epoch_id.as_deref(),
                work_key: work_key.as_deref(),
                completed_at: completed_at.as_deref(),
                outcome_summary_json: outcome_json.as_deref(),
            },
        )? {
            return Ok(Some(run_id));
        }
    }
    Ok(None)
}

/// Finalize one Backfill Run after its independent transform transaction.
/// Keeping this owner-only step in a named helper makes the phase boundary
/// explicit: the generic task APIs must not be able to cancel the Run between
/// the transform commit and this durable status/evidence transaction.
fn finalize_legacy_backfill_run(
    db: &Database,
    project_id: &str,
    run_id: &str,
    transform_result: &anyhow::Result<BackfillSummary>,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            finalize_legacy_backfill_run_in_tx(conn, project_id, run_id, None, transform_result)
        })
    })
}

/// Finalize a Backfill inside an already-open authority transaction. The
/// optional expected epoch is used by the CI fault seam to make the planner
/// identity and the lifecycle terminalization one atomic check/write.
fn finalize_legacy_backfill_run_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    expected_semantic_epoch_id: Option<&str>,
    transform_result: &anyhow::Result<BackfillSummary>,
) -> anyhow::Result<()> {
    let (actual_project_id, run_kind, work_key, semantic_epoch_id): (
        String,
        String,
        Option<String>,
        Option<String>,
    ) = conn.query_row(
        "SELECT project_id, run_kind, work_key, semantic_epoch_id
           FROM narrative_extraction_runs
          WHERE id = ?1",
        [run_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    anyhow::ensure!(
        actual_project_id == project_id,
        "NEX_BACKFILL_RUN_PROJECT_MISMATCH: Run '{run_id}' belongs to another project"
    );
    anyhow::ensure!(
        run_kind == "backfill" && work_key.as_deref() == Some(LEGACY_BACKFILL_WORK_KEY),
        "NEX_BACKFILL_RUN_WORK_IDENTITY_MISMATCH: Run '{run_id}' is not the canonical Backfill"
    );
    let semantic_epoch_id = semantic_epoch_id.ok_or_else(|| {
        anyhow::anyhow!("NEX_BACKFILL_RUN_EPOCH_MISSING: Run '{run_id}' has no Semantic Epoch")
    })?;
    if let Some(expected_semantic_epoch_id) = expected_semantic_epoch_id {
        anyhow::ensure!(
            semantic_epoch_id == expected_semantic_epoch_id,
            "NEX_BACKFILL_RUN_EPOCH_MISMATCH: Run '{run_id}' Semantic Epoch changed before finalization"
        );
    }
    let outcome = match transform_result {
        Ok(summary) => json!({
            "maintenancePhase": "backfill-complete",
            "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION,
            "semanticEpochId": semantic_epoch_id,
            "summary": summary,
        }),
        Err(error) => json!({
            "maintenancePhase": "backfill-failed",
            "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION,
            "semanticEpochId": semantic_epoch_id,
            "failure": error.to_string(),
        }),
    };
    if transform_result.is_ok() {
        validate_phase_success_outcome(
            "backfill",
            project_id,
            LEGACY_BACKFILL_WORK_KEY,
            Some(&semantic_epoch_id),
            &outcome,
        )?;
    }
    record_run_outcome_in_tx(conn, run_id, &outcome)?;
    if transform_result.is_ok()
        && super::maintenance_runtime::foreground_system_work_barrier_requested()
    {
        // The product-journey owner releases this exact Run after a
        // successful ordinary tree_node_patch. Validate that the native
        // lifecycle pair remains held with the Run.
        let handle = load_maintenance_run_in_tx(conn, run_id)?;
        hold_maintenance_run_in_tx(conn, &handle)?;
        return Ok(());
    }
    match transform_result {
        Ok(_) => {
            let handle = load_maintenance_run_in_tx(conn, run_id)?;
            let finalized_at = complete_maintenance_run_in_tx(conn, &handle)?;
            resolve_terminal_failure_for_run_in_tx(conn, project_id, run_id, &finalized_at)?;
        }
        Err(error) => {
            let message = error.to_string();
            let failure_kind = maintenance_failure_kind_for_message(&message);
            let handle = load_maintenance_run_in_tx(conn, run_id)?;
            let finalized_at = fail_maintenance_run_in_tx(conn, &handle, failure_kind, &message)?;
            project_terminal_failure_for_run_in_tx(
                conn,
                project_id,
                run_id,
                &canonical_failure_message(failure_kind, &message),
                &finalized_at,
                true,
            )?;
        }
    }
    Ok(())
}

fn maintenance_failure_kind_for_message(message: &str) -> MaintenanceFailureKind {
    let classification = super::maintenance_runtime::classify_failure(message);
    if classification.code == "NEX_MAINTENANCE_INTERRUPTED" {
        MaintenanceFailureKind::Interrupted
    } else if classification.retryable {
        MaintenanceFailureKind::Transient
    } else {
        MaintenanceFailureKind::Manual
    }
}

/// Status of the most recent Backfill Run for one project, if any --
/// `getNarrativeBackfillStatus`'s underlying read
/// (`narrative-run-kind-policy.json`'s `adminCommands`). Read-only: issues
/// only a `SELECT`, never creates a Run
/// (contrast [`bootstrap_legacy_dependency_backfill_for_project`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackfillStatus {
    pub run_id: String,
    pub status: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

pub fn get_backfill_status_for_project(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Option<BackfillStatus>> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    conn.query_row(
        "SELECT id, status, created_at, started_at, completed_at
           FROM narrative_extraction_runs
          WHERE project_id = ?1 AND run_kind = 'backfill' AND work_key = ?2
          ORDER BY created_at DESC LIMIT 1",
        params![project_id, LEGACY_BACKFILL_WORK_KEY],
        |row| {
            Ok(BackfillStatus {
                run_id: row.get(0)?,
                status: row.get(1)?,
                created_at: row.get(2)?,
                started_at: row.get(3)?,
                completed_at: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// Production Backfill transform. The freshly-created Backfill Run owns every
/// Application Edge it emits; the explicit owner prevents the legacy
/// ApplyCommit.run_id from being mistaken for the writer Run after C2-ZB.
pub(crate) fn backfill_project_semantic_build_graph_in_tx_for_run(
    conn: &Connection,
    project_id: &str,
    now: &str,
    backfill_run_id: &str,
) -> anyhow::Result<BackfillSummary> {
    anyhow::ensure!(
        !backfill_run_id.trim().is_empty(),
        "NEX_BACKFILL_RUN_INVALID: backfill Run id is required"
    );
    anyhow::ensure!(
        !project_id.is_empty(),
        "NEX_BACKFILL_PROJECT_INVALID: projectId is required"
    );
    anyhow::ensure!(
        !now.is_empty(),
        "NEX_BACKFILL_CREATED_AT_INVALID: now is required"
    );

    let epoch_created = if get_current_epoch(conn, project_id)?.is_none() {
        create_epoch_in_tx(conn, project_id, "initial", None)?;
        true
    } else {
        false
    };

    let contributions_before = count_contributions(conn, project_id)?;
    let edges_before = count_edges(conn, project_id)?;
    // The Feed head at the moment of the Backfill, and the lower bound every
    // row it writes gets.
    //
    // `None` was wrong, and not merely imprecise. The projection reads
    // `COALESCE(baseline_sequence, -1)`, so a NULL baseline claims "every
    // event ever recorded is evidence about this row" -- but the projection's
    // cursor is per project, and on any project whose Contributions have been
    // read before, it has already advanced past all of that history. The two
    // modules each assumed the other kept the coupling: the row said replay
    // everything, the cursor said there is nothing left to replay, and the
    // events in between reached the row never. Neither acknowledge helper can
    // move a cursor backwards -- both clamp with `MAX()` -- so the loss was
    // permanent.
    //
    // Anchoring to the head makes the row's claim match what the cursor can
    // actually deliver: everything before the Backfill is out of scope,
    // everything after it is evidence. That does give up pre-Backfill edits,
    // but by a rule stated once here rather than by an invisible interaction
    // between two watermarks.
    let backfill_baseline_sequence: Option<i64> = conn
        .query_row(
            "SELECT MAX(canonical_sequence) FROM narrative_change_events
              WHERE project_id = ?1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let mut applications_without_run_id = 0usize;
    for application in load_legacy_applications(conn, project_id)? {
        // `applied_entity_kind` is the writer-row vocabulary
        // (`codex_entry`, `temporal_scene_chronicle`, ...), which is neither
        // what the Change Feed addresses objects by nor what `commit.rs`'s
        // live Apply path writes into this same column. Both now go through
        // the one canonical mapping, so a backfilled row and a live row
        // describing the same object share an identity instead of being two
        // strings that never join.
        let target_object_identity = contribution_target_identity_for_application(
            conn,
            &application.applied_entity_kind,
            &application.applied_entity_id,
        )?;
        // `Unchanged` means "not yet evaluated", which is the right starting
        // point for a target that exists. A target that could not be resolved
        // at all is different: the object is gone, so the field this
        // Application wrote cannot still match what it applied, and recording
        // `unchanged` would assert something known to be false. `Missing` is
        // that state.
        let target_state = if target_object_identity.starts_with(UNRESOLVED_TARGET_PREFIX) {
            ContributionTargetState::Missing
        } else {
            ContributionTargetState::Unchanged
        };
        record_contribution_in_tx(
            conn,
            project_id,
            // `operation_id` is None, not missing data to fill in later: a
            // pre-Gate-C2 Application has no `narrative_apply_operations`
            // row, and that table carries no unique key this one could join
            // on to identify one retroactively.
            &ContributionProvenance {
                application_id: &application.id,
                commit_id: &application.commit_id,
                proposal_id: &application.proposal_id,
                revision_id: &application.revision_id,
                operation_id: None,
                // No Feed transaction exists for a pre-Gate-C0 commit, so no
                // canonical event corresponds to this Application itself.
                // The Backfill's own position in the Feed is the honest
                // stand-in -- see `backfill_baseline_sequence` above.
                baseline_sequence: backfill_baseline_sequence,
            },
            &ContributionField {
                target_object_identity: &target_object_identity,
                field_path: LEGACY_BACKFILL_FIELD_PATH,
                target_state,
                // A pre-Gate-C2 Application wrote the whole entity at unknown
                // granularity, so there is no Field Authority coordinate to
                // read ownership from. These rows stay `maintained` until a
                // human write on a real field stamps them.
                authority: None,
            },
            now,
        )?;

        if application.run_id.is_none() {
            applications_without_run_id += 1;
        }
        // The v3 writer has its own fresh Backfill Run owner.  The
        // ApplyCommit.run_id is lineage for the C2-ZB migration only, so a
        // legacy Application with NULL lineage can still emit its durable
        // projection dependency Edge under the fresh owner.
        record_legacy_dependency_edges_in_tx(
            conn,
            project_id,
            &application.id,
            backfill_run_id,
            now,
        )?;
    }
    // The rows minted above all took `authority: None` -- a whole-entity
    // sentinel is not a Field Authority coordinate, so there is nothing to
    // look up per row. That is correct at insert time and wrong a moment
    // later if the author had already claimed fields of these objects, which
    // is the common case: the Backfill runs on old workspaces, and old
    // workspaces have been edited. Replaying the ledger here makes ownership
    // independent of whether the Backfill or the human write happened first.
    reproject_user_ownership_from_authority_in_tx(conn, Some(project_id))?;

    let contributions_after = count_contributions(conn, project_id)?;
    let edges_after = count_edges(conn, project_id)?;

    Ok(BackfillSummary {
        epoch_created,
        contributions_created: contributions_after.saturating_sub(contributions_before),
        edges_created: edges_after.saturating_sub(edges_before),
        applications_without_run_id,
    })
}

/// Application-grained Dependency Edge backfill for one legacy Application:
/// every `narrative_projection_dependencies` row it left behind becomes one
/// Edge keyed by the Application and owned by the freshly-created Backfill
/// Run. The ApplyCommit's `run_id` is only the durable lineage used by the
/// C2-ZB re-key planner; it is never substituted for the writer owner here.
///
/// `dependency.source_key` is used directly as the Edge's
/// `source_object_identity`, for exactly the reason `repository.rs`'s
/// `record_run_dependency_edges_in_tx` documents: it is *not* run back
/// through `source_object_identity_for`. `narrative_projection_dependencies`
/// is written in one place only (`commit.rs`'s
/// `INSERT OR IGNORE INTO narrative_projection_dependencies`), from the
/// `SourceBasisRow`s that `reconciliation_envelope.rs`'s
/// `load_source_basis_rows`/`load_read_set_rows` produce -- and those carry
/// the envelope's `inputRef` verbatim, which `source_revision.rs`'s
/// per-kind resolvers require to already be prefixed (`resolve_scene_body`
/// rejects anything that does not `strip_prefix("project:scene:")` with
/// `NEX_SOURCE_KEY_INVALID`). Re-deriving the identity here prepended the
/// prefix a second time -- `project:scene:project:scene:s1` -- and every
/// backfilled Edge then evaluated as `source-missing` because no resolver
/// could match it back to its Source.
// NARRATIVE_DEPENDENCY_PRODUCER: legacy-application-projection-dependency
fn record_legacy_dependency_edges_in_tx(
    conn: &Connection,
    project_id: &str,
    application_id: &str,
    backfill_run_id: &str,
    now: &str,
) -> anyhow::Result<()> {
    for dependency in load_legacy_projection_dependencies(conn, application_id)? {
        let source_object_identity =
            canonical_source_object_identity(&dependency.source_kind, &dependency.source_key)?;
        let read_set_json = serde_json::to_string(&[dependency.observed_revision_token.as_str()])?;
        record_dependency_edge_in_tx(
            conn,
            project_id,
            APPLICATION_CONSUMER_KIND,
            application_id,
            &source_object_identity,
            &read_set_json,
            None,
            // C2-ZB: Application Edges carry the fresh Backfill Run as their
            // declaring owner. `run_id` is the legacy ApplyCommit lineage and
            // is intentionally not used as the Edge owner.
            Some(backfill_run_id),
            now,
        )?;
    }
    Ok(())
}

fn count_contributions(conn: &Connection, project_id: &str) -> anyhow::Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_application_contributions WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    Ok(usize::try_from(count).unwrap_or(0))
}

fn count_edges(conn: &Connection, project_id: &str) -> anyhow::Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_dependency_edges WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;
    Ok(usize::try_from(count).unwrap_or(0))
}

#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn backfill_project_semantic_build_graph_in_tx(
    conn: &Connection,
    project_id: &str,
    now: &str,
) -> anyhow::Result<BackfillSummary> {
    let backfill_run_id = format!("test-backfill-run-{project_id}");
    if project_id.is_empty() || now.is_empty() {
        return backfill_project_semantic_build_graph_in_tx_for_run(
            conn,
            project_id,
            now,
            &backfill_run_id,
        );
    }
    conn.execute(
        "INSERT OR IGNORE INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, run_kind, work_key)
         VALUES (?1, ?2, 'test', '{}', '{\"backfillAlgorithmVersion\":\"3\"}',
                 'sha256:test', 'completed', '{}', ?3, 'backfill', ?4)",
        params![backfill_run_id, project_id, now, LEGACY_BACKFILL_WORK_KEY],
    )?;
    backfill_project_semantic_build_graph_in_tx_for_run(conn, project_id, now, &backfill_run_id)
}

/// Every `narrative_projection_dependencies` row a legacy Application left
/// behind. `propagation` is always `'freshness-only'` today (the table's own
/// `CHECK`), so it carries no information beyond what `source_key`/
/// `observed_revision_token` already give the Generic Graph.
///
/// `source_kind` *is* loaded, even though `source_key` is normally already
/// the fully-qualified identity. `domain-projection` is the exception:
/// `resolve_domain_projection` accepts a bare id, so a legitimate envelope
/// can leave `projection-1` here, and only the kind says what prefix that
/// bare id is missing. `canonical_source_object_identity` needs both.
fn load_legacy_projection_dependencies(
    conn: &Connection,
    application_id: &str,
) -> anyhow::Result<Vec<LegacyProjectionDependency>> {
    let mut statement = conn.prepare(
        "SELECT source_kind, source_key, observed_revision_token
           FROM narrative_projection_dependencies
          WHERE application_id = ?1
          ORDER BY source_kind ASC, source_key ASC",
    )?;
    let rows = statement
        .query_map(params![application_id], |row| {
            Ok(LegacyProjectionDependency {
                source_kind: row.get(0)?,
                source_key: row.get(1)?,
                observed_revision_token: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Every pre-existing Application for `project_id`, oldest first.
/// `narrative_proposal_applications` has no `project_id` column of its own
/// -- ownership is inherited through the immutable `commit_id` ->
/// `narrative_apply_commits.project_id` link, the same join
/// `commit.rs`'s `validate_retraction_targets` uses to scope a target
/// Application to its project.
fn load_legacy_applications(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<LegacyApplication>> {
    let mut statement = conn.prepare(
        "SELECT a.id, a.commit_id, a.proposal_id, a.revision_id,
                a.applied_entity_kind, a.applied_entity_id, c.run_id
           FROM narrative_proposal_applications a
           INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
          WHERE c.project_id = ?1
          ORDER BY a.created_at ASC, a.id ASC",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok(LegacyApplication {
                id: row.get(0)?,
                commit_id: row.get(1)?,
                proposal_id: row.get(2)?,
                revision_id: row.get(3)?,
                applied_entity_kind: row.get(4)?,
                applied_entity_id: row.get(5)?,
                run_id: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::narrative_extraction::application_contributions::{
        list_contributions_for_application, list_contributions_for_target,
    };
    use crate::narrative_extraction::repository::cancel_run;
    use crate::narrative_extraction::semantic_epoch::list_epochs;
    use crate::Database;
    use std::path::Path;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db
    }

    fn seed_project(conn: &Connection, project_id: &str) {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, ?2)",
            params![project_id, "Test Project"],
        )
        .expect("seed project");
    }

    /// Minimal fixture matching the shape `commit.rs`'s
    /// `narrative_extraction_apply_commit` leaves behind: one applied
    /// commit row plus one applied-entity row. `commit.rs` has no
    /// `#[cfg(test)]` module of its own to mirror (its apply flow is
    /// covered by `tests/narrative_prepared_commit.rs` integration
    /// fixtures instead), so this inserts directly against the same
    /// production schema those rows are ultimately persisted through.
    #[allow(clippy::too_many_arguments)]
    fn seed_legacy_application(
        conn: &Connection,
        project_id: &str,
        commit_id: &str,
        application_id: &str,
        applied_entity_kind: &str,
        applied_entity_id: &str,
        created_at: &str,
    ) {
        seed_legacy_application_with_run(
            conn,
            project_id,
            commit_id,
            application_id,
            applied_entity_kind,
            applied_entity_id,
            created_at,
            None,
        );
    }

    /// As [`seed_legacy_application`], but also lets the owning commit's
    /// `run_id` be set so tests can exercise the durable lineage used by the
    /// C2-ZB migration.
    #[allow(clippy::too_many_arguments)]
    fn seed_legacy_application_with_run(
        conn: &Connection,
        project_id: &str,
        commit_id: &str,
        application_id: &str,
        applied_entity_kind: &str,
        applied_entity_id: &str,
        created_at: &str,
        run_id: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO narrative_apply_commits
                (id, project_id, run_id, request_id, plan_digest, status, created_at, version)
             VALUES (?1, ?2, ?3, ?4, ?5, 'applied', ?6, 0)",
            params![
                commit_id,
                project_id,
                run_id,
                format!("request-{commit_id}"),
                format!("digest-{commit_id}"),
                created_at,
            ],
        )
        .expect("seed commit");
        conn.execute(
            "INSERT INTO narrative_proposal_applications
                (id, commit_id, proposal_id, revision_id, applied_entity_kind,
                 applied_entity_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                application_id,
                commit_id,
                format!("proposal-{application_id}"),
                format!("revision-{application_id}"),
                applied_entity_kind,
                applied_entity_id,
                created_at,
            ],
        )
        .expect("seed application");
    }

    fn seed_legacy_projection_dependency(
        conn: &Connection,
        application_id: &str,
        source_kind: &str,
        source_key: &str,
        observed_revision_token: &str,
    ) {
        conn.execute(
            "INSERT INTO narrative_projection_dependencies
                (application_id, source_kind, source_key, observed_revision_token, propagation)
             VALUES (?1, ?2, ?3, ?4, 'freshness-only')",
            params![
                application_id,
                source_kind,
                source_key,
                observed_revision_token
            ],
        )
        .expect("seed projection dependency");
    }

    #[test]
    fn empty_project_only_creates_initial_epoch() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            let summary = backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T00:00:00.000Z",
            )?;
            assert!(summary.epoch_created);
            assert_eq!(summary.contributions_created, 0);

            let epoch = get_current_epoch(conn, "project-1")?.expect("epoch exists");
            assert_eq!(epoch.epoch_number, 0);
            assert_eq!(epoch.reason, "initial");
            Ok(())
        })
        .expect("backfill empty project");
    }

    /// A Backfill row's lower bound is where the Feed already is, not "no
    /// lower bound".
    ///
    /// NULL claimed every event ever recorded is evidence about the row,
    /// while the projection's per-project cursor had in general already moved
    /// past all of it -- and neither acknowledge helper can move a cursor
    /// backwards. The row asked for a replay that could never be delivered.
    #[test]
    fn a_backfilled_contribution_starts_at_the_current_feed_head() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            seed_legacy_application(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_entry",
                "entry-1",
                "2026-08-15T00:00:00.000Z",
            );
            conn.execute(
                "INSERT INTO change_events
                    (event_uid, project_id, domain, op_type, payload, session_id,
                     sequence, timestamp, prev_hash, hash)
                 VALUES ('uid-77', 'project-1', 'narrative', 'update', '{}', 'session-1',
                         77, 0, '', 'uid-77')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_change_transactions
                    (id, project_id, request_id, source_domain, source_change_event_uid,
                     source_change_event_sequence, cause_kind, origin, payload_digest,
                     created_at)
                 VALUES ('tx-77', 'project-1', 'req-77', 'test', 'uid-77', 77, 'forward',
                         'human', 'digest', '2026-08-15T01:00:00.000Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO narrative_change_events
                    (id, project_id, transaction_id, canonical_change_event_uid,
                     canonical_sequence, event_ordinal, object_key_json, change_kind,
                     mutation_kind, changed_paths_json, occurred_at)
                 VALUES ('ev-77', 'project-1', 'tx-77', 'uid-77', 77, 0,
                         '{\"kind\":\"scene\",\"sceneId\":\"s1\"}', 'content', 'update',
                         '[\"/title\"]', '2026-08-15T01:00:00.000Z')",
                [],
            )?;

            backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;

            let baseline: Option<i64> = conn.query_row(
                "SELECT baseline_sequence FROM narrative_application_contributions
                  WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(baseline, Some(77));
            Ok(())
        })
        .expect("test body");
    }

    #[test]
    fn existing_applications_get_one_unchanged_contribution_each() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            seed_legacy_application(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_entry",
                "entry-1",
                "2026-08-15T00:00:00.000Z",
            );
            seed_legacy_application(
                conn,
                "project-1",
                "commit-2",
                "app-2",
                "event",
                "event-1",
                "2026-08-15T01:00:00.000Z",
            );

            let summary = backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;
            assert!(summary.epoch_created);
            assert_eq!(summary.contributions_created, 2);

            let contributions_1 = list_contributions_for_application(conn, "project-1", "app-1")?;
            assert_eq!(contributions_1.len(), 1);
            assert_eq!(
                contributions_1[0].target_object_identity,
                "codex-entry:entry-1"
            );
            assert_eq!(contributions_1[0].field_path, LEGACY_BACKFILL_FIELD_PATH);
            assert_eq!(
                contributions_1[0].target_state,
                ContributionTargetState::Unchanged
            );

            let contributions_2 = list_contributions_for_application(conn, "project-1", "app-2")?;
            assert_eq!(contributions_2.len(), 1);
            // `event` in the writer-row vocabulary, `chronicle-event` in the
            // ratified Object Addressing one this column now uses.
            assert_eq!(
                contributions_2[0].target_object_identity,
                "chronicle-event:event-1"
            );
            Ok(())
        })
        .expect("backfill with applications");
    }

    #[test]
    fn rerunning_backfill_is_idempotent() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            seed_legacy_application(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_entry",
                "entry-1",
                "2026-08-15T00:00:00.000Z",
            );

            let first = backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;
            assert!(first.epoch_created);
            assert_eq!(first.contributions_created, 1);

            let second = backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T03:00:00.000Z",
            )?;
            assert!(!second.epoch_created, "epoch must not be re-minted");
            assert_eq!(
                second.contributions_created, 0,
                "re-run must not create duplicate contribution rows"
            );

            let epochs = list_epochs(conn, "project-1")?;
            assert_eq!(
                epochs.len(),
                1,
                "only one epoch should exist after two runs"
            );

            let contributions = list_contributions_for_application(conn, "project-1", "app-1")?;
            assert_eq!(contributions.len(), 1, "no duplicate contribution row");
            // The row's target_state / created_at should reflect the second
            // run's upsert, matching record_contribution_in_tx's documented
            // upsert-in-place behavior.
            assert_eq!(contributions[0].created_at, "2026-08-15T03:00:00.000Z");
            Ok(())
        })
        .expect("idempotent rerun");
    }

    #[test]
    fn applications_are_scoped_to_their_project() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            seed_project(conn, "project-2");
            seed_legacy_application(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_entry",
                "entry-1",
                "2026-08-15T00:00:00.000Z",
            );
            seed_legacy_application(
                conn,
                "project-2",
                "commit-2",
                "app-2",
                "codex_entry",
                "entry-2",
                "2026-08-15T00:00:00.000Z",
            );

            let summary = backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;
            assert_eq!(summary.contributions_created, 1);

            let project_1_contributions =
                list_contributions_for_target(conn, "project-1", "codex-entry:entry-1")?;
            assert_eq!(project_1_contributions.len(), 1);

            let project_2_contributions =
                list_contributions_for_target(conn, "project-2", "codex-entry:entry-2")?;
            assert!(
                project_2_contributions.is_empty(),
                "backfilling project-1 must not touch project-2's Applications"
            );

            // project-2 must still have no epoch of its own yet.
            assert!(get_current_epoch(conn, "project-2")?.is_none());
            Ok(())
        })
        .expect("project scoping");
    }

    #[test]
    fn empty_project_id_fails_closed() {
        let db = test_db();
        let error = db
            .with_conn(|conn| {
                backfill_project_semantic_build_graph_in_tx(conn, "", "2026-08-15T00:00:00.000Z")
            })
            .expect_err("empty projectId must be rejected");
        assert!(error
            .to_string()
            .starts_with("NEX_BACKFILL_PROJECT_INVALID"));
    }

    #[test]
    fn empty_now_fails_closed() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            Ok(())
        })
        .expect("seed project");
        let error = db
            .with_conn(|conn| backfill_project_semantic_build_graph_in_tx(conn, "project-1", ""))
            .expect_err("empty now must be rejected");
        assert!(error
            .to_string()
            .starts_with("NEX_BACKFILL_CREATED_AT_INVALID"));
    }

    #[test]
    fn applications_with_run_id_get_backfilled_dependency_edges() {
        use crate::narrative_extraction::dependency_edges::find_edges_by_consumer;

        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            seed_legacy_application_with_run(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_entry",
                "entry-1",
                "2026-08-15T00:00:00.000Z",
                Some("run-1"),
            );
            seed_legacy_projection_dependency(
                conn,
                "app-1",
                "scene-body",
                "project:scene:scene-1",
                "v1@2026-08-14T00:00:00.000Z",
            );

            let summary = backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;
            assert_eq!(summary.edges_created, 1);
            assert_eq!(summary.applications_without_run_id, 0);

            let edges =
                find_edges_by_consumer(conn, "project-1", APPLICATION_CONSUMER_KIND, "app-1")?;
            assert_eq!(edges.len(), 1);
            assert_eq!(edges[0].source_object_identity, "project:scene:scene-1");
            assert_eq!(edges[0].read_set_json, "[\"v1@2026-08-14T00:00:00.000Z\"]");
            Ok(())
        })
        .expect("backfill with run-scoped dependency edges");
    }

    /// `narrative_projection_dependencies.source_key` already holds the
    /// fully-qualified `source_object_identity` -- `commit.rs` writes it
    /// straight from the Reconciliation Envelope's `inputRef`, and
    /// `source_revision.rs`'s resolvers reject an `inputRef` that is not
    /// already prefixed. Backfill must therefore copy it, never re-derive
    /// it through `source_object_identity_for`: doing so produced
    /// `project:scene:project:scene:scene-1` and made every backfilled Edge
    /// evaluate as `source-missing`. Covers more than one source kind so the
    /// invariant is pinned to the rule, not to one prefix.
    #[test]
    fn backfilled_edges_never_double_prefix_the_source_identity() {
        use crate::narrative_extraction::dependency_edges::find_edges_by_consumer;
        use crate::narrative_extraction::restore_rebuild::verify_narrative_dependency_graph_for_project;

        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, snapshot_digest, created_at, version)
                 VALUES ('run-1', 'project-1', 'test', '{}', '{}', 'digest',
                         'completed', '{}', 'sha256:snapshot',
                         '2026-08-15T00:00:00.000Z', 0)",
                [],
            )?;
            seed_legacy_application_with_run(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_entry",
                "entry-1",
                "2026-08-15T00:00:00.000Z",
                Some("run-1"),
            );
            for (source_kind, source_key) in [
                ("scene-body", "project:scene:scene-1"),
                ("snapshot-document", "snapshot:run-1"),
                ("codex-catalog", "project:codex-catalog:project-1"),
                ("narrative-artifact", "artifact:artifact-1"),
            ] {
                seed_legacy_projection_dependency(
                    conn,
                    "app-1",
                    source_kind,
                    source_key,
                    "v1@2026-08-14T00:00:00.000Z",
                );
            }

            backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;

            let edges = find_edges_by_consumer(
                conn,
                "project-1",
                APPLICATION_CONSUMER_KIND,
                "app-1",
            )?;
            let mut identities = edges
                .iter()
                .map(|edge| edge.source_object_identity.as_str())
                .collect::<Vec<_>>();
            identities.sort_unstable();
            assert_eq!(
                identities,
                vec![
                    "artifact:artifact-1",
                    "project:codex-catalog:project-1",
                    "project:scene:scene-1",
                    "snapshot:run-1",
                ]
            );
            assert!(edges.iter().all(|edge| {
                edge.consumer_kind == APPLICATION_CONSUMER_KIND
                    && edge.owning_run_id.as_deref() == Some("test-backfill-run-project-1")
                    && edge.owning_run_id.as_deref() != Some("run-1")
            }));
            let snapshot_edge_id: String = conn.query_row(
                "SELECT id FROM narrative_dependency_edges
                  WHERE project_id = 'project-1'
                    AND consumer_kind = 'application'
                    AND consumer_key = 'app-1'
                    AND source_object_identity = 'snapshot:run-1'",
                [],
                |row| row.get(0),
            )?;
            let report = verify_narrative_dependency_graph_for_project(conn, "project-1")?;
            assert!(
                report.edge_ids_with_unresolvable_consumer_scope.is_empty(),
                "snapshot:run-1 must resolve through the original Apply Run while the Edge keeps the fresh Backfill owner"
            );
            assert!(
                !report
                    .edge_ids_with_missing_source
                    .contains(&snapshot_edge_id),
                "snapshot:run-1 must resolve as a source through the embedded Apply Run"
            );
            Ok(())
        })
        .expect("backfill copies the stored source identity verbatim");
    }

    /// The work key must carry the algorithm version, or a workspace that
    /// already completed an older Backfill silently reuses it and never runs
    /// the new transform.
    #[test]
    fn the_work_key_carries_the_algorithm_version() {
        assert!(
            LEGACY_BACKFILL_WORK_KEY.ends_with(&format!(":v{LEGACY_BACKFILL_ALGORITHM_VERSION}")),
            "work key '{LEGACY_BACKFILL_WORK_KEY}' must end with \
             ':v{LEGACY_BACKFILL_ALGORITHM_VERSION}'"
        );
    }

    /// A bare `projection-1` is a legitimate envelope value --
    /// `resolve_domain_projection` accepts it -- but `infer_source_kind` only
    /// recognises `projection:`-prefixed identities, so storing it verbatim
    /// produced an Edge the Evaluator reads as an unknown Source.
    #[test]
    fn a_bare_projection_source_key_is_canonicalized_into_the_edge() {
        use crate::narrative_extraction::dependency_edges::find_edges_by_consumer;

        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            seed_legacy_application_with_run(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_entry",
                "entry-1",
                "2026-08-15T00:00:00.000Z",
                Some("run-1"),
            );
            seed_legacy_projection_dependency(
                conn,
                "app-1",
                "domain-projection",
                "projection-1",
                "v1@2026-08-14T00:00:00.000Z",
            );

            backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;

            let edges =
                find_edges_by_consumer(conn, "project-1", APPLICATION_CONSUMER_KIND, "app-1")?;
            assert_eq!(edges.len(), 1);
            assert_eq!(edges[0].source_object_identity, "projection:projection-1");
            Ok(())
        })
        .expect("a bare projection key is canonicalized");
    }

    /// The Backfill sentinel must land on the same object the live Apply path
    /// records, which for a detail-value write is the owning Codex Entry --
    /// not the detail-value row. Only `field_path` may differ.
    #[test]
    fn a_detail_value_application_is_projected_onto_its_codex_entry() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, name, type)
                 VALUES ('entry-1', 'project-1', 'Entry', 'character')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_detail_definitions (id, project_id, type_slug, name)
                 VALUES ('def-1', 'project-1', 'character', 'Height')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_detail_values (id, entry_id, definition_id, value)
                 VALUES ('value-1', 'entry-1', 'def-1', '180cm')",
                [],
            )?;
            seed_legacy_application_with_run(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_detail_value",
                "value-1",
                "2026-08-15T00:00:00.000Z",
                Some("run-1"),
            );

            backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;

            let contributions = list_contributions_for_application(conn, "project-1", "app-1")?;
            assert_eq!(contributions.len(), 1);
            assert_eq!(
                contributions[0].target_object_identity, "codex-entry:entry-1",
                "the Backfill sentinel must name the Entry the live Apply path names"
            );
            Ok(())
        })
        .expect("detail value applications project onto their entry");
    }

    /// A detail value that no longer exists cannot be projected, and guessing
    /// would attribute the field to the wrong object.
    #[test]
    fn an_unresolvable_detail_value_is_marked_rather_than_guessed() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            seed_legacy_application_with_run(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_detail_value",
                "value-gone",
                "2026-08-15T00:00:00.000Z",
                Some("run-1"),
            );

            backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;

            let contributions = list_contributions_for_application(conn, "project-1", "app-1")?;
            assert_eq!(contributions.len(), 1);
            assert_eq!(
                contributions[0].target_object_identity,
                "unresolved:codex-detail-value:value-gone"
            );
            assert_eq!(
                contributions[0].target_state,
                ContributionTargetState::Missing,
                "an unresolvable target cannot still match what was applied"
            );
            Ok(())
        })
        .expect("an unresolvable detail value is marked");
    }

    #[test]
    fn applications_without_run_id_are_counted_but_still_emit_v3_edges() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            // seed_legacy_application (no run_id) matches every commit
            // predating the Run/Task/Attempt execution-state model.
            seed_legacy_application(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_entry",
                "entry-1",
                "2026-08-15T00:00:00.000Z",
            );
            seed_legacy_projection_dependency(
                conn,
                "app-1",
                "scene-body",
                "project:scene:scene-1",
                "v1@2026-08-14T00:00:00.000Z",
            );

            let summary = backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;
            assert_eq!(
                summary.contributions_created, 1,
                "Contribution seeding must still happen with no run_id"
            );
            assert_eq!(summary.edges_created, 1);
            assert_eq!(summary.applications_without_run_id, 1);
            Ok(())
        })
        .expect("backfill with no run id");
    }

    #[test]
    fn rerunning_backfill_edges_is_idempotent() {
        use crate::narrative_extraction::dependency_edges::find_edges_by_consumer;

        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            seed_legacy_application_with_run(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_entry",
                "entry-1",
                "2026-08-15T00:00:00.000Z",
                Some("run-1"),
            );
            seed_legacy_projection_dependency(
                conn,
                "app-1",
                "scene-body",
                "project:scene:scene-1",
                "v1@2026-08-14T00:00:00.000Z",
            );

            let first = backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T02:00:00.000Z",
            )?;
            assert_eq!(first.edges_created, 1);

            let second = backfill_project_semantic_build_graph_in_tx(
                conn,
                "project-1",
                "2026-08-15T03:00:00.000Z",
            )?;
            assert_eq!(
                second.edges_created, 0,
                "re-run must not create a duplicate Edge row"
            );

            let edges =
                find_edges_by_consumer(conn, "project-1", APPLICATION_CONSUMER_KIND, "app-1")?;
            assert_eq!(edges.len(), 1, "no duplicate edge row");
            Ok(())
        })
        .expect("idempotent edge rerun");
    }

    fn run_kind_and_status(db: &Database, run_id: &str) -> (String, String, Option<String>) {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT run_kind, status, work_key FROM narrative_extraction_runs WHERE id = ?1",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(Into::into)
        })
        .expect("read run")
    }

    #[test]
    fn bootstrap_creates_and_completes_a_backfill_run() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            seed_legacy_application_with_run(
                conn,
                "project-1",
                "commit-1",
                "app-1",
                "codex_entry",
                "entry-1",
                "2026-08-15T00:00:00.000Z",
                Some("run-1"),
            );
            seed_legacy_projection_dependency(
                conn,
                "app-1",
                "scene-body",
                "project:scene:scene-1",
                "v1@2026-08-14T00:00:00.000Z",
            );
            Ok(())
        })
        .expect("seed project");

        let outcome = bootstrap_legacy_dependency_backfill_for_project(&db, "project-1")
            .expect("bootstrap backfill");
        let run_id = match outcome {
            LegacyBackfillBootstrapOutcome::Ran { run_id, summary } => {
                assert_eq!(summary.contributions_created, 1);
                assert_eq!(summary.edges_created, 1);
                run_id
            }
            LegacyBackfillBootstrapOutcome::AlreadyRun { .. } => {
                panic!("first bootstrap call must create a fresh run, not reuse one")
            }
        };

        let (run_kind, status, work_key) = run_kind_and_status(&db, &run_id);
        assert_eq!(run_kind, "backfill");
        assert_eq!(status, "completed");
        assert_eq!(work_key.as_deref(), Some(LEGACY_BACKFILL_WORK_KEY));
    }

    #[test]
    fn backfill_owner_finalizer_survives_generic_cancel_phase_gap() {
        let db = test_db();
        let run_id = db
            .with_conn(|conn| {
                seed_project(conn, "project-1");
                with_immediate_transaction(conn, |conn| {
                    let epoch_id = create_epoch_in_tx(conn, "project-1", "initial", None)?;
                    let spec = json!({
                        "backfillAlgorithmVersion": LEGACY_BACKFILL_ALGORITHM_VERSION
                    });
                    let spec_digest = format!("sha256:{}", digest_plan(&spec));
                    let created = create_maintenance_run_in_tx(
                        conn,
                        "project-1",
                        "backfill",
                        &epoch_id,
                        LEGACY_BACKFILL_WORK_KEY,
                        &spec,
                        &spec_digest,
                        SystemRunWorkKeyReuse::RunningAndCompleted,
                    )?;
                    Ok(created.run_id)
                })
            })
            .expect("create phase-gap Backfill Run");

        let generic_error = cancel_run(&db, run_id.clone(), "project-1".to_string())
            .expect_err("generic cancellation must not win the Backfill phase gap");
        assert!(generic_error
            .to_string()
            .contains("NEX_SYSTEM_RUN_API_FORBIDDEN"));

        let transform_result: anyhow::Result<BackfillSummary> = Err(anyhow::anyhow!(
            "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION: committed transform cannot be finalized"
        ));
        finalize_legacy_backfill_run(&db, "project-1", &run_id, &transform_result)
            .expect("Backfill owner finalizer must retain failure evidence");

        db.with_conn(|conn| {
            let (status, terminal_code, observations): (String, Option<String>, i64) = conn
                .query_row(
                    "SELECT r.status, r.terminal_reason_code,
                            (SELECT COUNT(*) FROM narrative_maintenance_finding_observations
                              WHERE run_id = ?1)
                       FROM narrative_extraction_runs r WHERE r.id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            assert_eq!(status, "failed");
            assert!(terminal_code.is_some());
            assert!(
                observations > 0,
                "failed Backfill must retain terminal evidence"
            );
            Ok(())
        })
        .expect("read owner-finalized Backfill Run");
    }

    #[test]
    fn backfill_projection_failure_rolls_back_status_and_terminal_evidence() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            // This entity kind deliberately has no canonical Contribution
            // mapping, so the transform reaches the failed finalizer.
            seed_legacy_application(
                conn,
                "project-1",
                "commit-invalid",
                "application-invalid",
                "unsupported-entity-kind",
                "entity-invalid",
                "2026-08-22T00:00:00.000Z",
            );
            conn.execute_batch(
                "CREATE TRIGGER reject_backfill_terminal_lifecycle
                   BEFORE INSERT ON narrative_maintenance_finding_lifecycle
                   BEGIN
                     SELECT RAISE(ABORT, 'forced backfill lifecycle failure');
                   END;",
            )?;
            Ok(())
        })
        .expect("seed failed-backfill fixture");

        let error = match bootstrap_legacy_dependency_backfill_for_project(&db, "project-1") {
            Ok(_) => panic!("a projection failure must not look like a completed backfill"),
            Err(error) => error,
        };
        assert!(error
            .to_string()
            .contains("forced backfill lifecycle failure"));

        db.with_conn(|conn| {
            let (status, outcome, terminal_code, observations): (
                String,
                Option<String>,
                Option<String>,
                i64,
            ) = conn.query_row(
                "SELECT r.status, r.outcome_summary_json, r.terminal_reason_code,
                        (SELECT COUNT(*) FROM narrative_maintenance_finding_observations)
                   FROM narrative_extraction_runs r
                  WHERE r.project_id = 'project-1' AND r.run_kind = 'backfill'
                  ORDER BY julianday(COALESCE(r.completed_at, r.started_at, r.created_at)) DESC,
                           COALESCE(r.completed_at, r.started_at, r.created_at) DESC,
                           r.id DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(status, "running");
            assert_eq!(outcome, None);
            assert_eq!(terminal_code, None);
            assert_eq!(observations, 0);
            Ok(())
        })
        .expect("failed backfill finalization must roll back atomically");
    }

    #[test]
    fn bootstrap_is_automatic_once_per_project() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            Ok(())
        })
        .expect("seed project");

        let first = bootstrap_legacy_dependency_backfill_for_project(&db, "project-1")
            .expect("first bootstrap call");
        let first_run_id = match first {
            LegacyBackfillBootstrapOutcome::Ran { run_id, .. } => run_id,
            LegacyBackfillBootstrapOutcome::AlreadyRun { .. } => {
                panic!("first call must create a fresh run")
            }
        };

        let second = bootstrap_legacy_dependency_backfill_for_project(&db, "project-1")
            .expect("second bootstrap call");
        match second {
            LegacyBackfillBootstrapOutcome::AlreadyRun { run_id } => {
                assert_eq!(run_id, first_run_id, "must reuse the same completed run")
            }
            LegacyBackfillBootstrapOutcome::Ran { .. } => {
                panic!("second call must not create a duplicate backfill run")
            }
        }

        let run_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_extraction_runs
                      WHERE project_id = 'project-1' AND run_kind = 'backfill'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count backfill runs");
        assert_eq!(run_count, 1, "exactly one backfill run must ever exist");
    }

    #[test]
    fn bootstrap_requires_a_supported_completed_at_for_marker_reuse() {
        // A marker whose completed_at is NULL is not reusable evidence, so
        // bootstrap runs again. A marker carrying an unparseable instant is
        // corrupted ordering evidence: the lifecycle allocator fails closed
        // (NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID) instead of silently
        // ordering new work past it.
        let seeded_first_run = |completed_at: Option<&str>| {
            let db = test_db();
            db.with_conn(|conn| {
                seed_project(conn, "project-1");
                Ok(())
            })
            .expect("seed project");
            let first_run_id =
                match bootstrap_legacy_dependency_backfill_for_project(&db, "project-1")
                    .expect("initial bootstrap")
                {
                    LegacyBackfillBootstrapOutcome::Ran { run_id, .. } => run_id,
                    LegacyBackfillBootstrapOutcome::AlreadyRun { .. } => {
                        panic!("initial bootstrap must create a Run")
                    }
                };
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET completed_at = ?1 WHERE id = ?2",
                    params![completed_at, first_run_id],
                )?;
                Ok(())
            })
            .expect("corrupt completed timestamp");
            (db, first_run_id)
        };

        let (db, first_run_id) = seeded_first_run(None);
        let second = bootstrap_legacy_dependency_backfill_for_project(&db, "project-1")
            .expect("marker without completed_at must be rerunnable");
        let second_run_id = match second {
            LegacyBackfillBootstrapOutcome::Ran { run_id, .. } => run_id,
            LegacyBackfillBootstrapOutcome::AlreadyRun { .. } => {
                panic!("marker without completed_at must not be reused")
            }
        };
        assert_ne!(second_run_id, first_run_id);

        let (db, _) = seeded_first_run(Some("not-a-supported-instant"));
        let error = bootstrap_legacy_dependency_backfill_for_project(&db, "project-1")
            .expect_err("an unparseable marker instant must fail the allocator closed");
        assert!(error
            .to_string()
            .contains("NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID"));
    }

    #[test]
    fn bootstrap_handles_each_project_independently() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "project-1");
            seed_project(conn, "project-2");
            Ok(())
        })
        .expect("seed projects");

        bootstrap_legacy_dependency_backfill_for_project(&db, "project-1")
            .expect("bootstrap project-1");
        bootstrap_legacy_dependency_backfill_for_project(&db, "project-2")
            .expect("bootstrap project-2");

        for project_id in ["project-1", "project-2"] {
            let run_count: i64 = db
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_extraction_runs
                          WHERE project_id = ?1 AND run_kind = 'backfill'",
                        params![project_id],
                        |row| row.get(0),
                    )
                    .map_err(Into::into)
                })
                .expect("count backfill runs");
            assert_eq!(run_count, 1, "each project gets its own backfill run");
        }
    }
}
