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
//!     without re-deriving it from the Prepared Commit plan JSON every time.
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

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use uuid::Uuid;

use super::change_feed::narrative_object_key;

/// Builds the canonical `kind:id` string a Contribution's
/// `target_object_identity` is keyed by, from the writer-row `entity_kind`
/// vocabulary (`codex_entry`, `temporal_scene_chronicle`, ...).
///
/// Object Addressing is a ratified contract, not a local convention: ADR 005
/// fixes it as a C2 start condition, and
/// `policies/narrative/change-feed-writers.json` declares the
/// `narrative-extraction.apply` writer's own objectKey as
/// `codex-entry|chronicle-event|plot-thread|foreshadow`. So the Applications
/// this table records must be addressed by the same names the Change Feed
/// uses -- notably `chronicle-event`, never `event`.
///
/// [`narrative_object_key`] is the single source of that mapping, so this
/// delegates rather than restating it. That also makes the two writers agree
/// *by construction*: `commit.rs`'s Apply path reaches this through
/// [`contribution_target_identity_for_authority_kind`], and
/// `legacy_backfill.rs` calls it directly, so neither can drift from the
/// Feed's vocabulary without the other following.
///
/// Kinds with no first-class canonical key (today: the codex semantic
/// binding) fall through `narrative_object_key`'s `component` catch-all,
/// whose `componentId` already carries the originating kind. Those keep the
/// full `component:<kind>:<id>` form -- dropping to `component:<id>` would
/// collide across kinds.
pub(crate) fn contribution_target_identity(
    entity_kind: &str,
    entity_id: &str,
) -> anyhow::Result<String> {
    // `narrative_object_key` funnels *every* unrecognized kind into its
    // `component` catch-all, which is right for the Change Feed -- an
    // unmodelled component still needs an addressable key -- but wrong as a
    // durable identity boundary. Without this allowlist, adding an
    // `applied_entity_kind` and forgetting to map it would persist
    // `component:<newKind>:<id>` and pass CI. Only the kinds below may reach
    // the catch-all.
    const CATCH_ALL_KINDS: &[&str] = &["codex_semantic_binding"];
    anyhow::ensure!(
        CATCH_ALL_KINDS.contains(&entity_kind)
            || !matches!(
                narrative_object_key(entity_kind, entity_id)
                    .get("kind")
                    .and_then(Value::as_str),
                Some("component")
            ),
        "NEX_CONTRIBUTION_TARGET_KIND_INVALID: no canonical object kind is mapped for entity kind '{entity_kind}'"
    );
    let object_key = narrative_object_key(entity_kind, entity_id);
    let kind = object_key
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CONTRIBUTION_TARGET_IDENTITY_INVALID: no canonical object kind for '{entity_kind}'"
            )
        })?;
    if kind == "component" {
        let component_id = object_key
            .get("componentId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CONTRIBUTION_TARGET_IDENTITY_INVALID: component object key for '{entity_kind}' has no componentId"
                )
            })?;
        return Ok(format!("{kind}:{component_id}"));
    }
    Ok(format!("{kind}:{entity_id}"))
}

/// Marks a Contribution whose real target could not be determined. Not a
/// canonical object key on purpose: nothing should ever join on it, and it is
/// greppable for the manual review it asks for. Preferred over guessing,
/// which would attribute a field to the wrong object.
pub(crate) const UNRESOLVED_TARGET_PREFIX: &str = "unresolved:";

/// The identity for an Application row's `(applied_entity_kind,
/// applied_entity_id)`, projected onto the object the Contribution is
/// actually *about*.
///
/// For almost every operation the applied entity already is that object, so
/// this is [`contribution_target_identity`] unchanged. `codex.detail.value.
/// set` is the one exception, and it is not a spelling difference but an
/// identity one: `commit.rs` records `applied_entity_kind =
/// codex_detail_value` with the detail-value row's id, while
/// `field_authority.rs`'s `affected_fields` reports the same write as
/// `codex-entry:<entryId>` plus `/details/<definitionId>`. Translating the
/// kind alone would leave the two paths pointing at different objects --
/// `codex-detail-value:<valueId>` versus `codex-entry:<entryId>` -- which no
/// name mapping can reconcile, because the ids differ too.
///
/// Every other kind was checked for the same hazard and matches: the scene
/// and event metadata patches and the story-order materialize all record the
/// scene/event id they annotate (`temporal_operations.rs`), and the semantic
/// binding upsert records the same `binding_id` `affected_fields` uses
/// (`semantic_bindings.rs`).
///
/// A detail-value row that no longer exists cannot be projected. That yields
/// an explicit [`UNRESOLVED_TARGET_PREFIX`] identity rather than a guess.
pub(crate) fn contribution_target_identity_for_application(
    conn: &Connection,
    applied_entity_kind: &str,
    applied_entity_id: &str,
) -> anyhow::Result<String> {
    if applied_entity_kind == "codex_detail_value" {
        let entry_id: Option<String> = conn
            .query_row(
                "SELECT entry_id FROM codex_detail_values WHERE id = ?1",
                params![applied_entity_id],
                |row| row.get(0),
            )
            .optional()?;
        return match entry_id {
            Some(entry_id) => contribution_target_identity("codex_entry", &entry_id),
            None => Ok(format!(
                "{UNRESOLVED_TARGET_PREFIX}codex-detail-value:{applied_entity_id}"
            )),
        };
    }
    contribution_target_identity(applied_entity_kind, applied_entity_id)
}

/// Same identity, from `field_authority.rs`'s `affected_fields` vocabulary.
///
/// That vocabulary is a third, non-ratified one: it is already *projected*
/// (a `codex.detail.value.set` reports `codex-entry` plus
/// `/details/<definitionId>`, not the detail-value row), which is what makes
/// it the right grain for a field-level table -- but its spellings are the
/// Field Authority ledger's, shared with `record_human_field_write`'s human
/// writes, and they are not the Feed's. Renaming them there would drag every
/// human-write call site and every existing `narrative_field_authority` row
/// along for no gain, so the projection is kept and only the *name* is
/// translated, here, at the one boundary that needs it.
///
/// Exhaustive on purpose: an unrecognized kind fails closed rather than
/// silently minting an identity nothing can resolve, matching how
/// `affected_fields` itself rejects operation kinds it does not model.
pub(crate) fn contribution_target_identity_for_authority_kind(
    authority_kind: &str,
    entity_id: &str,
) -> anyhow::Result<String> {
    let entity_kind = match authority_kind {
        "event" => "event",
        "scene" => "scene",
        "codex-entry" => "codex_entry",
        "codex-relation" => "codex_relation",
        "codex-phase" => "codex_phase",
        "codex-detail-semantic-binding" => "codex_semantic_binding",
        "temporal-node" => "temporal_node",
        "temporal-constraint" => "temporal_constraint",
        "temporal-projection" => "temporal_projection",
        "plot-thread" => "plot_thread",
        "plot-marker" => "plot_thread_marker",
        "plot-branch" => "plot_thread_branch",
        "foreshadow" => "foreshadow",
        other => anyhow::bail!(
            "NEX_CONTRIBUTION_TARGET_KIND_INVALID: no canonical object kind is mapped for Field Authority kind '{other}'"
        ),
    };
    contribution_target_identity(entity_kind, entity_id)
}

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

/// No production reader yet -- `record_contribution_in_tx` above is wired
/// (C2-T1); the walk-both-directions read queries below (`list_contributions_for_target`
/// / `list_contributions_for_application`) are Undo/Redo and Freshness
/// infrastructure whose caller has not landed yet.
#[allow(dead_code)]
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
/// Which Application produced a Contribution, and where that Application
/// came from (SCHEMA 29).
///
/// Grouped rather than passed as five more parameters because these five
/// always travel together and are always read together: a Contribution
/// without its Commit/Proposal/Revision cannot be traced back to the write
/// that made it.
///
/// `operation_id` is `None` for a Legacy Backfill row. A pre-Gate-C2
/// Application has no `narrative_apply_operations` row, and that table has no
/// unique key this one could join on retroactively, so `None` means "not
/// identifiable" rather than "none".
pub(crate) struct ContributionProvenance<'a> {
    pub application_id: &'a str,
    pub commit_id: &'a str,
    pub proposal_id: &'a str,
    pub revision_id: &'a str,
    pub operation_id: Option<&'a str>,
}

pub(crate) fn record_contribution_in_tx(
    conn: &Connection,
    project_id: &str,
    provenance: &ContributionProvenance<'_>,
    target_object_identity: &str,
    field_path: &str,
    target_state: ContributionTargetState,
    created_at: &str,
) -> anyhow::Result<String> {
    let ContributionProvenance {
        application_id,
        commit_id,
        proposal_id,
        revision_id,
        operation_id,
    } = *provenance;
    anyhow::ensure!(
        !project_id.is_empty(),
        "NEX_CONTRIBUTION_PROJECT_INVALID: projectId is required"
    );
    anyhow::ensure!(
        !application_id.is_empty(),
        "NEX_CONTRIBUTION_APPLICATION_INVALID: applicationId is required"
    );
    anyhow::ensure!(
        !commit_id.is_empty() && !proposal_id.is_empty() && !revision_id.is_empty(),
        "NEX_CONTRIBUTION_PROVENANCE_INVALID: commitId, proposalId and revisionId are required"
    );
    anyhow::ensure!(
        operation_id.is_none_or(|id| !id.is_empty()),
        "NEX_CONTRIBUTION_PROVENANCE_INVALID: operationId must be absent or non-empty"
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
    // Provenance is set on insert and refreshed on conflict: re-recording the
    // same (project, application, target, field) means the same Application
    // wrote that field again, so the Commit/Proposal/Revision it came from is
    // the newer one. `maintenance_ownership` is deliberately absent from the
    // DO UPDATE -- it is a durable disposition that a re-record must not
    // silently reset, the same reason Attention rows are not touched by
    // Run publish.
    conn.query_row(
        "INSERT INTO narrative_application_contributions
            (id, project_id, application_id, commit_id, proposal_id, revision_id,
             operation_id, target_object_identity, field_path, target_state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(project_id, application_id, target_object_identity, field_path)
         DO UPDATE SET target_state = excluded.target_state,
             commit_id = excluded.commit_id,
             proposal_id = excluded.proposal_id,
             revision_id = excluded.revision_id,
             operation_id = excluded.operation_id,
             created_at = excluded.created_at
         RETURNING id",
        params![
            id,
            project_id,
            application_id,
            commit_id,
            proposal_id,
            revision_id,
            operation_id,
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
#[allow(dead_code)]
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
#[allow(dead_code)]
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

#[allow(dead_code)]
type ContributionRow = (String, String, String, String, String, String, String);

#[allow(dead_code)]
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

#[allow(dead_code)]
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

    /// The provenance every Contribution now carries. These tests are about
    /// the row's own behaviour, not about where the Application came from, so
    /// one fixed Commit/Proposal/Revision keeps them focused.
    fn test_provenance(application_id: &str) -> ContributionProvenance<'_> {
        ContributionProvenance {
            application_id,
            commit_id: "commit-1",
            proposal_id: "proposal-1",
            revision_id: "revision-1",
            operation_id: None,
        }
    }

    /// Every kind `field_authority.rs`'s `affected_fields` can report, paired
    /// with the `applied_entity_kind` the same object is written under by
    /// `commit.rs`'s operation match. The Apply path reaches
    /// `target_object_identity` through the first, the Legacy Backfill path
    /// through the second.
    const AUTHORITY_AND_WRITER_KINDS: &[(&str, &str)] = &[
        ("event", "event"),
        ("scene", "scene"),
        ("codex-entry", "codex_entry"),
        ("codex-relation", "codex_relation"),
        ("codex-phase", "codex_phase"),
        ("codex-detail-semantic-binding", "codex_semantic_binding"),
        ("temporal-node", "temporal_node"),
        ("temporal-constraint", "temporal_constraint"),
        ("temporal-projection", "temporal_projection"),
        ("plot-thread", "plot_thread"),
        ("plot-marker", "plot_thread_marker"),
        ("plot-branch", "plot_thread_branch"),
        ("foreshadow", "foreshadow"),
    ];

    /// The reason this translation exists. Before it, `commit.rs` stored the
    /// Field Authority spelling and `legacy_backfill.rs` the writer-row
    /// spelling, so a live Contribution and a backfilled one describing the
    /// same object were two strings that never joined.
    #[test]
    fn both_writer_paths_agree_on_one_identity_per_object() {
        for (authority_kind, writer_kind) in AUTHORITY_AND_WRITER_KINDS {
            let from_apply = contribution_target_identity_for_authority_kind(authority_kind, "x1")
                .unwrap_or_else(|error| panic!("{authority_kind} must map: {error}"));
            let from_backfill = contribution_target_identity(writer_kind, "x1")
                .unwrap_or_else(|error| panic!("{writer_kind} must map: {error}"));
            assert_eq!(
                from_apply, from_backfill,
                "Apply and Backfill disagree for {authority_kind}/{writer_kind}"
            );
        }
    }

    /// The one kind whose two vocabularies genuinely differ, and the whole
    /// reason a translation is needed rather than a pass-through.
    /// `change-feed-writers.json` declares the `narrative-extraction.apply`
    /// writer's objectKey as `chronicle-event`, never `event`.
    #[test]
    fn chronicle_events_are_addressed_by_their_ratified_kind() {
        assert_eq!(
            contribution_target_identity_for_authority_kind("event", "event-1")
                .expect("event maps"),
            "chronicle-event:event-1"
        );
        assert_eq!(
            contribution_target_identity("temporal_event_chronicle", "event-1")
                .expect("temporal event chronicle maps"),
            "chronicle-event:event-1",
            "the temporal chronicle row collapses onto the event it annotates"
        );
        assert_eq!(
            contribution_target_identity("temporal_scene_chronicle", "scene-1")
                .expect("temporal scene chronicle maps"),
            "scene:scene-1"
        );
    }

    /// A kind with no first-class canonical key keeps the originating kind in
    /// its identity; collapsing to `component:<id>` would make two different
    /// kinds sharing an id indistinguishable.
    #[test]
    fn kinds_without_a_canonical_key_stay_distinguishable() {
        assert_eq!(
            contribution_target_identity_for_authority_kind(
                "codex-detail-semantic-binding",
                "binding-1"
            )
            .expect("semantic binding maps"),
            "component:codex_semantic_binding:binding-1"
        );
    }

    /// Fails closed rather than minting an identity nothing can resolve.
    #[test]
    fn an_unmapped_authority_kind_is_rejected() {
        let error = contribution_target_identity_for_authority_kind("not-a-kind", "x1")
            .expect_err("an unmapped kind must not silently produce an identity");
        assert!(
            error
                .to_string()
                .contains("NEX_CONTRIBUTION_TARGET_KIND_INVALID"),
            "unexpected error: {error}"
        );
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
                &test_provenance("app-1"),
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
                &test_provenance("app-1"),
                "scene:s1",
                "body",
                ContributionTargetState::Modified,
                "2026-08-15T00:00:00.000Z",
            )
            .expect("first record");

            let second_id = record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
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
                &test_provenance("app-1"),
                "scene:s1",
                "body",
                ContributionTargetState::Modified,
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record body field");
            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
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
                &test_provenance("app-1"),
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
