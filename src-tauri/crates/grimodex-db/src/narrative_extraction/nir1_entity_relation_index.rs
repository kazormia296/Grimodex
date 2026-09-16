//! Native-only Graph Index binding for the reviewed NIR-1 Entity/Relation
//! surface.
//!
//! The binding is a sealed cache over the existing metadata, D1, V1 and
//! canonical Freshness authorities. It never persists adjacency or exposes a
//! product query. Adjacency remains the request-local `nir1_graph` primitive.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{ensure, Result};
use chrono::{SecondsFormat, Utc};
use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::declaration_storage::{
    read_active_dependency_declaration_set_in_tx, write_dependency_declaration_set_in_tx,
    ActiveDependencyDeclarationSetRead, DependencyDeclaration, DependencyDeclarationSetRequest,
};
use super::dependency_edges::{
    consumer_dependency_set_digest, delete_edges_for_consumer_in_tx, find_edges_by_consumer,
    record_dependency_edge_in_tx, DependencyEdge,
};
use super::evaluator::{
    evaluate_edge, BuildAction, EdgeComparisonInput, EdgeObservation, EvidenceFreshness,
};
use super::nir1_chronicle_index::NirChronicleIndexRuntime;
use super::nir1_entity_relation::{
    read_nir1_entity_relation_revision_current_for_graph_index, Nir1EntityRelationRevision,
};
use super::publish_runtime::publish_complete_runless_graph_freshness_in_tx;
use super::semantic_epoch::get_current_epoch;
use grimodex_core::narrative_nir1::{
    self, ENTITY_RELATION_INDEX_KEY, ENTITY_RELATION_PRODUCER, ENTITY_RELATION_SOURCE_KIND,
};

pub(crate) const PRODUCER_ID: &str = ENTITY_RELATION_PRODUCER;
pub(crate) const PRODUCER_VERSION: &str = "nir1-reviewed-entity-relation/v1";
pub(crate) const INDEX_KEY: &str = ENTITY_RELATION_INDEX_KEY;
pub(crate) const SOURCE_KIND: &str = ENTITY_RELATION_SOURCE_KIND;
const CONSUMER_KIND: &str = "semantic-index";

// These limits are the ratified graph-limited-binding values.  Keep the
// resource guard separate from the semantic GraphLimits in grimodex-core:
// this scan must reject an oversized whole Source before it can publish a
// partial derived binding.
const GRAPH_RECORD_ADMISSION: usize = narrative_nir1::MAX_GRAPH_RECORDS;
const GRAPH_INPUT_BYTE_LIMIT: usize = narrative_nir1::MAX_GRAPH_INPUT_BYTES;
const GRAPH_SQL_VM_STEP_LIMIT: usize = 100_000;
const GRAPH_SQL_CHECK_INTERVAL: i32 = 1_000;
const GRAPH_SQL_MAX_CALLBACKS: usize = GRAPH_SQL_VM_STEP_LIMIT / GRAPH_SQL_CHECK_INTERVAL as usize;

#[cfg(test)]
thread_local! {
    static GRAPH_TEST_CANCEL_AFTER_FIRST_ROSTER_ROW: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(crate) fn cancel_next_native_prepare_after_first_roster_row_for_test() {
    GRAPH_TEST_CANCEL_AFTER_FIRST_ROSTER_ROW.with(|cancel| cancel.set(true));
}

#[cfg(test)]
fn take_native_prepare_test_cancellation() -> bool {
    GRAPH_TEST_CANCEL_AFTER_FIRST_ROSTER_ROW.with(std::cell::Cell::take)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GraphObjectRosterEntry {
    pub object_id: String,
    pub revision_id: String,
    pub decision_id: String,
    pub source_token: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GraphEligibilitySource {
    pub digest: String,
    pub roster: Vec<GraphObjectRosterEntry>,
}

/// Opaque persisted Graph binding state returned after a successful publish.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredBinding {
    pub(crate) generation: i64,
    pub(crate) source_digest: String,
    pub(crate) dependency_set_digest: String,
    pub(crate) dirty: bool,
    pub(crate) declaration_set_id: String,
    pub(crate) head_version: i64,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum BindingRead {
    Missing,
    Registered(StoredBinding),
    Reserved,
}

/// Opaque sealed Graph build snapshot passed from preparation to publication.
pub struct GraphIndexBuildSnapshot {
    project: String,
    semantic_epoch: String,
    source: GraphEligibilitySource,
    prior: Option<StoredBinding>,
    edges: Vec<DependencyEdge>,
    runtime_owner: u64,
    runtime_epoch: u64,
}

struct GraphReadAdmission<'a> {
    runtime: &'a NirChronicleIndexRuntime,
    owner: u64,
    epoch: u64,
    cancellation_epoch: Arc<AtomicU64>,
}

impl GraphReadAdmission<'_> {
    fn ensure_current(&self, conn: &Connection) -> Result<()> {
        ensure!(
            self.cancellation_epoch.load(Ordering::Acquire) == self.epoch
                && self
                    .runtime
                    .native_build_is_current(conn, self.owner, self.epoch)?,
            "NIR1_GRAPH_ROSTER_CANCELLED"
        );
        Ok(())
    }
}

#[cfg(test)]
impl GraphIndexBuildSnapshot {
    pub(crate) fn edges_for_test(&self) -> Vec<DependencyEdge> {
        self.edges.clone()
    }

    pub(crate) fn replace_edges_for_test(&mut self, edges: Vec<DependencyEdge>) {
        self.edges = edges;
    }
}

pub(crate) fn source_key(project: &str) -> String {
    format!("project:nir1-entity-relation-eligibility:{project}")
}

fn checked_roster_value_bytes(roster: &[GraphObjectRosterEntry]) -> Result<usize> {
    roster.iter().try_fold(0usize, |total, entry| {
        total
            .checked_add(entry.object_id.len())
            .and_then(|total| total.checked_add(entry.revision_id.len()))
            .and_then(|total| total.checked_add(entry.decision_id.len()))
            .and_then(|total| total.checked_add(entry.source_token.len()))
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))
    })
}

#[derive(Serialize)]
struct GraphSourceDigestInput<'a> {
    contract: &'static str,
    #[serde(rename = "projectId")]
    project_id: &'a str,
    #[serde(rename = "qualifiedCurrentRevisionRoster")]
    roster: &'a [GraphObjectRosterEntry],
}

#[derive(Default)]
struct JsonByteCounter {
    len: usize,
}

impl std::io::Write for JsonByteCounter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.len = self
            .len
            .checked_add(bytes.len())
            .ok_or_else(|| std::io::Error::other("JSON length overflow"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn graph_source_digest_input(project: &str, roster: &[GraphObjectRosterEntry]) -> Result<Vec<u8>> {
    let input = GraphSourceDigestInput {
        contract: "nir1-entity-relation-eligibility/1",
        project_id: project,
        roster,
    };
    let mut counter = JsonByteCounter::default();
    serde_json::to_writer(&mut counter, &input)?;
    ensure!(
        counter.len <= GRAPH_INPUT_BYTE_LIMIT,
        "NIR1_GRAPH_ROSTER_INPUT_LIMIT"
    );
    let mut bytes = Vec::with_capacity(counter.len);
    serde_json::to_writer(&mut bytes, &input)?;
    ensure!(
        bytes.len() == counter.len,
        "NIR1_GRAPH_ROSTER_INPUT_SERIALIZATION_MISMATCH"
    );
    Ok(bytes)
}

struct RevisionInputStats {
    bytes: usize,
    material_records: usize,
}

pub(crate) fn graph_source_from_roster(
    project: &str,
    mut roster: Vec<GraphObjectRosterEntry>,
) -> Result<GraphEligibilitySource> {
    ensure!(!project.trim().is_empty() && project.trim() == project);
    ensure!(
        roster
            .len()
            .checked_add(1)
            .is_some_and(|count| count <= GRAPH_RECORD_ADMISSION),
        "NIR1_GRAPH_ROSTER_RECORD_LIMIT"
    );
    ensure!(
        checked_roster_value_bytes(&roster)? <= GRAPH_INPUT_BYTE_LIMIT,
        "NIR1_GRAPH_ROSTER_INPUT_LIMIT"
    );
    for entry in &roster {
        ensure!(
            (entry.object_id.starts_with("codex:") && entry.object_id.len() > "codex:".len())
                || (entry.object_id.starts_with("codex-relation:")
                    && entry.object_id.len() > "codex-relation:".len()),
            "NIR1_GRAPH_ROSTER_OBJECT_INVALID"
        );
        for value in [
            &entry.object_id,
            &entry.revision_id,
            &entry.decision_id,
            &entry.source_token,
        ] {
            ensure!(!value.trim().is_empty() && value.trim() == value);
        }
    }
    roster.sort_by(|left, right| {
        (
            &left.object_id,
            &left.revision_id,
            &left.decision_id,
            &left.source_token,
        )
            .cmp(&(
                &right.object_id,
                &right.revision_id,
                &right.decision_id,
                &right.source_token,
            ))
    });
    let bytes = graph_source_digest_input(project, &roster)?;
    Ok(GraphEligibilitySource {
        digest: format!("sha256:{}", hex::encode(Sha256::digest(bytes))),
        roster,
    })
}

/// Read exactly the qualified current typed revisions. The A2 reader performs
/// the immutable revision, Decision, source, epoch and canonical Freshness
/// checks; this layer only projects the already-qualified bundle to a sorted
/// object/token roster.
pub(crate) fn read_eligibility_source(
    conn: &Connection,
    project: &str,
) -> Result<GraphEligibilitySource> {
    with_graph_sql_budget(conn, None, || {
        read_eligibility_source_bounded(conn, project, None)
    })
}

fn read_eligibility_source_for_native_build(
    conn: &Connection,
    project: &str,
    runtime: &NirChronicleIndexRuntime,
    owner: u64,
    epoch: u64,
) -> Result<GraphEligibilitySource> {
    let admission = GraphReadAdmission {
        runtime,
        owner,
        epoch,
        cancellation_epoch: runtime.native_build_cancellation_epoch(),
    };
    admission.ensure_current(conn)?;
    let cancellation_epoch = Arc::clone(&admission.cancellation_epoch);
    with_graph_sql_budget(conn, Some((&cancellation_epoch, epoch)), || {
        read_eligibility_source_bounded(conn, project, Some(&admission))
    })
}

fn with_graph_sql_budget<T, F>(
    conn: &Connection,
    cancellation_epoch: Option<(&Arc<AtomicU64>, u64)>,
    operation: F,
) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let cancelled = Arc::new(AtomicBool::new(false));
    let budget_exhausted = Arc::new(AtomicBool::new(false));
    let cancelled_for_hook = Arc::clone(&cancelled);
    let budget_for_hook = Arc::clone(&budget_exhausted);
    let cancellation_epoch =
        cancellation_epoch.map(|(epoch, expected)| (Arc::clone(epoch), expected));
    let mut callbacks = 0usize;
    conn.progress_handler(
        GRAPH_SQL_CHECK_INTERVAL,
        Some(move || {
            callbacks = callbacks.saturating_add(1);
            if cancellation_epoch
                .as_ref()
                .is_some_and(|(epoch, expected)| epoch.load(Ordering::Acquire) != *expected)
            {
                cancelled_for_hook.store(true, Ordering::Release);
                return true;
            }
            if callbacks >= GRAPH_SQL_MAX_CALLBACKS {
                budget_for_hook.store(true, Ordering::Release);
                return true;
            }
            false
        }),
    )?;
    let result = operation();
    let reset = conn.progress_handler(0, None::<fn() -> bool>);
    if let Err(error) = reset {
        return Err(anyhow::anyhow!(
            "NIR1_GRAPH_SQL_PROGRESS_HANDLER_RESET_FAILED: {error}"
        ));
    }
    if cancelled.load(Ordering::Acquire) {
        anyhow::bail!("NIR1_GRAPH_ROSTER_CANCELLED");
    }
    if budget_exhausted.load(Ordering::Acquire) {
        anyhow::bail!("NIR1_GRAPH_SQL_RESOURCE_LIMIT");
    }
    result
}

fn with_graph_no_wait<T, F>(conn: &Connection, operation: F) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let original_timeout_ms: i64 =
        conn.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
    ensure!(
        original_timeout_ms >= 0,
        "SQLite returned a negative busy_timeout"
    );
    conn.busy_timeout(Duration::ZERO)?;
    let operation_result = operation();
    let restore_result = conn.busy_timeout(Duration::from_millis(original_timeout_ms as u64));
    match (operation_result, restore_result) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
        (Ok(value), Ok(())) => Ok(value),
    }
}

fn read_eligibility_source_bounded(
    conn: &Connection,
    project: &str,
    admission: Option<&GraphReadAdmission<'_>>,
) -> Result<GraphEligibilitySource> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 Graph Source requires a read transaction"
    );
    ensure!(!project.trim().is_empty() && project.trim() == project);
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?1)",
        params![project],
        |row| row.get(0),
    )?;
    ensure!(
        exists,
        "NEX_SOURCE_MISSING: eligibility project does not exist"
    );

    if let Some(admission) = admission {
        admission.ensure_current(conn)?;
    }
    let mut scanned_record_count = 0usize;
    let mut input_bytes = 0usize;
    let mut roster = Vec::new();
    {
        let mut statement = conn.prepare(
            "SELECT DISTINCT
                    length(CAST(proposal.current_revision_id AS BLOB)),
                    proposal.current_revision_id
               FROM narrative_proposal_sets proposal_set
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
               JOIN narrative_proposals proposal
                 ON proposal.proposal_set_id = proposal_set.id
              WHERE proposal_set.project_id = ?1
                AND proposal_set.set_kind = ?2
                AND extraction_run.surface_path_id = ?3
                AND proposal.current_revision_id IS NOT NULL
              ORDER BY proposal.current_revision_id ASC
              LIMIT ?4",
        )?;
        let mut rows = statement.query(params![
            project,
            super::nir1_entity_relation::NIR1_ENTITY_RELATION_SET_KIND,
            super::nir1_entity_relation::NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            GRAPH_RECORD_ADMISSION as i64,
        ])?;
        while let Some(row) = rows.next()? {
            let revision_id_bytes = usize::try_from(row.get::<_, i64>(0)?)
                .map_err(|_| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
            ensure!(
                revision_id_bytes <= GRAPH_INPUT_BYTE_LIMIT,
                "NIR1_GRAPH_ROSTER_INPUT_LIMIT"
            );
            let revision_id = row.get::<_, String>(1)?;
            if let Some(admission) = admission {
                admission.ensure_current(conn)?;
            }
            input_bytes = input_bytes
                .checked_add(revision_id.len())
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
            ensure!(
                input_bytes <= GRAPH_INPUT_BYTE_LIMIT,
                "NIR1_GRAPH_ROSTER_INPUT_LIMIT"
            );
            scanned_record_count = scanned_record_count
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_RECORD_LIMIT"))?;
            ensure!(
                scanned_record_count <= GRAPH_RECORD_ADMISSION,
                "NIR1_GRAPH_ROSTER_RECORD_LIMIT"
            );
            let Some(input_stats) =
                read_revision_input_stats(conn, project, &revision_id, admission)?
            else {
                continue;
            };
            #[cfg(test)]
            if let Some(admission) = admission {
                if take_native_prepare_test_cancellation() {
                    admission.runtime.pause()?;
                }
            }
            input_bytes = input_bytes
                .checked_add(input_stats.bytes)
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
            ensure!(
                input_bytes <= GRAPH_INPUT_BYTE_LIMIT,
                "NIR1_GRAPH_ROSTER_INPUT_LIMIT"
            );
            scanned_record_count = scanned_record_count
                .checked_add(input_stats.material_records)
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_RECORD_LIMIT"))?;
            ensure!(
                scanned_record_count <= GRAPH_RECORD_ADMISSION,
                "NIR1_GRAPH_ROSTER_RECORD_LIMIT"
            );
            if let Some(admission) = admission {
                admission.ensure_current(conn)?;
            }
            let Some((revision, decision_id)) =
                read_nir1_entity_relation_revision_current_for_graph_index(
                    conn,
                    project,
                    &revision_id,
                )?
            else {
                continue;
            };
            if let Some(admission) = admission {
                admission.ensure_current(conn)?;
            }
            let material_records = revision
                .bundle
                .entities
                .len()
                .checked_add(revision.bundle.relations.len())
                .and_then(|count| count.checked_add(revision.material_basis.evidence_set.len()))
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_RECORD_LIMIT"))?;
            ensure!(
                material_records == input_stats.material_records,
                "NIR1_GRAPH_ROSTER_RECORD_MISMATCH"
            );
            input_bytes = input_bytes
                .checked_add(roster_entry_value_bytes(&revision, &decision_id)?)
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
            ensure!(
                input_bytes <= GRAPH_INPUT_BYTE_LIMIT,
                "NIR1_GRAPH_ROSTER_INPUT_LIMIT"
            );
            append_revision_roster(&mut roster, &revision, &decision_id);
            if let Some(admission) = admission {
                admission.ensure_current(conn)?;
            }
        }
    }
    let has_extra_revision: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM (
                 SELECT DISTINCT proposal.current_revision_id
                   FROM narrative_proposal_sets proposal_set
                   JOIN narrative_extraction_runs extraction_run
                     ON extraction_run.id = proposal_set.run_id
                    AND extraction_run.project_id = proposal_set.project_id
                   JOIN narrative_proposals proposal
                     ON proposal.proposal_set_id = proposal_set.id
                  WHERE proposal_set.project_id = ?1
                    AND proposal_set.set_kind = ?2
                    AND extraction_run.surface_path_id = ?3
                    AND proposal.current_revision_id IS NOT NULL
                  ORDER BY proposal.current_revision_id ASC
                  LIMIT 1 OFFSET ?4
               )
           )",
        params![
            project,
            super::nir1_entity_relation::NIR1_ENTITY_RELATION_SET_KIND,
            super::nir1_entity_relation::NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            GRAPH_RECORD_ADMISSION as i64,
        ],
        |row| row.get(0),
    )?;
    ensure!(!has_extra_revision, "NIR1_GRAPH_ROSTER_RECORD_LIMIT");
    if let Some(admission) = admission {
        admission.ensure_current(conn)?;
    }
    let source = graph_source_from_roster(project, roster)?;
    if let Some(admission) = admission {
        admission.ensure_current(conn)?;
    }
    Ok(source)
}

fn read_revision_input_stats(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    admission: Option<&GraphReadAdmission<'_>>,
) -> Result<Option<RevisionInputStats>> {
    // Lengths are deliberately selected without invoking any JSON function.
    // The size guard below therefore runs before SQLite starts parsing the
    // payload or walking its material arrays.
    let lengths: Option<(i64, i64)> = conn
        .query_row(
            "SELECT COALESCE(length(CAST(revision.payload_json AS BLOB)), 0),
                    COALESCE(length(CAST(revision.reconciliation_envelope_json AS BLOB)), 0)
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal
                 ON proposal.id = revision.proposal_id
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
              WHERE revision.id = ?1
                AND proposal_set.project_id = ?2
                AND proposal_set.set_kind = ?3
                AND extraction_run.surface_path_id = ?4",
            params![
                revision_id,
                project,
                super::nir1_entity_relation::NIR1_ENTITY_RELATION_SET_KIND,
                super::nir1_entity_relation::NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((payload_bytes, envelope_bytes)) = lengths else {
        return Ok(None);
    };
    let payload_bytes = usize::try_from(payload_bytes)
        .map_err(|_| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
    let envelope_bytes = usize::try_from(envelope_bytes)
        .map_err(|_| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
    let total = payload_bytes
        .checked_add(envelope_bytes)
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
    ensure!(
        total <= GRAPH_INPUT_BYTE_LIMIT,
        "NIR1_GRAPH_ROSTER_INPUT_LIMIT"
    );
    if let Some(admission) = admission {
        admission.ensure_current(conn)?;
    }
    let (entity_count, relation_count, evidence_count): (i64, i64, i64) = conn.query_row(
        "SELECT CASE WHEN json_valid(revision.payload_json)
                         THEN COALESCE(json_array_length(
                                  json_extract(revision.payload_json, '$.bundle.entities')
                              ), 0)
                         ELSE 0 END,
                    CASE WHEN json_valid(revision.payload_json)
                         THEN COALESCE(json_array_length(
                                  json_extract(revision.payload_json, '$.bundle.relations')
                              ), 0)
                         ELSE 0 END,
                    CASE WHEN json_valid(revision.payload_json)
                         THEN COALESCE((
                              SELECT SUM(
                                  CASE WHEN json_valid(entity.value)
                                       THEN COALESCE(json_array_length(
                                            json_extract(entity.value, '$.evidence')
                                        ), 0)
                                       ELSE 0 END
                              )
                                FROM json_each(
                                    CASE WHEN json_type(
                                               revision.payload_json,
                                               '$.bundle.entities'
                                         ) = 'array'
                                         THEN json_extract(
                                               revision.payload_json,
                                               '$.bundle.entities'
                                         )
                                         ELSE '[]' END
                                ) AS entity
                         ), 0)
                         ELSE 0 END
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal
                 ON proposal.id = revision.proposal_id
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
              WHERE revision.id = ?1
                AND proposal_set.project_id = ?2
                AND proposal_set.set_kind = ?3
                AND extraction_run.surface_path_id = ?4",
        params![
            revision_id,
            project,
            super::nir1_entity_relation::NIR1_ENTITY_RELATION_SET_KIND,
            super::nir1_entity_relation::NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
        ],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if let Some(admission) = admission {
        admission.ensure_current(conn)?;
    }
    let entity_count = usize::try_from(entity_count)
        .map_err(|_| anyhow::anyhow!("NIR1_GRAPH_ROSTER_RECORD_LIMIT"))?;
    let relation_count = usize::try_from(relation_count)
        .map_err(|_| anyhow::anyhow!("NIR1_GRAPH_ROSTER_RECORD_LIMIT"))?;
    let evidence_count = usize::try_from(evidence_count)
        .map_err(|_| anyhow::anyhow!("NIR1_GRAPH_ROSTER_RECORD_LIMIT"))?;
    let material_records = entity_count
        .checked_add(relation_count)
        .and_then(|count| count.checked_add(evidence_count))
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_RECORD_LIMIT"))?;
    Ok(Some(RevisionInputStats {
        bytes: total,
        material_records,
    }))
}

fn roster_entry_value_bytes(
    revision: &Nir1EntityRelationRevision,
    decision_id: &str,
) -> Result<usize> {
    let revision_bytes = revision.revision_id.len();
    let decision_bytes = decision_id.len();
    revision
        .bundle
        .entities
        .iter()
        .map(|entity| {
            "codex:"
                .len()
                .checked_add(entity.entity_id.len())
                .and_then(|bytes| bytes.checked_add(revision_bytes))
                .and_then(|bytes| bytes.checked_add(decision_bytes))
                .and_then(|bytes| bytes.checked_add(entity.source_token.len()))
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))
        })
        .chain(revision.bundle.relations.iter().map(|relation| {
            "codex-relation:"
                .len()
                .checked_add(relation.edge_id.len())
                .and_then(|bytes| bytes.checked_add(revision_bytes))
                .and_then(|bytes| bytes.checked_add(decision_bytes))
                .and_then(|bytes| bytes.checked_add(relation.source_token.len()))
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))
        }))
        .try_fold(0usize, |total, entry| {
            total
                .checked_add(entry?)
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))
        })
}

fn append_revision_roster(
    roster: &mut Vec<GraphObjectRosterEntry>,
    revision: &Nir1EntityRelationRevision,
    decision_id: &str,
) {
    roster.extend(
        revision
            .bundle
            .entities
            .iter()
            .map(|entity| GraphObjectRosterEntry {
                object_id: format!("codex:{}", entity.entity_id),
                revision_id: revision.revision_id.clone(),
                decision_id: decision_id.to_owned(),
                source_token: entity.source_token.clone(),
            }),
    );
    roster.extend(
        revision
            .bundle
            .relations
            .iter()
            .map(|relation| GraphObjectRosterEntry {
                object_id: format!("codex-relation:{}", relation.edge_id),
                revision_id: revision.revision_id.clone(),
                decision_id: decision_id.to_owned(),
                source_token: relation.source_token.clone(),
            }),
    );
}

pub(crate) fn read(conn: &Connection, project: &str) -> Result<BindingRead> {
    read_internal(conn, project, true, true)
}

/// The Graph producer calls the canonical Freshness writer after it has
/// materialised the new metadata/D1/V1 surfaces but before the Freshness row
/// exists. This narrow admission recognizes only that exact in-progress
/// binding; all ordinary registration, Verify, Restore, and query reads still
/// require the Freshness row.
pub(crate) fn is_publish_target(conn: &Connection, project: &str, key: &str) -> Result<bool> {
    if key != INDEX_KEY
        || conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? < 35
    {
        return Ok(false);
    }
    Ok(matches!(
        read_internal(conn, project, false, false)?,
        BindingRead::Registered(_)
    ))
}

fn read_internal(
    conn: &Connection,
    project: &str,
    require_freshness: bool,
    require_current_freshness: bool,
) -> Result<BindingRead> {
    let row = conn
        .query_row(
            "SELECT generation,source_digest,dependency_set_digest,dirty_cache_flag,producer_id,producer_version,built_at
               FROM narrative_semantic_index_metadata
              WHERE project_id=?1 AND index_key=?2",
            params![project, INDEX_KEY],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()?;
    let declaration =
        read_active_dependency_declaration_set_in_tx(conn, project, CONSUMER_KIND, INDEX_KEY)?;
    let Some((generation, source_digest, dependency_digest, dirty, producer, version, built_at)) =
        row
    else {
        let residue: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM narrative_dependency_edges WHERE project_id=?1 AND consumer_kind=?2 AND consumer_key=?3)
               OR EXISTS(SELECT 1 FROM narrative_consumer_freshness WHERE project_id=?1 AND consumer_kind=?2 AND consumer_key=?3)",
            params![project, CONSUMER_KIND, INDEX_KEY],
            |row| row.get(0),
        )?;
        return Ok(
            if !residue && declaration == ActiveDependencyDeclarationSetRead::Missing {
                BindingRead::Missing
            } else {
                BindingRead::Reserved
            },
        );
    };
    let ActiveDependencyDeclarationSetRead::Active(declaration) = declaration else {
        return Ok(BindingRead::Reserved);
    };
    let (Some(source_digest), Some(dependency_set_digest)) = (source_digest, dependency_digest)
    else {
        return Ok(BindingRead::Reserved);
    };
    let current_dependency_digest =
        consumer_dependency_set_digest(conn, project, CONSUMER_KIND, INDEX_KEY)?;
    if generation <= 0
        || !matches!(dirty, 0 | 1)
        || !is_digest(&source_digest)
        || !canonical_instant(&built_at)
        || producer.as_deref() != Some(PRODUCER_ID)
        || version.as_deref() != Some(PRODUCER_VERSION)
        || declaration.producer_id != PRODUCER_ID
        || declaration.producer_generation != generation
        || declaration.dependency_set_digest != dependency_set_digest
        || declaration.entries.is_empty()
    {
        return Ok(BindingRead::Reserved);
    }
    let head_version: i64 = conn
        .query_row(
            "SELECT version FROM narrative_dependency_declaration_heads
              WHERE project_id=?1 AND consumer_kind=?2 AND consumer_key=?3",
            params![project, CONSUMER_KIND, INDEX_KEY],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0);
    if head_version <= 0 {
        return Ok(BindingRead::Reserved);
    }
    let freshness = conn
        .query_row(
            "SELECT evidence_freshness,build_action,semantic_epoch_id,dependency_set_digest,updated_at
               FROM narrative_consumer_freshness
              WHERE project_id=?1 AND consumer_kind=?2 AND consumer_key=?3",
            params![project, CONSUMER_KIND, INDEX_KEY],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    match freshness {
        Some((freshness, action, semantic_epoch, freshness_digest, updated_at)) => {
            let freshness_digest_matches =
                freshness_digest.as_deref() == Some(current_dependency_digest.as_str());
            if EvidenceFreshness::try_from(freshness.as_str()).is_err()
                || BuildAction::try_from(action.as_str()).is_err()
                || semantic_epoch.trim().is_empty()
                || !canonical_instant(&updated_at)
                || (!freshness_digest_matches && (require_current_freshness || dirty == 0))
            {
                return Ok(BindingRead::Reserved);
            }
        }
        None if require_freshness => {
            return Ok(BindingRead::Reserved);
        }
        None => {}
    }
    let edges = find_edges_by_consumer(conn, project, CONSUMER_KIND, INDEX_KEY)?;
    let source_identity = source_key(project);
    if edges.len() != declaration.entries.len()
        || declaration.entries.iter().any(|entry| {
            entry.dependency_role != DependencyRole::RankingOnly
                || entry.selector_json != "{\"kind\":\"whole-source\"}"
                || !edges
                    .iter()
                    .any(|edge| edge.source_object_identity == entry.source_object_identity)
        })
        || !declaration
            .entries
            .iter()
            .any(|entry| entry.source_object_identity == source_identity)
    {
        return Ok(BindingRead::Reserved);
    }
    for edge in &edges {
        let Ok(tokens) = serde_json::from_str::<Vec<String>>(&edge.read_set_json) else {
            return Ok(BindingRead::Reserved);
        };
        let canonical_tokens = tokens.iter().cloned().collect::<BTreeSet<_>>();
        let canonical_tokens = canonical_tokens.iter().cloned().collect::<Vec<_>>();
        if tokens.is_empty()
            || tokens.iter().any(|token| token.trim().is_empty())
            || canonical_tokens.len() != tokens.len()
            || tokens != canonical_tokens
            || (edge.source_object_identity == source_identity
                && (tokens.len() != 1
                    || tokens[0] != source_digest
                    || edge.owning_run_id.is_some()))
        {
            return Ok(BindingRead::Reserved);
        }
    }
    Ok(BindingRead::Registered(StoredBinding {
        generation,
        source_digest,
        dependency_set_digest,
        dirty: dirty == 1,
        declaration_set_id: declaration.declaration_set_id,
        head_version,
    }))
}

pub(crate) fn is_registered(conn: &Connection, project: &str, key: &str) -> Result<bool> {
    if conn.is_autocommit() {
        let tx = conn.unchecked_transaction()?;
        return is_registered(&tx, project, key);
    }
    if key != INDEX_KEY
        || conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? < 35
    {
        return Ok(false);
    }
    Ok(matches!(read(conn, project)?, BindingRead::Registered(_)))
}

/// Check whether the exact Graph binding is structurally registered and live.
pub fn is_complete_registered(conn: &Connection, project: &str, key: &str) -> Result<bool> {
    if key != INDEX_KEY {
        return Ok(false);
    }
    if conn.is_autocommit() {
        let tx = conn.unchecked_transaction()?;
        return is_complete_registered(&tx, project, key);
    }
    let BindingRead::Registered(binding) = read(conn, project)? else {
        return Ok(false);
    };
    let Some(epoch) = get_current_epoch(conn, project)? else {
        return Ok(false);
    };
    let source = read_eligibility_source(conn, project)?;
    if binding.source_digest != source.digest {
        return Ok(false);
    }
    let edges = find_edges_by_consumer(conn, project, CONSUMER_KIND, key)?;
    if !edges_match_source(&edges, project, &source)? {
        return Ok(false);
    }
    let freshness = conn
        .query_row(
            "SELECT f.evidence_freshness,f.build_action,f.semantic_epoch_id,
                    f.dependency_set_digest,f.updated_at,m.built_at
               FROM narrative_consumer_freshness f
               JOIN narrative_semantic_index_metadata m
                 ON m.project_id=f.project_id AND m.index_key=f.consumer_key
              WHERE f.project_id=?1 AND f.consumer_kind=?2 AND f.consumer_key=?3",
            params![project, CONSUMER_KIND, key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((freshness, action, semantic_epoch, dependency_digest, updated_at, built_at)) =
        freshness
    else {
        return Ok(false);
    };
    if !matches!(
        EvidenceFreshness::try_from(freshness.as_str()),
        Ok(EvidenceFreshness::Fresh)
    ) || !matches!(
        BuildAction::try_from(action.as_str()),
        Ok(BuildAction::None)
    ) || semantic_epoch != epoch.id
        || !canonical_instant(&updated_at)
        || !canonical_instant(&built_at)
        || dependency_digest.as_deref()
            != Some(&consumer_dependency_set_digest(
                conn,
                project,
                CONSUMER_KIND,
                key,
            )?)
    {
        return Ok(false);
    }
    let mut statement = conn.prepare(
        "SELECT s.evidence_freshness,s.build_action,s.evaluated_at_epoch_id
           FROM narrative_dependency_edge_states s
           JOIN narrative_dependency_edges e ON e.id=s.edge_id
          WHERE e.project_id=?1 AND e.consumer_kind=?2 AND e.consumer_key=?3",
    )?;
    let states = statement
        .query_map(params![project, CONSUMER_KIND, key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if states.len() != edges.len()
        || states.iter().any(|(freshness, action, state_epoch)| {
            freshness != EvidenceFreshness::Fresh.as_str()
                || action != BuildAction::None.as_str()
                || state_epoch != &epoch.id
        })
    {
        return Ok(false);
    }
    Ok(!binding.dirty)
}

fn edges_match_source(
    edges: &[DependencyEdge],
    project: &str,
    source: &GraphEligibilitySource,
) -> Result<bool> {
    let mut expected = BTreeMap::<String, BTreeSet<String>>::new();
    expected.insert(
        source_key(project),
        [source.digest.clone()].into_iter().collect(),
    );
    for entry in &source.roster {
        expected
            .entry(entry.object_id.clone())
            .or_default()
            .insert(entry.source_token.clone());
    }
    if expected.len() != edges.len() {
        return Ok(false);
    }
    for edge in edges {
        let Some(tokens) = expected.get(&edge.source_object_identity) else {
            return Ok(false);
        };
        let actual = serde_json::from_str::<Vec<String>>(&edge.read_set_json).ok();
        let Some(actual) = actual else {
            return Ok(false);
        };
        let actual = actual.into_iter().collect::<BTreeSet<_>>();
        if &actual != tokens {
            return Ok(false);
        }
    }
    Ok(true)
}

fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(is_hex_digest)
}

fn is_hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn canonical_instant(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|instant| {
        instant
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
            == value
    })
}

/// Prepare an opaque, bounded Graph snapshot in a caller-owned read transaction.
pub fn prepare_graph_index_build(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
) -> Result<GraphIndexBuildSnapshot> {
    with_graph_no_wait(conn, || {
        prepare_graph_index_build_in_tx(conn, runtime, project)
    })
}

fn prepare_graph_index_build_in_tx(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
) -> Result<GraphIndexBuildSnapshot> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 Graph preparation requires a read transaction"
    );
    let semantic_epoch = get_current_epoch(conn, project)?
        .map(|epoch| epoch.id)
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_CURRENT_EPOCH_UNAVAILABLE"))?;
    let (runtime_owner, runtime_epoch) = runtime
        .admit_native_build(conn)?
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_RUNTIME_UNAVAILABLE"))?;
    let source = read_eligibility_source_for_native_build(
        conn,
        project,
        runtime,
        runtime_owner,
        runtime_epoch,
    )?;
    let prior = match read(conn, project)? {
        BindingRead::Missing => None,
        BindingRead::Registered(binding) => Some(binding),
        BindingRead::Reserved => anyhow::bail!("NIR1_GRAPH_BINDING_RESERVED"),
    };
    let edges = input_edges(project, &source)?;
    Ok(GraphIndexBuildSnapshot {
        project: project.to_owned(),
        semantic_epoch,
        source,
        prior,
        edges,
        runtime_owner,
        runtime_epoch,
    })
}

fn input_edges(project: &str, source: &GraphEligibilitySource) -> Result<Vec<DependencyEdge>> {
    ensure!(
        source
            .roster
            .len()
            .checked_add(1)
            .is_some_and(|count| count <= GRAPH_RECORD_ADMISSION),
        "NIR1_GRAPH_ADMISSION_LIMIT"
    );
    let mut sources = BTreeMap::<String, BTreeSet<String>>::new();
    sources.insert(
        source_key(project),
        [source.digest.clone()].into_iter().collect(),
    );
    for entry in &source.roster {
        sources
            .entry(entry.object_id.clone())
            .or_default()
            .insert(entry.source_token.clone());
    }
    sources
        .into_iter()
        .map(|(identity, tokens)| {
            Ok(DependencyEdge {
                id: String::new(),
                project_id: project.to_owned(),
                consumer_kind: CONSUMER_KIND.to_owned(),
                consumer_key: INDEX_KEY.to_owned(),
                source_object_identity: identity,
                read_set_json: serde_json::to_string(&tokens.into_iter().collect::<Vec<_>>())?,
                generated_by_transaction_id: None,
                created_at: String::new(),
                owning_run_id: None,
            })
        })
        .collect()
}

pub(crate) fn snapshot_current(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    snapshot: &GraphIndexBuildSnapshot,
) -> Result<bool> {
    if !runtime.native_build_is_current(conn, snapshot.runtime_owner, snapshot.runtime_epoch)? {
        return Ok(false);
    }
    let Some(epoch) = get_current_epoch(conn, &snapshot.project)? else {
        return Ok(false);
    };
    if epoch.id != snapshot.semantic_epoch {
        return Ok(false);
    }
    let prior = match read(conn, &snapshot.project)? {
        BindingRead::Missing => None,
        BindingRead::Registered(binding) => Some(binding),
        BindingRead::Reserved => return Ok(false),
    };
    if prior != snapshot.prior {
        return Ok(false);
    }
    let source = read_eligibility_source_for_native_build(
        conn,
        &snapshot.project,
        runtime,
        snapshot.runtime_owner,
        snapshot.runtime_epoch,
    )?;
    Ok(source == snapshot.source && input_edges(&snapshot.project, &source)? == snapshot.edges)
}

fn ensure_snapshot_edges_are_sealed(snapshot: &GraphIndexBuildSnapshot) -> Result<()> {
    ensure!(
        input_edges(&snapshot.project, &snapshot.source)? == snapshot.edges,
        "NIR1_GRAPH_SNAPSHOT_EDGES_MISMATCH"
    );
    Ok(())
}

/// Publish a sealed Graph snapshot in a caller-owned write transaction.
// NARRATIVE_DEPENDENCY_PRODUCER: nir1-reviewed-entity-relation-v1
pub fn publish_nir1_entity_relation_index_in_tx(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    snapshot: GraphIndexBuildSnapshot,
) -> Result<StoredBinding> {
    with_graph_no_wait(conn, || {
        publish_nir1_entity_relation_index_in_tx_inner(conn, runtime, snapshot)
    })
}

fn publish_nir1_entity_relation_index_in_tx_inner(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    snapshot: GraphIndexBuildSnapshot,
) -> Result<StoredBinding> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 Graph publication requires a write transaction"
    );
    // This is deliberately before the first D1/V1/metadata write. The
    // snapshot is opaque in production, and the exact deterministic edge
    // set is recomputed from its sealed roster so partial, extra, or
    // field-tampered input cannot advance a generation.
    ensure_snapshot_edges_are_sealed(&snapshot)?;
    ensure!(
        snapshot_current(conn, runtime, &snapshot)?,
        "NIR1_GRAPH_SNAPSHOT_STALE"
    );
    let generation = snapshot
        .prior
        .as_ref()
        .map_or(0, |binding| binding.generation)
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("NIR1 Graph generation exhausted"))?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let declarations = snapshot
        .edges
        .iter()
        .map(|edge| DependencyDeclaration {
            source_object_identity: edge.source_object_identity.clone(),
            role: DependencyRole::RankingOnly,
            selector: DependencySelector::WholeSource,
        })
        .collect();
    let d1 = write_dependency_declaration_set_in_tx(
        conn,
        DependencyDeclarationSetRequest {
            project_id: snapshot.project.clone(),
            consumer_kind: CONSUMER_KIND.to_owned(),
            consumer_key: INDEX_KEY.to_owned(),
            producer_id: PRODUCER_ID.to_owned(),
            producer_generation: generation,
            expected_head_version: snapshot
                .prior
                .as_ref()
                .map_or(0, |binding| binding.head_version),
            declarations,
            created_at: now.clone(),
        },
    )?;
    delete_edges_for_consumer_in_tx(conn, &snapshot.project, CONSUMER_KIND, INDEX_KEY)?;
    for edge in &snapshot.edges {
        record_dependency_edge_in_tx(
            conn,
            &snapshot.project,
            CONSUMER_KIND,
            INDEX_KEY,
            &edge.source_object_identity,
            &edge.read_set_json,
            None,
            None,
            &now,
        )?;
    }
    conn.execute(
        "INSERT INTO narrative_semantic_index_metadata
            (project_id,index_key,generation,built_at,source_digest,dependency_set_digest,dirty_cache_flag,producer_id,producer_version)
         VALUES (?1,?2,?3,?4,?5,?6,0,?7,?8)
         ON CONFLICT(project_id,index_key) DO UPDATE SET
            generation=excluded.generation,built_at=excluded.built_at,
            source_digest=excluded.source_digest,dependency_set_digest=excluded.dependency_set_digest,
            dirty_cache_flag=1,producer_id=excluded.producer_id,producer_version=excluded.producer_version",
        params![
            snapshot.project,
            INDEX_KEY,
            generation,
            now,
            snapshot.source.digest,
            d1.dependency_set_digest,
            PRODUCER_ID,
            PRODUCER_VERSION,
        ],
    )?;

    // The write transaction still owns the snapshot. Re-read the qualified
    // roster immediately before Freshness publication; any mismatch aborts
    // the caller's transaction and therefore cannot leave a partial proof.
    ensure!(
        runtime.native_build_is_current(conn, snapshot.runtime_owner, snapshot.runtime_epoch)?
            && get_current_epoch(conn, &snapshot.project)?
                .is_some_and(|epoch| epoch.id == snapshot.semantic_epoch)
            && read_eligibility_source_for_native_build(
                conn,
                &snapshot.project,
                runtime,
                snapshot.runtime_owner,
                snapshot.runtime_epoch,
            )? == snapshot.source,
        "NIR1_GRAPH_SNAPSHOT_CHANGED_DURING_PUBLISH"
    );
    let edges = find_edges_by_consumer(conn, &snapshot.project, CONSUMER_KIND, INDEX_KEY)?;
    let observations = edges
        .iter()
        .map(|edge| {
            Ok((
                edge.id.clone(),
                evaluate_graph_edge(conn, &snapshot.project, edge)?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        observations.iter().all(|(_, observation)| {
            observation.freshness == EvidenceFreshness::Fresh
                && observation.build_action == BuildAction::None
                && observation.reason_code.is_none()
        }),
        "NIR1_GRAPH_SOURCE_CHANGED_DURING_PUBLISH"
    );
    let freshness_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    publish_complete_runless_graph_freshness_in_tx(
        conn,
        &snapshot.project,
        CONSUMER_KIND,
        INDEX_KEY,
        &observations,
        &snapshot.semantic_epoch,
        &freshness_at,
    )?;
    conn.execute(
        "UPDATE narrative_semantic_index_metadata
            SET dirty_cache_flag=0
          WHERE project_id=?1 AND index_key=?2 AND generation=?3",
        params![snapshot.project, INDEX_KEY, generation],
    )?;
    let final_read = read(conn, &snapshot.project)?;
    match final_read {
        BindingRead::Registered(binding) if binding.generation == generation && !binding.dirty => {
            Ok(binding)
        }
        other => anyhow::bail!("NIR1_GRAPH_PUBLISHED_BINDING_INCOHERENT: {other:?}"),
    }
}

fn evaluate_graph_edge(
    conn: &Connection,
    project: &str,
    edge: &DependencyEdge,
) -> Result<EdgeObservation> {
    let stored = serde_json::from_str::<Vec<String>>(&edge.read_set_json)?;
    ensure!(stored.len() == 1, "NIR1_GRAPH_V1_READ_SET_INVALID");
    let current = if edge.source_object_identity == source_key(project) {
        Some(stored[0].clone())
    } else {
        super::nir1_entity_relation::typed_source_token_for_incremental(
            conn,
            project,
            &edge.source_object_identity,
        )?
    };
    Ok(evaluate_edge(&EdgeComparisonInput {
        stored_revision_token: Some(stored[0].clone()),
        current_revision_token: current.clone(),
        current_source_exists: current.is_some(),
        comparison_available: current.is_some(),
        ..EdgeComparisonInput::default()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graph_source_sorts_qualified_roster_and_has_stable_digest() {
        let unsorted = vec![
            GraphObjectRosterEntry {
                object_id: "codex-relation:r-2".to_owned(),
                revision_id: "revision-2".to_owned(),
                decision_id: "decision-2".to_owned(),
                source_token: "token-2".to_owned(),
            },
            GraphObjectRosterEntry {
                object_id: "codex:e-1".to_owned(),
                revision_id: "revision-1".to_owned(),
                decision_id: "decision-1".to_owned(),
                source_token: "token-1".to_owned(),
            },
        ];

        let source = graph_source_from_roster("project-1", unsorted).expect("source");
        assert_eq!(source.roster[0].object_id, "codex-relation:r-2");
        assert_eq!(source.roster[1].object_id, "codex:e-1");
        assert_eq!(
            source,
            graph_source_from_roster("project-1", source.roster.clone()).expect("source")
        );
        assert!(source.digest.starts_with("sha256:"));
    }

    #[test]
    fn graph_source_enforces_the_512_record_admission_boundary() {
        let entry = |index: usize| GraphObjectRosterEntry {
            object_id: format!("codex:entity-{index}"),
            revision_id: format!("revision-{index}"),
            decision_id: format!("decision-{index}"),
            source_token: format!("source-token-{index}"),
        };
        let accepted = (0..(GRAPH_RECORD_ADMISSION - 1)).map(entry).collect();
        assert!(graph_source_from_roster("project-1", accepted).is_ok());

        let rejected = (0..GRAPH_RECORD_ADMISSION).map(entry).collect();
        let error = graph_source_from_roster("project-1", rejected)
            .expect_err("the source identity consumes one bounded admission record")
            .to_string();
        assert!(error.contains("NIR1_GRAPH_ROSTER_RECORD_LIMIT"), "{error}");
    }

    #[test]
    fn graph_sql_budget_and_cancellation_clear_the_progress_handler() -> Result<()> {
        let connection = Connection::open_in_memory()?;
        let query = "WITH RECURSIVE sequence(value) AS (
                         SELECT 1
                         UNION ALL
                         SELECT value + 1 FROM sequence WHERE value < 1000000
                     )
                     SELECT sum(value) FROM sequence";
        let budget_error = with_graph_sql_budget(&connection, None, || {
            connection
                .query_row(query, [], |row| row.get::<_, i64>(0))
                .map(|_| ())
                .map_err(Into::into)
        })
        .expect_err("the bounded SQL budget must interrupt the recursive query")
        .to_string();
        assert!(
            budget_error.contains("NIR1_GRAPH_SQL_RESOURCE_LIMIT"),
            "{budget_error}"
        );

        let cancellation_epoch = Arc::new(AtomicU64::new(2));
        let cancellation_error =
            with_graph_sql_budget(&connection, Some((&cancellation_epoch, 1)), || {
                connection
                    .query_row(query, [], |row| row.get::<_, i64>(0))
                    .map(|_| ())
                    .map_err(Into::into)
            })
            .expect_err("the cancellation epoch must interrupt the recursive query")
            .to_string();
        assert!(
            cancellation_error.contains("NIR1_GRAPH_ROSTER_CANCELLED"),
            "{cancellation_error}"
        );
        let reusable: i64 = connection.query_row("SELECT 1", [], |row| row.get(0))?;
        assert_eq!(reusable, 1);
        Ok(())
    }

    #[test]
    fn graph_no_wait_restores_busy_timeout_after_locked_write() -> Result<()> {
        let path = std::env::temp_dir().join(format!(
            "grimodex-nir1-graph-no-wait-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let result = (|| -> Result<()> {
            let primary = Connection::open(&path)?;
            let locker = Connection::open(&path)?;
            primary.busy_timeout(Duration::from_millis(5_000))?;
            primary.execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE graph_no_wait_test (id INTEGER PRIMARY KEY, value TEXT);",
            )?;
            locker.execute_batch("BEGIN EXCLUSIVE;")?;

            let started = std::time::Instant::now();
            let error = with_graph_no_wait(&primary, || {
                primary
                    .execute(
                        "INSERT INTO graph_no_wait_test (value) VALUES ('blocked')",
                        [],
                    )
                    .map(|_| ())
                    .map_err(Into::into)
            })
            .expect_err("Graph publication must fail immediately on an incompatible lock")
            .to_string();
            assert!(started.elapsed() < Duration::from_secs(1), "{error}");
            assert!(error.contains("locked"), "{error}");
            let timeout_ms: i64 =
                primary.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
            assert_eq!(timeout_ms, 5_000);

            locker.execute_batch("ROLLBACK;")?;
            primary.execute(
                "INSERT INTO graph_no_wait_test (value) VALUES ('reusable')",
                [],
            )?;
            let count: i64 =
                primary.query_row("SELECT COUNT(*) FROM graph_no_wait_test", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 1);
            Ok(())
        })();
        for suffix in ["", "-wal", "-shm"] {
            let mut candidate = path.as_os_str().to_owned();
            candidate.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(candidate));
        }
        result
    }
}
