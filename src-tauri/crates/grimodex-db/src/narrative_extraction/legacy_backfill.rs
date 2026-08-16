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
//! `target_object_identity` is built directly from the Application's own
//! `applied_entity_kind`/`applied_entity_id` columns (`"{kind}:{id}"`)
//! rather than the canonical `object_key_identity` JSON shape
//! (`canonical_feed_snapshots.rs`): the two vocabularies already diverge
//! (`event` vs. `chronicle-event`, `codex_entry` vs. `codex-entry`, ...) and
//! reconciling them is a Freshness-evaluator concern, not a backfill
//! concern -- this module only needs a stable, collision-free key derived
//! from data the Application row already owns. `field_path` uses
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

use rusqlite::{params, Connection};

use super::application_contributions::{record_contribution_in_tx, ContributionTargetState};
use super::dependency_edges::{
    record_dependency_edge_in_tx, source_object_identity_for, RUN_CONSUMER_KIND,
};
use super::semantic_epoch::{create_epoch_in_tx, get_current_epoch};

/// Field path recorded for every backfilled Contribution. Legacy
/// Applications predate per-field Contribution tracking, so there is no
/// specific JSON pointer to recover -- this sentinel stands for "the whole
/// entity this Application wrote, granularity unknown".
const LEGACY_BACKFILL_FIELD_PATH: &str = "/legacy-application";

/// Outcome of one `backfill_project_semantic_build_graph_in_tx` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BackfillSummary {
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
    applied_entity_kind: String,
    applied_entity_id: String,
    run_id: Option<String>,
}

struct LegacyProjectionDependency {
    source_kind: String,
    source_key: String,
    observed_revision_token: String,
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
        let target_object_identity = format!(
            "{}:{}",
            application.applied_entity_kind, application.applied_entity_id
        );
        record_contribution_in_tx(
            conn,
            project_id,
            &application.id,
            &target_object_identity,
            LEGACY_BACKFILL_FIELD_PATH,
            ContributionTargetState::Unchanged,
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
fn record_legacy_dependency_edges_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    application_id: &str,
    now: &str,
) -> anyhow::Result<()> {
    for dependency in load_legacy_projection_dependencies(conn, application_id)? {
        let source_object_identity =
            source_object_identity_for(&dependency.source_kind, &dependency.source_key)?;
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
/// `CHECK`), so it carries no information beyond what `source_kind`/
/// `source_key`/`observed_revision_token` already give the Generic Graph.
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
        "SELECT a.id, a.applied_entity_kind, a.applied_entity_id, c.run_id
           FROM narrative_proposal_applications a
           INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
          WHERE c.project_id = ?1
          ORDER BY a.created_at ASC, a.id ASC",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok(LegacyApplication {
                id: row.get(0)?,
                applied_entity_kind: row.get(1)?,
                applied_entity_id: row.get(2)?,
                run_id: row.get(3)?,
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
                "codex_entry:entry-1"
            );
            assert_eq!(contributions_1[0].field_path, LEGACY_BACKFILL_FIELD_PATH);
            assert_eq!(
                contributions_1[0].target_state,
                ContributionTargetState::Unchanged
            );

            let contributions_2 = list_contributions_for_application(conn, "project-1", "app-2")?;
            assert_eq!(contributions_2.len(), 1);
            assert_eq!(contributions_2[0].target_object_identity, "event:event-1");
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
                list_contributions_for_target(conn, "project-1", "codex_entry:entry-1")?;
            assert_eq!(project_1_contributions.len(), 1);

            let project_2_contributions =
                list_contributions_for_target(conn, "project-2", "codex_entry:entry-2")?;
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
                "scene-1",
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
                "scene-1",
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
                "scene-1",
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
}
