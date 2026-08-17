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
//!      identity mirrors Producer-time C2-T1 wiring exactly
//!      (`repository.rs`'s `record_run_dependency_edges_in_tx`):
//!      `(RUN_CONSUMER_KIND, run_id)`, the owning `narrative_apply_commits`
//!      row's own `run_id` column -- never the individual Application, so a
//!      later Verify/Rebuild walking `find_edges_by_consumer` sees the same
//!      shape whether a Run's Edges came from a live Reconciliation
//!      Envelope or from this backfill. A commit with a `NULL` `run_id`
//!      (predates the Run/Task/Attempt execution-state model entirely) has
//!      no Run-scoped Consumer identity to backfill an Edge under; its
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

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;

use super::application_contributions::{
    contribution_target_identity_for_application, record_contribution_in_tx,
    ContributionProvenance, ContributionTargetState, UNRESOLVED_TARGET_PREFIX,
};
use super::dependency_edges::{
    canonical_source_object_identity, record_dependency_edge_in_tx, RUN_CONSUMER_KIND,
};
use super::digest_plan;
use super::execution_state::{transition_run_status_in_tx, NarrativeRunStatus};
use super::repository::{create_system_run_in_tx, SystemRunWorkKeyReuse};
use super::semantic_epoch::{create_epoch_in_tx, get_current_epoch};
use super::task_leases::with_immediate_transaction;
use crate::Database;

/// Work key every project's Legacy Dependency Backfill Run is created
/// under (Run Kind Policy `dependency-backfill`). One logical Backfill per
/// project per algorithm version -- see
/// [`bootstrap_legacy_dependency_backfill_for_project`].
///
/// The trailing `:v<n>` is load-bearing and must move with
/// [`LEGACY_BACKFILL_ALGORITHM_VERSION`] (a test pins that). The Run Kind
/// Policy seals `backfillAlgorithmVersion` as a `sealedParameters` entry, so
/// the contract already says two Runs at different algorithm versions are
/// not the same work -- but `find_reusable_system_run` matches on
/// `(project_id, run_kind, work_key, status)` and never opens the sealed
/// spec, so with a version-free key a Run left `completed` by an older
/// algorithm is reused and the new transform never runs. Carrying the
/// version in the key is what makes the implementation honour the seal.
const LEGACY_BACKFILL_WORK_KEY: &str = "legacy-dependency-backfill:v2";

/// Sealed into the Run's `spec_json` per the Run Kind Policy's
/// `sealedParameters`. This backfill has no legacy schema-version/
/// high-water-mark to seal (its whole input is "every existing
/// `narrative_proposal_applications`/`narrative_projection_dependencies`
/// row", not a bounded/versioned slice), so `backfillAlgorithmVersion` is
/// the one parameter worth sealing: bump it if this transform's write
/// shape ever changes in a way that would make an older completed Run
/// unsafe to treat as equivalent to a fresh one.
/// `"2"` since Contribution `target_object_identity` and Dependency Edge
/// `source_object_identity` are both written in canonical form: a Run
/// completed under `"1"` left `codex_entry:<id>` Contributions and
/// double-prefixed Edges, so it is not equivalent to a fresh one.
const LEGACY_BACKFILL_ALGORITHM_VERSION: &str = "2";

/// Outcome of [`bootstrap_legacy_dependency_backfill_for_project`].
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

/// Field path recorded for every backfilled Contribution. Legacy
/// Applications predate per-field Contribution tracking, so there is no
/// specific JSON pointer to recover -- this sentinel stands for "the whole
/// entity this Application wrote, granularity unknown".
const LEGACY_BACKFILL_FIELD_PATH: &str = "/legacy-application";

/// Outcome of one `backfill_project_semantic_build_graph_in_tx` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    /// has a `NULL` `run_id` -- predates the Run/Task/Attempt
    /// execution-state model, so there is no Run-scoped Consumer identity
    /// to backfill a Dependency Edge under. Their Contribution row is still
    /// seeded; only Edge backfill is skipped for these, and this count
    /// makes that skip visible rather than silent.
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
/// Its only production caller today is the Admin IPC
/// `retryNarrativeLegacyBackfill`. The policy's `automatic-once` post-open
/// trigger is intentionally **not** wired: committing from a second
/// connection while the foreground holds a deferred transaction fails that
/// transaction with SQLITE_BUSY_SNAPSHOT, which `busy_timeout` cannot
/// retry (see the long comment at the former call site in `open.rs`, and
/// `execute.rs`'s `BEGIN IMMEDIATE` note). Re-wiring it requires either
/// running on the live authority's connection or making
/// `domain_writes.rs`'s deferred transactions IMMEDIATE.
///
/// Three phases, each its own transaction, so a Phase 2 failure cannot
/// erase the Phase 1 Run record it should be explaining:
///
///   1. Reuse-check + Run creation (`create_system_run_in_tx`,
///      `SystemRunWorkKeyReuse::RunningAndCompleted` -- matching the
///      ratified policy's `sameWorkKeyReuse` exactly) under a freshly
///      ensured/created Semantic Epoch. If a Run already exists
///      `pending`/`running`/`completed`, this returns `AlreadyRun` and
///      does nothing further.
///   2. Run the transform itself
///      (`backfill_project_semantic_build_graph_in_tx`) in its own
///      transaction, so a failure rolls back only its own partial writes,
///      never the Run record from phase 1.
///   3. Finalize the Run's status to `completed`/`failed` based on phase
///      2's outcome, in yet another transaction -- always attempted, even
///      on phase 2 failure, so a failed attempt is visible via a `failed`
///      Run row rather than stuck at `running` forever.
///
/// A `failed` Run is not reused by phase 1's `RunningAndCompleted` check,
/// so a later invocation retries it. With the post-open trigger unwired,
/// that retry is operator-driven (the Admin IPC) rather than automatic:
/// `autoRetryableFailureClasses`' bounded auto-retry (SQLite busy,
/// process interruption, app shutdown, lease timeout, transient I/O) will
/// only fall out of "retry on next open" once that trigger is restored.
/// A structurally-broken project
/// (`NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION`) fails the same way on
/// every invocation; surfacing that persistently to a human via the
/// Maintenance Inbox is a follow-on, not implemented here.
///
/// Known gap, not addressed here: a crash strictly between phase 1
/// committing and phase 3 running (the transform itself is a fast,
/// bounded SQL scan+upsert, so this window is narrow but not zero) leaves
/// the Run stuck at `running`, which phase 1's `RunningAndCompleted`
/// check treats as "still in progress" and does not retry. Recovering a
/// Run/Task/Attempt stuck `running` after a terminated process is a Lane
/// B / execution-state-model concern spanning every Run Kind, not
/// something specific to Backfill worth solving narrowly here.
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
            let created = create_system_run_in_tx(
                conn,
                project_id,
                "backfill",
                &epoch_id,
                LEGACY_BACKFILL_WORK_KEY,
                &spec,
                &spec_digest,
                SystemRunWorkKeyReuse::RunningAndCompleted,
                // No request identity: this Run is started by the system
                // itself, not by an addressable caller request.
                None,
            )?;
            let run_id = created["runId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("create_system_run_in_tx returned no runId"))?
                .to_string();
            let reused = created["reused"].as_bool().unwrap_or(false);
            Ok((run_id, reused))
        })
    })?;

    if reused {
        return Ok(LegacyBackfillBootstrapOutcome::AlreadyRun { run_id });
    }

    let transform_result = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            backfill_project_semantic_build_graph_in_tx(conn, project_id, &now)
        })
    });

    let finalize_status = if transform_result.is_ok() {
        NarrativeRunStatus::Completed
    } else {
        NarrativeRunStatus::Failed
    };
    let finalize_result = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            transition_run_status_in_tx(conn, &run_id, finalize_status)
        })
    });
    if let Err(finalize_error) = finalize_result {
        tracing::error!(
            "legacy dependency backfill: failed to finalize run '{run_id}' status: {finalize_error}"
        );
    }

    match transform_result {
        Ok(summary) => Ok(LegacyBackfillBootstrapOutcome::Ran { run_id, summary }),
        Err(error) => Err(error),
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

/// Backfill one project's Semantic Build Graph foundation from its
/// pre-Gate-C2 Application history. See module docs for the epoch and
/// Contribution seeding this performs. Ambient-transaction helper: the
/// caller is expected to run this inside its own `BEGIN IMMEDIATE` /
/// commit block (a one-off migration/maintenance job), matching every
/// other `_in_tx` helper in this crate.
pub(crate) fn backfill_project_semantic_build_graph_in_tx(
    conn: &Connection,
    project_id: &str,
    now: &str,
) -> anyhow::Result<BackfillSummary> {
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
                // single canonical event corresponds to this Application and
                // there is no self-stale lower bound to record. None is the
                // conservative reading: every event counts as newer.
                baseline_sequence: None,
            },
            &target_object_identity,
            LEGACY_BACKFILL_FIELD_PATH,
            target_state,
            now,
        )?;

        match &application.run_id {
            Some(run_id) => {
                record_legacy_dependency_edges_in_tx(
                    conn,
                    project_id,
                    run_id,
                    &application.id,
                    now,
                )?;
            }
            None => applications_without_run_id += 1,
        }
    }
    let contributions_after = count_contributions(conn, project_id)?;
    let edges_after = count_edges(conn, project_id)?;

    Ok(BackfillSummary {
        epoch_created,
        contributions_created: contributions_after.saturating_sub(contributions_before),
        edges_created: edges_after.saturating_sub(edges_before),
        applications_without_run_id,
    })
}

/// Producer-time-shaped Dependency Edge backfill for one legacy Application:
/// every `narrative_projection_dependencies` row it left behind becomes one
/// Edge declared by its owning Run, mirroring `repository.rs`'s
/// `record_run_dependency_edges_in_tx` exactly (same Consumer identity, same
/// one-element `read_set_json`) so this Run's Edge set looks identical
/// whether it was declared live or backfilled.
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
fn record_legacy_dependency_edges_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    application_id: &str,
    now: &str,
) -> anyhow::Result<()> {
    for dependency in load_legacy_projection_dependencies(conn, application_id)? {
        let source_object_identity =
            canonical_source_object_identity(&dependency.source_kind, &dependency.source_key)?;
        let read_set_json = serde_json::to_string(&[dependency.observed_revision_token.as_str()])?;
        record_dependency_edge_in_tx(
            conn,
            project_id,
            RUN_CONSUMER_KIND,
            run_id,
            &source_object_identity,
            &read_set_json,
            None,
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
    /// `run_id` be set -- needed to exercise Dependency Edge backfill, which
    /// is Run-scoped.
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

            let edges = find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1")?;
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
            for (source_kind, source_key) in [
                ("scene-body", "project:scene:scene-1"),
                ("snapshot-document", "snapshot:run-legacy-1"),
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

            let edges = find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1")?;
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
                    "snapshot:run-legacy-1",
                ]
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

            let edges = find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1")?;
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
    fn applications_without_run_id_are_counted_and_skipped() {
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
            assert_eq!(
                summary.edges_created, 0,
                "no Run-scoped Consumer identity exists to backfill an Edge under"
            );
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

            let edges = find_edges_by_consumer(conn, "project-1", RUN_CONSUMER_KIND, "run-1")?;
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
