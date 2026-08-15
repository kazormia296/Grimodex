//! Field-level Application bookkeeping (Gate C2 Lane H).
//!
//! `narrative_application_contributions` records which Application (an
//! applied Proposal Revision, see `commit.rs`) most recently touched which
//! field on which target object. This is deliberately narrower than the
//! Application row itself: an Application can span many fields across many
//! target objects, and Undo/Redo or downstream Freshness work needs to walk
//! that fan-out in both directions —
//!   * target -> Applications ("which Proposals wrote this field?")
//!   * Application -> targets ("what does undoing this Application touch?")
//! without re-deriving it from the Prepared Commit plan JSON every time.
//!
//! `ContributionTargetState` is a distinct axis from the Prepared Commit /
//! Change Feed review vocabulary in
//! `policies/narrative/semantic-state-vocabulary.json`
//! (`reviewStates`, `projectionApplicationStates`). Do not conflate the two:
//! this state describes what happened to the *field this Application wrote*
//! (still matching what was applied, hand-edited over, gone, replaced by a
//! later Application, rolled back, or no longer relevant), not a Proposal's
//! review lifecycle.
//!
//! Callers own the surrounding transaction; every write here takes `&Connection`
//! so it composes into the same commit/rollback boundary as the domain
//! mutation, Undo journal, and canonical Change Event it accompanies. Actual
//! call-site wiring into `commit.rs` lands in C2-T1 — this module only
//! establishes the bookkeeping primitives.

use rusqlite::{params, Connection, Row};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ContributionTargetState {
    Unchanged,
    Modified,
    Missing,
    Superseded,
    Undone,
    NotApplicable,
}

impl ContributionTargetState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Unchanged => "unchanged",
            Self::Modified => "modified",
            Self::Missing => "missing",
            Self::Superseded => "superseded",
            Self::Undone => "undone",
            Self::NotApplicable => "not-applicable",
        }
    }
}

impl TryFrom<&str> for ContributionTargetState {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> anyhow::Result<Self> {
        match value {
            "unchanged" => Ok(Self::Unchanged),
            "modified" => Ok(Self::Modified),
            "missing" => Ok(Self::Missing),
            "superseded" => Ok(Self::Superseded),
            "undone" => Ok(Self::Undone),
            "not-applicable" => Ok(Self::NotApplicable),
            other => anyhow::bail!(
                "NEX_CONTRIBUTION_TARGET_STATE_INVALID: unknown Application contribution target state '{other}'"
            ),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ApplicationContribution {
    pub id: String,
    pub project_id: String,
    pub application_id: String,
    pub target_object_identity: String,
    pub field_path: String,
    pub target_state: ContributionTargetState,
    pub created_at: String,
}

/// Upsert a single field-level contribution record inside the caller's
/// transaction. Re-recording the same `(project_id, application_id,
/// target_object_identity, field_path)` key (for example, a later Undo/Redo
/// pass revising the target state) overwrites `target_state`/`created_at` on
/// the existing row rather than creating a duplicate. Returns the row id —
/// the freshly minted id on first insert, or the pre-existing row's id when
/// the upsert matched an existing key.
pub(crate) fn record_contribution_in_tx(
    conn: &Connection,
    project_id: &str,
    application_id: &str,
    target_object_identity: &str,
    field_path: &str,
    target_state: ContributionTargetState,
    created_at: &str,
) -> anyhow::Result<String> {
    anyhow::ensure!(
        !project_id.is_empty(),
        "NEX_CONTRIBUTION_PROJECT_INVALID: projectId is required"
    );
    anyhow::ensure!(
        !application_id.is_empty(),
        "NEX_CONTRIBUTION_APPLICATION_INVALID: applicationId is required"
    );
    anyhow::ensure!(
        !target_object_identity.is_empty(),
        "NEX_CONTRIBUTION_TARGET_INVALID: targetObjectIdentity is required"
    );
    anyhow::ensure!(
        !field_path.is_empty(),
        "NEX_CONTRIBUTION_FIELD_INVALID: fieldPath is required"
    );
    anyhow::ensure!(
        !created_at.is_empty(),
        "NEX_CONTRIBUTION_CREATED_AT_INVALID: createdAt is required"
    );

    let id = Uuid::new_v4().to_string();
    conn.query_row(
        "INSERT INTO narrative_application_contributions
            (id, project_id, application_id, target_object_identity, field_path,
             target_state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(project_id, application_id, target_object_identity, field_path)
         DO UPDATE SET target_state = excluded.target_state,
             created_at = excluded.created_at
         RETURNING id",
        params![
            id,
            project_id,
            application_id,
            target_object_identity,
            field_path,
            target_state.as_str(),
            created_at,
        ],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

/// All Applications that contributed to a target object, across every field
/// they touched. Answers "which Proposals wrote which fields on this scene
/// (or other target)?".
pub(crate) fn list_contributions_for_target(
    conn: &Connection,
    project_id: &str,
    target_object_identity: &str,
) -> anyhow::Result<Vec<ApplicationContribution>> {
    let mut statement = conn.prepare(
        "SELECT id, project_id, application_id, target_object_identity, field_path,
                target_state, created_at
           FROM narrative_application_contributions
          WHERE project_id = ?1 AND target_object_identity = ?2
          ORDER BY field_path ASC, application_id ASC",
    )?;
    let rows = statement
        .query_map(
            params![project_id, target_object_identity],
            map_contribution_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(contribution_from_row).collect()
}

/// All fields a single Application contributed to, across every target
/// object it touched. Answers "what changes if this Application is undone?".
pub(crate) fn list_contributions_for_application(
    conn: &Connection,
    project_id: &str,
    application_id: &str,
) -> anyhow::Result<Vec<ApplicationContribution>> {
    let mut statement = conn.prepare(
        "SELECT id, project_id, application_id, target_object_identity, field_path,
                target_state, created_at
           FROM narrative_application_contributions
          WHERE project_id = ?1 AND application_id = ?2
          ORDER BY target_object_identity ASC, field_path ASC",
    )?;
    let rows = statement
        .query_map(params![project_id, application_id], map_contribution_row)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(contribution_from_row).collect()
}

type ContributionRow = (String, String, String, String, String, String, String);

fn map_contribution_row(row: &Row<'_>) -> rusqlite::Result<ContributionRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
    ))
}

fn contribution_from_row(row: ContributionRow) -> anyhow::Result<ApplicationContribution> {
    let (
        id,
        project_id,
        application_id,
        target_object_identity,
        field_path,
        target_state,
        created_at,
    ) = row;
    Ok(ApplicationContribution {
        id,
        project_id,
        application_id,
        target_object_identity,
        field_path,
        target_state: ContributionTargetState::try_from(target_state.as_str())?,
        created_at,
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::Database;

    fn seed_project(conn: &Connection, project_id: &str) {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, ?2)",
            params![project_id, "Test Project"],
        )
        .expect("seed project");
    }

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db
    }

    #[test]
    fn record_contribution_is_visible_from_both_directions() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            let id = record_contribution_in_tx(
                conn,
                "p1",
                "app-1",
                "scene:s1",
                "body",
                ContributionTargetState::Modified,
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record contribution");
            assert!(!id.is_empty());

            let for_target =
                list_contributions_for_target(conn, "p1", "scene:s1").expect("list for target");
            assert_eq!(for_target.len(), 1);
            assert_eq!(for_target[0].id, id);
            assert_eq!(for_target[0].application_id, "app-1");
            assert_eq!(
                for_target[0].target_state,
                ContributionTargetState::Modified
            );

            let for_application = list_contributions_for_application(conn, "p1", "app-1")
                .expect("list for application");
            assert_eq!(for_application.len(), 1);
            assert_eq!(for_application[0].id, id);
            assert_eq!(for_application[0].target_object_identity, "scene:s1");
            assert_eq!(for_application[0].field_path, "body");

            Ok(())
        })
        .expect("test body");
    }

    #[test]
    fn record_contribution_upsert_updates_target_state_in_place() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            let first_id = record_contribution_in_tx(
                conn,
                "p1",
                "app-1",
                "scene:s1",
                "body",
                ContributionTargetState::Modified,
                "2026-08-15T00:00:00.000Z",
            )
            .expect("first record");

            let second_id = record_contribution_in_tx(
                conn,
                "p1",
                "app-1",
                "scene:s1",
                "body",
                ContributionTargetState::Undone,
                "2026-08-15T01:00:00.000Z",
            )
            .expect("upsert record");
            assert_eq!(first_id, second_id, "upsert must keep the same row id");

            let rows =
                list_contributions_for_target(conn, "p1", "scene:s1").expect("list for target");
            assert_eq!(rows.len(), 1, "upsert must not create a duplicate row");
            assert_eq!(rows[0].target_state, ContributionTargetState::Undone);
            assert_eq!(rows[0].created_at, "2026-08-15T01:00:00.000Z");

            Ok(())
        })
        .expect("test body");
    }

    #[test]
    fn distinct_field_paths_on_same_target_and_application_do_not_collide() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            record_contribution_in_tx(
                conn,
                "p1",
                "app-1",
                "scene:s1",
                "body",
                ContributionTargetState::Modified,
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record body field");
            record_contribution_in_tx(
                conn,
                "p1",
                "app-1",
                "scene:s1",
                "title",
                ContributionTargetState::Unchanged,
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record title field");

            let rows =
                list_contributions_for_target(conn, "p1", "scene:s1").expect("list for target");
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0].field_path, "body");
            assert_eq!(rows[1].field_path, "title");

            Ok(())
        })
        .expect("test body");
    }

    #[test]
    fn list_functions_scope_strictly_to_project() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_project(conn, "p2");
            record_contribution_in_tx(
                conn,
                "p1",
                "app-1",
                "scene:s1",
                "body",
                ContributionTargetState::Modified,
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record in p1");

            assert!(list_contributions_for_target(conn, "p2", "scene:s1")
                .expect("list for target")
                .is_empty());
            assert!(list_contributions_for_application(conn, "p2", "app-1")
                .expect("list for application")
                .is_empty());

            Ok(())
        })
        .expect("test body");
    }

    #[test]
    fn unknown_target_state_string_fails_closed() {
        assert!(ContributionTargetState::try_from("archived").is_err());
        assert!(ContributionTargetState::try_from("").is_err());
        assert_eq!(
            ContributionTargetState::try_from("not-applicable").expect("known state"),
            ContributionTargetState::NotApplicable
        );
    }

    #[test]
    fn as_str_round_trips_through_try_from() {
        let states = [
            ContributionTargetState::Unchanged,
            ContributionTargetState::Modified,
            ContributionTargetState::Missing,
            ContributionTargetState::Superseded,
            ContributionTargetState::Undone,
            ContributionTargetState::NotApplicable,
        ];
        for state in states {
            assert_eq!(
                ContributionTargetState::try_from(state.as_str()).expect("round trip"),
                state
            );
        }
    }
}
