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

use anyhow::Context as _;
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
/// **Not used to file a Contribution.** The Apply path used to address
/// Contributions through this function, but `affected_fields`'s entity id is
/// a Field Authority coordinate, not an object id --
/// `temporal.constraint.create` reports `authority_entity_id()`, which falls
/// back to a fingerprint while the inserted row gets a fresh UUID. Apply now
/// reads `applied_entity_kind`/`applied_entity_id` off the Application row and
/// goes through [`contribution_target_identity_for_application`], the same
/// path the Legacy Backfill takes, so the two writers agree by construction.
///
/// It is still the production route in the other direction: a human write or
/// an explicit lock arrives as a Field Authority coordinate and
/// [`mark_fields_user_owned_in_tx`] has to find the Contributions it bears
/// on. (An earlier version of this comment claimed "no production caller",
/// which that function has been contradicting since it was written.)
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
        // Historic only: the live Apply path has no operation that files a
        // Contribution against a detail *definition*, but SCHEMA 28 rewrites
        // a `codex_detail_definition:` identity prefix, so rows predating
        // this branch can carry one. Mapping it costs nothing and is what
        // lets a human edit of a definition reach them.
        "codex-detail-definition" => "codex_detail_definition",
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
    /// Where this field lives in the Field Authority ledger, when the caller
    /// knows. `maintenance_ownership` is decided from that ledger and from
    /// nothing else, so a caller that cannot name the coordinate gets
    /// `maintained` rather than a guess.
    ///
    /// The Apply path always knows it: `affected_fields` yields exactly this
    /// coordinate, and its `field_path` is the same string stored here. The
    /// Legacy Backfill never does -- a pre-Gate-C2 Application records the
    /// whole-entity sentinel, which is not a Field Authority coordinate at
    /// all -- so its rows stay `maintained` until a human write stamps them.
    pub authority: Option<FieldAuthorityCoordinate<'a>>,
}

/// A field's address in `narrative_field_authority`, which speaks its own
/// `(entity_kind, entity_id)` vocabulary rather than the canonical object
/// identity this table is keyed by.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FieldAuthorityCoordinate<'a> {
    pub entity_kind: &'a str,
    pub entity_id: &'a str,
}

/// Whether the Field Authority ledger says a person holds this field.
///
/// This is the *only* input to a new Contribution's `maintenance_ownership`.
/// Reading a sibling Contribution instead -- which is what this did before --
/// answered a different question: it could only see ownership that some
/// earlier stamp had already copied onto this table, so a field a human wrote
/// before any Contribution existed came out `maintained`, and an explicit
/// lock (which never stamped anything) came out `maintained` forever.
///
/// `explicit_lock` is checked as well as `owner_kind` because the lock path
/// is the stronger statement of the two, and a row can only carry it after
/// `set_human_field_lock_in_tx` has also set `owner_kind = 'human'`; testing
/// both means a future writer that sets one without the other still fails
/// closed towards the user.
fn field_is_user_owned(
    conn: &Connection,
    project_id: &str,
    coordinate: FieldAuthorityCoordinate<'_>,
    field_path: &str,
) -> anyhow::Result<bool> {
    let owned: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM narrative_field_authority
             WHERE project_id = ?1 AND entity_kind = ?2 AND entity_id = ?3
               AND field_path = ?4
               AND (owner_kind = 'human' OR explicit_lock <> 0)
         )",
        params![
            project_id,
            coordinate.entity_kind,
            coordinate.entity_id,
            field_path
        ],
        |row| row.get(0),
    )?;
    Ok(owned)
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
        authority,
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
    //
    // The two `target_state_*` columns are cleared rather than left, because
    // they are the projection's watermark for the state the DO UPDATE just
    // overwrote. Leaving them said "as of event N the field was `modified`"
    // on a row now claiming `unchanged`, and the projection's
    // `COALESCE(target_state_sequence, -1) < ?` guard then refused to
    // re-apply event N -- permanently, and not repairable by rewinding the
    // cursor, since the refusal is in the row rather than in the cursor. A
    // re-record moves `baseline_sequence` forward too, so clearing the
    // watermark is also what lets the new lower bound decide which events
    // still count. Reachable through a Legacy Backfill re-run, which upserts
    // on this same key.
    // Ownership belongs to the *field*, and `narrative_field_authority` is
    // where a person's claim on a field is recorded. Reading it here is what
    // makes this column agree with the ledger the Apply-time gate
    // (`validate_operation_field_authority`) already enforces against, rather
    // than being a second, drifting opinion about the same fact.
    //
    // This replaced reading a sibling Contribution on the same field. The
    // sibling could only report ownership that some earlier write had already
    // copied onto this table, which got three cases wrong: a field a human
    // wrote before any Contribution existed, a field held only by an explicit
    // lock, and -- because the predicate was `<> 'maintained'` with no
    // ordering -- a field whose only sibling carried the Repair Run's
    // `detached` verdict, which is a statement about one Contribution rather
    // than about who owns the field.
    let user_owned = match authority {
        Some(coordinate) => field_is_user_owned(conn, project_id, coordinate, field_path)?,
        None => false,
    };
    let initial_ownership = if user_owned { "user-owned" } else { "maintained" };

    conn.query_row(
        "INSERT INTO narrative_application_contributions
            (id, project_id, application_id, commit_id, proposal_id, revision_id,
             operation_id, baseline_sequence, target_object_identity, field_path,
             target_state, created_at, maintenance_ownership)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(project_id, application_id, target_object_identity, field_path)
         DO UPDATE SET target_state = excluded.target_state,
             commit_id = excluded.commit_id,
             proposal_id = excluded.proposal_id,
             revision_id = excluded.revision_id,
             operation_id = excluded.operation_id,
             baseline_sequence = excluded.baseline_sequence,
             target_state_sequence = NULL,
             target_state_updated_at = NULL,
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
            initial_ownership,
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
/// The `/legacy-application` disjunct is the Legacy Backfill sentinel, which
/// means "the whole entity this Application wrote, granularity unknown"
/// rather than a field literally called that. Compared as an ordinary path it
/// equalled nothing a live Apply ever records, so a backfilled Contribution
/// stayed `unchanged` no matter how thoroughly a later Application rewrote
/// the object. Switching this to the projection's `paths_overlap` would not
/// have fixed it -- the sentinel is not a prefix of `/title` either -- so the
/// marker has to be recognised by name. `the_supersede_sql_and_the_backfill_
/// agree_on_the_sentinel` pins this literal against the constant.
///
/// One direction only. A legacy row is superseded by any later live write to
/// the same object; a later legacy row does not supersede a live field row,
/// because "something wrote this object at unknown granularity" is not
/// evidence that it wrote *that* field.
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
                       AND (later.field_path = contribution.field_path
                        OR contribution.field_path = '/legacy-application')
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

/// Hands the Contributions on a hand-written field over to the user.
///
/// `maintenance_ownership` is the axis this table is named for, and it is the
/// one place a *person* speaks: `maintained` says maintenance may keep
/// proposing and applying to this field, `user-owned` says the author has
/// taken it and maintenance may only propose. (`detached` is the Repair Run's
/// "could not reconstruct this" verdict -- `unrecoverableDisposition` in the
/// Run Kind Policy -- and is not written here.)
///
/// Derived from the Field Authority ledger rather than from the Change Feed,
/// and that is not interchangeable. Step 7's projection deliberately treats
/// every write with no Application lineage as evidence, which *includes*
/// in-app agent and MCP writes carrying `origin = ai-apply`. Deriving
/// ownership there would let an AI edit hand the field to the user. Here the
/// human gate holds by construction: `record_human_field_write` is reached
/// only from the manual writers, and `agent_writes.rs` gates it behind
/// `surface == "manual"`.
///
/// One direction only. ADR 005 permits a later Interpretation to propose
/// against a human-authored field but forbids it to *implicitly reclaim*
/// maintenance ownership, so nothing automatic ever writes `user-owned` back
/// to `maintained`; that takes an explicit act, through the same decision
/// authority that grants an override. This is also why the column stays out
/// of `record_contribution_in_tx`'s `DO UPDATE`: re-recording a field must not
/// quietly reset who owns it.
///
/// Called from inside `record_human_field_write` rather than from each of its
/// call sites -- there are over thirty across the manual writers -- so one
/// added later cannot silently skip it.
/// Field Authority kinds that address something no Contribution can ever be
/// filed against, so having no object mapping is the correct answer rather
/// than a missing one.
///
/// `tree_node` is on the list even though scenes plainly do carry
/// Contributions: the Apply path files those under the `scene` coordinate,
/// and no production writer records Field Authority against `tree_node`.
const KINDS_WITHOUT_CONTRIBUTIONS: &[&str] = &["project", "codex-tag", "codex-type", "tree_node"];

pub(crate) fn mark_fields_user_owned_in_tx(
    conn: &Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    field_paths: &[&str],
) -> anyhow::Result<()> {
    // The Field Authority ledger speaks its own kind vocabulary, and this is
    // the boundary that translates it -- the reason
    // `contribution_target_identity_for_authority_kind` was kept.
    //
    // An unmappable kind used to return `Ok(())` here. That silently answered
    // two very different questions the same way: "this kind can never carry a
    // Contribution, so there is nothing to hand over" and "this kind should
    // have a Contribution and the mapping is missing". The first is a fact
    // about the vocabulary and belongs in a list; the second is a defect, and
    // swallowing it means a human's claim on a field disappears with no trace
    // anywhere. It fails closed now.
    if KINDS_WITHOUT_CONTRIBUTIONS.contains(&entity_kind) {
        return Ok(());
    }
    let target_object_identity =
        contribution_target_identity_for_authority_kind(entity_kind, entity_id).with_context(
            || {
                format!(
                    "cannot hand ownership of a '{entity_kind}' field to the user: \
                     the kind maps to no canonical object and is not on the list of \
                     kinds that carry no Contribution"
                )
            },
        )?;
    for field_path in field_paths {
        conn.execute(
            // `target_state_updated_at` is deliberately untouched: it and
            // `target_state_sequence` describe when the *state* axis last
            // moved, and this moves the ownership axis. Stamping it here
            // would make the pair describe two different things.
            //
            // The sentinel disjunct is the Legacy Backfill's whole-object
            // row. It means "the whole entity this Application wrote,
            // granularity unknown", so a person taking any field of that
            // entity has taken part of what it covers, and maintenance may
            // no longer keep applying to it. Matching only `= ?3` left it
            // `maintained` forever: no live writer ever supplies a field
            // literally called `/legacy-application`, so nothing could reach
            // it. The state axis already treats the sentinel this way in
            // `paths_overlap` and in the supersede subquery; leaving the
            // ownership axis on exact equality made one marker mean two
            // different things depending on which column was being decided.
            "UPDATE narrative_application_contributions
                SET maintenance_ownership = 'user-owned'
              WHERE project_id = ?1
                AND target_object_identity = ?2
                AND (field_path = ?3 OR field_path = ?4)
                AND maintenance_ownership = 'maintained'",
            params![
                project_id,
                target_object_identity,
                field_path,
                super::legacy_backfill::LEGACY_BACKFILL_FIELD_PATH
            ],
        )?;
    }
    Ok(())
}

/// Replays the Field Authority ledger onto Contributions that already exist.
///
/// `mark_fields_user_owned_in_tx` runs forward, at the moment a person takes
/// a field. Two paths need the reverse: the SCHEMA 29 rebuild, which inherits
/// a ledger written long before this column existed, and the Legacy Backfill,
/// which mints Contributions for Applications that predate Gate C2 and may
/// well run on a workspace whose fields the author has already claimed.
/// Without this, ownership depended on which of the two happened last.
///
/// `project_id` scopes it: the Backfill knows its project, the migration
/// sweeps them all.
///
/// Per-row errors are logged rather than propagated. Both callers replay
/// arbitrary historical ledger content in bulk, where one row naming a kind
/// this build no longer maps should not fail an entire workspace open or an
/// entire Backfill -- unlike a single deliberate human write, which fails
/// closed so the person is not told their claim was recorded when it was not.
pub(crate) fn reproject_user_ownership_from_authority_in_tx(
    conn: &Connection,
    project_id: Option<&str>,
) -> anyhow::Result<()> {
    let owned: Vec<(String, String, String, String)> = match project_id {
        Some(project_id) => conn
            .prepare(
                "SELECT project_id, entity_kind, entity_id, field_path
                   FROM narrative_field_authority
                  WHERE project_id = ?1 AND (owner_kind = 'human' OR explicit_lock <> 0)",
            )?
            .query_map(params![project_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<_, _>>()?,
        None => conn
            .prepare(
                "SELECT project_id, entity_kind, entity_id, field_path
                   FROM narrative_field_authority
                  WHERE owner_kind = 'human' OR explicit_lock <> 0",
            )?
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?
            .collect::<Result<_, _>>()?,
    };
    for (project_id, entity_kind, entity_id, field_path) in owned {
        if let Err(error) = mark_fields_user_owned_in_tx(
            conn,
            &project_id,
            &entity_kind,
            &entity_id,
            &[field_path.as_str()],
        ) {
            tracing::warn!(
                target: "narrative.authority",
                %error,
                entity_kind,
                "could not re-project Field Authority ownership onto Contributions"
            );
        }
    }
    Ok(())
}

/// Brings the stored half of `target_state` up to date before reading it.
///
/// `modified` and `missing` come from the Change Feed, and a projection of a
/// log is only as current as its last run. Pumping it here rather than leaving
/// it to a background task is what makes these readers return a consistent
/// answer: same process, same SQLite connection, same transaction as the read
/// that follows.
///
/// The cursor is what keeps that cheap. A pump with nothing new to account for
/// reads one row and stops.
fn pump_out_of_band_edits(conn: &Connection, project_id: &str) -> anyhow::Result<()> {
    // Autocommit means no caller-owned transaction to join, and the projection
    // must not open one behind a reader's back. Reading slightly stale
    // `modified` is recoverable -- the next pump inside a transaction fixes
    // it -- while a nested write here would not be.
    if conn.is_autocommit() {
        return Ok(());
    }
    super::contribution_target_state::project_out_of_band_edits_in_tx(conn, project_id)?;
    Ok(())
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
    pump_out_of_band_edits(conn, project_id)?;
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
    pump_out_of_band_edits(conn, project_id)?;
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
                    authority: None,
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
                authority: None,
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
                authority: None,
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

    fn ownership_of(conn: &Connection, project_id: &str, field_path: &str) -> String {
        conn.query_row(
            "SELECT maintenance_ownership FROM narrative_application_contributions
              WHERE project_id = ?1 AND field_path = ?2",
            params![project_id, field_path],
            |row| row.get(0),
        )
        .expect("read maintenance ownership")
    }

    /// The axis this table is named for. A hand-written field belongs to its
    /// author, and maintenance may only propose against it from then on.
    #[test]
    fn a_hand_written_field_hands_its_contribution_to_the_user() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
                &ContributionField {
                    target_object_identity: "codex-entry:e1",
                    field_path: "/name",
                    target_state: ContributionTargetState::Unchanged,
                    authority: None,
                },
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record contribution");
            assert_eq!(ownership_of(conn, "p1", "/name"), "maintained");

            super::super::field_authority::record_human_field_write(
                conn,
                "p1",
                "codex-entry",
                "e1",
                &["/name"],
                "2026-08-16T00:00:00.000Z",
            )
            .expect("record human field write");

            assert_eq!(ownership_of(conn, "p1", "/name"), "user-owned");
            Ok(())
        })
        .expect("test body");
    }

    /// ADR 005 lets a later Interpretation propose against a human-authored
    /// field but forbids it to reclaim ownership implicitly. Re-recording the
    /// Contribution is exactly that attempt, and it must not land.
    #[test]
    fn re_recording_a_contribution_does_not_reclaim_ownership() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            let field = ContributionField {
                target_object_identity: "codex-entry:e1",
                field_path: "/name",
                target_state: ContributionTargetState::Unchanged,
                authority: None,
            };
            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
                &field,
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record contribution");
            super::super::field_authority::record_human_field_write(
                conn,
                "p1",
                "codex-entry",
                "e1",
                &["/name"],
                "2026-08-16T00:00:00.000Z",
            )
            .expect("record human field write");

            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
                &field,
                "2026-08-17T00:00:00.000Z",
            )
            .expect("re-record contribution");

            assert_eq!(
                ownership_of(conn, "p1", "/name"),
                "user-owned",
                "a later Application must not take the field back"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// `detached` is the Repair Run's verdict that this Contribution's link to
    /// its target could not be reconstructed -- `unrecoverableDisposition` in
    /// the Run Kind Policy. Nobody maintains it, and a hand edit elsewhere does
    /// not make it the user's either. Only `maintained` is a state this
    /// transition may leave, which is what the guard on the UPDATE says.
    #[test]
    fn a_detached_contribution_is_not_handed_to_the_user() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
                &ContributionField {
                    target_object_identity: "codex-entry:e1",
                    field_path: "/name",
                    target_state: ContributionTargetState::Unchanged,
                    authority: None,
                },
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record contribution");
            conn.execute(
                "UPDATE narrative_application_contributions
                    SET maintenance_ownership = 'detached'",
                [],
            )
            .expect("mark detached");

            super::super::field_authority::record_human_field_write(
                conn,
                "p1",
                "codex-entry",
                "e1",
                &["/name"],
                "2026-08-16T00:00:00.000Z",
            )
            .expect("record human field write");

            assert_eq!(
                ownership_of(conn, "p1", "/name"),
                "detached",
                "an unreconstructible link does not become user-owned"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// The reclamation ADR 005 forbids, taken by the one path that could still
    /// do it: not by overwriting an owned row, but by inserting a fresh one
    /// beside it. A later Application writing the same field gets its own
    /// Contribution row, and a column default would hand it back `maintained`.
    #[test]
    fn a_later_application_inherits_the_users_ownership_of_the_field() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            let field = ContributionField {
                target_object_identity: "codex-entry:e1",
                field_path: "/name",
                target_state: ContributionTargetState::Unchanged,
                authority: Some(FieldAuthorityCoordinate {
                    entity_kind: "codex-entry",
                    entity_id: "e1",
                }),
            };
            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
                &field,
                "2026-08-15T00:00:00.000Z",
            )
            .expect("first Application");
            super::super::field_authority::record_human_field_write(
                conn,
                "p1",
                "codex-entry",
                "e1",
                &["/name"],
                "2026-08-16T00:00:00.000Z",
            )
            .expect("human takes the field");

            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-2"),
                &field,
                "2026-08-17T00:00:00.000Z",
            )
            .expect("second Application on the same field");

            let owners: Vec<String> = conn
                .prepare(
                    "SELECT maintenance_ownership FROM narrative_application_contributions
                      WHERE project_id = 'p1' AND field_path = '/name'
                      ORDER BY application_id ASC",
                )
                .expect("prepare")
                .query_map([], |row| row.get(0))
                .expect("query")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect");
            assert_eq!(
                owners,
                vec!["user-owned".to_string(), "user-owned".to_string()],
                "a new row on a user-owned field must not reset ownership"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// The case sibling inheritance could not see, and the reason ownership
    /// is read from the ledger instead. A human writes a field before any
    /// Application has contributed to it, so there is no Contribution row to
    /// copy an answer from -- and the ledger already holds the answer. The
    /// first Contribution recorded afterwards has to arrive `user-owned`.
    ///
    /// This test previously asserted `maintained` here and called it a known
    /// gap. It was not a gap in what could be known; the claim that the two
    /// tables "cannot be joined" was wrong. `affected_fields` hands the Apply
    /// path the exact ledger coordinate.
    #[test]
    fn a_field_the_user_took_before_any_contribution_is_owned_from_the_first_row() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            super::super::field_authority::record_human_field_write(
                conn,
                "p1",
                "codex-entry",
                "e1",
                &["/name"],
                "2026-08-15T00:00:00.000Z",
            )
            .expect("human writes first");

            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
                &ContributionField {
                    target_object_identity: "codex-entry:e1",
                    field_path: "/name",
                    target_state: ContributionTargetState::Unchanged,
                    authority: Some(FieldAuthorityCoordinate {
                        entity_kind: "codex-entry",
                        entity_id: "e1",
                    }),
                },
                "2026-08-16T00:00:00.000Z",
            )
            .expect("first Application afterwards");

            assert_eq!(
                ownership_of(conn, "p1", "/name"),
                "user-owned",
                "the ledger already said the author holds this field, so the \
                 first Contribution on it has to say so too"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// Only the named field changes hands. A human editing the title does not
    /// hand over the summary.
    #[test]
    fn ownership_moves_only_for_the_field_that_was_written() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            for field_path in ["/name", "/summary"] {
                record_contribution_in_tx(
                    conn,
                    "p1",
                    &test_provenance("app-1"),
                    &ContributionField {
                        target_object_identity: "codex-entry:e1",
                        field_path,
                        target_state: ContributionTargetState::Unchanged,
                        authority: None,
                    },
                    "2026-08-15T00:00:00.000Z",
                )
                .expect("record contribution");
            }

            super::super::field_authority::record_human_field_write(
                conn,
                "p1",
                "codex-entry",
                "e1",
                &["/name"],
                "2026-08-16T00:00:00.000Z",
            )
            .expect("record human field write");

            assert_eq!(ownership_of(conn, "p1", "/name"), "user-owned");
            assert_eq!(ownership_of(conn, "p1", "/summary"), "maintained");
            Ok(())
        })
        .expect("test body");
    }

    /// A kind that maps to no canonical object fails closed. Ownership must
    /// never land on a guessed object, and it must not vanish silently
    /// either: a `return Ok(())` here reported success while the person's
    /// claim on the field went nowhere at all.
    ///
    /// `KINDS_WITHOUT_CONTRIBUTIONS` is the other half of this rule, and
    /// `a_kind_that_carries_no_contribution_is_skipped_quietly` covers it --
    /// the two must not be confused, which is exactly what one shared
    /// `Ok(())` did.
    #[test]
    fn an_unmappable_authority_kind_fails_closed_rather_than_guessing() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
                &ContributionField {
                    target_object_identity: "codex-entry:e1",
                    field_path: "/name",
                    target_state: ContributionTargetState::Unchanged,
                    authority: None,
                },
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record contribution");

            let error = super::super::field_authority::record_human_field_write(
                conn,
                "p1",
                "not-a-ratified-kind",
                "x1",
                &["/name"],
                "2026-08-16T00:00:00.000Z",
            )
            .expect_err("an unmappable kind must not report a silent success");
            assert!(
                format!("{error:#}").contains("cannot hand ownership of a"),
                "the error has to name the failure, got: {error:#}"
            );

            assert_eq!(
                ownership_of(conn, "p1", "/name"),
                "maintained",
                "ownership must not land on an object the kind does not address"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// The other half of the rule above: a kind that genuinely cannot carry a
    /// Contribution is not a defect, and a human write against it has to
    /// succeed. `project` is one -- nothing files a Contribution against a
    /// whole project.
    #[test]
    fn a_kind_that_carries_no_contribution_is_skipped_quietly() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            super::super::field_authority::record_human_field_write(
                conn,
                "p1",
                "project",
                "p1",
                &["/title"],
                "2026-08-16T00:00:00.000Z",
            )
            .expect("a kind with no Contribution must not fail the human write");
            Ok(())
        })
        .expect("test body");
    }

    /// The explicit field lock is the strongest claim a person can make about
    /// a field, and until now it reached `narrative_field_authority` and
    /// stopped there -- `mark_fields_user_owned_in_tx` had one caller, the
    /// manual-write path, and this was not it. Nothing covered this at all.
    #[test]
    fn an_explicit_lock_hands_the_contribution_to_the_user() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-1"),
                &ContributionField {
                    target_object_identity: "codex-entry:e1",
                    field_path: "/name",
                    target_state: ContributionTargetState::Unchanged,
                    authority: Some(FieldAuthorityCoordinate {
                        entity_kind: "codex-entry",
                        entity_id: "e1",
                    }),
                },
                "2026-08-15T00:00:00.000Z",
            )
            .expect("record contribution");
            assert_eq!(ownership_of(conn, "p1", "/name"), "maintained");

            super::super::field_authority::set_human_field_lock_in_tx(
                conn,
                &super::super::models::HumanFieldLockPayload {
                    project_id: "p1".to_string(),
                    entity_kind: "codex-entry".to_string(),
                    entity_id: "e1".to_string(),
                    field_path: "/name".to_string(),
                    locked: true,
                    expected_version: 0,
                },
            )
            .expect("lock the field");

            assert_eq!(
                ownership_of(conn, "p1", "/name"),
                "user-owned",
                "a locked field cannot keep reporting that maintenance may apply to it"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// The sentinel means "the whole entity, granularity unknown", so a
    /// person taking any field of that entity has taken part of what it
    /// covers. Exact `field_path` equality could never conclude that: no
    /// writer ever supplies a field literally called `/legacy-application`,
    /// so the row stayed `maintained` for the life of the workspace while the
    /// state axis had already been taught to treat the marker as whole-object.
    #[test]
    fn a_human_edit_hands_the_whole_object_sentinel_to_the_user() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-legacy"),
                &ContributionField {
                    target_object_identity: "codex-entry:e1",
                    field_path: super::super::legacy_backfill::LEGACY_BACKFILL_FIELD_PATH,
                    target_state: ContributionTargetState::Unchanged,
                    authority: None,
                },
                "2026-08-15T00:00:00.000Z",
            )
            .expect("legacy backfill row");

            super::super::field_authority::record_human_field_write(
                conn,
                "p1",
                "codex-entry",
                "e1",
                &["/name"],
                "2026-08-16T00:00:00.000Z",
            )
            .expect("the author takes a field of the same entity");

            assert_eq!(
                ownership_of(conn, "p1", "/legacy-application"),
                "user-owned",
                "a whole-entity row covers the field the author just took"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// The same fact, reached from the other order. A Backfill runs on old
    /// workspaces, and old workspaces have already been edited, so the row is
    /// minted after the claim rather than before it. Its `authority` is
    /// `None` -- a sentinel is not a ledger coordinate -- so nothing decides
    /// ownership at insert time and the replay has to.
    #[test]
    fn a_backfill_after_a_human_edit_still_hands_the_sentinel_over() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_commit(conn, "p1", "applied");
            super::super::field_authority::record_human_field_write(
                conn,
                "p1",
                "codex-entry",
                "e1",
                &["/name"],
                "2026-08-15T00:00:00.000Z",
            )
            .expect("the author takes a field first");

            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-legacy"),
                &ContributionField {
                    target_object_identity: "codex-entry:e1",
                    field_path: super::super::legacy_backfill::LEGACY_BACKFILL_FIELD_PATH,
                    target_state: ContributionTargetState::Unchanged,
                    authority: None,
                },
                "2026-08-16T00:00:00.000Z",
            )
            .expect("legacy backfill row minted afterwards");
            assert_eq!(
                ownership_of(conn, "p1", "/legacy-application"),
                "maintained",
                "nothing can decide this at insert time -- the replay is what fixes it"
            );

            reproject_user_ownership_from_authority_in_tx(conn, Some("p1"))
                .expect("replay the ledger");

            assert_eq!(
                ownership_of(conn, "p1", "/legacy-application"),
                "user-owned",
                "ownership must not depend on whether the Backfill or the edit came first"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// The Legacy Backfill sentinel means "the whole entity, granularity
    /// unknown". A later Application that rewrites any field of that object
    /// therefore supersedes it -- which exact `field_path` equality could
    /// never conclude, because no live Apply records a field by that name.
    #[test]
    fn a_later_application_supersedes_the_whole_object_sentinel() {
        let db = test_db();
        db.with_conn(|conn| {
            seed_project(conn, "p1");
            seed_named_commit(conn, "p1", "commit-1", "applied");
            seed_named_commit(conn, "p1", "commit-2", "applied");
            record_contribution_in_tx(
                conn,
                "p1",
                &test_provenance("app-legacy"),
                &ContributionField {
                    target_object_identity: "codex-entry:e1",
                    field_path: "/legacy-application",
                    target_state: ContributionTargetState::Unchanged,
                    authority: None,
                },
                "2026-08-15T00:00:00.000Z",
            )
            .expect("legacy backfill row");

            let mut later = test_provenance("app-live");
            later.commit_id = "commit-2";
            later.baseline_sequence = Some(40);
            record_contribution_in_tx(
                conn,
                "p1",
                &later,
                &ContributionField {
                    target_object_identity: "codex-entry:e1",
                    field_path: "/title",
                    target_state: ContributionTargetState::Unchanged,
                    authority: None,
                },
                "2026-08-16T00:00:00.000Z",
            )
            .expect("later live application");

            let legacy = list_contributions_for_application(conn, "p1", "app-legacy")
                .expect("read the legacy contribution");
            assert_eq!(
                legacy[0].target_state,
                ContributionTargetState::Superseded,
                "a whole-object row cannot stay unchanged after the object was rewritten"
            );

            let live = list_contributions_for_application(conn, "p1", "app-live")
                .expect("read the live contribution");
            assert_eq!(
                live[0].target_state,
                ContributionTargetState::Unchanged,
                "the relaxation is one-directional: a whole-object row from the past \
                 is not evidence that it wrote this particular field"
            );
            Ok(())
        })
        .expect("test body");
    }

    /// The sentinel is a literal in the supersede SQL and a constant in the
    /// Backfill. Nothing but this test keeps the two spellings together.
    #[test]
    fn the_supersede_sql_and_the_backfill_agree_on_the_sentinel() {
        assert!(
            EFFECTIVE_TARGET_STATE_SQL
                .contains(super::super::legacy_backfill::LEGACY_BACKFILL_FIELD_PATH),
            "the supersede subquery must name the same sentinel the Backfill writes"
        );
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
                    authority: None,
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
                    authority: None,
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
                    authority: None,
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
                    authority: None,
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
                    authority: None,
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
                    authority: None,
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
