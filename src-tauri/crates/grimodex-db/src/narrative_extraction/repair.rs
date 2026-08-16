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
use super::restore_rebuild::{
    duplicate_edge_ids_to_deactivate, rebuild_repair_dependency_edges_in_tx,
};
use super::semantic_epoch::get_current_epoch;
use super::task_leases::with_immediate_transaction;
use crate::backup_restore::{create_persistent_live_safety_artifact, LiveSafetyArtifact};
use crate::Database;

const REPAIR_LEASE_TTL_SECONDS: i64 = 15 * 60;

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

/// Seals a Repair plan for one project. Today only the
/// `deactivate-duplicate-edge` category
/// (`restore_rebuild::duplicate_edge_ids_to_deactivate`) is populated --
/// see this module's doc comment on why the other five `allowedRepairs`
/// categories cannot be proposed yet. An empty plan (nothing this Verify
/// coverage can propose a repair for) is a valid, non-error outcome; the
/// caller should not proceed to
/// [`repair_narrative_dependency_declarations_for_project`] with one.
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

    let mut edge_ids_to_deactivate = duplicate_edge_ids_to_deactivate(conn, project_id)?;
    edge_ids_to_deactivate.sort();

    let sealed = json!({
        "planKind": "dependency-repair-v1",
        "verifyRunId": verify_run_id,
        "semanticEpochId": semantic_epoch_id,
        "edgeIdsToDeactivate": edge_ids_to_deactivate,
    });
    let digest = format!("sha256:{}", digest_plan(&sealed));

    Ok(RepairPlan {
        verify_run_id: verify_run_id.to_string(),
        semantic_epoch_id: semantic_epoch_id.to_string(),
        edge_ids_to_deactivate,
        digest,
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
pub fn repair_narrative_dependency_declarations_for_project(
    db: &Database,
    workspace_path: &Path,
    project_id: &str,
    plan: &RepairPlan,
    lease_owner: &str,
    explicit_confirmation: bool,
) -> anyhow::Result<RepairOutcome> {
    anyhow::ensure!(
        explicit_confirmation,
        "NEX_REPAIR_CONFIRMATION_REQUIRED: dependency-repair requires explicit confirmation"
    );
    anyhow::ensure!(!lease_owner.trim().is_empty(), "leaseOwner is required");

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
                &now_text,
                &expires_at,
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
        // describes). To build the fixture this test needs, drop that
        // constraint on this throwaway per-test database only (`CREATE
        // TABLE ... AS SELECT` never carries constraints over) before
        // inserting the duplicate; the whole database is discarded when the
        // test ends, so there is no need to restore it.
        db.with_conn(|conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = OFF;
                 CREATE TABLE narrative_dependency_edges_unconstrained AS
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

        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", "verify-run-1", &epoch_id))
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

        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", "verify-run-1", &epoch_id))
            .expect("seal plan");
        assert!(plan.edge_ids_to_deactivate.is_empty());
        assert_eq!(plan.change_count(), 0);
    }

    #[test]
    fn repair_requires_explicit_confirmation() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let (old_id, _new_id) = seed_duplicate_edges(&db);
        let plan = RepairPlan {
            verify_run_id: "verify-run-1".to_string(),
            semantic_epoch_id: epoch_id,
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
        )
        .expect_err("must fail without explicit confirmation");
        assert!(error
            .to_string()
            .starts_with("NEX_REPAIR_CONFIRMATION_REQUIRED"));
    }

    #[test]
    fn repair_executes_the_sealed_plan_and_releases_the_lease() {
        let (workspace_path, db) = test_workspace("case");
        let epoch_id = seed_epoch(&db, "project-1");
        let (old_id, new_id) = seed_duplicate_edges(&db);
        let plan = db
            .with_conn(|conn| seal_repair_plan(conn, "project-1", "verify-run-1", &epoch_id))
            .expect("seal plan");
        assert_eq!(plan.edge_ids_to_deactivate, vec![old_id.clone()]);

        let outcome = repair_narrative_dependency_declarations_for_project(
            &db,
            &workspace_path,
            "project-1",
            &plan,
            "test-owner",
            true,
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
