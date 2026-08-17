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
/// The scene and event metadata patches and the story-order materialize were
/// checked for the same hazard and match: they all record the scene/event id
/// they annotate (`temporal_operations.rs`), as does the semantic binding
/// upsert with its `binding_id` (`semantic_bindings.rs`).
///
/// `temporal.constraint.create` does **not** match, and is not fixed here.
/// `affected_fields` reports `authority_entity_id()`, a Field Authority
/// coordinate that falls back to the payload fingerprint, while
/// `apply_constraint_create_in_tx` mints a fresh UUID for the row -- so the
/// Apply path addresses an object that does not exist. Addressing
/// Contributions by the Application row's `applied_entity_id` is the fix; see
/// `the_two_writers_disagree_on_the_constraint_id_itself`.
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
///
/// **No production caller.** The Apply path used to address Contributions
/// through this function, but `affected_fields`'s entity id is a Field
/// Authority coordinate, not an object id -- `temporal.constraint.create`
/// reports `authority_entity_id()`, which falls back to a fingerprint while
/// the inserted row gets a fresh UUID. Apply now reads
/// `applied_entity_kind`/`applied_entity_id` off the Application row and goes
/// through [`contribution_target_identity_for_application`], the same path the
/// Legacy Backfill takes, so the two writers agree by construction. This is
/// kept because it is the only written-down statement of how the Field
/// Authority vocabulary corresponds to Object Addressing, and its test pins
/// that correspondence across every kind `affected_fields` can report.
#[allow(dead_code)]
pub(crate) fn contribution_target_identity_for_authority_kind(
    authority_kind: &str,
    entity_id: &str,
) -> anyhow::Result<String> {
    contribution_target_identity(writer_kind_for_authority_kind(authority_kind)?, entity_id)
}

/// The writer-row spelling of a Field Authority kind, so the identity is
/// derived from one table rather than restated per call site.
fn writer_kind_for_authority_kind(authority_kind: &str) -> anyhow::Result<&'static str> {
    Ok(match authority_kind {
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
    })
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
///
/// `baseline_sequence` is the canonical `change_events.sequence` this
/// Application's own write landed on -- the self-stale guard's lower bound
/// (ADR 005). Without it, a later evaluation reads the Apply's own Change
/// Feed event as evidence that the Source moved underneath the Application
/// and marks it stale the instant it was applied. `None` for a Legacy
/// Backfill row: a pre-Gate-C0 commit has no Feed transaction, so no single
/// event corresponds to it, and "no lower bound" is the conservative reading
/// -- every event counts as newer.
pub(crate) struct ContributionProvenance<'a> {
    pub application_id: &'a str,
    pub commit_id: &'a str,
    pub proposal_id: &'a str,
    pub revision_id: &'a str,
    pub operation_id: Option<&'a str>,
    pub baseline_sequence: Option<i64>,
}

/// The field this Contribution is about, and what the Application left in
/// it.
///
/// Separate from [`ContributionProvenance`] because the two have different
/// lifetimes at the call site: provenance is fixed per Application, while
/// this varies per field the Application touched.
pub(crate) struct ContributionField<'a> {
    pub target_object_identity: &'a str,
    pub field_path: &'a str,
    pub target_state: ContributionTargetState,
}

pub(crate) fn record_contribution_in_tx(
    conn: &Connection,
    project_id: &str,
    provenance: &ContributionProvenance<'_>,
    field: &ContributionField<'_>,
    created_at: &str,
) -> anyhow::Result<String> {
    let ContributionField {
        target_object_identity,
        field_path,
        target_state,
    } = *field;
    let ContributionProvenance {
        application_id,
        commit_id,
        proposal_id,
        revision_id,
        operation_id,
        baseline_sequence,
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
        baseline_sequence.is_none_or(|sequence| sequence > 0),
        "NEX_CONTRIBUTION_PROVENANCE_INVALID: baselineSequence must be absent or positive"
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
             operation_id, baseline_sequence, target_object_identity, field_path,
             target_state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(project_id, application_id, target_object_identity, field_path)
         DO UPDATE SET target_state = excluded.target_state,
             commit_id = excluded.commit_id,
             proposal_id = excluded.proposal_id,
             revision_id = excluded.revision_id,
             operation_id = excluded.operation_id,
             baseline_sequence = excluded.baseline_sequence,
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
            baseline_sequence,
            target_object_identity,
            field_path,
            target_state.as_str(),
            created_at,
        ],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

/// The stored `target_state` projected onto the state a reader must act on.
///
/// `undone` is deliberately **not** stored. It describes the Application's
/// lifecycle, and that already lives -- durably, transactionally, and in one
/// place -- in `narrative_apply_commits.status`. Writing it into
/// `target_state` as well would put one fact in two columns, and the pair can
/// only stay honest until the first path updates one without the other. The
/// stored column keeps the other axis: how the *field* compares to what the
/// Application wrote.
///
/// Deriving it also makes Undo and Redo genuinely inverse for free. Undo
/// cannot lose a prior `missing` or `modified` by overwriting it, and Redo
/// cannot fabricate `unchanged` over a field it is in no position to compare.
/// Neither statement exists to get wrong.
///
/// `superseded` is derived for the same reason. Whether a later Application
/// has since written the same field of the same object is a fact about this
/// table's own contents, so storing it would mean an UPDATE across earlier
/// rows on every write -- and then a second one to walk it back whenever the
/// superseding commit is undone. That is the same pair of statements Undo and
/// Redo were, with the same way to get out of step.
///
/// Precedence, strongest first:
///
/// * `not-applicable` -- an operation that wrote nothing has nothing to undo
///   and nothing to be superseded out of, so neither lifecycle applies;
/// * `undone` -- while the owning commit is undone, what a later Application
///   did to the field is not this row's story;
/// * `superseded` -- a live, later Application owns the field now;
/// * whatever is stored.
///
/// **What counts as "later"**, in order, because no single column answers it:
///
/// * `baseline_sequence` -- the canonical event this Application's write
///   landed on. NULL on Legacy Backfill rows, which predate the Feed
///   entirely, so `COALESCE(..., -1)` sorts them before every real sequence.
///   That is the correct reading: a backfilled row describes a write that
///   already happened, and any Feed-era Application supersedes it.
/// * `operation_index` -- `baseline_sequence` is the *commit's* sequence,
///   shared by every Application in it, so two Applications in one commit
///   writing the same field tie on it. The operation order inside the commit
///   is what actually decided the value, and that is what this recovers.
/// * `created_at`, then `id` -- so the order is total. Without a final
///   tie-break two rows could each see the other as later and both report
///   `superseded`, leaving the field owned by nobody.
///
/// An `undone` Application supersedes nothing: its write was rolled back, so
/// the field reverts to whoever held it before. A `not-applicable` one
/// supersedes nothing either, because it never wrote.
///
/// `LEFT JOIN`, not `JOIN`: a missing commit row must not silently drop the
/// Contribution from the answer. `commit_id` is NOT NULL and SCHEMA 29's
/// rebuild fails closed on orphans, so this should be unreachable -- but a
/// reader losing rows is a worse failure than one reporting a stored state.
const EFFECTIVE_TARGET_STATE_SQL: &str = "CASE
        WHEN contribution.target_state = 'not-applicable' THEN 'not-applicable'
        WHEN apply_commit.status = 'undone' THEN 'undone'
        WHEN EXISTS (SELECT 1 FROM narrative_application_contributions later
                     LEFT JOIN narrative_apply_commits later_commit
                            ON later_commit.id = later.commit_id
                     LEFT JOIN narrative_apply_operations later_operation
                            ON later_operation.id = later.operation_id
                     LEFT JOIN narrative_apply_operations self_operation
                            ON self_operation.id = contribution.operation_id
                     WHERE later.project_id = contribution.project_id
                       AND later.target_object_identity
                           = contribution.target_object_identity
                       AND later.field_path = contribution.field_path
                       AND later.id <> contribution.id
                       AND COALESCE(later_commit.status, '') <> 'undone'
                       AND later.target_state <> 'not-applicable'
                       AND (COALESCE(later.baseline_sequence, -1)
                              > COALESCE(contribution.baseline_sequence, -1)
                        OR (COALESCE(later.baseline_sequence, -1)
                              = COALESCE(contribution.baseline_sequence, -1)
                            AND (COALESCE(later_operation.operation_index, -1)
                                   > COALESCE(self_operation.operation_index, -1)
                             OR (COALESCE(later_operation.operation_index, -1)
                                   = COALESCE(self_operation.operation_index, -1)
                                 AND (later.created_at > contribution.created_at
                                  OR (later.created_at = contribution.created_at
                                      AND later.id > contribution.id))))))
        ) THEN 'superseded'
        ELSE contribution.target_state
    END";

/// All Applications that contributed to a target object, across every field
/// they touched. Answers "which Proposals wrote which fields on this scene
/// (or other target)?".
#[allow(dead_code)]
pub(crate) fn list_contributions_for_target(
    conn: &Connection,
    project_id: &str,
    target_object_identity: &str,
) -> anyhow::Result<Vec<ApplicationContribution>> {
    let mut statement = conn.prepare(&format!(
        "SELECT contribution.id, contribution.project_id, contribution.application_id,
                contribution.target_object_identity, contribution.field_path,
                {EFFECTIVE_TARGET_STATE_SQL}, contribution.created_at
           FROM narrative_application_contributions contribution
           LEFT JOIN narrative_apply_commits apply_commit
             ON apply_commit.id = contribution.commit_id
          WHERE contribution.project_id = ?1
            AND contribution.target_object_identity = ?2
          ORDER BY contribution.field_path ASC, contribution.application_id ASC"
    ))?;
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
    let mut statement = conn.prepare(&format!(
        "SELECT contribution.id, contribution.project_id, contribution.application_id,
                contribution.target_object_identity, contribution.field_path,
                {EFFECTIVE_TARGET_STATE_SQL}, contribution.created_at
           FROM narrative_application_contributions contribution
           LEFT JOIN narrative_apply_commits apply_commit
             ON apply_commit.id = contribution.commit_id
          WHERE contribution.project_id = ?1 AND contribution.application_id = ?2
          ORDER BY contribution.target_object_identity ASC, contribution.field_path ASC"
    ))?;
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
            baseline_sequence: None,
        }
    }

    /// `baseline_sequence` is the self-stale guard's lower bound, so a
    /// nonsensical one has to be refused rather than stored: SQLite's CHECK
    /// would catch it, but the writer should say which contract was broken.
    #[test]
    fn a_non_positive_baseline_sequence_is_rejected() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            let mut provenance = test_provenance("app-1");
            provenance.baseline_sequence = Some(0);
            let error = record_contribution_in_tx(
                conn,
                "p1",
                &provenance,
                &ContributionField {
                    target_object_identity: "scene:s1",
                    field_path: "/title",
                    target_state: ContributionTargetState::Unchanged,
                },
                "2026-08-15T00:00:00.000Z",
            )
            .expect_err("a zero baseline sequence must not be stored");
            assert!(
                error
                    .to_string()
                    .contains("NEX_CONTRIBUTION_PROVENANCE_INVALID"),
                "unexpected error: {error}"
            );
            Ok(())
        })
        .expect("reject a non-positive baseline sequence");
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
        // `temporal-constraint` is deliberately absent: see
        // `the_two_writers_disagree_on_the_constraint_id_itself`.
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
    ///
    /// **Scope: spelling only.** Both sides are handed the same id on
    /// purpose, so this proves the two vocabularies normalize to one *kind*.
    /// It says nothing about whether the two writers arrive at the same *id*
    /// for a given operation -- that is a property of the callers, and
    /// `temporal.constraint.create` does not have it. Reading this as
    /// "the two writers agree on one identity" is what let that gap survive a
    /// review; the id side is pinned separately, below.
    #[test]
    fn both_writer_vocabularies_normalize_to_one_kind_spelling() {
        for (authority_kind, writer_kind) in AUTHORITY_AND_WRITER_KINDS {
            let from_apply = contribution_target_identity_for_authority_kind(authority_kind, "x1")
                .unwrap_or_else(|error| panic!("{authority_kind} must map: {error}"));
            let from_backfill = contribution_target_identity(writer_kind, "x1")
                .unwrap_or_else(|error| panic!("{writer_kind} must map: {error}"));
            assert_eq!(
                from_apply, from_backfill,
                "the two vocabularies spell {authority_kind}/{writer_kind} differently"
            );
        }
    }

    /// `temporal.constraint.create` is the kind the spelling test above
    /// cannot cover, and this pins why so the gap cannot be quietly closed by
    /// renaming something.
    ///
    /// `affected_fields` reports `authority_entity_id()`
    /// (`temporal_constraints.rs`), which falls back to the payload
    /// fingerprint -- then a referenced node id, then the literal
    /// `"constraint"` -- when no `constraintId` is supplied.
    /// `apply_constraint_create_in_tx` mints a fresh UUID in exactly that
    /// case. The two ids therefore *cannot* coincide, so translating the kind
    /// leaves the Apply path addressing an object that does not exist.
    ///
    /// The runtime fix belongs with the Apply path (address Contributions by
    /// the Application row's `applied_entity_id`), not with this mapping.
    /// Until that lands, this test is the standing record that the C2-T2
    /// precondition is unmet for this kind.
    #[test]
    fn the_two_writers_disagree_on_the_constraint_id_itself() {
        let from_ledger_coordinate =
            contribution_target_identity_for_authority_kind("temporal-constraint", "fingerprint-1")
                .expect("temporal-constraint maps");
        let from_applied_row = contribution_target_identity("temporal_constraint", "uuid-1")
            .expect("temporal_constraint maps");

        assert_eq!(from_ledger_coordinate, "temporal-constraint:fingerprint-1");
        assert_eq!(from_applied_row, "temporal-constraint:uuid-1");
        assert_ne!(
            from_ledger_coordinate, from_applied_row,
            "if these ever match, the id-level gap has been closed and \
             temporal-constraint can rejoin AUTHORITY_AND_WRITER_KINDS"
        );
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

    /// The Application lifecycle side of the pair. `test_provenance` names
    /// `commit-1`, so seeding that id is what makes the derivation observable.
    fn seed_commit(conn: &Connection, project_id: &str, status: &str) {
        seed_named_commit(conn, project_id, "commit-1", status);
    }

    fn seed_named_commit(conn: &Connection, project_id: &str, commit_id: &str, status: &str) {
        conn.execute(
            "INSERT INTO narrative_apply_commits
                (id, project_id, request_id, plan_digest, status, created_at)
             VALUES (?1, ?2, ?3, 'digest-1', ?4, '2026-08-15T00:00:00.000Z')
             ON CONFLICT(id) DO UPDATE SET status = excluded.status",
            params![commit_id, project_id, format!("req-{commit_id}"), status],
        )
        .expect("seed apply commit");
    }

    /// One Contribution on the shared `scene:s1` / `body` field, so a whole
    /// supersede chain can be described by its ordering keys alone.
    #[allow(clippy::too_many_arguments)]
    fn record_ordered(
        conn: &Connection,
        project_id: &str,
        commit_id: &str,
        application_id: &str,
        baseline_sequence: Option<i64>,
        operation: Option<(&str, i64)>,
        state: ContributionTargetState,
    ) {
        if let Some((operation_id, operation_index)) = operation {
            conn.execute(
                "INSERT INTO narrative_apply_operations
                    (id, commit_id, operation_index, operation_kind, status, created_at)
                 VALUES (?1, ?2, ?3, 'codex.entry.patch', 'applied',
                         '2026-08-15T00:00:00.000Z')
                 ON CONFLICT(id) DO NOTHING",
                params![operation_id, commit_id, operation_index],
            )
            .expect("seed apply operation");
        }
        record_contribution_in_tx(
            conn,
            project_id,
            &ContributionProvenance {
                application_id,
                commit_id,
                proposal_id: "proposal-1",
                revision_id: "revision-1",
                operation_id: operation.map(|(id, _)| id),
                baseline_sequence,
            },
            &ContributionField {
                target_object_identity: "scene:s1",
                field_path: "body",
                target_state: state,
            },
            "2026-08-15T00:00:00.000Z",
        )
        .expect("record contribution");
    }

    /// Effective state per Application, for the shared target/field.
    fn states_by_application(
        conn: &Connection,
        project_id: &str,
    ) -> Vec<(String, ContributionTargetState)> {
        list_contributions_for_target(conn, project_id, "scene:s1")
            .expect("list contributions for target")
            .into_iter()
            .map(|row| (row.application_id, row.target_state))
            .collect()
    }

    fn only_state(conn: &Connection, project_id: &str) -> ContributionTargetState {
        let rows = list_contributions_for_target(conn, project_id, "scene:s1")
            .expect("list contributions for target");
        assert_eq!(rows.len(), 1, "fixture should hold exactly one row");
        let by_application = list_contributions_for_application(conn, project_id, "app-1")
            .expect("list contributions for application");
        assert_eq!(
            by_application[0].target_state, rows[0].target_state,
            "both readers must agree on the effective state"
        );
        rows[0].target_state
    }

    fn record_state(conn: &Connection, project_id: &str, state: ContributionTargetState) {
        record_contribution_in_tx(
            conn,
            project_id,
            &test_provenance("app-1"),
            &ContributionField {
                target_object_identity: "scene:s1",
                field_path: "body",
                target_state: state,
            },
            "2026-08-15T00:00:00.000Z",
        )
        .expect("record contribution");
    }

    /// `undone` is derived from the owning commit's status, never stored, so
    /// undoing and redoing is lossless by construction: the stored state is
    /// untouched throughout and simply re-emerges.
    ///
    /// This is the whole reason the Undo/Redo route writes nothing. Storing
    /// `undone` would overwrite whatever the field state was, and Redo could
    /// then only guess -- and `unchanged` is precisely the guess it must not
    /// make on a row whose digest is NULL.
    #[test]
    fn undoing_and_redoing_a_commit_does_not_lose_the_field_state() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            // `missing` is the state legacy_backfill writes for a target it
            // could not resolve, precisely because `unchanged` would be a
            // known falsehood there. It is the one that must survive.
            record_state(conn, "p1", ContributionTargetState::Missing);
            assert_eq!(only_state(conn, "p1"), ContributionTargetState::Missing);

            seed_commit(conn, "p1", "undone");
            assert_eq!(
                only_state(conn, "p1"),
                ContributionTargetState::Undone,
                "an undone commit's Contributions read as undone"
            );

            seed_commit(conn, "p1", "redone");
            assert_eq!(
                only_state(conn, "p1"),
                ContributionTargetState::Missing,
                "redo must restore the stored state, not fabricate `unchanged`"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// The plain case: a later Application takes the field, and only the
    /// latest one is still current.
    #[test]
    fn a_later_application_supersedes_the_earlier_one_on_the_same_field() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            for (commit, application, sequence) in [
                ("c1", "app-1", 10),
                ("c2", "app-2", 20),
                ("c3", "app-3", 30),
            ] {
                seed_named_commit(conn, "p1", commit, "applied");
                record_ordered(
                    conn,
                    "p1",
                    commit,
                    application,
                    Some(sequence),
                    None,
                    ContributionTargetState::Unchanged,
                );
            }

            assert_eq!(
                states_by_application(conn, "p1"),
                vec![
                    ("app-1".into(), ContributionTargetState::Superseded),
                    ("app-2".into(), ContributionTargetState::Superseded),
                    ("app-3".into(), ContributionTargetState::Unchanged),
                ]
            );
            Ok(())
        })
        .expect("test body");
    }

    /// Undoing the superseding commit hands the field back. A stored
    /// `superseded` would have needed a second write to walk this back, which
    /// is the whole reason it is derived.
    #[test]
    fn undoing_the_later_application_returns_the_field_to_the_earlier_one() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_named_commit(conn, "p1", "c1", "applied");
            record_ordered(
                conn,
                "p1",
                "c1",
                "app-1",
                Some(10),
                None,
                ContributionTargetState::Unchanged,
            );
            seed_named_commit(conn, "p1", "c2", "applied");
            record_ordered(
                conn,
                "p1",
                "c2",
                "app-2",
                Some(20),
                None,
                ContributionTargetState::Unchanged,
            );
            assert_eq!(
                states_by_application(conn, "p1")[0].1,
                ContributionTargetState::Superseded
            );

            seed_named_commit(conn, "p1", "c2", "undone");

            assert_eq!(
                states_by_application(conn, "p1"),
                vec![
                    ("app-1".into(), ContributionTargetState::Unchanged),
                    ("app-2".into(), ContributionTargetState::Undone),
                ],
                "an undone Application supersedes nothing"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// `baseline_sequence` is the commit's, shared by every Application in it,
    /// so two Applications in one commit tie on it. The operation order inside
    /// the commit is what actually decided the field's value.
    #[test]
    fn two_applications_in_one_commit_are_ordered_by_operation_index() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_named_commit(conn, "p1", "c1", "applied");
            record_ordered(
                conn,
                "p1",
                "c1",
                "app-1",
                Some(10),
                Some(("op-1", 0)),
                ContributionTargetState::Unchanged,
            );
            record_ordered(
                conn,
                "p1",
                "c1",
                "app-2",
                Some(10),
                Some(("op-2", 1)),
                ContributionTargetState::Unchanged,
            );

            assert_eq!(
                states_by_application(conn, "p1"),
                vec![
                    ("app-1".into(), ContributionTargetState::Superseded),
                    ("app-2".into(), ContributionTargetState::Unchanged),
                ],
                "the later operation in the same commit owns the field"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// A Legacy Backfill row has no `baseline_sequence` because it predates
    /// the Feed. It describes a write that already happened, so any Feed-era
    /// Application supersedes it -- and it supersedes none of them.
    #[test]
    fn a_backfilled_row_without_a_sequence_sorts_before_every_real_one() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_named_commit(conn, "p1", "c0", "applied");
            record_ordered(
                conn,
                "p1",
                "c0",
                "app-legacy",
                None,
                None,
                ContributionTargetState::Unchanged,
            );
            seed_named_commit(conn, "p1", "c1", "applied");
            record_ordered(
                conn,
                "p1",
                "c1",
                "app-1",
                Some(10),
                None,
                ContributionTargetState::Unchanged,
            );

            assert_eq!(
                states_by_application(conn, "p1"),
                vec![
                    ("app-1".into(), ContributionTargetState::Unchanged),
                    ("app-legacy".into(), ContributionTargetState::Superseded),
                ]
            );
            Ok(())
        })
        .expect("test body");
    }

    /// An operation that wrote nothing cannot take a field away from the
    /// Application that did write it.
    #[test]
    fn a_not_applicable_application_supersedes_nothing() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_named_commit(conn, "p1", "c1", "applied");
            record_ordered(
                conn,
                "p1",
                "c1",
                "app-1",
                Some(10),
                None,
                ContributionTargetState::Unchanged,
            );
            seed_named_commit(conn, "p1", "c2", "applied");
            record_ordered(
                conn,
                "p1",
                "c2",
                "app-2",
                Some(20),
                None,
                ContributionTargetState::NotApplicable,
            );

            assert_eq!(
                states_by_application(conn, "p1"),
                vec![
                    ("app-1".into(), ContributionTargetState::Unchanged),
                    ("app-2".into(), ContributionTargetState::NotApplicable),
                ]
            );
            Ok(())
        })
        .expect("test body");
    }

    /// Every row of the chain must agree on who is current. Without the final
    /// `id` tie-break two rows could each see the other as later and both
    /// report `superseded`, leaving the field owned by nobody.
    #[test]
    fn exactly_one_row_of_a_fully_tied_chain_survives() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_named_commit(conn, "p1", "c1", "applied");
            for application in ["app-a", "app-b", "app-c"] {
                record_ordered(
                    conn,
                    "p1",
                    "c1",
                    application,
                    Some(10),
                    None,
                    ContributionTargetState::Unchanged,
                );
            }

            let states = states_by_application(conn, "p1");
            let current = states
                .iter()
                .filter(|(_, state)| *state != ContributionTargetState::Superseded)
                .count();
            assert_eq!(
                current, 1,
                "a totally tied chain must still name one owner, got {states:?}"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// An operation that wrote nothing has nothing to roll back, so calling it
    /// `undone` would claim a rollback that never happened.
    #[test]
    fn a_not_applicable_contribution_outranks_the_commit_lifecycle() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "undone");
            record_state(conn, "p1", ContributionTargetState::NotApplicable);

            assert_eq!(
                only_state(conn, "p1"),
                ContributionTargetState::NotApplicable
            );
            Ok(())
        })
        .expect("test body");
    }

    /// The stored column must never carry the lifecycle axis. If some future
    /// path writes `undone` into it, that is the two-places-one-fact bug this
    /// design exists to prevent, and it should be caught here rather than by a
    /// reader disagreeing with the commit table.
    #[test]
    fn an_applied_commit_reports_the_stored_state_verbatim() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            for state in [
                ContributionTargetState::Unchanged,
                ContributionTargetState::Modified,
                ContributionTargetState::Missing,
                ContributionTargetState::Superseded,
            ] {
                record_state(conn, "p1", state);
                assert_eq!(only_state(conn, "p1"), state);
            }
            Ok(())
        })
        .expect("test body");
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
                &ContributionField {
                    target_object_identity: "scene:s1",
                    field_path: "body",
                    target_state: ContributionTargetState::Modified,
                },
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
                &ContributionField {
                    target_object_identity: "scene:s1",
                    field_path: "body",
                    target_state: ContributionTargetState::Modified,
                },
                "2026-08-15T00:00:00.000Z",
            )
            .expect("first record");

            let second_id = record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
                &ContributionField {
                    target_object_identity: "scene:s1",
                    field_path: "body",
                    target_state: ContributionTargetState::Undone,
                },
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
                &ContributionField {
                    target_object_identity: "scene:s1",
                    field_path: "body",
                    target_state: ContributionTargetState::Modified,
                },
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record body field");
            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
                &ContributionField {
                    target_object_identity: "scene:s1",
                    field_path: "title",
                    target_state: ContributionTargetState::Unchanged,
                },
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
                &ContributionField {
                    target_object_identity: "scene:s1",
                    field_path: "body",
                    target_state: ContributionTargetState::Modified,
                },
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
