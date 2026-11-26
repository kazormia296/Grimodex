//! Scene -> Chronicle Proposals read (SRA/1 R1-R3, DR-SRA-2..4).
//!
//! One paged, read-only answer to "which Proposals have this Scene as evidence?",
//! for the Scene's review section. It writes nothing and adds no table, column
//! or index.
//!
//! The Scene is found through the existing Dependency Edge index
//! (`idx_narrative_dependency_edges_source`, `(project_id, source_object_identity)`):
//! every Proposal revision that *read* the Scene declares an Edge on
//! `project:scene:<id>`. A Scene that was only read is not evidence, so each
//! Edge is narrowed to the Proposal's *current* revision whose sealed evidence
//! list (`effectiveMaterialBasis.evidenceSet`) names the Scene. Every join after
//! the Edge is a primary-key lookup. The Proposal query therefore reads the
//! Edges of one Scene (history included), not the project; it has no upper bound
//! beyond that, and the index has no order, so each page sorts the matching rows
//! (`USE TEMP B-TREE FOR ORDER BY`) before it cuts the page.
//!
//! The page is keyed on the Proposal id, so a Proposal revised between two pages
//! keeps its place and is not returned twice. The order is by id, not by age; a
//! Proposal that appears between two pages is seen only by a read from the first
//! page, so a screen re-reads from the first page when it is told something changed.
//!
//! The Chronicle state is the one cost that is not per Scene: it reads
//! `narrative_proposal_applications` (one row per imported event, no
//! `proposal_id` index) once per page, so that statement scans the table (see
//! `APPLIED_PROPOSALS_SQL`).
//!
//! What a revision's own record decides about Related Scenes (approval, Secret
//! flag, Scope, canonical Freshness) comes from the same parts as the query-bound
//! admission reader (`retrieval_admission::read_revision_static_eligibility`); the
//! reasons that depend on the Scene being written are not returned, because this
//! read has no such Scene. The duplicate flag is the bulk-approval reason (c),
//! shared through `bulk_approval::sealed_probable_duplicate`.
//!
//! Only quotes the revision's sealed record already holds are returned; no Scene
//! body is read.

use std::collections::{BTreeSet, HashMap};

use anyhow::{ensure, Result};
use grimodex_core::narrative_ir::CHRONICLE_EVENT_PROPOSAL_KIND;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::bulk_approval::{sealed_probable_duplicate, BulkApprovalContext, PlanSource};
use super::redecidable_proposals::{page_statuses, RedecideStatus};
use super::retrieval_admission::{
    read_revision_static_eligibility, read_static_scope_authority, RevisionEligibilityReason,
    RevisionSourceState, StaticEligibilityInput,
};
use super::revision_eligibility::RevisionFreshnessReason;
use crate::Database;

/// Largest page this read returns, whatever the caller asks for. Each item
/// replays the revision's sealed membership and canonical Freshness, so the page
/// is kept small.
pub const SCENE_PROPOSALS_PAGE_MAX: usize = 50;
/// Page size when the caller names none.
pub const SCENE_PROPOSALS_PAGE_DEFAULT: usize = 20;
/// Evidence quotes returned per Proposal (the rest are counted, not returned).
pub const SCENE_PROPOSALS_EVIDENCE_MAX: usize = 16;
/// Longest accepted identity or cursor.
const IDENTITY_MAX_BYTES: usize = 256;

pub(super) const SCENE_SOURCE_PREFIX: &str = "project:scene:";
const PROPOSAL_REVISION_CONSUMER_KIND: &str = "proposal-revision";

/// The page query. `INDEXED BY` makes a missing Edge index a loud failure
/// instead of a project-wide scan; the plan is pinned by a test.
const SCENE_PROPOSALS_SQL: &str = "
SELECT r.id, p.id, s.id, s.run_id, p.proposal_key, p.status,
       r.payload_json, r.reconciliation_envelope_json, r.reconciliation_envelope_digest
  FROM narrative_dependency_edges AS e INDEXED BY idx_narrative_dependency_edges_source
  JOIN narrative_proposal_revisions r ON r.id = e.consumer_key
  JOIN narrative_proposals p ON p.id = r.proposal_id AND p.current_revision_id = r.id
  JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
 WHERE e.project_id = ?1
   AND e.source_object_identity = ?2
   AND e.consumer_kind = ?3
   AND s.project_id = ?1
   AND p.kind = ?4
   AND (?5 IS NULL OR p.id > ?5)
   AND CASE WHEN json_valid(r.reconciliation_envelope_json)
            THEN EXISTS (SELECT 1
                           FROM json_each(r.reconciliation_envelope_json,
                                          '$.effectiveMaterialBasis.evidenceSet') ev
                          WHERE json_extract(ev.value, '$.sourceKey') = ?2)
            ELSE 0 END
 ORDER BY p.id
 LIMIT ?6";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListSceneProposalsPayload {
    pub project_id: String,
    pub scene_id: String,
    /// The `nextCursor` of the previous page; absent for the first page.
    #[serde(default)]
    pub cursor: Option<String>,
    /// Page size. Larger than [`SCENE_PROPOSALS_PAGE_MAX`] is cut to it.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SceneProposalReviewState {
    Unreviewed,
    Approved,
    Rejected,
    Held,
    Deferred,
    Other,
}

/// The state of the Sources the revision was read from.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SceneProposalSourceState {
    Fresh,
    Stale,
    Unknown,
}

/// Whether the Proposal's current revision is in the Chronicle: an Application
/// exists and no compensation retracted it.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SceneProposalChronicleState {
    NotApplied,
    Applied,
}

/// The sealed duplicate judgement of extraction time (`unknown`: the sealed Plan
/// could not be read).
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SceneProposalDuplicateSuspicion {
    None,
    Probable,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneProposalEvidence {
    /// The Scene the quote is from (the requested Scene).
    pub scene_id: String,
    pub quote: String,
}

/// Static only: no reason here depends on the Scene being written.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneProposalRelatedUse {
    /// No static reason keeps the revision out of Related Scenes.
    pub likely: bool,
    pub reasons: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneProposalItem {
    pub proposal_id: String,
    pub revision_id: String,
    pub title: Option<String>,
    /// The evidence of this Scene, as sealed in the revision (at most
    /// [`SCENE_PROPOSALS_EVIDENCE_MAX`]).
    pub evidence: Vec<SceneProposalEvidence>,
    pub evidence_truncated: bool,
    /// The other Scenes the revision's evidence spans, sorted.
    pub other_scene_ids: Vec<String>,
    pub review_state: SceneProposalReviewState,
    pub source_state: SceneProposalSourceState,
    pub chronicle_state: SceneProposalChronicleState,
    pub probable_duplicate: SceneProposalDuplicateSuspicion,
    pub related_use: SceneProposalRelatedUse,
    #[serde(flatten)]
    pub redecide: RedecideStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneProposalPage {
    pub items: Vec<SceneProposalItem>,
    /// Pass it back as `cursor` for the next page; absent on the last page.
    pub next_cursor: Option<String>,
    /// The page size actually applied.
    pub limit: u32,
}

/// The page size to apply: the default when none is given, never above the cap.
pub fn effective_scene_proposals_limit(requested: Option<u32>) -> Result<usize> {
    match requested {
        None => Ok(SCENE_PROPOSALS_PAGE_DEFAULT),
        Some(0) => anyhow::bail!("NEX_SCENE_PROPOSALS_INPUT_INVALID: limit must be positive"),
        Some(limit) => Ok((limit as usize).min(SCENE_PROPOSALS_PAGE_MAX)),
    }
}

fn exact_identity(name: &str, value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.trim() == value && value.len() <= IDENTITY_MAX_BYTES,
        "NEX_SCENE_PROPOSALS_INPUT_INVALID: {name} must be a non-empty exact string of at most {IDENTITY_MAX_BYTES} bytes"
    );
    Ok(())
}

/// Reason codes the Scene section may show. Stable kebab-case.
pub fn scene_proposal_reason_code(reason: RevisionEligibilityReason) -> &'static str {
    match reason {
        RevisionEligibilityReason::RevisionNotCurrentHumanApproved => "not-approved",
        RevisionEligibilityReason::MembershipUnavailable => "material-unavailable",
        RevisionEligibilityReason::BindingInvalid => "binding-invalid",
        RevisionEligibilityReason::Secret => "secret",
        RevisionEligibilityReason::StaticContractUnclassified => "contract-unclassified",
        RevisionEligibilityReason::ScopeControlUnclassified => "scope-control-unclassified",
        RevisionEligibilityReason::MaterialAuthorityUnavailable => "material-authority-unavailable",
        RevisionEligibilityReason::ScopeUnresolved => "scope-unresolved",
        RevisionEligibilityReason::ScopeUnsupported => "scope-unsupported",
        RevisionEligibilityReason::EvidenceMismatch => "evidence-mismatch",
        RevisionEligibilityReason::CanonicalFreshness(reason) => match reason {
            RevisionFreshnessReason::StoredStateNotFresh
            | RevisionFreshnessReason::CurrentSourceNotFresh
            | RevisionFreshnessReason::PendingRelevantChange
            | RevisionFreshnessReason::PendingGlobalChange => "source-stale",
            _ => "source-unverified",
        },
        // The Scene-dependent reasons never come out of the static reader; a
        // caller that somehow holds one gets a neutral code, not a Scene fact.
        RevisionEligibilityReason::QueryContextUnavailable
        | RevisionEligibilityReason::UnsupportedQueryAxis
        | RevisionEligibilityReason::SourceNotBeforeQuery => "scene-dependent",
    }
}

fn review_state(status: &str) -> SceneProposalReviewState {
    match status {
        "unreviewed" => SceneProposalReviewState::Unreviewed,
        "approved" => SceneProposalReviewState::Approved,
        "rejected" => SceneProposalReviewState::Rejected,
        "held" => SceneProposalReviewState::Held,
        "deferred" => SceneProposalReviewState::Deferred,
        _ => SceneProposalReviewState::Other,
    }
}

struct PageRow {
    revision_id: String,
    proposal_id: String,
    proposal_set_id: String,
    run_id: String,
    proposal_key: String,
    status: String,
    payload_json: String,
    envelope_json: String,
    envelope_digest: Option<String>,
}

pub(super) fn evidence_entries(envelope: &Value) -> &[Value] {
    envelope
        .pointer("/effectiveMaterialBasis/evidenceSet")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

/// This Scene's evidence quotes, and the other Scenes the evidence spans.
fn scene_evidence(
    envelope: &Value,
    scene_source_key: &str,
) -> (Vec<SceneProposalEvidence>, bool, Vec<String>) {
    let mut quotes = Vec::new();
    let mut truncated = false;
    let mut others = BTreeSet::new();
    for entry in evidence_entries(envelope) {
        let Some(source_key) = entry.get("sourceKey").and_then(Value::as_str) else {
            continue;
        };
        if source_key == scene_source_key {
            if quotes.len() < SCENE_PROPOSALS_EVIDENCE_MAX {
                quotes.push(SceneProposalEvidence {
                    scene_id: scene_source_key
                        .strip_prefix(SCENE_SOURCE_PREFIX)
                        .unwrap_or(scene_source_key)
                        .to_owned(),
                    quote: entry
                        .get("quote")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                });
            } else {
                truncated = true;
            }
        } else if let Some(scene_id) = source_key.strip_prefix(SCENE_SOURCE_PREFIX) {
            others.insert(scene_id.to_owned());
        }
    }
    (quotes, truncated, others.into_iter().collect())
}

/// The Proposals of `current` ((proposal id, current revision id) pairs) whose
/// *current revision* is in the Chronicle: a normal Application of that very
/// revision exists and no compensation retracts it. One statement per page.
/// An Application of an older revision does not count, so a Proposal revised
/// after its import is shown as not applied.
///
/// `narrative_proposal_applications` has no `proposal_id` index (only the
/// partial unique index on `compensates_application_id`), so this statement
/// scans the table once per page: one row per imported event, in the order of
/// the project's imports. `ensure_proposal_not_applied` reads it the same way.
/// The plan is pinned by a test and the cost is recorded in DR-SRA-2.
const APPLIED_PROPOSALS_SQL: &str = "
SELECT DISTINCT a.proposal_id
  FROM narrative_proposal_applications a
 WHERE a.application_kind = 'normal'
   AND (a.proposal_id, a.revision_id) IN (SELECT json_extract(value, '$[0]'),
                                                 json_extract(value, '$[1]')
                                            FROM json_each(?1))
   AND NOT EXISTS (SELECT 1
                     FROM narrative_proposal_applications c
                    WHERE c.application_kind = 'compensation'
                      AND c.compensates_application_id = a.id)";

fn applied_proposals(conn: &Connection, current: &[(&str, &str)]) -> Result<BTreeSet<String>> {
    if current.is_empty() {
        return Ok(BTreeSet::new());
    }
    let pairs_json = serde_json::to_string(current)?;
    let mut statement = conn.prepare(APPLIED_PROPOSALS_SQL)?;
    let rows = statement
        .query_map([pairs_json], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    Ok(rows)
}

fn read_page_rows(
    conn: &Connection,
    project_id: &str,
    scene_source_key: &str,
    cursor: Option<&str>,
    fetch: usize,
) -> Result<Vec<PageRow>> {
    let mut statement = conn.prepare(SCENE_PROPOSALS_SQL)?;
    let rows = statement
        .query_map(
            params![
                project_id,
                scene_source_key,
                PROPOSAL_REVISION_CONSUMER_KIND,
                CHRONICLE_EVENT_PROPOSAL_KIND,
                cursor,
                fetch as i64,
            ],
            |row| {
                Ok(PageRow {
                    revision_id: row.get(0)?,
                    proposal_id: row.get(1)?,
                    proposal_set_id: row.get(2)?,
                    run_id: row.get(3)?,
                    proposal_key: row.get(4)?,
                    status: row.get(5)?,
                    payload_json: row.get(6)?,
                    envelope_json: row.get(7)?,
                    envelope_digest: row.get(8)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// `conn` must be inside one read transaction.
fn read_scene_proposals(
    conn: &mut Connection,
    payload: &ListSceneProposalsPayload,
    limit: usize,
) -> Result<SceneProposalPage> {
    let project_id = payload.project_id.as_str();
    let scene_id = payload.scene_id.as_str();
    let empty = SceneProposalPage {
        items: Vec::new(),
        next_cursor: None,
        limit: limit as u32,
    };
    // The Scene must be a Scene of this project; anything else (another
    // project's Scene, a note, an unknown id) has no Proposals to show.
    let belongs: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM tree_nodes WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    if belongs.is_none() {
        return Ok(empty);
    }
    let scene_source_key = format!("{SCENE_SOURCE_PREFIX}{scene_id}");
    let mut rows = read_page_rows(
        conn,
        project_id,
        &scene_source_key,
        payload.cursor.as_deref(),
        limit + 1,
    )?;
    let next_cursor = if rows.len() > limit {
        rows.truncate(limit);
        rows.last().map(|row| row.proposal_id.clone())
    } else {
        None
    };
    if rows.is_empty() {
        return Ok(empty);
    }

    let statuses = page_statuses(
        conn,
        project_id,
        &rows
            .iter()
            .map(|row| row.proposal_id.as_str())
            .collect::<Vec<_>>(),
    )?;
    let applied = applied_proposals(
        conn,
        &rows
            .iter()
            .map(|row| (row.proposal_id.as_str(), row.revision_id.as_str()))
            .collect::<Vec<_>>(),
    )?;
    let authority = read_static_scope_authority(conn, project_id)?;
    let mut plan_contexts: HashMap<String, BulkApprovalContext> = HashMap::new();
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let envelope: Value = serde_json::from_str(&row.envelope_json).unwrap_or(Value::Null);
        let revision_payload: Value =
            serde_json::from_str(&row.payload_json).unwrap_or(Value::Null);
        let title = revision_payload
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let (evidence, evidence_truncated, other_scene_ids) =
            scene_evidence(&envelope, &scene_source_key);

        let eligibility = read_revision_static_eligibility(
            conn,
            project_id,
            &StaticEligibilityInput {
                revision_id: &row.revision_id,
                proposal_id: &row.proposal_id,
                envelope_json: &row.envelope_json,
                envelope_digest: row.envelope_digest.as_deref(),
                payload_json: &row.payload_json,
            },
            authority.as_ref(),
        )?;

        let context = plan_contexts
            .entry(row.proposal_set_id.clone())
            .or_insert_with(|| {
                BulkApprovalContext::new(
                    project_id,
                    &row.run_id,
                    &row.proposal_set_id,
                    PlanSource::Verify,
                )
            });
        let probable_duplicate =
            match sealed_probable_duplicate(conn, context, &row.proposal_key, title.as_deref()) {
                None => SceneProposalDuplicateSuspicion::Unknown,
                Some(true) => SceneProposalDuplicateSuspicion::Probable,
                Some(false) => SceneProposalDuplicateSuspicion::None,
            };

        items.push(SceneProposalItem {
            redecide: statuses
                .get(&row.proposal_id)
                .ok_or_else(|| anyhow::anyhow!("missing scene proposal facts"))?
                .clone(),
            proposal_id: row.proposal_id.clone(),
            revision_id: row.revision_id.clone(),
            title,
            evidence,
            evidence_truncated,
            other_scene_ids,
            review_state: review_state(&row.status),
            source_state: match eligibility.source {
                RevisionSourceState::Fresh => SceneProposalSourceState::Fresh,
                RevisionSourceState::Stale => SceneProposalSourceState::Stale,
                RevisionSourceState::Unknown => SceneProposalSourceState::Unknown,
            },
            chronicle_state: if applied.contains(&row.proposal_id) {
                SceneProposalChronicleState::Applied
            } else {
                SceneProposalChronicleState::NotApplied
            },
            probable_duplicate,
            related_use: SceneProposalRelatedUse {
                likely: eligibility.reasons.is_empty(),
                reasons: eligibility
                    .reasons
                    .iter()
                    .map(|reason| scene_proposal_reason_code(*reason))
                    .collect(),
            },
        });
    }
    Ok(SceneProposalPage {
        items,
        next_cursor,
        limit: limit as u32,
    })
}

/// The current revisions of the Chronicle Proposals that cite `sceneId` as
/// evidence, one page. The project binding is checked here: a Scene that is not
/// a Scene of `projectId` gives an empty page.
pub fn narrative_extraction_list_scene_proposals(
    db: &Database,
    payload: ListSceneProposalsPayload,
) -> Result<SceneProposalPage> {
    exact_identity("projectId", &payload.project_id)?;
    exact_identity("sceneId", &payload.scene_id)?;
    if let Some(cursor) = payload.cursor.as_deref() {
        exact_identity("cursor", cursor)?;
    }
    let limit = effective_scene_proposals_limit(payload.limit)?;
    db.with_read_transaction(|conn| read_scene_proposals(conn, &payload, limit))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(conn: &Connection, sql: &str) -> Vec<String> {
        let mut statement = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .expect("plan the Scene Proposals query");
        let count = statement.parameter_count();
        statement
            .query_map(
                rusqlite::params_from_iter(std::iter::repeat_n("x", count)),
                |row| row.get::<_, String>(3),
            )
            .expect("read the plan")
            .collect::<Result<Vec<_>, _>>()
            .expect("plan rows")
    }

    #[test]
    fn page_query_starts_from_the_scene_edge_index_and_scans_no_table() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            let lines = plan(conn, SCENE_PROPOSALS_SQL);
            assert!(
                lines.iter().any(|line| line.contains(
                    "SEARCH e USING INDEX idx_narrative_dependency_edges_source \
                     (project_id=? AND source_object_identity=?)"
                )),
                "the Edge index is the entry: {lines:?}"
            );
            // Every other table is reached by primary key; the only scan allowed
            // is the correlated json_each over one revision's evidence list.
            for line in &lines {
                if let Some(rest) = line.strip_prefix("SCAN ") {
                    assert!(
                        rest.starts_with("ev VIRTUAL TABLE"),
                        "no table scan in the page query: {line}"
                    );
                }
            }
            for table in ["r", "p", "s"] {
                assert!(
                    lines.iter().any(|line| line
                        .starts_with(&format!("SEARCH {table} USING INDEX sqlite_autoindex_"))),
                    "{table} is a primary-key lookup: {lines:?}"
                );
            }
            Ok(())
        })
        .expect("inspect the plan");
    }

    #[test]
    fn page_query_sorts_the_scenes_matches_and_the_applied_query_scans_the_applications_once() {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        db.with_conn(|conn| {
            // The Edge index has no order, so the page sorts what the Scene
            // matched before it cuts the page (the cost the module doc names).
            let lines = plan(conn, SCENE_PROPOSALS_SQL);
            assert!(
                lines
                    .iter()
                    .any(|line| line == "USE TEMP B-TREE FOR ORDER BY"),
                "the page is sorted after the Edge lookup: {lines:?}"
            );
            // The Chronicle state reads the Applications table in one scan; its
            // compensation check is an index search, and nothing else scans.
            let lines = plan(conn, APPLIED_PROPOSALS_SQL);
            let scans: Vec<_> = lines
                .iter()
                .filter(|line| line.starts_with("SCAN "))
                .collect();
            assert_eq!(
                scans.len(),
                2,
                "one scan of the Applications and the pairs of the page: {lines:?}"
            );
            assert!(scans.iter().any(|line| line.as_str() == "SCAN a"));
            assert!(
                lines.iter().any(|line| line.starts_with(
                    "SEARCH c USING COVERING INDEX idx_narrative_compensation_target"
                )),
                "the compensation check is an index search: {lines:?}"
            );
            Ok(())
        })
        .expect("inspect the plans");
    }

    #[test]
    fn every_static_reason_has_its_own_stable_code() {
        use RevisionEligibilityReason as Reason;
        use RevisionFreshnessReason as Fresh;
        for (reason, code) in [
            (Reason::RevisionNotCurrentHumanApproved, "not-approved"),
            (Reason::MembershipUnavailable, "material-unavailable"),
            (Reason::BindingInvalid, "binding-invalid"),
            (Reason::Secret, "secret"),
            (Reason::StaticContractUnclassified, "contract-unclassified"),
            (
                Reason::ScopeControlUnclassified,
                "scope-control-unclassified",
            ),
            (
                Reason::MaterialAuthorityUnavailable,
                "material-authority-unavailable",
            ),
            (Reason::ScopeUnresolved, "scope-unresolved"),
            (Reason::ScopeUnsupported, "scope-unsupported"),
            (Reason::EvidenceMismatch, "evidence-mismatch"),
            (
                Reason::CanonicalFreshness(Fresh::StoredStateNotFresh),
                "source-stale",
            ),
            (
                Reason::CanonicalFreshness(Fresh::CurrentSourceNotFresh),
                "source-stale",
            ),
            (
                Reason::CanonicalFreshness(Fresh::PendingRelevantChange),
                "source-stale",
            ),
            (
                Reason::CanonicalFreshness(Fresh::PendingGlobalChange),
                "source-stale",
            ),
            (
                Reason::CanonicalFreshness(Fresh::CurrentSourceUnavailable),
                "source-unverified",
            ),
            (Reason::QueryContextUnavailable, "scene-dependent"),
            (Reason::UnsupportedQueryAxis, "scene-dependent"),
            (Reason::SourceNotBeforeQuery, "scene-dependent"),
        ] {
            assert_eq!(scene_proposal_reason_code(reason), code, "{reason:?}");
        }
    }

    #[test]
    fn requested_limit_is_cut_to_the_cap_and_defaults_when_absent() {
        assert_eq!(
            effective_scene_proposals_limit(None).expect("default"),
            SCENE_PROPOSALS_PAGE_DEFAULT
        );
        assert_eq!(effective_scene_proposals_limit(Some(1)).expect("one"), 1);
        assert_eq!(
            effective_scene_proposals_limit(Some(SCENE_PROPOSALS_PAGE_MAX as u32)).expect("cap"),
            SCENE_PROPOSALS_PAGE_MAX
        );
        assert_eq!(
            effective_scene_proposals_limit(Some(u32::MAX)).expect("cut"),
            SCENE_PROPOSALS_PAGE_MAX
        );
        assert!(effective_scene_proposals_limit(Some(0)).is_err());
    }
}
