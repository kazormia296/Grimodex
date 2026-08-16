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
//! itself -- callers inspect [`RepairPlan::edge_ids_to_deactivate`] before
//! ever calling [`repair_narrative_dependency_declarations_for_project`]).
//!
//! # Why the preconditions are re-checked at the point of mutation
//!
//! Every precondition above is checked when the plan is sealed, and then
//! *again* inside the transaction that deletes the rows. That is not
//! belt-and-braces: sealing happens before a human confirms, and the Repair
//! lease excludes other Repairs, not ordinary Producer writes. Between
//! preview and confirmation the Durable Graph can move. So [`RepairPlan`]
//! carries no authority of its own -- it is opaque outside this module,
//! constructible only by [`seal_repair_plan`], and
//! [`revalidate_plan_in_tx`] re-derives it from the database and refuses to
//! proceed unless it still digests identically.
//!
//! The mutation, the lease release, the Run outcome and the Run's
//! terminalization all commit in that same transaction. Splitting them
//! would allow a crash to leave Edges deleted with the Run still `running`
//! and no outcome recorded -- a state from which a retry cannot tell
//! "already applied" from "never started". Keeping them together means
//! `running` always implies "not applied", which is what makes
//! `manualRetry: crash-recovery-of-an-already-approved-sealed-plan-only`
//! implementable at all (see [`resume_or_report_in_progress`]).
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
    create_system_run_in_tx, find_run_by_request_identity, record_run_outcome_in_tx,
    RunRequestIdentity, SystemRunWorkKeyReuse,
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

/// Identity a Repair lease claim is made under: who, for which Verify
/// result, applying which sealed plan, under which Run.
///
/// All four together are the lease's identity, and all four are
/// compare-and-swapped before the graph is touched -- see
/// [`assert_repair_lease_still_held_in_tx`].
pub(crate) struct RepairLeaseClaim {
    pub lease_owner: String,
    pub verify_run_id: String,
    pub repair_plan_digest: String,
    /// The Run entitled to apply this plan. `lease_owner` says which
    /// process; this says which execution, so a second attempt by the same
    /// owner cannot inherit the first one's entitlement.
    pub active_run_id: String,
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
        !claim.active_run_id.trim().is_empty(),
        "activeRunId is required"
    );
    anyhow::ensure!(
        !semantic_epoch_id.trim().is_empty(),
        "semanticEpochId is required"
    );

    /// The identity columns of an existing lease, plus whether it is live.
    struct ExistingLease {
        lease_owner: String,
        verify_run_id: String,
        repair_plan_digest: String,
        semantic_epoch_id: String,
        active_run_id: Option<String>,
        expired: bool,
    }

    let existing = conn
        .query_row(
            "SELECT lease_owner, verify_run_id, repair_plan_digest, semantic_epoch_id,
                    active_run_id, julianday(expires_at) < julianday('now')
               FROM narrative_maintenance_repair_leases WHERE project_id = ?1",
            params![project_id],
            |row| {
                Ok(ExistingLease {
                    lease_owner: row.get(0)?,
                    verify_run_id: row.get(1)?,
                    repair_plan_digest: row.get(2)?,
                    semantic_epoch_id: row.get(3)?,
                    active_run_id: row.get(4)?,
                    expired: row.get(5)?,
                })
            },
        )
        .optional()?;

    if let Some(existing) = &existing {
        // "Same claim" means *every* identity column matches, `active_run_id`
        // included. Two Runs can legitimately share an owner, a Verify Run
        // and a plan digest -- this Run Kind declares
        // `no-automatic-reuse-decision`, so a second approval of the same
        // plan under a new requestId really does create a second Run. If
        // `active_run_id` were left out of this comparison, that second Run
        // would be treated as a re-entrant claim, overwrite the first Run's
        // entitlement, and make the first Run lose its own lease at the
        // post-backup CAS. `semantic_epoch_id` is compared for the same
        // reason: a lease from a prior generation is not this one.
        let is_same_claim = existing.lease_owner == claim.lease_owner
            && existing.verify_run_id == claim.verify_run_id
            && existing.repair_plan_digest == claim.repair_plan_digest
            && existing.semantic_epoch_id == semantic_epoch_id
            && existing.active_run_id.as_deref() == Some(claim.active_run_id.as_str());
        anyhow::ensure!(
            existing.expired || is_same_claim,
            "NEX_REPAIR_LEASE_HELD: project '{project_id}' already has an active Repair lease \
             held by '{}' (Run '{}') -- this claim is Run '{}', which is a different execution",
            existing.lease_owner,
            existing.active_run_id.as_deref().unwrap_or("<none>"),
            claim.active_run_id
        );
    }

    // Defence in depth: the same rule again inside the write, so the read
    // above cannot be raced. A live lease is only overwritten when every
    // identity column matches; otherwise the UPSERT matches nothing.
    let claimed = conn.execute(
        "INSERT INTO narrative_maintenance_repair_leases
            (project_id, lease_owner, verify_run_id, repair_plan_digest, semantic_epoch_id,
             claimed_at, expires_at, active_run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(project_id) DO UPDATE SET
             lease_owner = excluded.lease_owner,
             verify_run_id = excluded.verify_run_id,
             repair_plan_digest = excluded.repair_plan_digest,
             semantic_epoch_id = excluded.semantic_epoch_id,
             claimed_at = excluded.claimed_at,
             expires_at = excluded.expires_at,
             active_run_id = excluded.active_run_id
          WHERE julianday(narrative_maintenance_repair_leases.expires_at)
                    < julianday('now')
             OR (narrative_maintenance_repair_leases.lease_owner = excluded.lease_owner
                 AND narrative_maintenance_repair_leases.verify_run_id = excluded.verify_run_id
                 AND narrative_maintenance_repair_leases.repair_plan_digest
                         = excluded.repair_plan_digest
                 AND narrative_maintenance_repair_leases.semantic_epoch_id
                         = excluded.semantic_epoch_id
                 AND narrative_maintenance_repair_leases.active_run_id
                         = excluded.active_run_id)",
        params![
            project_id,
            claim.lease_owner,
            claim.verify_run_id,
            claim.repair_plan_digest,
            semantic_epoch_id,
            now,
            expires_at,
            claim.active_run_id,
        ],
    )?;
    anyhow::ensure!(
        claimed == 1,
        "NEX_REPAIR_LEASE_HELD: project '{project_id}' already has an active Repair lease held \
         by another execution; Run '{}' did not acquire it",
        claim.active_run_id
    );
    Ok(())
}

/// Proves, inside the mutation transaction, that this worker *still* holds
/// the exclusive right it claimed -- and does not merely hold a plan that
/// is still semantically valid.
///
/// These are different authorities. `revalidate_plan_in_tx` asks "does this
/// plan still describe the graph?"; this asks "am I still the one allowed
/// to apply it?". A lease has a TTL, and step 2 of the execution is a
/// backup that can take minutes on a large workspace:
///
/// ```text
/// A claims the lease  ->  A's backup runs long  ->  A's lease expires
///                     ->  B claims the lease for its own plan
///                     ->  A enters its mutation transaction
/// ```
///
/// Without this check A would delete Edges while B holds the lease, and
/// then delete *B's* lease row on the way out. The CAS covers every column
/// that makes the lease this one, plus liveness, so an expired or
/// re-claimed lease aborts the transaction before a single Edge is
/// removed.
pub(crate) fn assert_repair_lease_still_held_in_tx(
    conn: &Connection,
    project_id: &str,
    claim: &RepairLeaseClaim,
    semantic_epoch_id: &str,
) -> anyhow::Result<()> {
    let held: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_maintenance_repair_leases
          WHERE project_id = ?1
            AND lease_owner = ?2
            AND verify_run_id = ?3
            AND repair_plan_digest = ?4
            AND semantic_epoch_id = ?5
            AND active_run_id = ?6
            AND julianday(expires_at) > julianday('now')",
        params![
            project_id,
            claim.lease_owner,
            claim.verify_run_id,
            claim.repair_plan_digest,
            semantic_epoch_id,
            claim.active_run_id,
        ],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        held == 1,
        "NEX_REPAIR_LEASE_LOST: Run '{}' no longer holds a live Repair lease on project          '{project_id}' for this plan -- it expired or was re-claimed while this attempt was          preparing. Nothing was changed; re-seal and retry",
        claim.active_run_id
    );
    Ok(())
}

/// Releases the lease under the same identity that claimed it, and reports
/// whether a row was actually removed.
///
/// The unconditional `DELETE ... WHERE project_id = ?` this replaces would
/// happily delete a lease that had since been re-claimed by someone else.
pub(crate) fn release_held_repair_lease_in_tx(
    conn: &Connection,
    project_id: &str,
    claim: &RepairLeaseClaim,
    semantic_epoch_id: &str,
) -> anyhow::Result<usize> {
    let released = conn.execute(
        "DELETE FROM narrative_maintenance_repair_leases
          WHERE project_id = ?1
            AND lease_owner = ?2
            AND verify_run_id = ?3
            AND repair_plan_digest = ?4
            AND semantic_epoch_id = ?5
            AND active_run_id = ?6",
        params![
            project_id,
            claim.lease_owner,
            claim.verify_run_id,
            claim.repair_plan_digest,
            semantic_epoch_id,
            claim.active_run_id,
        ],
    )?;
    Ok(released)
}

/// A sealed `dependency-repair` plan: the exact, deterministic set of
/// changes a Repair execution will make, plus the digest that binds a
/// lease claim and an execution call to this exact plan.
///
/// **Fields are private and there is no public constructor.** The only way
/// to obtain a `RepairPlan` from outside this module is [`seal_repair_plan`],
/// which derives every field from a completed Verify Run. That is the
/// difference between "the caller is expected to have verified first" and
/// "a plan that was not verified first cannot be expressed" -- and this
/// type authorises deleting Durable Graph rows, so it has to be the
/// second. A hand-built
/// `RepairPlan { verify_run_id: "arbitrary", digest: "arbitrary", .. }`
/// does not compile outside this module, and
/// [`revalidate_plan_in_tx`] rejects one built inside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairPlan {
    verify_run_id: String,
    semantic_epoch_id: String,
    /// Digest of the exact Verify report this plan was derived from,
    /// sealed into [`RepairPlan::digest`]. Two plans naming the same Edge
    /// ids but derived from different Verify results are different plans.
    verify_report_digest: String,
    edge_ids_to_deactivate: Vec<String>,
    digest: String,
}

impl RepairPlan {
    /// The change-count preview the policy's `change-count-preview`
    /// precondition requires a human see before confirming.
    pub fn change_count(&self) -> usize {
        self.edge_ids_to_deactivate.len()
    }

    /// Whether this plan proposes nothing. A valid, non-error outcome:
    /// the Verify coverage found nothing it can repair.
    pub fn is_empty(&self) -> bool {
        self.edge_ids_to_deactivate.is_empty()
    }

    /// The digest a caller echoes back to prove it is confirming the plan
    /// it was shown, not a plan the graph has since moved out from under.
    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn verify_run_id(&self) -> &str {
        &self.verify_run_id
    }

    pub fn semantic_epoch_id(&self) -> &str {
        &self.semantic_epoch_id
    }

    pub fn verify_report_digest(&self) -> &str {
        &self.verify_report_digest
    }

    pub fn edge_ids_to_deactivate(&self) -> &[String] {
        &self.edge_ids_to_deactivate
    }
}

/// The one definition of a Repair plan's digest, so sealing and
/// re-validating cannot drift into computing it two different ways.
fn repair_plan_digest(
    verify_run_id: &str,
    verify_report_digest: &str,
    semantic_epoch_id: &str,
    edge_ids_to_deactivate: &[String],
) -> String {
    let sealed = json!({
        "planKind": "dependency-repair-v2",
        "verifyRunId": verify_run_id,
        "verifyReportDigest": verify_report_digest,
        "semanticEpochId": semantic_epoch_id,
        "edgeIdsToDeactivate": edge_ids_to_deactivate,
    });
    format!("sha256:{}", digest_plan(&sealed))
}

/// Re-derives the plan from the database and rejects `plan` unless it is
/// byte-for-byte the plan that derivation produces *right now*.
///
/// Called inside the same transaction that deletes the Edges, which is the
/// point: sealing happens before the human confirms, and between those two
/// moments an ordinary Producer write can add or remove a duplicate. The
/// Repair lease excludes other Repairs, not the rest of the system, so
/// "sealed a while ago" is not "still true". Re-sealing here and comparing
/// digests closes that window and, in one comparison, re-checks everything
/// [`seal_repair_plan`] checks: the Verify Run's existence, project,
/// kind, status and Epoch, its stored report and digest, and the live
/// repair target set.
fn revalidate_plan_in_tx(
    conn: &Connection,
    project_id: &str,
    plan: &RepairPlan,
) -> anyhow::Result<()> {
    let current_epoch_id = get_current_epoch(conn, project_id)?
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_REPAIR_NO_EPOCH: project '{project_id}' has no Semantic Epoch")
        })?
        .id;
    anyhow::ensure!(
        current_epoch_id == plan.semantic_epoch_id,
        "NEX_REPAIR_EPOCH_MISMATCH: sealed plan's Semantic Epoch ('{}') is no longer the \
         project's current one ('{current_epoch_id}') -- re-seal the plan",
        plan.semantic_epoch_id
    );

    let resealed = seal_repair_plan(conn, project_id, &plan.verify_run_id, &current_epoch_id)?;
    anyhow::ensure!(
        resealed.digest == plan.digest,
        "NEX_REPAIR_PLAN_STALE: this plan digests to '{}' but re-sealing the same Verify Run \
         against the Durable Graph as it stands now yields '{}' -- the graph changed since the \
         plan was sealed; request a fresh preview",
        plan.digest,
        resealed.digest
    );
    Ok(())
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

    let digest = repair_plan_digest(
        verify_run_id,
        &verify.report_digest,
        semantic_epoch_id,
        &edge_ids_to_deactivate,
    );

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

/// **The entry point every transport should call.** Resolves the request
/// *before* touching the Verify Run or the graph, then seals and executes
/// only if this request has not been seen.
///
/// Sealing first is the mistake this exists to prevent. A caller whose
/// repair succeeded but whose response was lost retries with the same
/// `requestId` and `planDigest`; if the entry point re-seals before looking
/// the request up, the duplicate Edges are already gone, the freshly sealed
/// plan no longer matches the Verify report, and the retry fails with
/// `NEX_REPAIR_PLAN_NOT_DERIVED_FROM_VERIFY` -- never reaching the stored
/// `completed` outcome sitting a few rows away. Request replay and work
/// equivalence are separate contracts, and replay has to win.
///
/// A replay reproduces what the original request returned. It deliberately
/// does *not* ask whether the same repair would still be possible against
/// the graph as it stands now: that is a different question, and answering
/// it is how a successful operation turns into a spurious failure.
///
/// `expected_plan_digest` is the digest the caller was shown at preview
/// time. For a new request it is checked against a freshly sealed plan; for
/// a known one it is checked against the digest that request was recorded
/// under, so a caller cannot replay someone else's approval by guessing a
/// `requestId`.
#[allow(clippy::too_many_arguments)]
pub fn repair_narrative_dependency_declarations_for_request(
    db: &Database,
    workspace_path: &Path,
    project_id: &str,
    verify_run_id: &str,
    expected_plan_digest: &str,
    lease_owner: &str,
    explicit_confirmation: bool,
    request_id: &str,
    actor_id: &str,
) -> anyhow::Result<RepairOutcome> {
    anyhow::ensure!(
        explicit_confirmation,
        "NEX_REPAIR_CONFIRMATION_REQUIRED: dependency-repair requires explicit confirmation"
    );
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!lease_owner.trim().is_empty(), "leaseOwner is required");
    anyhow::ensure!(
        !expected_plan_digest.trim().is_empty(),
        "NEX_REPAIR_PLAN_DIGEST_REQUIRED: planDigest is required"
    );
    anyhow::ensure!(
        !request_id.trim().is_empty(),
        "NEX_REPAIR_REQUEST_ID_REQUIRED: dependency-repair requires a stable requestId"
    );
    anyhow::ensure!(
        !actor_id.trim().is_empty(),
        "NEX_REPAIR_ACTOR_REQUIRED: dependency-repair requires an actorId"
    );

    // 1. Request first. `find_run_by_request_identity` fails closed on a
    //    payload-digest or actor mismatch, so a `requestId` presented with
    //    a different plan or by a different person is a conflict here
    //    rather than a replay.
    let prior = db.with_conn(|conn| {
        find_run_by_request_identity(
            conn,
            project_id,
            &RunRequestIdentity {
                request_id,
                idempotency_domain: REPAIR_IDEMPOTENCY_DOMAIN,
                payload_digest: expected_plan_digest,
                actor_id,
            },
        )
    })?;

    if let Some(prior) = prior {
        let run_id = prior["runId"].as_str().unwrap_or_default().to_string();
        let status = prior["status"].as_str().unwrap_or("");
        if !matches!(status, "pending" | "running") {
            // Terminal: reproduce the recorded answer without consulting
            // the graph at all.
            return replay_repair_outcome(&run_id, status, &prior["outcome"]);
        }

        // Still `running`: either genuinely in flight, or a crashed attempt
        // to resume. Resuming needs the approved plan, and the only
        // trustworthy way to get one is to re-derive it and require that it
        // digests to what this request was approved for.
        //
        // If that re-derivation fails, the Run cannot be resumed *ever* --
        // the Epoch rotated, or the graph moved past the approved plan. It
        // must not be left `running`, or every future retry returns the
        // same pre-resume error and the Run stays forever in flight,
        // blocking the C2-Z `no-active-backfill-or-repair-run` check.
        let plan =
            match seal_plan_matching_digest(db, project_id, verify_run_id, expected_plan_digest) {
                Ok(plan) => plan,
                Err(seal_error) => {
                    return terminalize_unresumable_run(
                        db,
                        project_id,
                        &run_id,
                        request_id,
                        expected_plan_digest,
                        actor_id,
                        seal_error,
                    );
                }
            };
        if plan.is_empty() {
            return Ok(RepairOutcome {
                edges_deactivated: 0,
                backup_artifact_path: String::new(),
            });
        }
        let (now_text, expires_at) = repair_lease_window();
        return resume_or_report_in_progress(
            db,
            workspace_path,
            project_id,
            &plan,
            lease_owner,
            &now_text,
            &expires_at,
            &run_id,
        );
    }

    // 2. Unseen request: seal now, and only accept the plan the caller was
    //    actually shown.
    let plan = seal_plan_matching_digest(db, project_id, verify_run_id, expected_plan_digest)?;
    repair_narrative_dependency_declarations_for_project(
        db,
        workspace_path,
        project_id,
        &plan,
        lease_owner,
        explicit_confirmation,
        request_id,
        actor_id,
    )
}

/// Lands a Run that can never be resumed, without ever reporting work it
/// did not do.
///
/// Reached when a `running` Run's approved plan cannot be re-derived. Two
/// things have to happen in order:
///
/// 1. Re-read the request. Sealing is not instantaneous, and a concurrent
///    attempt on the same Run may have completed while it ran -- in which
///    case the honest answer is that Run's recorded outcome, not a failure.
/// 2. Otherwise terminalize. `superseded` when the project's Semantic Epoch
///    has moved past the Run's (a new generation replaced the work rather
///    than the work going wrong); `failed` when the Epoch still matches and
///    it is the graph or the Verify result that drifted.
///
/// The original sealing error is what the caller sees either way: it is the
/// reason the resume was refused.
#[allow(clippy::too_many_arguments)]
fn terminalize_unresumable_run(
    db: &Database,
    project_id: &str,
    run_id: &str,
    request_id: &str,
    expected_plan_digest: &str,
    actor_id: &str,
    seal_error: anyhow::Error,
) -> anyhow::Result<RepairOutcome> {
    let current = db.with_conn(|conn| {
        find_run_by_request_identity(
            conn,
            project_id,
            &RunRequestIdentity {
                request_id,
                idempotency_domain: REPAIR_IDEMPOTENCY_DOMAIN,
                payload_digest: expected_plan_digest,
                actor_id,
            },
        )
    })?;
    if let Some(current) = &current {
        let status = current["status"].as_str().unwrap_or("");
        if !matches!(status, "pending" | "running") {
            return replay_repair_outcome(run_id, status, &current["outcome"]);
        }
    }

    let epoch_moved = db.with_conn(|conn| {
        let run_epoch: Option<String> = conn
            .query_row(
                "SELECT semantic_epoch_id FROM narrative_extraction_runs WHERE id = ?1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let current_epoch = get_current_epoch(conn, project_id)?.map(|epoch| epoch.id);
        Ok(run_epoch != current_epoch)
    })?;
    let status = if epoch_moved {
        NarrativeRunStatus::Superseded
    } else {
        NarrativeRunStatus::Failed
    };

    Err(terminalize_repair_run(db, run_id, status, seal_error))
}

/// Seals a plan from `verify_run_id` and refuses to return it unless it is
/// the plan the caller was shown.
fn seal_plan_matching_digest(
    db: &Database,
    project_id: &str,
    verify_run_id: &str,
    expected_plan_digest: &str,
) -> anyhow::Result<RepairPlan> {
    let current_epoch_id = db
        .with_conn(|conn| get_current_epoch(conn, project_id))?
        .map(|epoch| epoch.id)
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_REPAIR_NO_EPOCH: project '{project_id}' has no Semantic Epoch")
        })?;
    let plan =
        db.with_conn(|conn| seal_repair_plan(conn, project_id, verify_run_id, &current_epoch_id))?;
    anyhow::ensure!(
        plan.digest() == expected_plan_digest,
        "NEX_REPAIR_PLAN_DIGEST_MISMATCH: the supplied planDigest does not match the \
         freshly-sealed plan -- the Durable Graph may have changed since the preview; request a \
         fresh preview before retrying"
    );
    Ok(plan)
}

fn repair_lease_window() -> (String, String) {
    let now = chrono::Utc::now();
    (
        now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        (now + chrono::Duration::seconds(REPAIR_LEASE_TTL_SECONDS))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
    )
}

/// Executes one `dependency-repair` Run against an already-sealed plan.
///
/// Prefer [`repair_narrative_dependency_declarations_for_request`]: this
/// takes a plan the caller sealed, so it can only resolve a replay *after*
/// that sealing has already happened -- which is exactly the ordering that
/// makes a lost response unreplayable. This remains public for callers that
/// already hold a sealed plan and manage that ordering themselves.
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
///   3. One transaction that re-proves the lease is still held, re-derives
///      and re-checks the plan, deletes the Edges, releases the lease,
///      records the outcome, and completes the Run.
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
        // A terminal Run replays its own recorded answer; a Run still
        // `running` is either genuinely in flight or the wreckage of a
        // crashed attempt, and only `resume_or_report_in_progress` can
        // tell those apart.
        let status = run["status"].as_str().unwrap_or("");
        if matches!(status, "pending" | "running") {
            return resume_or_report_in_progress(
                db,
                workspace_path,
                project_id,
                plan,
                lease_owner,
                &now_text,
                &expires_at,
                &run_id,
            );
        }
        return replay_repair_outcome(&run_id, status, &run["outcome"]);
    }

    execute_repair_under_run(
        db,
        workspace_path,
        project_id,
        plan,
        lease_owner,
        &now_text,
        &expires_at,
        &run_id,
    )
}

/// Decide what a retry of a request whose Run is still `running` means.
///
/// The policy's `manualRetry` for this Run Kind is
/// `crash-recovery-of-an-already-approved-sealed-plan-only`, so this is
/// that recovery -- not a second repair. Two outcomes:
///
/// 1. A *live* Repair lease means an attempt may still be running in
///    another process. There is no way to prove otherwise, so this fails
///    closed as `NEX_REPAIR_REQUEST_IN_PROGRESS` and waits for the lease to
///    lapse.
/// 2. Otherwise the previous worker is gone. Resume: run the same
///    already-approved sealed plan under the *existing* Run, so recovery
///    never mints a duplicate.
///
/// Deliberately absent: any attempt to infer, from the plan's Edges being
/// gone, that *this* Run deleted them. Absence is not attribution -- a
/// different request, a restore, or another graph repair could have removed
/// the same rows, and crediting this Run with work it never did would write
/// a fabricated success into the audit record. Because the mutation and the
/// Run's completion now commit together, a `running` Run whose plan was
/// applied is not a state this writer can produce, so nothing is lost by
/// refusing to guess. The resume path re-validates the plan inside the
/// mutation transaction; if the graph has moved on -- including because
/// someone else already repaired it -- that fails closed and this Run is
/// recorded as failed, which is the truth.
#[allow(clippy::too_many_arguments)]
fn resume_or_report_in_progress(
    db: &Database,
    workspace_path: &Path,
    project_id: &str,
    plan: &RepairPlan,
    lease_owner: &str,
    now_text: &str,
    expires_at: &str,
    run_id: &str,
) -> anyhow::Result<RepairOutcome> {
    if let Some(owner) = db.with_conn(|conn| live_repair_lease_owner(conn, project_id))? {
        anyhow::bail!(
            "NEX_REPAIR_REQUEST_IN_PROGRESS: Run '{run_id}' is still running and '{owner}' holds \
             a live Repair lease on project '{project_id}'; wait for it to finish or lapse \
             rather than starting a second repair"
        );
    }

    execute_repair_under_run(
        db,
        workspace_path,
        project_id,
        plan,
        lease_owner,
        now_text,
        expires_at,
        run_id,
    )
}

/// The owner of this project's Repair lease, if one exists and has not
/// expired. `None` means no live lease -- either none was ever claimed, or
/// the process that held it is gone and its TTL has lapsed.
fn live_repair_lease_owner(conn: &Connection, project_id: &str) -> anyhow::Result<Option<String>> {
    let row: Option<(String, bool)> = conn
        .query_row(
            "SELECT lease_owner, julianday(expires_at) < julianday('now')
               FROM narrative_maintenance_repair_leases WHERE project_id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.and_then(|(owner, expired)| if expired { None } else { Some(owner) }))
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
        "completed" => {
            // Defaulting a missing field to 0/"" here would report "this
            // repair deactivated nothing" for a Run that may well have
            // deactivated something -- inventing a successful answer out of
            // a record that does not contain one. A completed Run whose
            // outcome cannot be read is a bookkeeping failure to surface,
            // not a result to synthesize.
            let edges_deactivated = outcome
                .get("edgesDeactivated")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_REPAIR_OUTCOME_MALFORMED: Run '{run_id}' is 'completed' but its \
                         recorded outcome has no readable edgesDeactivated; refusing to report \
                         a synthesized result"
                    )
                })?;
            let backup_artifact_path = outcome
                .get("backupArtifactPath")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_REPAIR_OUTCOME_MALFORMED: Run '{run_id}' is 'completed' but its \
                         recorded outcome has no readable backupArtifactPath"
                    )
                })?;
            Ok(RepairOutcome {
                edges_deactivated: edges_deactivated as usize,
                backup_artifact_path: backup_artifact_path.to_string(),
            })
        }
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
/// will reproduce, in its own transaction.
///
/// Errors propagate. A caller must never report success before the Run
/// outcome is durable: a Run stuck `running` is precisely what makes a
/// later retry unable to tell "already applied" from "never started", and
/// swallowing the failure that caused it would hide the one fact needed to
/// recover. The success path does not use this at all -- there, the
/// outcome commits in the same transaction as the repair (see
/// [`execute_repair_under_run`]); this is for terminalizing a Run whose
/// mutation did *not* happen, and for recovering one that did.
fn finalize_repair_run(
    db: &Database,
    run_id: &str,
    status: NarrativeRunStatus,
    outcome: Option<&serde_json::Value>,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            if let Some(outcome) = outcome {
                record_run_outcome_in_tx(conn, run_id, outcome)?;
            }
            transition_run_status_in_tx(conn, run_id, status)
        })
    })
}

/// Terminalize a Run after a precondition or execution error, and report
/// whichever failure the caller most needs to see.
///
/// The original error wins: it is the reason the repair did not happen. A
/// finalization failure on top of it is appended rather than dropped,
/// because a Run left `running` changes what a later retry is allowed to
/// assume.
fn terminalize_repair_run(
    db: &Database,
    run_id: &str,
    status: NarrativeRunStatus,
    error: anyhow::Error,
) -> anyhow::Error {
    let recorded = json!({ "failure": error.to_string() });
    match finalize_repair_run(db, run_id, status, Some(&recorded)) {
        Ok(()) => error,
        Err(finalize_error) => error.context(format!(
            "NEX_REPAIR_RUN_NOT_TERMINALIZED: Run '{run_id}' could not be marked '{}' \
             ({finalize_error}); it will stay 'running' until recovered",
            status.as_str()
        )),
    }
}

/// Errors that mean "another execution holds the lease", as opposed to
/// "this attempt is wrong".
fn is_lease_contention(error: &anyhow::Error) -> bool {
    let text = error.to_string();
    text.contains("NEX_REPAIR_LEASE_HELD") || text.contains("NEX_REPAIR_LEASE_LOST")
}

/// Whether the project's live Repair lease is held *for this Run*.
///
/// This is what separates "someone else's repair is in the way, so this Run
/// cannot proceed" from "another attempt is executing this very Run right
/// now". Only the first is this Run's failure.
///
/// Two attempts can share one Run without either being a crash recovery: a
/// caller that sends the same `requestId` twice concurrently has one call
/// create the Run and the other replay into it, and whichever reaches the
/// lease second loses the race. Keying the distinction on the lease's
/// `active_run_id` rather than on which call created the Run covers that
/// case as well as the crash-resume one.
fn lease_is_held_for_run(db: &Database, project_id: &str, run_id: &str) -> bool {
    db.with_conn(|conn| {
        let held: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_maintenance_repair_leases
              WHERE project_id = ?1
                AND active_run_id = ?2
                AND julianday(expires_at) > julianday('now')",
            params![project_id, run_id],
            |row| row.get(0),
        )?;
        Ok(held == 1)
    })
    .unwrap_or(false)
}

/// Runs one already-approved sealed plan under an existing Run and lands
/// that Run in a terminal state, whatever happens.
///
/// The order is fixed, and step 3 is deliberately one transaction:
///
///   1. Epoch match + lease claim, in one transaction -- a plan sealed
///      against a since-rotated Epoch is stale and must be re-sealed, not
///      blindly applied.
///   2. Automatic backup, outside any DB transaction (filesystem I/O
///      against the live file, not a SQL write). A backup failure releases
///      the lease and fails closed (`NEX_REPAIR_BACKUP_FAILED`) rather
///      than proceeding without one.
///   3. **One** `BEGIN IMMEDIATE` that re-validates the plan against the
///      graph as it stands, deletes the Edges, releases the lease, records
///      the outcome, and moves the Run to `completed`.
///
/// Step 3 being atomic is the whole point. Split across two transactions,
/// a crash in between leaves Edges deleted, the lease released, and the
/// Run still `running` with no outcome -- a state from which no retry can
/// tell whether the repair happened. Committing the mutation and its own
/// record together makes that state unreachable, so `running` after a
/// crash always means "not applied" and recovery has an unambiguous
/// answer.
#[allow(clippy::too_many_arguments)]
fn execute_repair_under_run(
    db: &Database,
    workspace_path: &Path,
    project_id: &str,
    plan: &RepairPlan,
    lease_owner: &str,
    now_text: &str,
    expires_at: &str,
    run_id: &str,
) -> anyhow::Result<RepairOutcome> {
    match execute_repair_steps(
        db,
        workspace_path,
        project_id,
        plan,
        lease_owner,
        now_text,
        expires_at,
        run_id,
    ) {
        Ok(outcome) => Ok(outcome),
        Err(error)
            if is_lease_contention(&error) && lease_is_held_for_run(db, project_id, run_id) =>
        {
            // Two attempts on this same Run raced and the other one won, so
            // it is repairing under this Run right now. Failing the Run here
            // would terminalize one that is about to succeed. Report it as
            // in flight and leave it alone.
            Err(error.context(format!(
                "NEX_REPAIR_REQUEST_IN_PROGRESS: Run '{run_id}' is already being executed by \
                 another attempt that holds the Repair lease; wait for it rather than starting \
                 a third"
            )))
        }
        Err(error) => {
            // The mutation did not commit, so the lease this attempt may
            // have claimed is the only thing left to undo. Release it
            // before failing, or a failed attempt locks the project out of
            // a corrected retry until TTL expiry -- but release *only*
            // this attempt's own lease. If it already expired and someone
            // else re-claimed it, the predicate matches nothing and their
            // lease is left alone.
            let claim = RepairLeaseClaim {
                lease_owner: lease_owner.to_string(),
                verify_run_id: plan.verify_run_id.clone(),
                repair_plan_digest: plan.digest.clone(),
                active_run_id: run_id.to_string(),
            };
            let _ = db.with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    release_held_repair_lease_in_tx(
                        conn,
                        project_id,
                        &claim,
                        &plan.semantic_epoch_id,
                    )
                })
            });
            Err(terminalize_repair_run(
                db,
                run_id,
                NarrativeRunStatus::Failed,
                error,
            ))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn execute_repair_steps(
    db: &Database,
    workspace_path: &Path,
    project_id: &str,
    plan: &RepairPlan,
    lease_owner: &str,
    now_text: &str,
    expires_at: &str,
    run_id: &str,
) -> anyhow::Result<RepairOutcome> {
    let claim = RepairLeaseClaim {
        lease_owner: lease_owner.to_string(),
        verify_run_id: plan.verify_run_id.clone(),
        repair_plan_digest: plan.digest.clone(),
        active_run_id: run_id.to_string(),
    };

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
                &claim,
                &current_epoch_id,
                now_text,
                expires_at,
            )
        })
    })?;

    // 2. Automatic backup. Slow on a large workspace -- slow enough that
    //    the lease claimed above can expire and be re-claimed by someone
    //    else before step 3 starts, which is why step 3 re-proves it.
    let db_path = workspace_path.join("grimodex.db");
    let backup_artifact = create_persistent_live_safety_artifact(workspace_path, &db_path)
        .map_err(|error| anyhow::anyhow!("NEX_REPAIR_BACKUP_FAILED: {error}"))?;
    let backup_artifact_path = safety_artifact_path_string(&backup_artifact);

    // 3. Re-prove authority, re-validate, repair, release, record,
    //    terminalize -- atomically.
    let edges_deactivated = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            assert_repair_lease_still_held_in_tx(
                conn,
                project_id,
                &claim,
                &plan.semantic_epoch_id,
            )?;
            revalidate_plan_in_tx(conn, project_id, plan)?;
            let deleted = rebuild_repair_dependency_edges_in_tx(
                conn,
                project_id,
                plan.edge_ids_to_deactivate(),
            )?;
            let released =
                release_held_repair_lease_in_tx(conn, project_id, &claim, &plan.semantic_epoch_id)?;
            anyhow::ensure!(
                released == 1,
                "NEX_REPAIR_LEASE_LOST: the Repair lease changed hands inside the mutation \
                 transaction; rolling back rather than releasing another holder's lease"
            );
            record_run_outcome_in_tx(
                conn,
                run_id,
                &json!({
                    "edgesDeactivated": deleted,
                    "backupArtifactPath": backup_artifact_path,
                }),
            )?;
            transition_run_status_in_tx(conn, run_id, NarrativeRunStatus::Completed)?;
            Ok(deleted)
        })
    })?;

    Ok(RepairOutcome {
        edges_deactivated,
        backup_artifact_path,
    })
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

    /// A `dependency-repair` Run left `running` under `plan`'s request
    /// identity: what a crash between Run creation and the repair
    /// transaction leaves behind. Written directly rather than by killing a
    /// real call, because the point is to test what recovery does with the
    /// wreckage, not to reproduce the crash.
    fn seed_crashed_repair_run(
        db: &Database,
        project_id: &str,
        plan: &RepairPlan,
        request_id: &str,
        actor_id: &str,
    ) -> String {
        let run_id = format!("crashed-{request_id}");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, created_at, run_kind, semantic_epoch_id, work_key,
                     request_id, idempotency_domain, request_payload_digest, actor_id)
                 VALUES (?1, ?2, 'surface', '{}', '{}', 'sha256:spec', 'running',
                         '2026-08-15T00:00:00.000Z', 'dependency-repair', ?3, ?4,
                         ?5, ?6, ?7, ?8)",
                params![
                    run_id,
                    project_id,
                    plan.semantic_epoch_id(),
                    plan.digest(),
                    request_id,
                    REPAIR_IDEMPOTENCY_DOMAIN,
                    plan.digest(),
                    actor_id,
                ],
            )?;
            Ok(())
        })
        .expect("seed a crashed repair run");
        run_id
    }

    fn run_status(db: &Database, run_id: &str) -> String {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = ?1",
                params![run_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(Into::into)
        })
        .expect("read run status")
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
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

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

    /// A Run forced back to `running` after its repair landed must never
    /// repair a second time.
    ///
    /// The real writer cannot produce this state — the mutation and the
    /// Run's completion commit together — so recovery does not try to
    /// reconstruct a success from it. It resumes, the in-transaction
    /// re-validation finds the duplicates already gone, and it fails
    /// closed. The graph is what matters here: no second deletion.
    #[test]
    fn a_request_forced_back_to_running_never_repairs_twice() {
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
        let after_repair = edge_count(&db);

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
        .expect_err("a plan whose targets are gone cannot be applied again");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_PLAN_NOT_DERIVED_FROM_VERIFY"),
            "unexpected error: {error}"
        );
        assert_eq!(
            edge_count(&db),
            after_repair,
            "recovery must never repair a second time"
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

    /// How many `dependency-repair` Runs exist. A replay must not add one.
    fn repair_run_count(db: &Database) -> i64 {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs
                  WHERE run_kind = 'dependency-repair'",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .expect("count repair runs")
    }

    /// Safety artifacts written under the fixture workspace. A replay must
    /// not take a second backup.
    fn backup_count(workspace_path: &Path) -> usize {
        fn count_dir(dir: &Path) -> usize {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return 0;
            };
            entries.flatten().count()
        }
        // `create_persistent_live_safety_artifact` writes under the
        // workspace; count everything that is not the live database itself.
        let Ok(entries) = std::fs::read_dir(workspace_path) else {
            return 0;
        };
        entries
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                !name.starts_with("grimodex.db")
            })
            .map(|entry| {
                if entry.path().is_dir() {
                    count_dir(&entry.path())
                } else {
                    1
                }
            })
            .sum()
    }

    fn surviving_edge_ids(db: &Database) -> Vec<String> {
        db.with_conn(|conn| {
            let ids = conn
                .prepare(
                    "SELECT id FROM narrative_dependency_edges WHERE project_id = 'project-1'",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
        .expect("list edges")
    }

    /// A second duplicate group, so a plan can carry more than one repair
    /// target. Assumes [`seed_duplicate_edges`] already dropped this
    /// throwaway database's UNIQUE constraint. Returns the older row's id,
    /// which is the one a Repair would deactivate.
    fn seed_second_duplicate_pair(db: &Database) -> String {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at)
                 VALUES ('edge-second-old', 'project-1', ?1, 'run-2',
                         'project:scene:scene-2', '[]', '2026-08-14T00:00:00.000Z'),
                        ('edge-second-new', 'project-1', ?1, 'run-2',
                         'project:scene:scene-2', '[]', '2026-08-15T00:00:00.000Z')",
                params![RUN_CONSUMER_KIND],
            )?;
            Ok(())
        })
        .expect("seed a second duplicate pair");
        "edge-second-old".to_string()
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
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
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

    // -- the Core API's own authority ---------------------------------------
    //
    // `RepairPlan`'s fields are private, so nothing outside this module can
    // express a plan that was not sealed from a Verify Run. These tests
    // reach past that from *inside* the module, to prove the execution
    // transaction does not take a plan's word for anything either.

    #[test]
    fn a_forged_plan_is_rejected_and_deletes_nothing() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let (old_id, _new_id) = seed_duplicate_edges(&db);
        let before = edge_count(&db);
        let forged = RepairPlan {
            verify_run_id: "arbitrary".to_string(),
            semantic_epoch_id: epoch_id,
            verify_report_digest: "arbitrary".to_string(),
            edge_ids_to_deactivate: vec![old_id],
            digest: "arbitrary".to_string(),
        };

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &forged,
            "test-owner",
            true,
            "req-forged",
            "test-actor",
        )
        .expect_err("a plan naming no real Verify Run must not delete anything");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_VERIFY_RUN_NOT_FOUND"),
            "unexpected error: {error}"
        );
        assert_eq!(edge_count(&db), before, "no Edge may have been deleted");
    }

    #[test]
    fn a_plan_whose_digest_does_not_match_its_contents_is_rejected() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let sealed = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        let before = edge_count(&db);
        // Everything real except the digest that is supposed to bind it.
        let tampered = RepairPlan {
            digest: "sha256:not-the-real-digest".to_string(),
            ..sealed
        };

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &tampered,
            "test-owner",
            true,
            "req-tampered",
            "test-actor",
        )
        .expect_err("a plan must digest to what it claims");
        assert!(
            error.to_string().contains("NEX_REPAIR_PLAN_STALE"),
            "unexpected error: {error}"
        );
        assert_eq!(edge_count(&db), before, "no Edge may have been deleted");
    }

    #[test]
    fn a_producer_write_between_sealing_and_execution_is_caught_in_the_transaction() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

        // The Repair lease excludes other Repairs, not ordinary Producer
        // writes. A third row in the same duplicate group after sealing
        // means the plan no longer describes the graph it will be applied
        // to -- the TOCTOU window the in-transaction re-validation closes.
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at)
                 VALUES ('edge-late', 'project-1', ?1, 'run-1', 'project:scene:scene-1',
                         '[\"v3@t\"]', '2026-08-16T00:00:00.000Z')",
                params![RUN_CONSUMER_KIND],
            )?;
            Ok(())
        })
        .expect("a Producer writes after the plan was sealed");
        let before = edge_count(&db);

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-toctou",
            "test-actor",
        )
        .expect_err("a plan sealed against a since-changed graph must not be applied");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_PLAN_NOT_DERIVED_FROM_VERIFY"),
            "unexpected error: {error}"
        );
        assert_eq!(edge_count(&db), before, "no Edge may have been deleted");
    }

    // -- crash atomicity and recovery ---------------------------------------

    #[test]
    fn a_successful_repair_commits_its_run_outcome_with_the_mutation() {
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
            "req-atomic",
            "test-actor",
        )
        .expect("repair");

        // There must be no window in which the Edges are gone but the Run
        // still says `running` with no outcome -- that is the state no
        // retry can interpret.
        let (status, outcome): (String, Option<String>) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status, outcome_summary_json FROM narrative_extraction_runs
                      WHERE run_kind = 'dependency-repair' AND request_id = 'req-atomic'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(Into::into)
            })
            .expect("read the repair run");
        assert_eq!(status, "completed");
        let outcome: serde_json::Value =
            serde_json::from_str(&outcome.expect("outcome recorded")).expect("outcome is json");
        assert_eq!(outcome["edgesDeactivated"].as_u64(), Some(1));
    }

    #[test]
    fn a_crashed_run_that_never_applied_its_plan_resumes_under_the_same_run() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let (old_id, new_id) = seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        let crashed_run_id =
            seed_crashed_repair_run(&db, "project-1", &plan, "req-crash", "test-actor");

        let outcome = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-crash",
            "test-actor",
        )
        .expect("an already-approved plan that never ran resumes");
        assert_eq!(outcome.edges_deactivated, 1);
        assert_eq!(run_status(&db, &crashed_run_id), "completed");

        // Recovery resumes the existing Run rather than minting a second
        // one -- the policy's manualRetry is crash recovery, not a new
        // approval.
        let repair_runs: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_extraction_runs
                      WHERE run_kind = 'dependency-repair'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count repair runs");
        assert_eq!(repair_runs, 1, "recovery must not create a duplicate Run");
        assert!(!surviving_edge_ids(&db).contains(&old_id));
        assert!(surviving_edge_ids(&db).contains(&new_id));
    }

    /// The reviewer's counterexample, made a test: absence is not
    /// attribution.
    ///
    /// Run A crashes before applying anything. A *different* request then
    /// repairs the same duplicates for real. When A is resent, its plan's
    /// Edges are all gone — but A did not delete them, and recording A as a
    /// success would write work it never did into the audit trail.
    #[test]
    fn a_crashed_run_is_not_credited_with_another_requests_repair() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        let crashed_run_id = seed_crashed_repair_run(&db, "project-1", &plan, "req-a", "actor-a");

        // A different request does the actual repair.
        repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "owner-b",
            true,
            "req-b",
            "actor-b",
        )
        .expect("the other request repairs");
        let after_b = edge_count(&db);

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "owner-a",
            true,
            "req-a",
            "actor-a",
        )
        .expect_err("Run A must not be credited with Run B's work");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_PLAN_NOT_DERIVED_FROM_VERIFY"),
            "unexpected error: {error}"
        );
        assert_eq!(
            run_status(&db, &crashed_run_id),
            "failed",
            "a Run that applied nothing must be recorded as failed, not completed"
        );
        assert_eq!(edge_count(&db), after_b, "nothing more may be deleted");
    }

    #[test]
    fn a_partially_applied_plan_refuses_to_resume() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let (old_id, _new_id) = seed_duplicate_edges(&db);
        let second_old_id = seed_second_duplicate_pair(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        assert_eq!(plan.change_count(), 2, "fixture needs two repair targets");
        let crashed_run_id =
            seed_crashed_repair_run(&db, "project-1", &plan, "req-partial", "test-actor");
        // Half applied: a state this crate's single-transaction writer
        // cannot produce, so something wrote around it.
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_dependency_edges WHERE id = ?1",
                params![old_id],
            )?;
            Ok(())
        })
        .expect("simulate a torn application");
        let before = edge_count(&db);

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-partial",
            "test-actor",
        )
        .expect_err("a torn application must not be resumed");
        // The in-transaction re-validation catches it: the plan no longer
        // describes the graph, so nothing is applied and the Run is failed.
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_PLAN_NOT_DERIVED_FROM_VERIFY"),
            "unexpected error: {error}"
        );
        assert_eq!(run_status(&db, &crashed_run_id), "failed");
        assert_eq!(edge_count(&db), before);
        assert!(surviving_edge_ids(&db).contains(&second_old_id));
    }

    #[test]
    fn a_running_run_with_a_live_lease_is_reported_in_progress() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        seed_crashed_repair_run(&db, "project-1", &plan, "req-live", "test-actor");
        // A live lease means another process may still be mid-repair. There
        // is no way to prove otherwise, so recovery must not start.
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &RepairLeaseClaim {
                        lease_owner: "other-owner".to_string(),
                        verify_run_id: plan.verify_run_id().to_string(),
                        repair_plan_digest: plan.digest().to_string(),
                        active_run_id: "test-run".to_string(),
                    },
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z",
                )
            })
        })
        .expect("claim a live lease");
        let before = edge_count(&db);

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-live",
            "test-actor",
        )
        .expect_err("a live lease must fail closed rather than resume");
        assert!(
            error.to_string().contains("NEX_REPAIR_REQUEST_IN_PROGRESS"),
            "unexpected error: {error}"
        );
        assert_eq!(edge_count(&db), before);
    }

    // -- the public request-first entry point -------------------------------
    //
    // These exercise `..._for_request`, which is what the N-API handler
    // calls. The `..._for_project` tests above take an already-sealed plan
    // and so cannot see an ordering bug that lives in the sealing step.

    #[test]
    fn a_lost_response_replays_the_stored_outcome_without_resealing() {
        let (workspace_path, db) = test_workspace("case");
        seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let epoch_id = db
            .with_conn(|conn| get_current_epoch(conn, "project-1"))
            .expect("epoch")
            .expect("epoch present")
            .id;
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("preview seals the plan the caller confirms");
        let plan_digest = plan.digest().to_string();

        let first = repair_narrative_dependency_declarations_for_request(
            &db,
            &workspace_path,
            "project-1",
            &verify_run_id,
            &plan_digest,
            "test-owner",
            true,
            "req-lost",
            "test-actor",
        )
        .expect("apply");
        let edges_after = edge_count(&db);
        let backups_after = backup_count(&workspace_path);

        // The response never reached the caller, so it retries the exact
        // same payload. Re-sealing first would fail: the duplicates are
        // gone, so a fresh plan no longer matches the Verify report.
        let replay = repair_narrative_dependency_declarations_for_request(
            &db,
            &workspace_path,
            "project-1",
            &verify_run_id,
            &plan_digest,
            "test-owner",
            true,
            "req-lost",
            "test-actor",
        )
        .expect("a retry of a landed request replays its stored outcome");

        assert_eq!(replay.edges_deactivated, first.edges_deactivated);
        assert_eq!(replay.backup_artifact_path, first.backup_artifact_path);
        assert_eq!(edge_count(&db), edges_after, "no second deletion");
        assert_eq!(
            backup_count(&workspace_path),
            backups_after,
            "a replay must not take another backup"
        );
        assert_eq!(
            repair_run_count(&db),
            1,
            "a replay must not create a second Run"
        );
    }

    /// A `running` Run whose plan can no longer be re-derived must not stay
    /// `running` forever. Before this, every retry returned the same
    /// pre-resume error and the Run was never terminalized — leaving it
    /// counted as in-flight by the C2-Z `no-active-backfill-or-repair-run`
    /// check.
    #[test]
    fn a_crashed_run_whose_plan_can_no_longer_be_derived_is_terminalized() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        let plan_digest = plan.digest().to_string();
        let crashed_run_id =
            seed_crashed_repair_run(&db, "project-1", &plan, "req-stuck", "actor-a");

        // A different request repairs the same duplicates first.
        repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "owner-b",
            true,
            "req-b",
            "actor-b",
        )
        .expect("the other request repairs");

        let error = repair_narrative_dependency_declarations_for_request(
            &db,
            &workspace_path,
            "project-1",
            &verify_run_id,
            &plan_digest,
            "owner-a",
            true,
            "req-stuck",
            "actor-a",
        )
        .expect_err("an unresumable plan cannot succeed");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_PLAN_NOT_DERIVED_FROM_VERIFY"),
            "unexpected error: {error}"
        );
        assert_eq!(
            run_status(&db, &crashed_run_id),
            "failed",
            "the Epoch did not move, so the graph drifted: failed"
        );

        // And a further retry replays that terminal answer instead of
        // re-deriving the same pre-resume error forever.
        let again = repair_narrative_dependency_declarations_for_request(
            &db,
            &workspace_path,
            "project-1",
            &verify_run_id,
            &plan_digest,
            "owner-a",
            true,
            "req-stuck",
            "actor-a",
        )
        .expect_err("a terminal Run replays its failure");
        assert!(
            again.to_string().contains("NEX_REPAIR_REQUEST_FAILED"),
            "unexpected error: {again}"
        );
    }

    #[test]
    fn a_crashed_run_left_behind_by_an_epoch_rotation_is_superseded() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        let plan_digest = plan.digest().to_string();
        let crashed_run_id =
            seed_crashed_repair_run(&db, "project-1", &plan, "req-rotated", "actor-a");

        // A restore rotates the generation out from under the crashed Run.
        db.with_conn(|conn| create_epoch_in_tx(conn, "project-1", "migration", None))
            .expect("rotate epoch");

        let error = repair_narrative_dependency_declarations_for_request(
            &db,
            &workspace_path,
            "project-1",
            &verify_run_id,
            &plan_digest,
            "owner-a",
            true,
            "req-rotated",
            "actor-a",
        )
        .expect_err("a plan from a prior Epoch cannot be resumed");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_VERIFY_RUN_EPOCH_MISMATCH")
                || error
                    .to_string()
                    .contains("NEX_REPAIR_PLAN_DIGEST_MISMATCH"),
            "unexpected error: {error}"
        );
        assert_eq!(
            run_status(&db, &crashed_run_id),
            "superseded",
            "a new generation replaced the work rather than the work going wrong"
        );
    }

    /// The reviewer's concurrency note: two retries of one crashed request
    /// share a Run, so losing the lease race must not fail that shared Run.
    #[test]
    fn a_concurrent_resume_of_the_same_run_reports_in_progress_without_failing_it() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        let crashed_run_id =
            seed_crashed_repair_run(&db, "project-1", &plan, "req-race", "actor-a");

        // Stand in for "the other retry got there first": a live lease held
        // under this same Run by a different owner process.
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &RepairLeaseClaim {
                        lease_owner: "owner-first".to_string(),
                        verify_run_id: verify_run_id.clone(),
                        repair_plan_digest: plan.digest().to_string(),
                        active_run_id: crashed_run_id.clone(),
                    },
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z",
                )
            })
        })
        .expect("the first retry holds the lease");

        let error = repair_narrative_dependency_declarations_for_request(
            &db,
            &workspace_path,
            "project-1",
            &verify_run_id,
            plan.digest(),
            "owner-second",
            true,
            "req-race",
            "actor-a",
        )
        .expect_err("the second retry must not proceed");
        assert!(
            error.to_string().contains("NEX_REPAIR_REQUEST_IN_PROGRESS"),
            "unexpected error: {error}"
        );
        assert_eq!(
            run_status(&db, &crashed_run_id),
            "running",
            "the shared Run must not be failed by the losing retry"
        );
    }

    /// Two concurrent calls carrying the *same* requestId share one Run:
    /// one creates it, the other replays into it. Whichever reaches the
    /// lease second must not mark that shared Run failed.
    ///
    /// This is the same hazard as a concurrent crash-resume, but it arrives
    /// through the *initial* path rather than the resume one — which is why
    /// the exemption keys on the lease's `active_run_id` rather than on
    /// which call created the Run.
    #[test]
    fn a_second_attempt_on_a_shared_run_does_not_fail_it() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");

        // The first call creates the Run and takes the lease under it. Build
        // that state directly: a `running` Run for this request, plus a live
        // lease bound to it held by the *other* attempt's owner.
        let shared_run_id =
            seed_crashed_repair_run(&db, "project-1", &plan, "req-shared-run", "actor-a");
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &RepairLeaseClaim {
                        lease_owner: "owner-first".to_string(),
                        verify_run_id: verify_run_id.clone(),
                        repair_plan_digest: plan.digest().to_string(),
                        active_run_id: shared_run_id.clone(),
                    },
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z",
                )
            })
        })
        .expect("the winning attempt holds the lease under the shared Run");

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "owner-second",
            true,
            "req-shared-run",
            "actor-a",
        )
        .expect_err("the losing attempt must not proceed");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_REQUEST_IN_PROGRESS"),
            "unexpected error: {error}"
        );
        assert_eq!(
            run_status(&db, &shared_run_id),
            "running",
            "the shared Run must survive the losing attempt"
        );
    }

    /// The converse: a lease held for a *different* Run really does mean
    /// this Run cannot proceed, so it must be failed rather than reported
    /// as in flight.
    #[test]
    fn a_lease_held_for_a_different_run_fails_this_one() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &RepairLeaseClaim {
                        lease_owner: "owner-other".to_string(),
                        verify_run_id: verify_run_id.clone(),
                        repair_plan_digest: plan.digest().to_string(),
                        active_run_id: "some-other-run".to_string(),
                    },
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z",
                )
            })
        })
        .expect("an unrelated Run holds the lease");

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "owner-mine",
            true,
            "req-blocked",
            "actor-a",
        )
        .expect_err("another Run's lease blocks this one");
        assert!(
            error.to_string().contains("NEX_REPAIR_LEASE_HELD"),
            "unexpected error: {error}"
        );
        let status: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT status FROM narrative_extraction_runs
                      WHERE request_id = 'req-blocked'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("the blocked Run exists");
        assert_eq!(
            status, "failed",
            "a Run blocked by someone else's lease is this Run's failure"
        );
    }

    /// `active_run_id` is part of the lease's identity from the moment it is
    /// claimed, not only at the post-backup CAS. Two Runs can share owner,
    /// Verify Run and plan digest — this Run Kind never auto-reuses work —
    /// so without it the second would silently steal the first's
    /// entitlement.
    #[test]
    fn a_second_run_may_not_take_over_a_live_lease_for_the_same_plan() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        let base = RepairLeaseClaim {
            lease_owner: "process-1".to_string(),
            verify_run_id: verify_run_id.clone(),
            repair_plan_digest: plan.digest().to_string(),
            active_run_id: "run-a".to_string(),
        };
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &base,
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z",
                )
            })
        })
        .expect("Run A claims the lease");

        // Same owner, same Verify Run, same plan digest -- different Run.
        let error = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    claim_repair_lease_in_tx(
                        conn,
                        "project-1",
                        &RepairLeaseClaim {
                            lease_owner: base.lease_owner.clone(),
                            verify_run_id: base.verify_run_id.clone(),
                            repair_plan_digest: base.repair_plan_digest.clone(),
                            active_run_id: "run-b".to_string(),
                        },
                        &epoch_id,
                        "2026-08-15T00:00:00.000Z",
                        "2099-01-01T00:00:00.000Z",
                    )
                })
            })
            .expect_err("a different Run is not a re-entrant claim");
        assert!(
            error.to_string().contains("NEX_REPAIR_LEASE_HELD"),
            "unexpected error: {error}"
        );

        let active_run_id: Option<String> = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT active_run_id FROM narrative_maintenance_repair_leases
                      WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read the lease");
        assert_eq!(
            active_run_id.as_deref(),
            Some("run-a"),
            "Run A's entitlement must survive Run B's attempt"
        );
    }

    #[test]
    fn the_request_first_entry_point_rejects_a_digest_the_caller_was_not_shown() {
        let (workspace_path, db) = test_workspace("case");
        seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let before = edge_count(&db);

        let error = repair_narrative_dependency_declarations_for_request(
            &db,
            &workspace_path,
            "project-1",
            &verify_run_id,
            "sha256:a-digest-nobody-was-shown",
            "test-owner",
            true,
            "req-wrong-digest",
            "test-actor",
        )
        .expect_err("apply must confirm the plan the caller actually saw");
        assert!(
            error
                .to_string()
                .contains("NEX_REPAIR_PLAN_DIGEST_MISMATCH"),
            "unexpected error: {error}"
        );
        assert_eq!(edge_count(&db), before);
        assert_eq!(repair_run_count(&db), 0, "a rejected apply creates no Run");
    }

    #[test]
    fn a_replayed_request_cannot_be_claimed_by_a_different_actor() {
        let (workspace_path, db) = test_workspace("case");
        seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let epoch_id = db
            .with_conn(|conn| get_current_epoch(conn, "project-1"))
            .expect("epoch")
            .expect("epoch present")
            .id;
        let plan_digest = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan")
            .digest()
            .to_string();
        repair_narrative_dependency_declarations_for_request(
            &db,
            &workspace_path,
            "project-1",
            &verify_run_id,
            &plan_digest,
            "test-owner",
            true,
            "req-shared",
            "actor-one",
        )
        .expect("apply");

        let error = repair_narrative_dependency_declarations_for_request(
            &db,
            &workspace_path,
            "project-1",
            &verify_run_id,
            &plan_digest,
            "test-owner",
            true,
            "req-shared",
            "actor-two",
        )
        .expect_err("a requestId is one person's approval, not a shared token");
        assert!(
            error.to_string().contains("NEX_RUN_REQUEST_CONFLICT"),
            "unexpected error: {error}"
        );
    }

    // -- lease ownership ----------------------------------------------------

    #[test]
    fn a_worker_whose_lease_was_reclaimed_cannot_mutate_or_release() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        let before = edge_count(&db);

        // Stand in for "A's lease expired during a long backup and B
        // re-claimed it": B owns a live lease under a different owner and
        // Run, so A's CAS must find nothing.
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &RepairLeaseClaim {
                        lease_owner: "owner-b".to_string(),
                        verify_run_id: verify_run_id.clone(),
                        repair_plan_digest: plan.digest().to_string(),
                        active_run_id: "run-b".to_string(),
                    },
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z",
                )
            })
        })
        .expect("B claims the lease");

        // A's own claim attempt is refused while B's lease is live, so A
        // never reaches the mutation transaction at all.
        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "owner-a",
            true,
            "req-a",
            "actor-a",
        )
        .expect_err("a worker without the lease must not mutate");
        assert!(
            error.to_string().contains("NEX_REPAIR_LEASE_"),
            "unexpected error: {error}"
        );
        assert_eq!(edge_count(&db), before, "no Edge may have been deleted");

        // And B's lease is still B's — not deleted by A's failure path.
        let (owner, run): (String, Option<String>) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT lease_owner, active_run_id FROM narrative_maintenance_repair_leases
                      WHERE project_id = 'project-1'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(Into::into)
            })
            .expect("B's lease survives");
        assert_eq!(owner, "owner-b");
        assert_eq!(run.as_deref(), Some("run-b"));
    }

    #[test]
    fn the_mutation_transaction_refuses_an_expired_lease() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        seed_duplicate_edges(&db);
        let verify_run_id = seed_verify_run(&db, "project-1");
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", &verify_run_id, &epoch_id))
            .expect("seal plan");
        let claim = RepairLeaseClaim {
            lease_owner: "owner-a".to_string(),
            verify_run_id: verify_run_id.clone(),
            repair_plan_digest: plan.digest().to_string(),
            active_run_id: "run-a".to_string(),
        };
        // Claimed, then expired — exactly what a long backup produces.
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &claim,
                    &epoch_id,
                    "2020-01-01T00:00:00.000Z",
                    "2020-01-01T00:15:00.000Z",
                )
            })
        })
        .expect("claim a lease that is already past its TTL");

        let error = db
            .with_conn(|conn| {
                assert_repair_lease_still_held_in_tx(conn, "project-1", &claim, &epoch_id)
            })
            .expect_err("an expired lease is not held");
        assert!(
            error.to_string().contains("NEX_REPAIR_LEASE_LOST"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn a_completed_run_with_an_unreadable_outcome_is_not_replayed_as_success() {
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
            "req-malformed",
            "test-actor",
        )
        .expect("repair");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs SET outcome_summary_json = '{}'
                  WHERE request_id = 'req-malformed'",
                [],
            )?;
            Ok(())
        })
        .expect("corrupt the recorded outcome");

        let error = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
            "req-malformed",
            "test-actor",
        )
        .expect_err("a completed Run whose outcome cannot be read must not replay as success");
        assert!(
            error.to_string().contains("NEX_REPAIR_OUTCOME_MALFORMED"),
            "unexpected error: {error}"
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
                        active_run_id: "test-run".to_string(),
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
                            active_run_id: "test-run".to_string(),
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
                        active_run_id: "test-run".to_string(),
                    },
                    &epoch_id,
                    now,
                    expires_at,
                )
            })
        })
        .expect("re-claiming the identical plan must succeed");
    }

    /// The other direction of the claim predicate: the *same* execution
    /// re-claiming its own live lease must succeed. The resume path relies
    /// on it, and a predicate that only ever rejected would break resume
    /// silently rather than loudly.
    #[test]
    fn a_run_may_reclaim_its_own_live_lease() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let claim = RepairLeaseClaim {
            lease_owner: "owner-a".to_string(),
            verify_run_id: "verify-run-1".to_string(),
            repair_plan_digest: "sha256:plan-a".to_string(),
            active_run_id: "run-a".to_string(),
        };
        for label in ["first claim", "re-entrant claim by the same Run"] {
            db.with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    claim_repair_lease_in_tx(
                        conn,
                        "project-1",
                        &claim,
                        &epoch_id,
                        "2026-08-15T00:00:00.000Z",
                        "2099-01-01T00:00:00.000Z",
                    )
                })
            })
            .unwrap_or_else(|error| panic!("{label} must succeed: {error}"));
        }

        // ...and the CAS the mutation transaction performs agrees.
        db.with_conn(|conn| {
            assert_repair_lease_still_held_in_tx(conn, "project-1", &claim, &epoch_id)
        })
        .expect("the re-claimed lease is still held by this Run");
    }

    /// A lease from a prior generation is not this one, even if every other
    /// column matches.
    #[test]
    fn a_lease_from_a_prior_epoch_is_not_the_same_claim() {
        let (_workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let claim = RepairLeaseClaim {
            lease_owner: "owner-a".to_string(),
            verify_run_id: "verify-run-1".to_string(),
            repair_plan_digest: "sha256:plan-a".to_string(),
            active_run_id: "run-a".to_string(),
        };
        db.with_conn(|conn| {
            with_immediate_transaction(conn, |conn| {
                claim_repair_lease_in_tx(
                    conn,
                    "project-1",
                    &claim,
                    &epoch_id,
                    "2026-08-15T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z",
                )
            })
        })
        .expect("claim under the first epoch");

        let rotated = db
            .with_conn(|conn| create_epoch_in_tx(conn, "project-1", "migration", None))
            .expect("rotate epoch");
        let error = db
            .with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    claim_repair_lease_in_tx(
                        conn,
                        "project-1",
                        &claim,
                        &rotated,
                        "2026-08-15T00:00:00.000Z",
                        "2099-01-01T00:00:00.000Z",
                    )
                })
            })
            .expect_err("a live lease from a prior Epoch must not be silently adopted");
        assert!(
            error.to_string().contains("NEX_REPAIR_LEASE_HELD"),
            "unexpected error: {error}"
        );
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
                        active_run_id: "test-run".to_string(),
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
                        active_run_id: "test-run".to_string(),
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
