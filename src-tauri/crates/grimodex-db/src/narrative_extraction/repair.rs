//! Gate C2 Run Kind Policy `dependency-repair`: manual-only correction of
//! Durable Dependency/Provenance declarations
//! (`narrative_dependency_edges`/`narrative_application_contributions`).
//!
//! Per the ratified principle ("Migration and recomputation are the
//! system's responsibility; correcting a meaningful durable declaration is
//! a human's responsibility"), this module implements the required
//! preconditions the policy fixes for this Run Kind
//! (`policies/narrative/narrative-run-kind-policy.json`'s
//! `requiredPreconditions`): a successful Verify Run id, a sealed repair
//! plan derived from that Verify's result, the plan's digest, the current
//! Semantic Epoch matching, an exclusive lease, an automatic backup,
//! explicit confirmation, and a change-count preview (the sealed plan
//! itself -- callers inspect `RepairPlan.edge_ids_to_deactivate` before
//! ever calling [`repair_narrative_dependency_declarations_for_project`]).
//!
//! # Scope of this implementation
//!
//! `narrative-run-kind-policy.json`'s `allowedRepairs` names six
//! categories. Only one is implemented end-to-end here --
//! `deactivate-duplicate-edge` -- because it is the only category
//! `restore_rebuild.rs`'s current `dependency-verify` coverage
//! (`DependencyGraphVerifyReport`, 6 of the policy's 13 named checks) can
//! actually surface: `edge-fully-reconstructible-from-durable-ledger`,
//! `artifact-with-explicit-dependency-manifest`,
//! `proposal-revision-edge-uniquely-derivable-from-source-basis-or-read-set`,
//! `application-contribution-uniquely-derivable-from-commit-receipt`, and
//! `supersede-a-clear-prior-generation` all depend on Verify checks this
//! crate does not implement yet
//! (`contribution-to-application-commit-correspondence`,
//! `application-revision-artifact-references`,
//! `legacy-mirror-migration-parity`, ...) -- there is nothing yet to seal
//! a plan *from* for those five. The lease/backup/epoch-match/confirmation
//! safety machinery below is generic and does not need to change as more
//! repair categories are added; only [`seal_repair_plan`] needs to grow.
//! `unrecoverableDisposition` (`detached`/`unknown`/`manual-review-required`)
//! is therefore also not implemented: nothing here classifies a finding
//! into that disposition yet, since the only finding this module can act
//! on today has a mechanical fix, not an unrecoverable one.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;

use super::digest_plan;
use super::execution_state::{transition_run_status_in_tx, NarrativeRunStatus};
use super::repository::{
    create_system_run_in_tx, record_run_outcome_in_tx, RunRequestIdentity, SystemRunWorkKeyReuse,
};
use super::restore_rebuild::{
    duplicate_edge_ids_to_deactivate, rebuild_repair_dependency_edges_in_tx,
    DependencyGraphVerifyReport, VERIFY_CONTRACT_VERSION, VERIFY_RUN_KIND,
};
use super::semantic_epoch::get_current_epoch;
use super::task_leases::with_immediate_transaction;
use crate::backup_restore::{create_persistent_live_safety_artifact, LiveSafetyArtifact};
use crate::Database;

const REPAIR_LEASE_TTL_SECONDS: i64 = 15 * 60;

/// Scopes Repair's `requestId` so it cannot collide with a request id
/// minted by any other surface.
const REPAIR_IDEMPOTENCY_DOMAIN: &str = "narrative.dependency-repair";

/// Identity a Repair lease claim is made under.
pub(crate) struct RepairLeaseClaim {
    pub lease_owner: String,
    pub verify_run_id: String,
    pub repair_plan_digest: String,
}

/// Claims the project's one Repair lease row (`PRIMARY KEY(project_id)`,
/// `narrative_maintenance_repair_leases`), or confirms the caller already
/// holds it for the exact same plan. Fails closed
/// (`NEX_REPAIR_LEASE_HELD`) if a *live* (non-expired) lease for a
/// different plan/owner already exists -- this is the policy's
/// `exclusive-workspace-lease` precondition, narrower than a full
/// workspace lock (see `migrate.rs`'s
/// `narrative_maintenance_repair_leases` table comment: SQLite's own
/// `BEGIN IMMEDIATE` already serializes the DML itself; this only
/// prevents two different sealed plans from both being "approved" for the
/// same project at once).
///
/// Ambient-transaction helper: the caller owns the surrounding
/// `BEGIN`/`COMMIT`.
pub(crate) fn claim_repair_lease_in_tx(
    conn: &Connection,
    project_id: &str,
    claim: &RepairLeaseClaim,
    semantic_epoch_id: &str,
    now: &str,
    expires_at: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(
        !claim.lease_owner.trim().is_empty(),
        "leaseOwner is required"
    );
    anyhow::ensure!(
        !claim.verify_run_id.trim().is_empty(),
        "verifyRunId is required"
    );
    anyhow::ensure!(
        !claim.repair_plan_digest.trim().is_empty(),
        "repairPlanDigest is required"
    );
    anyhow::ensure!(
        !semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );

    let existing: Option<(String, String, String, String)> = conn
        .query_row(
            "SELECT lease_owner, verify_run_id, repair_plan_digest, expires_at
               FROM narrative_maintenance_repair_leases WHERE project_id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;

    if let Some((existing_owner, existing_verify_run_id, existing_digest, existing_expires_at)) =
        &existing
    {
        let is_expired: bool = conn.query_row(
            "SELECT julianday(?1) < julianday('now')",
            params![existing_expires_at],
            |row| row.get(0),
        )?;
        let is_same_claim = existing_owner == &claim.lease_owner
            && existing_verify_run_id == &claim.verify_run_id
            && existing_digest == &claim.repair_plan_digest;
        anyhow::ensure!(
            is_expired || is_same_claim,
            "NEX_REPAIR_LEASE_HELD: project '{project_id}' already has an active Repair lease \
             held by '{existing_owner}' for a different plan"
        );
    }

    conn.execute(
        "INSERT INTO narrative_maintenance_repair_leases
            (project_id, lease_owner, verify_run_id, repair_plan_digest, semantic_epoch_id,
             claimed_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(project_id) DO UPDATE SET
             lease_owner = excluded.lease_owner,
             verify_run_id = excluded.verify_run_id,
             repair_plan_digest = excluded.repair_plan_digest,
             semantic_epoch_id = excluded.semantic_epoch_id,
             claimed_at = excluded.claimed_at,
             expires_at = excluded.expires_at",
        params![
            project_id,
            claim.lease_owner,
            claim.verify_run_id,
            claim.repair_plan_digest,
            semantic_epoch_id,
            now,
            expires_at,
        ],
    )?;
    Ok(())
}

/// Releases the project's Repair lease, if any. Not an error when there is
/// none to release (a lease may already have expired, or this may be a
/// best-effort cleanup call after a failure).
pub(crate) fn release_repair_lease_in_tx(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM narrative_maintenance_repair_leases WHERE project_id = ?1",
        params![project_id],
    )?;
    Ok(())
}

/// A sealed `dependency-repair` plan: the exact, deterministic set of
/// changes a Repair execution will make, plus the digest that binds a
/// lease claim and an execution call to this exact plan (if the
/// underlying data changes between sealing and execution, re-sealing
/// would produce a different digest, and [`claim_repair_lease_in_tx`]
/// would reject an execution attempt made against the stale one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairPlan {
    pub verify_run_id: String,
    pub semantic_epoch_id: String,
    /// Digest of the exact Verify report this plan was derived from,
    /// sealed into [`RepairPlan::digest`]. Two plans naming the same Edge
    /// ids but derived from different Verify results are different plans.
    pub verify_report_digest: String,
    pub edge_ids_to_deactivate: Vec<String>,
    pub digest: String,
}

impl RepairPlan {
    /// The change-count preview the policy's `change-count-preview`
    /// precondition requires a human see before confirming.
    pub fn change_count(&self) -> usize {
        self.edge_ids_to_deactivate.len()
    }
}

/// Seals a Repair plan for one project, **from a stored, completed
/// `dependency-verify` Run**. Today only the `deactivate-duplicate-edge`
/// category (`restore_rebuild::duplicate_edge_ids_to_deactivate`, surfaced
/// on the report as `duplicateEdgeIdsToDeactivate`) is populated -- see
/// this module's doc comment on why the other five `allowedRepairs`
/// categories cannot be proposed yet. An empty plan (nothing this Verify
/// coverage can propose a repair for) is a valid, non-error outcome; the
/// caller should not proceed to
/// [`repair_narrative_dependency_declarations_for_project`] with one.
///
/// `verifyRunId` is a *reference*, not a label. Every property the
/// policy's `verify-first` precondition depends on is checked here and
/// fails closed, because a Repair that trusts an unchecked run id is a
/// Repair with no verify-first precondition at all:
///
/// - the Run exists, belongs to `projectId`, and is a `dependency-verify`
/// - it reached `completed` -- a `failed`/`running` Verify proves nothing
/// - it ran under `semanticEpochId` -- a Verify from a prior generation
///   describes a graph that no longer exists
/// - it stored a Verify result under the *current* contract version, whose
///   recomputed digest still matches the digest recorded alongside it
/// - the live duplicate set still matches the one that Verify recorded, so
///   the plan describes the graph as it is now and not as it was
pub fn seal_repair_plan(
    conn: &Connection,
    project_id: &str,
    verify_run_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<RepairPlan> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!verify_run_id.trim().is_empty(), "verifyRunId is required");
    anyhow::ensure!(
        !semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );

    let verify = load_sealable_verify_result(conn, project_id, verify_run_id, semantic_epoch_id)?;

    // Derived from the Verify result, in the literal sense: this is the
    // list that Verify recorded, not a fresh re-derivation that merely
    // happens to be labelled with a Verify Run id.
    let mut edge_ids_to_deactivate = verify.report.duplicate_edge_ids_to_deactivate.clone();
    edge_ids_to_deactivate.sort();
    edge_ids_to_deactivate.dedup();

    // ...but a stored result is a snapshot, and Repair deletes rows. If
    // the graph moved since Verify observed it, the honest answer is
    // "re-verify", not "apply a plan derived from a stale observation".
    let mut live = duplicate_edge_ids_to_deactivate(conn, project_id)?;
    live.sort();
    live.dedup();
    anyhow::ensure!(
        live == edge_ids_to_deactivate,
        "NEX_REPAIR_PLAN_NOT_DERIVED_FROM_VERIFY: the Durable Graph's duplicate Edges no longer \
         match Verify Run '{verify_run_id}' ({} recorded, {} live) -- run a fresh \
         dependency-verify and seal from that result",
        edge_ids_to_deactivate.len(),
        live.len()
    );

    let sealed = json!({
        "planKind": "dependency-repair-v2",
        "verifyRunId": verify_run_id,
        "verifyReportDigest": verify.report_digest,
        "semanticEpochId": semantic_epoch_id,
        "edgeIdsToDeactivate": edge_ids_to_deactivate,
    });
    let digest = format!("sha256:{}", digest_plan(&sealed));

    Ok(RepairPlan {
        verify_run_id: verify_run_id.to_string(),
        semantic_epoch_id: semantic_epoch_id.to_string(),
        verify_report_digest: verify.report_digest,
        edge_ids_to_deactivate,
        digest,
    })
}

/// The Verify result a Repair plan may be sealed from.
struct SealableVerifyResult {
    report_digest: String,
    report: DependencyGraphVerifyReport,
}

/// Resolves `verify_run_id` into the Verify result it produced, or fails
/// closed. See [`seal_repair_plan`]'s doc comment for the list of
/// properties enforced and why each one matters; every rejection carries
/// its own `NEX_REPAIR_VERIFY_*` code so a caller can tell "no such Run"
/// from "that Run is still running" from "that Run is from a prior Epoch".
fn load_sealable_verify_result(
    conn: &Connection,
    project_id: &str,
    verify_run_id: &str,
    semantic_epoch_id: &str,
) -> anyhow::Result<SealableVerifyResult> {
    /// The `narrative_extraction_runs` columns this check reads.
    struct VerifyRunRow {
        project_id: String,
        run_kind: String,
        status: String,
        semantic_epoch_id: Option<String>,
        outcome_summary_json: Option<String>,
    }

    let row = conn
        .query_row(
            "SELECT project_id, run_kind, status, semantic_epoch_id, outcome_summary_json
               FROM narrative_extraction_runs
              WHERE id = ?1",
            params![verify_run_id],
            |row| {
                Ok(VerifyRunRow {
                    project_id: row.get(0)?,
                    run_kind: row.get(1)?,
                    status: row.get(2)?,
                    semantic_epoch_id: row.get(3)?,
                    outcome_summary_json: row.get(4)?,
                })
            },
        )
        .optional()?;

    let Some(VerifyRunRow {
        project_id: run_project_id,
        run_kind,
        status,
        semantic_epoch_id: run_epoch_id,
        outcome_summary_json: outcome_json,
    }) = row
    else {
        anyhow::bail!(
            "NEX_REPAIR_VERIFY_RUN_NOT_FOUND: no Run '{verify_run_id}' to seal a Repair plan from"
        );
    };
    anyhow::ensure!(
        run_project_id == project_id,
        "NEX_REPAIR_VERIFY_RUN_PROJECT_MISMATCH: Run '{verify_run_id}' belongs to project \
         '{run_project_id}', not '{project_id}'"
    );
    anyhow::ensure!(
        run_kind == VERIFY_RUN_KIND,
        "NEX_REPAIR_VERIFY_RUN_KIND_MISMATCH: Run '{verify_run_id}' is a '{run_kind}', not a \
         '{VERIFY_RUN_KIND}'"
    );
    anyhow::ensure!(
        status == "completed",
        "NEX_REPAIR_VERIFY_RUN_NOT_COMPLETED: Verify Run '{verify_run_id}' is '{status}'; only a \
         completed Verify can seal a Repair plan"
    );
    let run_epoch_id = run_epoch_id.unwrap_or_default();
    anyhow::ensure!(
        run_epoch_id == semantic_epoch_id,
        "NEX_REPAIR_VERIFY_RUN_EPOCH_MISMATCH: Verify Run '{verify_run_id}' ran under Semantic \
         Epoch '{run_epoch_id}', not the current '{semantic_epoch_id}'"
    );

    let outcome: serde_json::Value = outcome_json
        .as_deref()
        .filter(|json| !json.trim().is_empty())
        .map(serde_json::from_str)
        .transpose()?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_REPAIR_VERIFY_RESULT_MISSING: Verify Run '{verify_run_id}' recorded no result"
            )
        })?;

    let contract_version = outcome
        .get("verifyContractVersion")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    anyhow::ensure!(
        contract_version == VERIFY_CONTRACT_VERSION,
        "NEX_REPAIR_VERIFY_CONTRACT_VERSION_MISMATCH: Verify Run '{verify_run_id}' recorded a \
         version-'{contract_version}' result; this build seals only version \
         '{VERIFY_CONTRACT_VERSION}'"
    );

    let report_value = outcome.get("report").ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_REPAIR_VERIFY_RESULT_MISSING: Verify Run '{verify_run_id}' recorded no report"
        )
    })?;
    let recorded_digest = outcome
        .get("reportDigest")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let recomputed_digest = format!("sha256:{}", digest_plan(report_value));
    anyhow::ensure!(
        recorded_digest == recomputed_digest,
        "NEX_REPAIR_VERIFY_RESULT_DIGEST_MISMATCH: Verify Run '{verify_run_id}' recorded digest \
         '{recorded_digest}' but its stored report digests to '{recomputed_digest}'"
    );

    let report: DependencyGraphVerifyReport = serde_json::from_value(report_value.clone())
        .map_err(|error| {
            anyhow::anyhow!(
                "NEX_REPAIR_VERIFY_RESULT_MISSING: Verify Run '{verify_run_id}' recorded a report \
                 this build cannot read: {error}"
            )
        })?;

    Ok(SealableVerifyResult {
        report_digest: recomputed_digest,
        report,
    })
}

/// Outcome of one [`repair_narrative_dependency_declarations_for_project`]
/// call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairOutcome {
    pub edges_deactivated: usize,
    /// Filesystem path of the automatic backup taken before this repair
    /// executed. Empty when the plan was empty and no repair (and
    /// therefore no backup) was needed.
    pub backup_artifact_path: String,
}

fn safety_artifact_path_string(artifact: &LiveSafetyArtifact) -> String {
    match artifact {
        LiveSafetyArtifact::LogicalDb { path } => path.display().to_string(),
        LiveSafetyArtifact::ForensicBundle { dir } => dir.display().to_string(),
    }
}

/// Executes one `dependency-repair` Run: claims the exclusive lease, takes
/// an automatic backup, applies the sealed plan, and releases the lease.
/// Owns its own transaction(s) -- callers must not already be inside one.
///
/// Order matters and is fixed:
///
///   1. Epoch match (`plan.semantic_epoch_id` against the project's
///      *current* epoch) + lease claim, in one transaction -- a plan
///      sealed against a since-rotated Epoch is stale and must be
///      re-sealed, not blindly applied.
///   2. Automatic backup
///      (`backup_restore::create_persistent_live_safety_artifact`),
///      outside any DB transaction (it is filesystem I/O against the
///      live file, not a SQL write). A backup failure releases the lease
///      just claimed and fails closed
///      (`NEX_REPAIR_BACKUP_FAILED`) rather than proceeding without one.
///   3. Execute the plan
///      (`restore_rebuild::rebuild_repair_dependency_edges_in_tx`) and
///      release the lease, in one transaction. If execution fails, that
///      transaction rolls back (the lease release along with it), so the
///      lease is explicitly released again in a fresh transaction
///      afterward -- a failed repair must not leave the project locked
///      out of a corrected retry until TTL expiry.
///
/// `explicit_confirmation` must be `true` -- the policy's
/// `explicit-confirmation` precondition; this function takes no default.
/// An empty plan is a no-op that skips the lease/backup/execute machinery
/// entirely (nothing to protect against) and returns
/// `edges_deactivated: 0`.
///
/// `request_id`/`actor_id` are the policy's `stable-request-id` precondition
/// and the audit identity for a destructive operation. Before step 1 a
/// `dependency-repair` Run is created carrying both, and it is that Run's
/// request identity -- not the work key, which this Run Kind deliberately
/// declares `no-automatic-reuse-decision` -- that makes a retry of an
/// already-approved plan replay instead of repairing twice.
#[allow(clippy::too_many_arguments)]
pub fn repair_narrative_dependency_declarations_for_project(
    db: &Database,
    workspace_path: &Path,
    project_id: &str,
    plan: &RepairPlan,
    lease_owner: &str,
    explicit_confirmation: bool,
    request_id: &str,
    actor_id: &str,
) -> anyhow::Result<RepairOutcome> {
    anyhow::ensure!(
        explicit_confirmation,
        "NEX_REPAIR_CONFIRMATION_REQUIRED: dependency-repair requires explicit confirmation"
    );
    anyhow::ensure!(!lease_owner.trim().is_empty(), "leaseOwner is required");
    anyhow::ensure!(
        !request_id.trim().is_empty(),
        "NEX_REPAIR_REQUEST_ID_REQUIRED: dependency-repair requires a stable requestId"
    );
    anyhow::ensure!(
        !actor_id.trim().is_empty(),
        "NEX_REPAIR_ACTOR_REQUIRED: dependency-repair requires an actorId"
    );

    if plan.edge_ids_to_deactivate.is_empty() {
        return Ok(RepairOutcome {
            edges_deactivated: 0,
            backup_artifact_path: String::new(),
        });
    }

    let now = chrono::Utc::now();
    let now_text = now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let expires_at = (now + chrono::Duration::seconds(REPAIR_LEASE_TTL_SECONDS))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    // 0. The Run this repair executes under. Created before the lease so a
    //    replayed request is recognised before anything is claimed or
    //    written. The plan digest is the request payload: the same requestId
    //    arriving with a *different* sealed plan is a caller reusing an id
    //    for new work, and create_system_run_in_tx fails it closed rather
    //    than replaying the old approval onto new edges.
    let spec = json!({
        "verifyRunId": plan.verify_run_id,
        "repairPlanDigest": plan.digest,
        "edgeIdsToDeactivate": plan.edge_ids_to_deactivate.len(),
    });
    let spec_digest = format!("sha256:{}", digest_plan(&spec));
    let run = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            create_system_run_in_tx(
                conn,
                project_id,
                "dependency-repair",
                &plan.semantic_epoch_id,
                &plan.digest,
                &spec,
                &spec_digest,
                // Work equivalence deliberately never auto-reuses for
                // repair; request identity below is what makes a retry safe.
                SystemRunWorkKeyReuse::None,
                Some(&RunRequestIdentity {
                    request_id,
                    idempotency_domain: REPAIR_IDEMPOTENCY_DOMAIN,
                    payload_digest: &plan.digest,
                    actor_id,
                }),
            )
        })
    })?;
    let run_id = run["runId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("create_system_run_in_tx returned no runId"))?
        .to_string();
    if run["replayed"].as_bool().unwrap_or(false) {
        // "This request was seen before" is not "this request succeeded".
        // Only a completed Run replays as success, and it replays the
        // outcome it actually produced.
        return replay_repair_outcome(
            &run_id,
            run["status"].as_str().unwrap_or(""),
            &run["outcome"],
        );
    }

    // Everything past Run creation must land the Run in a terminal state,
    // including the epoch/lease/backup preconditions -- otherwise a failed
    // attempt leaves a `running` Run that a later replay would have to
    // guess about.
    let result = execute_repair_under_run(
        db,
        workspace_path,
        project_id,
        plan,
        lease_owner,
        &now_text,
        &expires_at,
        &run_id,
    );
    match &result {
        Ok(outcome) => {
            let recorded = json!({
                "edgesDeactivated": outcome.edges_deactivated,
                "backupArtifactPath": outcome.backup_artifact_path,
            });
            finalize_repair_run(db, &run_id, NarrativeRunStatus::Completed, Some(&recorded));
        }
        Err(error) => {
            let recorded = json!({ "failure": error.to_string() });
            finalize_repair_run(db, &run_id, NarrativeRunStatus::Failed, Some(&recorded));
        }
    }
    result
}

/// Reproduce the response a previously-seen request already produced.
///
/// Deliberately exhaustive over the Run status vocabulary: a replay must
/// never report work as done that did not happen, and a status this
/// function does not recognise is a reason to fail closed rather than
/// assume success.
fn replay_repair_outcome(
    run_id: &str,
    status: &str,
    outcome: &serde_json::Value,
) -> anyhow::Result<RepairOutcome> {
    match status {
        "completed" => Ok(RepairOutcome {
            edges_deactivated: outcome
                .get("edgesDeactivated")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as usize,
            backup_artifact_path: outcome
                .get("backupArtifactPath")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }),
        "failed" => {
            let failure = outcome
                .get("failure")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("the original attempt failed without a recorded reason");
            anyhow::bail!(
                "NEX_REPAIR_REQUEST_FAILED: this request already ran as Run '{run_id}' and \
                 failed: {failure}. Seal a fresh plan and issue a new requestId to retry."
            )
        }
        "pending" | "running" => anyhow::bail!(
            "NEX_REPAIR_REQUEST_IN_PROGRESS: this request is already running as Run '{run_id}'; \
             wait for it to finish rather than starting a second repair"
        ),
        "cancelled" | "superseded" => anyhow::bail!(
            "NEX_REPAIR_REQUEST_TERMINAL: this request's Run '{run_id}' is '{status}' and will \
             not produce a result; issue a new requestId"
        ),
        other => anyhow::bail!(
            "NEX_REPAIR_REQUEST_UNKNOWN_STATUS: Run '{run_id}' has unrecognized status \
             '{other}'; refusing to treat it as a successful replay"
        ),
    }
}

/// Land a Repair Run in a terminal state and store the outcome a replay
/// will reproduce. Failures here are logged rather than propagated: they
/// must not mask the real repair result, but they must not be silent
/// either, since a Run stuck `running` blocks every later replay.
fn finalize_repair_run(
    db: &Database,
    run_id: &str,
    status: NarrativeRunStatus,
    outcome: Option<&serde_json::Value>,
) {
    let result = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            if let Some(outcome) = outcome {
                record_run_outcome_in_tx(conn, run_id, outcome)?;
            }
            transition_run_status_in_tx(conn, run_id, status)
        })
    });
    if let Err(error) = result {
        tracing::error!(
            "dependency-repair: failed to finalize run '{run_id}' as {status:?}: {error}"
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_repair_under_run(
    db: &Database,
    workspace_path: &Path,
    project_id: &str,
    plan: &RepairPlan,
    lease_owner: &str,
    now_text: &str,
    expires_at: &str,
    _run_id: &str,
) -> anyhow::Result<RepairOutcome> {
    // 1. Epoch match + lease claim.
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let current_epoch_id = get_current_epoch(conn, project_id)?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_REPAIR_NO_EPOCH: project '{project_id}' has no Semantic Epoch"
                    )
                })?
                .id;
            anyhow::ensure!(
                current_epoch_id == plan.semantic_epoch_id,
                "NEX_REPAIR_EPOCH_MISMATCH: sealed plan's Semantic Epoch ('{}') is no longer \
                 the project's current one ('{current_epoch_id}') -- re-seal the plan",
                plan.semantic_epoch_id
            );
            claim_repair_lease_in_tx(
                conn,
                project_id,
                &RepairLeaseClaim {
                    lease_owner: lease_owner.to_string(),
                    verify_run_id: plan.verify_run_id.clone(),
                    repair_plan_digest: plan.digest.clone(),
                },
                &current_epoch_id,
                now_text,
                expires_at,
            )
        })
    })?;

    // 2. Automatic backup.
    let db_path = workspace_path.join("grimodex.db");
    let backup_artifact = match create_persistent_live_safety_artifact(workspace_path, &db_path) {
        Ok(artifact) => artifact,
        Err(error) => {
            let _ = db.with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    release_repair_lease_in_tx(conn, project_id)
                })
            });
            anyhow::bail!("NEX_REPAIR_BACKUP_FAILED: {error}");
        }
    };
    let backup_artifact_path = safety_artifact_path_string(&backup_artifact);

    // 3. Execute + release lease.
    let execute_result = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let deleted = rebuild_repair_dependency_edges_in_tx(
                conn,
                project_id,
                &plan.edge_ids_to_deactivate,
            )?;
            release_repair_lease_in_tx(conn, project_id)?;
            Ok(deleted)
        })
    });

    match execute_result {
        Ok(edges_deactivated) => Ok(RepairOutcome {
            edges_deactivated,
            backup_artifact_path,
        }),
        Err(error) => {
            let _ = db.with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    release_repair_lease_in_tx(conn, project_id)
                })
            });
            Err(error)
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::narrative_extraction::dependency_edges::{
        record_dependency_edge_in_tx, RUN_CONSUMER_KIND,
    };
    use crate::narrative_extraction::restore_rebuild::{
        run_dependency_verify_for_project, verify_narrative_dependency_graph_for_project,
    };
    use crate::narrative_extraction::semantic_epoch::create_epoch_in_tx;
    use std::path::PathBuf;

    /// Repair's automatic backup step needs a real, file-backed workspace
    /// (it `VACUUM INTO`s the live `.db` file) -- unlike every other test
    /// in this crate's own `#[cfg(test)]` modules, `:memory:` will not do.
    /// Matches `backup_restore.rs`'s own test fixture convention
    /// (`std::env::temp_dir()` + a UUID-suffixed directory name, no
    /// `tempfile` crate dependency).
    fn test_workspace(label: &str) -> (PathBuf, Database) {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-repair-test-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create fixture workspace dir");
        let db = Database::new(&dir.join("grimodex.db")).expect("open workspace database");
        db.migrate().expect("migrate");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project");
        (dir, db)
    }

    fn seed_epoch(db: &Database, project_id: &str) -> String {
        db.with_conn(|conn| create_epoch_in_tx(conn, project_id, "initial", None))
            .expect("create epoch")
    }

    /// Runs a real `dependency-verify` and returns its Run id. Sealing a
    /// plan needs one: `seal_repair_plan` reads its candidates out of a
    /// completed Verify Run's stored result, so a made-up run id is not a
    /// shortcut a test can take either.
    ///
    /// Call this *after* seeding whatever the Verify is supposed to
    /// observe -- the report is a snapshot, and sealing against a graph
    /// that moved since is exactly what `seal_repair_plan` rejects.
    fn seed_verify_run(db: &Database, project_id: &str) -> String {
        run_dependency_verify_for_project(db, project_id)
            .expect("run a dependency-verify")
            .run_id
    }

    /// Seeds a Run of an arbitrary kind/status directly, for the cases
    /// where `seal_repair_plan` has to reject the Run it is handed.
    fn seed_raw_run(
        db: &Database,
        run_id: &str,
        project_id: &str,
        run_kind: &str,
        status: &str,
        epoch_id: &str,
        outcome: Option<&serde_json::Value>,
    ) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, created_at, run_kind, semantic_epoch_id, outcome_summary_json)
                 VALUES (?1, ?2, 'surface', '{}', '{}', 'sha256:spec', ?3,
                         '2026-08-15T00:00:00.000Z', ?4, ?5, ?6)",
                params![
                    run_id,
                    project_id,
                    status,
                    run_kind,
                    epoch_id,
                    outcome.map(serde_json::Value::to_string),
                ],
            )?;
            Ok(())
        })
        .expect("seed a raw run");
    }

    fn seed_duplicate_edges(db: &Database) -> (String, String) {
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-1",
                r#"["v1@t"]"#,
                None,
                "2026-08-14T00:00:00.000Z",
            )
        })
        .expect("seed first edge");
        // `narrative_dependency_edges`'s own UNIQUE(project_id, consumer_kind,
        // consumer_key, source_object_identity) makes a genuine duplicate
        // structurally impossible through any writer -- including a raw
        // INSERT with the same key, which SQLite enforces regardless of
        // caller (exactly what `duplicate_edge_keys`'s doc comment
        // describes). To build the fixture this test needs, drop that one
        // constraint on this throwaway per-test database only, while
        // keeping PRIMARY KEY(id) intact -- `narrative_dependency_edge_states`
        // has a foreign key to `narrative_dependency_edges(id)`, and SQLite
        // requires the referenced column to still carry a unique index or
        // every later write through that FK fails closed with "foreign key
        // mismatch". The whole database is discarded when the test ends, so
        // there is no need to restore the dropped UNIQUE afterwards.
        db.with_conn(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = OFF;
                 CREATE TABLE narrative_dependency_edges_unconstrained (
                    id                          TEXT NOT NULL,
                    project_id                  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    consumer_kind               TEXT NOT NULL CHECK(length(consumer_kind) > 0),
                    consumer_key                TEXT NOT NULL CHECK(length(consumer_key) > 0),
                    source_object_identity      TEXT NOT NULL CHECK(length(source_object_identity) > 0),
                    read_set_json                TEXT NOT NULL DEFAULT '[]'
                        CHECK(json_valid(read_set_json) AND json_type(read_set_json) = 'array'),
                    generated_by_transaction_id TEXT,
                    created_at                  TEXT NOT NULL,
                    PRIMARY KEY(id)
                 );
                 INSERT INTO narrative_dependency_edges_unconstrained
                    SELECT * FROM narrative_dependency_edges;
                 DROP TABLE narrative_dependency_edges;
                 ALTER TABLE narrative_dependency_edges_unconstrained
                    RENAME TO narrative_dependency_edges;
                 PRAGMA foreign_keys = ON;",
            )?;
            Ok(())
        })
        .expect("drop the UNIQUE constraint on this throwaway test db");
        let new_id = db
            .with_conn(|conn| {
                let id = uuid::Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO narrative_dependency_edges
                        (id, project_id, consumer_kind, consumer_key, source_object_identity,
                         read_set_json, created_at)
                     VALUES (?1, 'project-1', ?2, 'run-1', 'project:scene:scene-1',
                             '[\"v2@t\"]', '2026-08-15T00:00:00.000Z')",
                    params![id, RUN_CONSUMER_KIND],
                )?;
                Ok(id)
            })
            .expect("directly insert a genuine duplicate row");
        let old_id = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT id FROM narrative_dependency_edges
                      WHERE project_id = 'project-1' AND source_object_identity = 'project:scene:scene-1'
                        AND id != ?1",
                    params![new_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(Into::into)
            })
            .expect("find the older duplicate");
        (old_id, new_id)
    }

    #[test]
    fn seal_repair_plan_proposes_deactivating_only_the_older_duplicate() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let (old_id, new_id) = seed_duplicate_edges(&db);

        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        assert_eq!(plan.edge_ids_to_deactivate, vec![old_id.clone()]);
        assert_eq!(plan.change_count(), 1);
        assert!(!plan.edge_ids_to_deactivate.contains(&new_id));
        assert!(!plan.digest.is_empty());
    }

    #[test]
    fn seal_repair_plan_is_empty_with_no_duplicates() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        db.with_conn(|conn| {
            record_dependency_edge_in_tx(
                conn,
                "project-1",
                RUN_CONSUMER_KIND,
                "run-1",
                "project:scene:scene-1",
                r#"["v1@t"]"#,
                None,
                "2026-08-14T00:00:00.000Z",
            )
        })
        .expect("seed a single healthy edge");

        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        assert!(plan.edge_ids_to_deactivate.is_empty());
        assert_eq!(plan.change_count(), 0);
    }

    // -- seal_repair_plan: the verify-first precondition ---------------------
    //
    // `verifyRunId` used to be a free string, so every one of these cases
    // sealed a plan happily. Each now has to fail closed with its own code.

    #[test]
    fn sealing_against_a_verify_run_that_does_not_exist_fails_closed() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);

        let error = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", "no-such-run", &epoch_id))
            .expect_err("a nonexistent Verify Run must not seal a plan");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_VERIFY_RUN_NOT_FOUND"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn sealing_against_a_failed_or_running_verify_run_fails_closed() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);

        for status in ["failed", "running", "pending", "cancelled"] {
            let run_id = format!("verify-{status}");
            seed_raw_run(
                &db,
                &run_id,
                "project-1",
                VERIFY_RUN_KIND,
                status,
                &epoch_id,
                None,
            );
            let error = db
                .with_conn(|conn| seal_repair_plan(conn, "project-1", &run_id, &epoch_id))
                .expect_err("a Verify Run that did not complete must not seal a plan");
            assert!(
                error
                    .to_string()
                    .contains("NEX_REPAIR_VERIFY_RUN_NOT_COMPLETED"),
                "unexpected error for status '{status}': {error}"
            );
        }
    }

    #[test]
    fn sealing_against_another_projects_verify_run_fails_closed() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-2', 'Other')",
                [],
            )?;
            Ok(())
        })
        .expect("seed the other project");
        let other_epoch_id = seed_epoch(&db, "project-2");
        let other_run_id = seed_verify_run(&db, "project-2");
        // The other project's Verify really did complete -- the only thing
        // wrong with it is whose graph it describes.
        assert_ne!(other_epoch_id, epoch_id);

        let error = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &other_run_id, &epoch_id))
            .expect_err("another project's Verify Run must not seal this project's plan");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_VERIFY_RUN_PROJECT_MISMATCH"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn sealing_against_a_prior_epochs_verify_run_fails_closed() {
        let (_workspace_path, db) = test_workspace("case");
        seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let stale_run_id = seed_verify_run(&db, "project-1");
        // Rotate the generation out from under the completed Verify.
        let current_epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "migration", None))
            .expect("rotate epoch");

        let error = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &stale_run_id, &current_epoch_id))
            .expect_err("a Verify from a prior Semantic Epoch must not seal a plan");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_VERIFY_RUN_EPOCH_MISMATCH"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn sealing_against_a_run_that_is_not_a_dependency_verify_fails_closed() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        // A completed Run under the right project and Epoch, carrying a
        // perfectly well-formed Verify result -- of the wrong Run Kind.
        // `semantic-index-rebuild` is what `dependency-rebuild-derived`
        // actually stores (the policy's `existingRunKindColumnValue`).
        let borrowed = db
            .with_conn(|conn| verify_narrative_dependency_graph_for_project(conn, "project-1"))
            .expect("produce a report to borrow");
        let report_value = serde_json::to_value(&borrowed).expect("serialize report");
        seed_raw_run(
            &db,
            "not-a-verify",
            "project-1",
            "semantic-index-rebuild",
            "completed",
            &epoch_id,
            Some(&json!({
                "verifyContractVersion": VERIFY_CONTRACT_VERSION,
                "semanticEpochId": epoch_id,
                "reportDigest": format!("sha256:{}", digest_plan(&report_value)),
                "report": report_value,
            })),
        );

        let error = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", "not-a-verify", &epoch_id))
            .expect_err("only a dependency-verify Run may seal a plan");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_VERIFY_RUN_KIND_MISMATCH"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn sealing_a_repair_target_the_verify_result_never_saw_fails_closed() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        // Verify observes a clean graph...
        let verify_run_id = seed_verify_run(&db, "project-1");
        // ...and only afterwards does the duplicate appear. The plan this
        // Verify can justify is empty; deactivating an Edge it never
        // examined would be a repair with no verify-first precondition.
        seed_duplicate_edges(&db);

        let error = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect_err("a target outside the Verify result must not be sealed into a plan");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_PLAN_NOT_DERIVED_FROM_VERIFY"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn sealing_against_a_tampered_verify_result_fails_closed() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let (old_id, _new_id) = seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        // Rewrite the stored report without touching its recorded digest:
        // the sealed plan must not be derivable from a result that no
        // longer matches the digest Verify signed it with.
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs
                    SET outcome_summary_json =
                          json_set(outcome_summary_json, '$.report.totalEdges', 999)
                  WHERE id = ?1",
                params![verify_run_id],
            )?;
            Ok(())
        })
        .expect("tamper with the stored report");

        let error = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect_err("a report that no longer matches its digest must not seal a plan");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_VERIFY_RESULT_DIGEST_MISMATCH"),
            "unexpected error: {error}"
        );
        // And the untampered path still works, so the assertion above is
        // about the tampering and not about the fixture.
        let fresh_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &fresh_run_id, &epoch_id))
            .expect("seal from an untampered Verify result");
        assert_eq!(plan.edge_ids_to_deactivate, vec![old_id]);
        assert!(plan.verify_report_digest.starts_with("sha256:"));
    }

    #[test]
    fn the_verify_report_digest_is_sealed_into_the_plan_digest() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let first_run_id = seed_verify_run(&db, "project-1");
        let second_run_id = seed_verify_run(&db, "project-1");
        assert_ne!(first_run_id, second_run_id);

        let first = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &first_run_id, &epoch_id))
            .expect("seal from the first Verify");
        let second = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &second_run_id, &epoch_id))
            .expect("seal from the second Verify");

        // Same graph, same candidates, same report digest -- but a plan is
        // bound to the Verify Run it was sealed from, so the digests differ.
        assert_eq!(first.edge_ids_to_deactivate, second.edge_ids_to_deactivate);
        assert_eq!(first.verify_report_digest, second.verify_report_digest);
        assert_ne!(first.digest, second.digest);
    }

    #[test]
    fn repair_requires_explicit_confirmation() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let (old_id, _new_id) = seed_duplicate_edges(&db);
        let plan = RepairPlan {
            verify_run_id: "verify-run-1".to_string(),
            semantic_epoch_id: epoch_id,
            verify_report_digest: "sha256:test-report".to_string(),
            edge_ids_to_deactivate: vec![old_id],
            digest: "sha256:test".to_string(),
        };

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            false,
            "req-test-1",
            "test-actor",
        )
        .expect_err("must fail without explicit confirmation");
        assert!(error
            .to_string()
            .starts_with("NEX_REPAIR_CONFIRMATION_REQUIRED"));
    }

    #[test]
    fn repair_records_a_run_carrying_its_request_and_actor_identity() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

        repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-audit-1",
            "operator-1",
        )
        .expect("execute repair");

        let (run_kind, status, request_id, domain, actor_id): (
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT run_kind, status, request_id, idempotency_domain, actor_id
                       FROM narrative_extraction_runs
                      WHERE project_id = 'project-1' AND run_kind = 'dependency-repair'",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .map_err(Into::into)
            })
            .expect("repair run exists");
        assert_eq!(run_kind, "dependency-repair");
        assert_eq!(status, "completed");
        assert_eq!(request_id.as_deref(), Some("req-audit-1"));
        assert_eq!(domain.as_deref(), Some(REPAIR_IDEMPOTENCY_DOMAIN));
        assert_eq!(actor_id.as_deref(), Some("operator-1"));
    }

    /// The hazard this whole status-aware replay path exists for: an
    /// attempt that never repaired anything must not come back as success
    /// just because the request id was seen before.
    #[test]
    fn replaying_a_request_whose_run_failed_does_not_report_success() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

        // Rotate the Epoch so the sealed plan is stale: the repair fails at
        // the epoch precondition, before anything is deactivated.
        db.with_conn(|conn| create_epoch_in_tx(conn, "project-1", "restore", None))
            .expect("rotate epoch");

        let first = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-failed-1",
            "operator-1",
        )
        .expect_err("stale epoch must fail");
        assert!(
            first.to_string().contains("NEX_REPAIR_EPOCH_MISMATCH"),
            "unexpected error: {first}"
        );

        // The Run must be terminal, not stuck `running`.
        let status: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM narrative_extraction_runs
                      WHERE project_id = 'project-1' AND run_kind = 'dependency-repair'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("repair run exists");
        assert_eq!(status, "failed");

        // Re-sending the same request must not be reported as a success.
        let replay = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-failed-1",
            "operator-1",
        )
        .expect_err("replaying a failed request must not succeed");
        assert!(
            replay.to_string().contains("NEX_REPAIR_REQUEST_FAILED"),
            "unexpected error: {replay}"
        );

        // And nothing was deactivated by either call.
        assert_eq!(edge_count(&db), 2);
    }

    #[test]
    fn a_different_actor_may_not_replay_another_actors_repair_request() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

        repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-actor-1",
            "operator-1",
        )
        .expect("first repair");

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-actor-1",
            "operator-2",
        )
        .expect_err("another actor must not replay this request");
        assert!(
            error.to_string().contains("NEX_RUN_REQUEST_CONFLICT"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn replaying_a_still_running_request_is_reported_as_in_progress() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

        repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-running-1",
            "operator-1",
        )
        .expect("first repair");

        // Simulate a process that died mid-repair: the Run never reached a
        // terminal state.
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs SET status = 'running'
                  WHERE project_id = 'project-1' AND run_kind = 'dependency-repair'",
                [],
            )?;
            Ok(())
        })
        .expect("force running");

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-running-1",
            "operator-1",
        )
        .expect_err("a running request must not replay as success");
        assert!(
            error.to_string().contains("NEX_REPAIR_REQUEST_IN_PROGRESS"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn replaying_a_completed_request_reproduces_the_original_outcome() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

        let first = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-outcome-1",
            "operator-1",
        )
        .expect("first repair");

        let replay = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-outcome-1",
            "operator-1",
        )
        .expect("replay must succeed");

        // A replay reproduces the original response, not a fresh empty one.
        assert_eq!(replay.edges_deactivated, first.edges_deactivated);
        assert_eq!(replay.backup_artifact_path, first.backup_artifact_path);
    }

    #[test]
    fn replaying_the_same_repair_request_does_not_repair_twice() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

        let first = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-replay-1",
            "operator-1",
        )
        .expect("first repair");
        assert_eq!(first.edges_deactivated, 1);

        let edges_after_first = edge_count(&db);

        // The same approved request arriving again -- a retry, not a second
        // decision. It must not deactivate anything further.
        let replay = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-replay-1",
            "operator-1",
        )
        .expect("replay must succeed");
        // A replay reproduces the original response rather than reporting a
        // second, empty repair -- but it must not touch any further edges.
        assert_eq!(replay.edges_deactivated, first.edges_deactivated);
        assert_eq!(edge_count(&db), edges_after_first);

        let run_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_extraction_runs
                      WHERE project_id = 'project-1' AND run_kind = 'dependency-repair'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count repair runs");
        assert_eq!(run_count, 1, "a replay must not create a second Run");
    }

    #[test]
    fn reusing_a_repair_request_id_for_a_different_plan_fails_closed() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

        repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-shared-1",
            "operator-1",
        )
        .expect("first repair");

        // Same requestId, different sealed plan: a caller reusing an id for
        // new work, which must never replay the earlier approval.
        let mut other_plan = plan.clone();
        other_plan.digest = "sha256:a-different-plan".to_string();
        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &other_plan,
            "test-owner",
            true,
            "req-shared-1",
            "operator-1",
        )
        .expect_err("a different plan under the same requestId must fail closed");
        assert!(
            error.to_string().contains("NEX_RUN_REQUEST_CONFLICT"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn repair_requires_a_request_id_and_an_actor() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

        for (request_id, actor_id) in [("", "operator-1"), ("  ", "operator-1"), ("req-1", "")] {
            let error = repair_narrative_dependency_declarations_for_project(
                &db,
                &workspace_path,
                "project-1",
                &plan,
                "test-owner",
                true,
                request_id,
                actor_id,
            )
            .expect_err("missing request identity must be rejected");
            let message = error.to_string();
            assert!(
                message.contains("NEX_REPAIR_REQUEST_ID_REQUIRED")
                    || message.contains("NEX_REPAIR_ACTOR_REQUIRED"),
                "unexpected error: {message}"
            );
        }
    }

    fn edge_count(db: &Database) -> i64 {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edges WHERE project_id = 'project-1'",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .expect("count edges")
    }

    #[test]
    fn repair_executes_the_sealed_plan_and_releases_the_lease() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let (old_id, new_id) = seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        assert_eq!(plan.edge_ids_to_deactivate, vec![old_id.clone()]);

        let outcome = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-test-2",
            "test-actor",
        )
        .expect("execute repair");
        assert_eq!(outcome.edges_deactivated, 1);
        assert!(!outcome.backup_artifact_path.is_empty());

        let remaining_ids: Vec<String> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT id FROM narrative_dependency_edges WHERE project_id = 'project-1'",
                )?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(Into::into)
            })
            .expect("list remaining edges");
        assert_eq!(remaining_ids, vec![new_id]);

        let lease_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_maintenance_repair_leases WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count leases");
        assert_eq!(
            lease_count, 0,
            "lease must be released after a successful repair"
        );
    }

    #[test]
    fn repair_fails_closed_on_a_stale_epoch() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let (old_id, _new_id) = seed_duplicate_edges(&db);
        let plan = RepairPlan {
            verify_run_id: "verify-run-1".to_string(),
            semantic_epoch_id: epoch_id,
            verify_report_digest: "sha256:test-report".to_string(),
            edge_ids_to_deactivate: vec![old_id],
            digest: "sha256:test".to_string(),
        };
        // Rotate to a new epoch after the plan was sealed.
        db.with_conn(|conn| create_epoch_in_tx(conn, "project-1", "migration", None))
            .expect("rotate epoch");

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-test-3",
            "test-actor",
        )
        .expect_err("a plan sealed against a stale epoch must be rejected");
        assert!(error.to_string().starts_with("NEX_REPAIR_EPOCH_MISMATCH"));

        let lease_count: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_maintenance_repair_leases WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count leases");
        assert_eq!(
            lease_count, 0,
            "an epoch-mismatch rejection must not leave a lease claimed"
        );
    }

    #[test]
    fn repair_lease_rejects_a_second_different_plan_while_active() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        // Deliberately far in the future (not "a few minutes from whenever
        // this test happens to run"): `julianday('now')` compares against
        // the real wall clock, so a near-term fixed timestamp risks
        // reading as already-expired on a machine/date this test wasn't
        // written on.
        let now = "2026-08-15T00:00:00.000Z";
        let expires_at = "2099-01-01T00:00:00.000Z";

        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &RepairLeaseClaim {
                        lease_owner: "owner-a".to_string(),
                        verify_run_id: "verify-run-1".to_string(),
                        repair_plan_digest: "sha256:plan-a".to_string(),
                    },
                    &epoch_id,
                    now,
                    expires_at,
                )
            })
        })
        .expect("first claim");

        let error = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    claim_repair_lease_in_tx(
                        conn,
                        "project-1",
                        &RepairLeaseClaim {
                            lease_owner: "owner-b".to_string(),
                            verify_run_id: "verify-run-2".to_string(),
                            repair_plan_digest: "sha256:plan-b".to_string(),
                        },
                        &epoch_id,
                        now,
                        expires_at,
                    )
                })
            })
            .expect_err("a second, different plan must not be claimable while the first is live");
        assert!(error.to_string().starts_with("NEX_REPAIR_LEASE_HELD"));

        // Re-claiming the SAME plan/owner is idempotent, not rejected.
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &RepairLeaseClaim {
                        lease_owner: "owner-a".to_string(),
                        verify_run_id: "verify-run-1".to_string(),
                        repair_plan_digest: "sha256:plan-a".to_string(),
                    },
                    &epoch_id,
                    now,
                    expires_at,
                )
            })
        })
        .expect("re-claiming the identical plan must succeed");
    }

    #[test]
    fn repair_lease_can_be_reclaimed_after_expiry() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");

        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &RepairLeaseClaim {
                        lease_owner: "owner-a".to_string(),
                        verify_run_id: "verify-run-1".to_string(),
                        repair_plan_digest: "sha256:plan-a".to_string(),
                    },
                    &epoch_id,
                    "2020-01-01T00:00:00.000Z",
                    "2020-01-01T00:15:00.000Z",
                )
            })
        })
        .expect("first claim, already expired");

        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &RepairLeaseClaim {
                        lease_owner: "owner-b".to_string(),
                        verify_run_id: "verify-run-2".to_string(),
                        repair_plan_digest: "sha256:plan-b".to_string(),
                    },
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                    "2026-08-15T00:15:00.000Z",
                )
            })
        })
        .expect("a new claim over an expired lease must succeed");

        let owner: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT lease_owner FROM narrative_maintenance_repair_leases WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read current lease owner");
        assert_eq!(owner, "owner-b");
    }
}
