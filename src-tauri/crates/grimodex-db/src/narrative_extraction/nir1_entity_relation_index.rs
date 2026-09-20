//! Native-only Graph Index binding for the reviewed NIR-1 Entity/Relation
//! surface.
//!
//! The binding is a sealed cache over the existing metadata, D1, V1 and
//! canonical Freshness authorities. It never persists adjacency or exposes a
//! product query. Adjacency remains the request-local `nir1_graph` primitive.

use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashSet},
    io::{self, Write},
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
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

// These limits remain the per-Revision validation envelope.  They are not
// whole-project roster/build limits: one project may contain any number of
// individually valid Revisions.
const REVISION_RECORD_ADMISSION: usize = narrative_nir1::MAX_GRAPH_RECORDS;
const REVISION_INPUT_BYTE_LIMIT: usize = narrative_nir1::MAX_GRAPH_INPUT_BYTES;
/// Test-only SQL cancellation cadence shared by the cancellation tests below.
#[cfg(test)]
const GRAPH_SQL_CHECK_INTERVAL: i32 = 1_000;
const GRAPH_SOURCE_PAGE_SIZE: i64 = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GraphWorkStage {
    Page,
    Row,
    A2,
    Material,
    Source,
    CompleteRegistration,
    Coverage,
    Restore,
    #[cfg(any(test, feature = "nir1-material-diagnostics"))]
    ColdReopen,
    Sort,
    Digest,
    Serialization,
    ResultAssembly,
    D1,
    Edge,
    Publish,
}

/// Request-local work control for the full-set producer.
///
/// This is intentionally a small internal seam rather than a generic
/// resource framework. The maintenance lane can provide a finite owner and
/// cancellation policy while the index keeps all checks in the caller-owned
/// transaction.
pub trait GraphWorkControl {
    fn check(&mut self, stage: GraphWorkStage) -> Result<()>;
}

pub(crate) struct NeverStopGraphWorkControl;

impl GraphWorkControl for NeverStopGraphWorkControl {
    fn check(&mut self, _stage: GraphWorkStage) -> Result<()> {
        Ok(())
    }
}

fn check_graph_work(
    control: &mut Option<&mut dyn GraphWorkControl>,
    stage: GraphWorkStage,
) -> Result<()> {
    if let Some(control) = control.as_deref_mut() {
        control.check(stage)?;
    }
    Ok(())
}

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
    pub material_kind: String,
    pub material_id: String,
    pub source_object_identity: String,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg(any(test, feature = "nir1-material-diagnostics"))]
pub(crate) struct GraphSnapshotCapacity {
    pub(crate) qualified_revisions: usize,
    pub(crate) roster_records: usize,
    pub(crate) dependency_edges: usize,
    pub(crate) roster_serialized_bytes: usize,
    pub(crate) edge_serialized_bytes: usize,
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
            self.cancellation_epoch.load(AtomicOrdering::Acquire) == self.epoch
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

#[cfg(any(test, feature = "nir1-material-diagnostics"))]
impl GraphIndexBuildSnapshot {
    pub(crate) fn capacity_shape_with_control(
        &self,
        control: &mut dyn GraphWorkControl,
    ) -> Result<GraphSnapshotCapacity> {
        let roster_bytes = serialized_json_array_len_with_control(&self.source.roster, control)?;
        // DependencyEdge is an internal DB projection and intentionally does
        // not implement Serialize.  Serialize the same request-local edge
        // container shape explicitly so both reported byte fields have the
        // same meaning; neither is presented as retained/live memory.
        let edge_bytes = {
            let mut edge_bytes = CountingJsonWriter::new(control);
            edge_bytes.write_bytes(b"[")?;
            for edge in &self.edges {
                edge_bytes.check(GraphWorkStage::Serialization)?;
                if edge_bytes.item_count > 0 {
                    edge_bytes.write_bytes(b",")?;
                }
                let payload = serde_json::json!({
                    "id": edge.id,
                    "projectId": edge.project_id,
                    "consumerKind": edge.consumer_kind,
                    "consumerKey": edge.consumer_key,
                    "sourceObjectIdentity": edge.source_object_identity,
                    "readSetJson": edge.read_set_json,
                    "generatedByTransactionId": edge.generated_by_transaction_id,
                    "createdAt": edge.created_at,
                    "owningRunId": edge.owning_run_id,
                });
                edge_bytes.write_json(&payload)?;
                edge_bytes.item_count += 1;
            }
            edge_bytes.write_bytes(b"]")?;
            edge_bytes.len
        };
        control.check(GraphWorkStage::Serialization)?;
        let mut qualified_revision_ids = BTreeSet::new();
        for entry in &self.source.roster {
            control.check(GraphWorkStage::ResultAssembly)?;
            qualified_revision_ids.insert(entry.revision_id.as_str());
        }
        let qualified_revisions = qualified_revision_ids.len();
        control.check(GraphWorkStage::ResultAssembly)?;
        Ok(GraphSnapshotCapacity {
            qualified_revisions,
            roster_records: self.source.roster.len(),
            dependency_edges: self.edges.len(),
            roster_serialized_bytes: roster_bytes,
            edge_serialized_bytes: edge_bytes,
        })
    }
}

#[cfg(any(test, feature = "nir1-material-diagnostics"))]
struct CountingJsonWriter<'a> {
    len: usize,
    item_count: usize,
    control: &'a mut dyn GraphWorkControl,
    error: Option<anyhow::Error>,
}

#[cfg(any(test, feature = "nir1-material-diagnostics"))]
impl<'a> CountingJsonWriter<'a> {
    fn new(control: &'a mut dyn GraphWorkControl) -> Self {
        Self {
            len: 0,
            item_count: 0,
            control,
            error: None,
        }
    }

    fn check(&mut self, stage: GraphWorkStage) -> Result<()> {
        self.control.check(stage)
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        let result = self.write_all(bytes);
        self.finish_io(result)
    }

    fn write_json<T: Serialize>(&mut self, value: &T) -> Result<()> {
        let result = serde_json::to_writer(&mut *self, value);
        self.finish_serde(result)
    }

    fn finish_io<T>(&mut self, result: io::Result<T>) -> Result<T> {
        if let Some(error) = self.error.take() {
            return Err(error);
        }
        Ok(result?)
    }

    fn finish_serde<T>(&mut self, result: serde_json::Result<T>) -> Result<T> {
        if let Some(error) = self.error.take() {
            return Err(error);
        }
        Ok(result?)
    }
}

#[cfg(any(test, feature = "nir1-material-diagnostics"))]
impl Write for CountingJsonWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Err(error) = self.control.check(GraphWorkStage::Serialization) {
            let message = error.to_string();
            self.error = Some(error);
            return Err(io::Error::other(message));
        }
        self.len = self
            .len
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("JSON length overflow"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(any(test, feature = "nir1-material-diagnostics"))]
fn serialized_json_array_len_with_control<T: Serialize>(
    values: &[T],
    control: &mut dyn GraphWorkControl,
) -> Result<usize> {
    let mut writer = CountingJsonWriter::new(control);
    writer.write_bytes(b"[")?;
    for (index, value) in values.iter().enumerate() {
        writer.check(GraphWorkStage::Serialization)?;
        if index > 0 {
            writer.write_bytes(b",")?;
        }
        writer.write_json(value)?;
        writer.check(GraphWorkStage::Serialization)?;
    }
    writer.write_bytes(b"]")?;
    writer.check(GraphWorkStage::Serialization)?;
    Ok(writer.len)
}

pub(crate) fn source_key(project: &str) -> String {
    format!("project:nir1-entity-relation-eligibility:{project}")
}

#[derive(Serialize)]
struct GraphSourceDigestInput<'a> {
    contract: &'static str,
    #[serde(rename = "projectId")]
    project_id: &'a str,
    #[serde(rename = "qualifiedCurrentRevisionRoster")]
    roster: &'a [GraphObjectRosterEntry],
}

struct GraphDigestSink<'a> {
    hasher: Sha256,
    len: usize,
    control: &'a mut dyn GraphWorkControl,
    error: Option<anyhow::Error>,
}

impl Write for GraphDigestSink<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Err(error) = self.control.check(GraphWorkStage::Digest) {
            let message = error.to_string();
            self.error = Some(error);
            return Err(io::Error::other(message));
        }
        self.hasher.update(bytes);
        self.len = self
            .len
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("JSON length overflow"))?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn graph_source_digest_input(
    project: &str,
    roster: &[GraphObjectRosterEntry],
    control: &mut dyn GraphWorkControl,
) -> Result<String> {
    let input = GraphSourceDigestInput {
        contract: "nir1-entity-relation-eligibility/1",
        project_id: project,
        roster,
    };
    let mut sink = GraphDigestSink {
        hasher: Sha256::new(),
        len: 0,
        control,
        error: None,
    };
    let (write_result, sink_error, digest) = {
        let write_result = serde_json::to_writer(&mut sink, &input);
        let sink_error = sink.error.take();
        let digest = sink.hasher.finalize();
        (write_result, sink_error, digest)
    };
    if let Some(error) = sink_error {
        return Err(error);
    }
    write_result?;
    control.check(GraphWorkStage::Digest)?;
    Ok(format!("sha256:{}", hex::encode(digest)))
}

struct RevisionInputStats {
    material_records: usize,
}

pub(crate) fn graph_source_from_roster(
    project: &str,
    roster: Vec<GraphObjectRosterEntry>,
) -> Result<GraphEligibilitySource> {
    let mut control = NeverStopGraphWorkControl;
    graph_source_from_roster_with_control(project, roster, &mut control)
}

pub(crate) fn graph_source_from_roster_with_control(
    project: &str,
    mut roster: Vec<GraphObjectRosterEntry>,
    control: &mut dyn GraphWorkControl,
) -> Result<GraphEligibilitySource> {
    ensure!(!project.trim().is_empty() && project.trim() == project);
    let mut material_tuples = HashSet::with_capacity(roster.len());
    for entry in &roster {
        control.check(GraphWorkStage::Row)?;
        ensure!(
            matches!(
                entry.material_kind.as_str(),
                "entity" | "relation" | "evidence"
            ),
            "NIR1_GRAPH_ROSTER_MATERIAL_KIND_INVALID"
        );
        for value in [
            &entry.material_id,
            &entry.source_object_identity,
            &entry.revision_id,
            &entry.decision_id,
            &entry.source_token,
        ] {
            ensure!(!value.trim().is_empty() && value.trim() == value);
        }
        ensure!(
            (entry.material_kind == "entity" && entry.source_object_identity.starts_with("codex:"))
                || (entry.material_kind == "relation"
                    && entry.source_object_identity.starts_with("codex-relation:"))
                || entry.material_kind == "evidence",
            "NIR1_GRAPH_ROSTER_SOURCE_IDENTITY_INVALID"
        );
        ensure!(
            material_tuples.insert((
                entry.material_kind.clone(),
                entry.material_id.clone(),
                entry.revision_id.clone(),
                entry.decision_id.clone(),
            )),
            "NIR1_GRAPH_ROSTER_DUPLICATE_MATERIAL"
        );
    }
    sort_roster_with_control(&mut roster, control)?;
    let digest = graph_source_digest_input(project, &roster, control)?;
    Ok(GraphEligibilitySource { digest, roster })
}

fn compare_roster_entries(
    left: &GraphObjectRosterEntry,
    right: &GraphObjectRosterEntry,
) -> Ordering {
    (
        &left.material_kind,
        &left.material_id,
        &left.source_object_identity,
        &left.revision_id,
        &left.decision_id,
        &left.source_token,
    )
        .cmp(&(
            &right.material_kind,
            &right.material_id,
            &right.source_object_identity,
            &right.revision_id,
            &right.decision_id,
            &right.source_token,
        ))
}

/// Sort in bounded chunks so cancellation is observed between comparator-heavy
/// sections.  The merge is deliberately local to the Graph roster and does
/// not introduce a reusable sorting framework or persistent staging table.
fn sort_roster_with_control(
    roster: &mut Vec<GraphObjectRosterEntry>,
    control: &mut dyn GraphWorkControl,
) -> Result<()> {
    const CHUNK: usize = 128;
    const MERGE_CHECK_INTERVAL: usize = 64;

    if roster.len() < 2 {
        control.check(GraphWorkStage::Sort)?;
        return Ok(());
    }
    for chunk in roster.chunks_mut(CHUNK) {
        control.check(GraphWorkStage::Sort)?;
        chunk.sort_by(compare_roster_entries);
        control.check(GraphWorkStage::Sort)?;
    }

    let mut width = CHUNK;
    while width < roster.len() {
        let mut merged = Vec::with_capacity(roster.len());
        let mut start = 0;
        while start < roster.len() {
            control.check(GraphWorkStage::Sort)?;
            let middle = (start + width).min(roster.len());
            let end = (middle + width).min(roster.len());
            let mut left = start;
            let mut right = middle;
            let mut since_check = 0;
            while left < middle || right < end {
                if since_check == MERGE_CHECK_INTERVAL {
                    control.check(GraphWorkStage::Sort)?;
                    since_check = 0;
                }
                match (left < middle, right < end) {
                    (true, true) if compare_roster_entries(&roster[left], &roster[right]) != Ordering::Greater => {
                        merged.push(roster[left].clone());
                        left += 1;
                    }
                    (true, true) => {
                        merged.push(roster[right].clone());
                        right += 1;
                    }
                    (true, false) => {
                        merged.push(roster[left].clone());
                        left += 1;
                    }
                    (false, true) => {
                        merged.push(roster[right].clone());
                        right += 1;
                    }
                    (false, false) => break,
                }
                since_check += 1;
            }
            start = end;
        }
        *roster = merged;
        control.check(GraphWorkStage::Sort)?;
        width = width.saturating_mul(2);
    }
    Ok(())
}

/// Read exactly the qualified current typed revisions. The A2 reader performs
/// the immutable revision, Decision, source, epoch and canonical Freshness
/// checks; this layer only projects the already-qualified bundle to a sorted
/// object/token roster.
pub(crate) fn read_eligibility_source(
    conn: &Connection,
    project: &str,
) -> Result<GraphEligibilitySource> {
    let mut control = NeverStopGraphWorkControl;
    read_eligibility_source_with_control(conn, project, &mut control)
}

pub(crate) fn read_eligibility_source_with_control(
    conn: &Connection,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<GraphEligibilitySource> {
    read_eligibility_source_bounded(conn, project, None, Some(control))
}

fn read_eligibility_source_for_native_build(
    conn: &Connection,
    project: &str,
    runtime: &NirChronicleIndexRuntime,
    owner: u64,
    epoch: u64,
    control: &mut dyn GraphWorkControl,
) -> Result<GraphEligibilitySource> {
    let admission = GraphReadAdmission {
        runtime,
        owner,
        epoch,
        cancellation_epoch: runtime.native_build_cancellation_epoch(),
    };
    admission.ensure_current(conn)?;
    // The outer NarrativeMaintenanceConnection scope owns the SQLite
    // progress hook and busy-timeout. Installing a second hook here would
    // replace that owner and clearing it on return would leave the outer
    // scope unable to interrupt the next statement. Runtime epochs are still
    // checked at every page/row/material boundary below; the outer hook
    // handles prompt stop-flag interruption while SQL is executing.
    read_eligibility_source_bounded(conn, project, Some(&admission), Some(control))
}

/// Test-only helper exercising SQL cancellation cadences.
#[cfg(test)]
fn with_graph_sql_cancellation<T, F>(
    conn: &Connection,
    cancellation_epoch: Option<(&Arc<AtomicU64>, u64)>,
    operation: F,
) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    let Some((cancellation_epoch, expected_epoch)) = cancellation_epoch else {
        return operation();
    };
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancelled_for_hook = Arc::clone(&cancelled);
    let cancellation_epoch = Arc::clone(cancellation_epoch);
    conn.progress_handler(
        GRAPH_SQL_CHECK_INTERVAL,
        Some(move || {
            if cancellation_epoch.load(AtomicOrdering::Acquire) != expected_epoch {
                cancelled_for_hook.store(true, AtomicOrdering::Release);
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
    if cancelled.load(AtomicOrdering::Acquire) {
        anyhow::bail!("NIR1_GRAPH_ROSTER_CANCELLED");
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
    mut control: Option<&mut dyn GraphWorkControl>,
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
    let mut roster = Vec::new();
    let mut cursor = String::new();
    let mut seen_revision_ids = HashSet::new();
    loop {
        check_graph_work(&mut control, GraphWorkStage::Page)?;
        if let Some(admission) = admission {
            admission.ensure_current(conn)?;
        }
        let mut statement = conn.prepare(
            "SELECT
                    length(CAST(proposal.id AS BLOB)),
                    length(CAST(proposal.current_revision_id AS BLOB)),
                    proposal.id,
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
                AND proposal.id > ?4
              ORDER BY proposal.id ASC
              LIMIT ?5",
        )?;
        let mut rows = statement.query(params![
            project,
            super::nir1_entity_relation::NIR1_ENTITY_RELATION_SET_KIND,
            super::nir1_entity_relation::NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            &cursor,
            GRAPH_SOURCE_PAGE_SIZE,
        ])?;
        let mut page = Vec::with_capacity(GRAPH_SOURCE_PAGE_SIZE as usize);
        while let Some(row) = rows.next()? {
            // Check the caller-owned stop boundary and both scalar byte
            // lengths before asking rusqlite to allocate either key. The
            // proposal primary key is the existing indexed keyset cursor;
            // revision IDs are request-local values and may be repeated by
            // multiple proposals.
            check_graph_work(&mut control, GraphWorkStage::Row)?;
            if let Some(admission) = admission {
                admission.ensure_current(conn)?;
            }
            let proposal_id_bytes = usize::try_from(row.get::<_, i64>(0)?)
                .map_err(|_| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
            ensure!(
                proposal_id_bytes <= REVISION_INPUT_BYTE_LIMIT,
                "NIR1_GRAPH_ROSTER_INPUT_LIMIT"
            );
            let revision_id_bytes = usize::try_from(row.get::<_, i64>(1)?)
                .map_err(|_| anyhow::anyhow!("NIR1_GRAPH_ROSTER_INPUT_LIMIT"))?;
            ensure!(
                revision_id_bytes <= REVISION_INPUT_BYTE_LIMIT,
                "NIR1_GRAPH_ROSTER_INPUT_LIMIT"
            );
            page.push((row.get::<_, String>(2)?, row.get::<_, String>(3)?));
        }
        if page.is_empty() {
            break;
        }
        for (proposal_id, revision_id) in page {
            // Advance by every scanned proposal, including an ineligible one.
            // This keyset boundary is the existing primary key, so an
            // all-ineligible page cannot be mistaken for end-of-input. A
            // revision can be pointed to by multiple proposals; validate it
            // once per request-local source build.
            cursor = proposal_id;
            if !seen_revision_ids.insert(revision_id.clone()) {
                continue;
            }
            if let Some(admission) = admission {
                admission.ensure_current(conn)?;
            }
            let Some(input_stats) =
                read_revision_input_stats(conn, project, &revision_id, admission)?
            else {
                continue;
            };
            check_graph_work(&mut control, GraphWorkStage::A2)?;
            if !preflight_revision_source_basis(conn, project, &revision_id, admission)? {
                continue;
            }
            if preflight_live_source_lengths(conn, project, &revision_id, admission)?.is_none() {
                continue;
            }
            #[cfg(test)]
            if let Some(admission) = admission {
                if take_native_prepare_test_cancellation() {
                    admission.runtime.pause()?;
                }
            }
            check_graph_work(&mut control, GraphWorkStage::A2)?;
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
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_REVISION_RECORD_LIMIT"))?;
            ensure!(
                material_records == input_stats.material_records,
                "NIR1_GRAPH_ROSTER_RECORD_MISMATCH"
            );
            append_revision_roster(&mut roster, &revision, &decision_id, &mut control)?;
            if let Some(admission) = admission {
                admission.ensure_current(conn)?;
            }
        }
    }
    if let Some(admission) = admission {
        admission.ensure_current(conn)?;
    }
    let source = if let Some(control) = control {
        graph_source_from_roster_with_control(project, roster, control)?
    } else {
        graph_source_from_roster(project, roster)?
    };
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
    // The 2 MiB contract is the semantic bundle admission enforced by the
    // A2 reader.  The persisted envelope carries basis and provenance JSON in
    // addition to that bundle, so payload and envelope may legitimately sum
    // above 2 MiB even when the bundle remains within its contract.  Guard
    // each stored component independently before the A2 reader allocates both
    // strings. This is an operational resource failure, not an ordinary
    // ineligible Revision: abort the source build so a partial roster can
    // never be published as complete.
    if !persisted_revision_components_within_limit(payload_bytes, envelope_bytes) {
        anyhow::bail!("NIR1_GRAPH_PERSISTED_REVISION_INPUT_LIMIT");
    }
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
                                    CASE WHEN json_valid(revision.payload_json)
                                              AND json_type(
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
    if material_records
        .checked_add(1)
        .is_none_or(|count| count > REVISION_RECORD_ADMISSION)
    {
        return Ok(None);
    }
    Ok(Some(RevisionInputStats { material_records }))
}

fn persisted_revision_components_within_limit(
    payload_bytes: usize,
    envelope_bytes: usize,
) -> bool {
    payload_bytes <= REVISION_INPUT_BYTE_LIMIT && envelope_bytes <= REVISION_INPUT_BYTE_LIMIT
}

/// Confirm that the sealed payload names exactly the material Sources bound by
/// the persisted basis before any live Source body is read. SQLite's JSON
/// operators inspect only the already-size-bounded payload and return scalar
/// ids/tokens; the Rust A2 reader therefore cannot allocate a large live body
/// for a Source whose basis row was deleted or replaced.
fn preflight_revision_source_basis(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    admission: Option<&GraphReadAdmission<'_>>,
) -> Result<bool> {
    if let Some(admission) = admission {
        admission.ensure_current(conn)?;
    }
    let scope_key = format!("project:scope-authority:{project}");
    let (
        payload_source_count,
        basis_count,
        scope_count,
        matched_payload_count,
        matched_basis_count,
        payload_scope_count,
        matched_scope_count,
        invalid_entity_count,
        invalid_relation_count,
    ): (i64, i64, i64, i64, i64, i64, i64, i64, i64) = conn.query_row(
        "WITH entity_sources AS (
                 SELECT entity.type AS element_type,
                        CASE WHEN entity.type = 'object' AND json_valid(entity.value)
                             THEN json_extract(entity.value, '$.entityId') END AS material_id,
                        CASE WHEN entity.type = 'object' AND json_valid(entity.value)
                             THEN json_extract(entity.value, '$.sourceToken') END AS source_token,
                        CASE WHEN entity.type = 'object' AND json_valid(entity.value)
                             THEN json_extract(entity.value, '$.scope.authorityRevision') END AS scope_token,
                        CASE WHEN entity.type = 'object' AND json_valid(entity.value)
                             THEN json_type(entity.value, '$.entityId') END AS material_id_type,
                        CASE WHEN entity.type = 'object' AND json_valid(entity.value)
                             THEN json_type(entity.value, '$.sourceToken') END AS source_token_type,
                        CASE WHEN entity.type = 'object' AND json_valid(entity.value)
                             THEN json_type(entity.value, '$.scope.authorityRevision') END AS scope_token_type
                   FROM narrative_proposal_revisions revision
                   JOIN json_each(
                        CASE WHEN json_valid(revision.payload_json)
                                  AND json_type(revision.payload_json, '$.bundle.entities') = 'array'
                             THEN json_extract(revision.payload_json, '$.bundle.entities')
                             ELSE '[]' END
                   ) AS entity
                  WHERE revision.id = ?1
             ), relation_sources AS (
                 SELECT relation.type AS element_type,
                        CASE WHEN relation.type = 'object' AND json_valid(relation.value)
                             THEN json_extract(relation.value, '$.edgeId') END AS material_id,
                        CASE WHEN relation.type = 'object' AND json_valid(relation.value)
                             THEN json_extract(relation.value, '$.sourceToken') END AS source_token,
                        CASE WHEN relation.type = 'object' AND json_valid(relation.value)
                             THEN json_type(relation.value, '$.edgeId') END AS material_id_type,
                        CASE WHEN relation.type = 'object' AND json_valid(relation.value)
                             THEN json_type(relation.value, '$.sourceToken') END AS source_token_type
                   FROM narrative_proposal_revisions revision
                   JOIN json_each(
                        CASE WHEN json_valid(revision.payload_json)
                                  AND json_type(revision.payload_json, '$.bundle.relations') = 'array'
                             THEN json_extract(revision.payload_json, '$.bundle.relations')
                             ELSE '[]' END
                   ) AS relation
                  WHERE revision.id = ?1
             ), payload_sources AS (
                 SELECT 'codex-entry' AS source_kind,
                        'codex:' || material_id AS source_key,
                        source_token
                   FROM entity_sources
                  UNION ALL
                 SELECT 'codex-relation',
                        'codex-relation:' || material_id,
                        source_token
                   FROM relation_sources
             ), payload_scopes AS (
                 SELECT scope_token
                   FROM entity_sources
                  WHERE scope_token IS NOT NULL
             ), basis AS (
                 SELECT source_kind, source_key, revision_token
                   FROM narrative_revision_source_basis
                  WHERE revision_id = ?1
             )
         SELECT
             (SELECT COUNT(*) FROM payload_sources),
             (SELECT COUNT(*) FROM basis),
             (SELECT COUNT(*) FROM basis
               WHERE source_kind = 'project-scope-authority' AND source_key = ?2),
             (SELECT COUNT(*)
                FROM payload_sources payload
               WHERE EXISTS (
                     SELECT 1 FROM basis
                      WHERE basis.source_kind = payload.source_kind
                        AND basis.source_key = payload.source_key
                        AND basis.revision_token = payload.source_token
               )),
             (SELECT COUNT(*)
                FROM basis material
               WHERE material.source_kind IN ('codex-entry', 'codex-relation')
                 AND EXISTS (
                     SELECT 1 FROM payload_sources payload
                      WHERE payload.source_kind = material.source_kind
                        AND payload.source_key = material.source_key
                        AND payload.source_token = material.revision_token
               )),
             (SELECT COUNT(*) FROM payload_scopes),
             (SELECT COUNT(*)
                FROM payload_scopes payload
               WHERE EXISTS (
                     SELECT 1 FROM basis
                      WHERE basis.source_kind = 'project-scope-authority'
                        AND basis.source_key = ?2
                        AND basis.revision_token = payload.scope_token
               )),
             (SELECT COUNT(*)
                FROM entity_sources
               WHERE COALESCE(element_type, '') <> 'object'
                  OR COALESCE(material_id_type, '') <> 'text'
                  OR COALESCE(source_token_type, '') <> 'text'
                  OR COALESCE(scope_token_type, '') <> 'text'),
             (SELECT COUNT(*)
                FROM relation_sources
               WHERE COALESCE(element_type, '') <> 'object'
                  OR COALESCE(material_id_type, '') <> 'text'
                  OR COALESCE(source_token_type, '') <> 'text')",
        params![revision_id, scope_key],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
            ))
        },
    )?;
    if let Some(admission) = admission {
        admission.ensure_current(conn)?;
    }
    Ok(
        basis_count == payload_source_count + 1
            && scope_count == 1
            && matched_payload_count == payload_source_count
            && matched_basis_count == payload_source_count
            && invalid_entity_count == 0
            && invalid_relation_count == 0
            && (payload_scope_count == 0 || matched_scope_count == payload_scope_count),
    )
}

/// Preflight the live Source values that the A2 reader will resolve. The
/// query returns only counts and lengths, so source payloads and JSON are not
/// allocated until the per-Revision envelope has passed its admission check.
/// `None` means this candidate is no longer a valid typed Source; callers
/// skip it as an ordinary A2-unavailable Revision.
fn preflight_live_source_lengths(
    conn: &Connection,
    project: &str,
    revision_id: &str,
    admission: Option<&GraphReadAdmission<'_>>,
) -> Result<Option<usize>> {
    if let Some(admission) = admission {
        admission.ensure_current(conn)?;
    }
    let (basis_count, matched_count, bytes): (i64, i64, i64) = conn.query_row(
        "SELECT COUNT(*),
                SUM(CASE
                    WHEN basis.source_kind = 'codex-entry'
                     AND entry.id IS NOT NULL
                     AND basis.revision_token = 'codex:' || entry.id || '@' || entry.updated_at THEN 1
                    WHEN basis.source_kind = 'codex-relation'
                     AND relation.id IS NOT NULL
                     AND basis.revision_token = 'v' || relation.version || '@'
                         || relation.updated_at || ':relation:' || relation.id THEN 1
                    WHEN basis.source_kind = 'project-scope-authority'
                     AND basis.source_key = ?2 THEN 1
                    ELSE 0
                END),
                COALESCE(SUM(
                    COALESCE(length(CAST(basis.source_key AS BLOB)), 0)
                  + COALESCE(length(CAST(basis.revision_token AS BLOB)), 0)
                  + COALESCE(length(CAST(entry.id AS BLOB)), 0)
                  + COALESCE(length(CAST(entry.type AS BLOB)), 0)
                  + COALESCE(length(CAST(entry.name AS BLOB)), 0)
                  + COALESCE(length(CAST(entry.summary AS BLOB)), 0)
                  + COALESCE(length(CAST(entry.updated_at AS BLOB)), 0)
                  + COALESCE(length(CAST(relation.id AS BLOB)), 0)
                  + COALESCE(length(CAST(relation.from_codex_id AS BLOB)), 0)
                  + COALESCE(length(CAST(relation.to_codex_id AS BLOB)), 0)
                  + COALESCE(length(CAST(relation.relation_type AS BLOB)), 0)
                  + COALESCE(length(CAST(relation.directionality AS BLOB)), 0)
                  + COALESCE(length(CAST(relation.version AS BLOB)), 0)
                  + COALESCE(length(CAST(relation.updated_at AS BLOB)), 0)
                ), 0)
           FROM narrative_revision_source_basis basis
           LEFT JOIN codex_entries entry
             ON basis.source_kind = 'codex-entry'
            AND substr(basis.source_key, 1, 6) = 'codex:'
            AND entry.id = substr(basis.source_key, 7)
            AND entry.project_id = ?1
            AND entry.context_mode NOT IN ('hidden', 'suppress')
           LEFT JOIN codex_relations relation
             ON basis.source_kind = 'codex-relation'
            AND substr(basis.source_key, 1, 15) = 'codex-relation:'
            AND relation.id = substr(basis.source_key, 16)
            AND relation.project_id = ?1
          WHERE basis.revision_id = ?3",
        params![project, format!("project:scope-authority:{project}"), revision_id],
        |row| Ok((row.get(0)?, row.get::<_, Option<i64>>(1)?.unwrap_or(0), row.get(2)?)),
    )?;
    if basis_count == 0 || basis_count != matched_count {
        return Ok(None);
    }
    let bytes =
        usize::try_from(bytes).map_err(|_| anyhow::anyhow!("NIR1_GRAPH_REVISION_INPUT_LIMIT"))?;
    if bytes > REVISION_INPUT_BYTE_LIMIT {
        return Ok(None);
    }
    if let Some(admission) = admission {
        admission.ensure_current(conn)?;
    }
    Ok(Some(bytes))
}

fn append_revision_roster(
    roster: &mut Vec<GraphObjectRosterEntry>,
    revision: &Nir1EntityRelationRevision,
    decision_id: &str,
    control: &mut Option<&mut dyn GraphWorkControl>,
) -> Result<()> {
    for entity in &revision.bundle.entities {
        check_graph_work(control, GraphWorkStage::Material)?;
        roster.push(GraphObjectRosterEntry {
            material_kind: "entity".to_owned(),
            material_id: entity.entity_id.clone(),
            source_object_identity: format!("codex:{}", entity.entity_id),
            revision_id: revision.revision_id.clone(),
            decision_id: decision_id.to_owned(),
            source_token: entity.source_token.clone(),
        });
    }
    for relation in &revision.bundle.relations {
        check_graph_work(control, GraphWorkStage::Material)?;
        roster.push(GraphObjectRosterEntry {
            material_kind: "relation".to_owned(),
            material_id: relation.edge_id.clone(),
            source_object_identity: format!("codex-relation:{}", relation.edge_id),
            revision_id: revision.revision_id.clone(),
            decision_id: decision_id.to_owned(),
            source_token: relation.source_token.clone(),
        });
    }
    for evidence in &revision.material_basis.evidence_set {
        check_graph_work(control, GraphWorkStage::Material)?;
        roster.push(GraphObjectRosterEntry {
            material_kind: "evidence".to_owned(),
            material_id: evidence.evidence_ref.clone(),
            source_object_identity: evidence.source_key.clone(),
            revision_id: revision.revision_id.clone(),
            decision_id: decision_id.to_owned(),
            source_token: evidence.revision_token.clone(),
        });
    }
    Ok(())
}

/// Capacity-diagnostics-only binding read: production readers enter through
/// `read_with_control` so cancellation and foreground preemption stay owned.
#[cfg(any(test, feature = "nir1-material-diagnostics"))]
pub(crate) fn read(conn: &Connection, project: &str) -> Result<BindingRead> {
    read_internal(conn, project, true, true, None)
}

fn read_with_control(
    conn: &Connection,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<BindingRead> {
    read_internal(conn, project, true, true, Some(control))
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
        read_internal(conn, project, false, false, None)?,
        BindingRead::Registered(_)
    ))
}

fn read_internal(
    conn: &Connection,
    project: &str,
    require_freshness: bool,
    require_current_freshness: bool,
    mut control: Option<&mut dyn GraphWorkControl>,
) -> Result<BindingRead> {
    check_graph_work(&mut control, GraphWorkStage::Coverage)?;
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
    check_graph_work(&mut control, GraphWorkStage::Coverage)?;
    let declaration =
        read_active_dependency_declaration_set_in_tx(conn, project, CONSUMER_KIND, INDEX_KEY)?;
    check_graph_work(&mut control, GraphWorkStage::D1)?;
    let Some((generation, source_digest, dependency_digest, dirty, producer, version, built_at)) =
        row
    else {
        let residue: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM narrative_dependency_edges WHERE project_id=?1 AND consumer_kind=?2 AND consumer_key=?3)
               OR EXISTS(SELECT 1 FROM narrative_consumer_freshness WHERE project_id=?1 AND consumer_kind=?2 AND consumer_key=?3)",
            params![project, CONSUMER_KIND, INDEX_KEY],
            |row| row.get(0),
        )?;
        check_graph_work(&mut control, GraphWorkStage::Coverage)?;
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
    check_graph_work(&mut control, GraphWorkStage::Digest)?;
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
    check_graph_work(&mut control, GraphWorkStage::D1)?;
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
    check_graph_work(&mut control, GraphWorkStage::Coverage)?;
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
    check_graph_work(&mut control, GraphWorkStage::Edge)?;
    let source_identity = source_key(project);
    let mut declaration_tuples = HashSet::with_capacity(declaration.entries.len());
    for entry in &declaration.entries {
        check_graph_work(&mut control, GraphWorkStage::D1)?;
        if entry.dependency_role != DependencyRole::RankingOnly
            || entry.selector_json != "{\"kind\":\"whole-source\"}"
            || !declaration_tuples.insert((
                entry.source_object_identity.clone(),
                entry.dependency_role.as_str().to_owned(),
                entry.selector_json.clone(),
            ))
        {
            return Ok(BindingRead::Reserved);
        }
    }
    let mut edge_tuples = HashSet::with_capacity(edges.len());
    for edge in &edges {
        check_graph_work(&mut control, GraphWorkStage::Edge)?;
        edge_tuples.insert((
            edge.source_object_identity.clone(),
            DependencyRole::RankingOnly.as_str().to_owned(),
            "{\"kind\":\"whole-source\"}".to_owned(),
        ));
    }
    if edges.len() != declaration.entries.len()
        || declaration_tuples != edge_tuples
        || !declaration_tuples
            .iter()
            .any(|(identity, _, _)| identity == &source_identity)
    {
        return Ok(BindingRead::Reserved);
    }
    for edge in &edges {
        check_graph_work(&mut control, GraphWorkStage::Edge)?;
        let Ok(tokens) = serde_json::from_str::<Vec<String>>(&edge.read_set_json) else {
            return Ok(BindingRead::Reserved);
        };
        let mut canonical_token_set = BTreeSet::new();
        for token in &tokens {
            check_graph_work(&mut control, GraphWorkStage::Edge)?;
            canonical_token_set.insert(token.clone());
        }
        let mut canonical_tokens = Vec::with_capacity(canonical_token_set.len());
        for token in canonical_token_set {
            check_graph_work(&mut control, GraphWorkStage::Sort)?;
            canonical_tokens.push(token);
        }
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
    let mut control = NeverStopGraphWorkControl;
    is_registered_with_control(conn, project, key, &mut control)
}

pub(crate) fn is_registered_with_control(
    conn: &Connection,
    project: &str,
    key: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<bool> {
    control.check(GraphWorkStage::Coverage)?;
    if conn.is_autocommit() {
        let tx = conn.unchecked_transaction()?;
        return is_registered_with_control(&tx, project, key, control);
    }
    if key != INDEX_KEY
        || conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))? < 35
    {
        return Ok(false);
    }
    control.check(GraphWorkStage::Coverage)?;
    Ok(matches!(read_internal(conn, project, true, true, Some(control))?, BindingRead::Registered(_)))
}

/// Check whether the exact Graph binding is completely registered and live
/// across the whole project.
pub fn is_complete_registered(conn: &Connection, project: &str, key: &str) -> Result<bool> {
    let mut control = NeverStopGraphWorkControl;
    is_complete_registered_with_control(conn, project, key, &mut control)
}

/// Controlled complete-registration verification for whole-project
/// maintenance. Structural `is_registered` remains a separate cheap check;
/// this path re-resolves the exact roster and live freshness under the caller
/// owned control.
pub(crate) fn is_complete_registered_with_control(
    conn: &Connection,
    project: &str,
    key: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<bool> {
    if key != INDEX_KEY {
        return Ok(false);
    }
    if conn.is_autocommit() {
        let tx = conn.unchecked_transaction()?;
        return is_complete_registered_with_control(&tx, project, key, control);
    }
    control.check(GraphWorkStage::CompleteRegistration)?;
    let BindingRead::Registered(binding) = read_with_control(conn, project, control)? else {
        return Ok(false);
    };
    let Some(epoch) = get_current_epoch(conn, project)? else {
        return Ok(false);
    };
    control.check(GraphWorkStage::Source)?;
    let source = read_eligibility_source_with_control(conn, project, control)?;
    if binding.source_digest != source.digest {
        return Ok(false);
    }
    let edges = find_edges_by_consumer(conn, project, CONSUMER_KIND, key)?;
    if !edges_match_source_with_control(&edges, project, &source, control)? {
        return Ok(false);
    }
    control.check(GraphWorkStage::Coverage)?;
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
    control.check(GraphWorkStage::CompleteRegistration)?;
    Ok(!binding.dirty)
}

fn edges_match_source_with_control(
    edges: &[DependencyEdge],
    project: &str,
    source: &GraphEligibilitySource,
    control: &mut dyn GraphWorkControl,
) -> Result<bool> {
    let mut expected = BTreeMap::<String, BTreeSet<String>>::new();
    expected.insert(
        source_key(project),
        [source.digest.clone()].into_iter().collect(),
    );
    for entry in &source.roster {
        control.check(GraphWorkStage::Coverage)?;
        expected
            .entry(entry.source_object_identity.clone())
            .or_default()
            .insert(entry.source_token.clone());
    }
    control.check(GraphWorkStage::Coverage)?;
    if expected.len() != edges.len() {
        return Ok(false);
    }
    for edge in edges {
        control.check(GraphWorkStage::Coverage)?;
        let Some(tokens) = expected.get(&edge.source_object_identity) else {
            return Ok(false);
        };
        let actual = serde_json::from_str::<Vec<String>>(&edge.read_set_json).ok();
        let Some(actual) = actual else {
            return Ok(false);
        };
        let mut actual_tokens = BTreeSet::new();
        for token in actual {
            control.check(GraphWorkStage::Coverage)?;
            actual_tokens.insert(token);
        }
        control.check(GraphWorkStage::Coverage)?;
        if &actual_tokens != tokens {
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
    let mut control = NeverStopGraphWorkControl;
    prepare_graph_index_build_with_control(conn, runtime, project, &mut control)
}

pub(crate) fn prepare_graph_index_build_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<GraphIndexBuildSnapshot> {
    prepare_graph_index_build_in_tx(conn, runtime, project, control)
}

fn prepare_graph_index_build_in_tx(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
    control: &mut dyn GraphWorkControl,
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
    control.check(GraphWorkStage::Page)?;
    let source = read_eligibility_source_for_native_build(
        conn,
        project,
        runtime,
        runtime_owner,
        runtime_epoch,
        control,
    )?;
    let prior = match read_with_control(conn, project, control)? {
        BindingRead::Missing => None,
        BindingRead::Registered(binding) => Some(binding),
        BindingRead::Reserved => anyhow::bail!("NIR1_GRAPH_BINDING_RESERVED"),
    };
    let edges = input_edges_with_control(project, &source, control)?;
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

/// Test-only entry point: production snapshots are compared through
/// `snapshot_current_with_control` so cancellation stays owned.
#[cfg(test)]
fn input_edges(project: &str, source: &GraphEligibilitySource) -> Result<Vec<DependencyEdge>> {
    let mut control = NeverStopGraphWorkControl;
    input_edges_with_control(project, source, &mut control)
}

fn input_edges_with_control(
    project: &str,
    source: &GraphEligibilitySource,
    control: &mut dyn GraphWorkControl,
) -> Result<Vec<DependencyEdge>> {
    let mut sources = BTreeMap::<String, BTreeSet<String>>::new();
    sources.insert(
        source_key(project),
        [source.digest.clone()].into_iter().collect(),
    );
    for entry in &source.roster {
        control.check(GraphWorkStage::Edge)?;
        sources
            .entry(entry.source_object_identity.clone())
            .or_default()
            .insert(entry.source_token.clone());
    }
    let mut edges = Vec::with_capacity(sources.len());
    for (identity, tokens) in sources {
        control.check(GraphWorkStage::Edge)?;
        let mut ordered_tokens = Vec::with_capacity(tokens.len());
        for token in tokens {
            control.check(GraphWorkStage::Sort)?;
            ordered_tokens.push(token);
        }
        control.check(GraphWorkStage::Serialization)?;
        let read_set_json = serde_json::to_string(&ordered_tokens)?;
        control.check(GraphWorkStage::Serialization)?;
        edges.push(DependencyEdge {
            id: String::new(),
            project_id: project.to_owned(),
            consumer_kind: CONSUMER_KIND.to_owned(),
            consumer_key: INDEX_KEY.to_owned(),
            source_object_identity: identity,
            read_set_json,
            generated_by_transaction_id: None,
            created_at: String::new(),
            owning_run_id: None,
        });
    }
    control.check(GraphWorkStage::ResultAssembly)?;
    Ok(edges)
}

fn snapshot_current_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    snapshot: &GraphIndexBuildSnapshot,
    control: &mut dyn GraphWorkControl,
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
    let prior = match read_with_control(conn, &snapshot.project, control)? {
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
        control,
    )?;
    Ok(source == snapshot.source
        && input_edges_with_control(&snapshot.project, &source, control)? == snapshot.edges)
}

fn ensure_snapshot_edges_are_sealed_with_control(
    snapshot: &GraphIndexBuildSnapshot,
    control: &mut dyn GraphWorkControl,
) -> Result<()> {
    ensure!(
        input_edges_with_control(&snapshot.project, &snapshot.source, control)? == snapshot.edges,
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
    let mut control = NeverStopGraphWorkControl;
    with_graph_no_wait(conn, || {
        publish_nir1_entity_relation_index_in_tx_inner(conn, runtime, snapshot, &mut control)
    })
}

#[cfg(any(test, feature = "nir1-material-diagnostics"))]
pub(crate) fn publish_nir1_entity_relation_index_in_tx_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    snapshot: GraphIndexBuildSnapshot,
    control: &mut dyn GraphWorkControl,
) -> Result<StoredBinding> {
    publish_nir1_entity_relation_index_in_tx_inner(conn, runtime, snapshot, control)
}

/// Recheck a complete registration after a workspace reopen using the new
/// runtime's caller-owned transaction. This keeps cold-reopen validation under
/// the same cancellation and foreground-preemption owner as build/publish.
///
/// Capacity-diagnostics-only: no production reader reopens a registration
/// outside a measured diagnostic mode.
#[cfg(feature = "nir1-material-diagnostics")]
pub(crate) fn cold_reopen_graph_index_with_control(
    conn: &Connection,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<bool> {
    control.check(GraphWorkStage::ColdReopen)?;
    is_complete_registered_with_control(conn, project, INDEX_KEY, control)
}

fn publish_nir1_entity_relation_index_in_tx_inner(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    snapshot: GraphIndexBuildSnapshot,
    control: &mut dyn GraphWorkControl,
) -> Result<StoredBinding> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 Graph publication requires a write transaction"
    );
    // This is deliberately before the first D1/V1/metadata write. The
    // snapshot is opaque in production, and the exact deterministic edge
    // set is recomputed from its sealed roster so partial, extra, or
    // field-tampered input cannot advance a generation.
    control.check(GraphWorkStage::Publish)?;
    ensure_snapshot_edges_are_sealed_with_control(&snapshot, control)?;
    ensure!(
        snapshot_current_with_control(conn, runtime, &snapshot, control)?,
        "NIR1_GRAPH_SNAPSHOT_STALE"
    );
    let generation = snapshot
        .prior
        .as_ref()
        .map_or(0, |binding| binding.generation)
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("NIR1 Graph generation exhausted"))?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut declarations = Vec::with_capacity(snapshot.edges.len());
    for edge in &snapshot.edges {
        control.check(GraphWorkStage::D1)?;
        declarations.push(DependencyDeclaration {
            source_object_identity: edge.source_object_identity.clone(),
            role: DependencyRole::RankingOnly,
            selector: DependencySelector::WholeSource,
        });
    }
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
    control.check(GraphWorkStage::Edge)?;
    delete_edges_for_consumer_in_tx(conn, &snapshot.project, CONSUMER_KIND, INDEX_KEY)?;
    for edge in &snapshot.edges {
        control.check(GraphWorkStage::Edge)?;
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
    control.check(GraphWorkStage::Publish)?;
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
    control.check(GraphWorkStage::Publish)?;
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
                control,
            )? == snapshot.source,
        "NIR1_GRAPH_SNAPSHOT_CHANGED_DURING_PUBLISH"
    );
    let edges = find_edges_by_consumer(conn, &snapshot.project, CONSUMER_KIND, INDEX_KEY)?;
    let mut observations = Vec::with_capacity(edges.len());
    for edge in &edges {
        control.check(GraphWorkStage::Edge)?;
        observations.push((
            edge.id.clone(),
            evaluate_graph_edge(conn, &snapshot.project, edge)?,
        ));
    }
    ensure!(
        observations.iter().all(|(_, observation)| {
            observation.freshness == EvidenceFreshness::Fresh
                && observation.build_action == BuildAction::None
                && observation.reason_code.is_none()
        }),
        "NIR1_GRAPH_SOURCE_CHANGED_DURING_PUBLISH"
    );
    let freshness_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    control.check(GraphWorkStage::Publish)?;
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
    control.check(GraphWorkStage::Publish)?;
    let final_read = read_with_control(conn, &snapshot.project, control)?;
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
    fn persisted_revision_components_are_guarded_independently() {
        assert!(persisted_revision_components_within_limit(
            REVISION_INPUT_BYTE_LIMIT,
            REVISION_INPUT_BYTE_LIMIT,
        ));
        assert!(!persisted_revision_components_within_limit(
            REVISION_INPUT_BYTE_LIMIT + 1,
            0,
        ));
        assert!(!persisted_revision_components_within_limit(
            0,
            REVISION_INPUT_BYTE_LIMIT + 1,
        ));
    }

    struct StopAt(GraphWorkStage);

    impl GraphWorkControl for StopAt {
        fn check(&mut self, stage: GraphWorkStage) -> Result<()> {
            if stage == self.0 {
                anyhow::bail!("NIR1_GRAPH_TEST_CANCELLED_{stage:?}");
            }
            Ok(())
        }
    }

    struct StopAfter {
        stage: GraphWorkStage,
        remaining: usize,
    }

    impl GraphWorkControl for StopAfter {
        fn check(&mut self, stage: GraphWorkStage) -> Result<()> {
            if stage == self.stage {
                if self.remaining == 0 {
                    anyhow::bail!("NIR1_GRAPH_TEST_CANCELLED_AFTER_{stage:?}");
                }
                self.remaining -= 1;
            }
            Ok(())
        }
    }

    struct TypedStop(GraphWorkStage);

    impl GraphWorkControl for TypedStop {
        fn check(&mut self, stage: GraphWorkStage) -> Result<()> {
            if stage == self.0 {
                return Err(crate::narrative_extraction::source_revision::validation_terminated(
                    crate::narrative_extraction::source_revision::ValidationTerminationReason::Cancelled,
                    "typed graph cancellation",
                ));
            }
            Ok(())
        }
    }

    fn roster_entry(
        material_kind: &str,
        material_id: &str,
        source_object_identity: &str,
        revision_id: &str,
        decision_id: &str,
        source_token: &str,
    ) -> GraphObjectRosterEntry {
        GraphObjectRosterEntry {
            material_kind: material_kind.to_owned(),
            material_id: material_id.to_owned(),
            source_object_identity: source_object_identity.to_owned(),
            revision_id: revision_id.to_owned(),
            decision_id: decision_id.to_owned(),
            source_token: source_token.to_owned(),
        }
    }

    #[test]
    fn graph_source_sorts_qualified_roster_and_has_stable_digest() {
        let unsorted = vec![
            roster_entry(
                "relation",
                "r-2",
                "codex-relation:r-2",
                "revision-2",
                "decision-2",
                "token-2",
            ),
            roster_entry(
                "entity",
                "e-1",
                "codex:e-1",
                "revision-1",
                "decision-1",
                "token-1",
            ),
        ];

        let source = graph_source_from_roster("project-1", unsorted).expect("source");
        assert_eq!(source.roster[0].material_id, "e-1");
        assert_eq!(source.roster[1].material_id, "r-2");
        assert_eq!(
            source,
            graph_source_from_roster("project-1", source.roster.clone()).expect("source")
        );
        assert!(source.digest.starts_with("sha256:"));
    }

    #[test]
    fn graph_source_accepts_more_than_512_and_streams_all_material_fields() {
        let roster = (0..513)
            .map(|index| {
                roster_entry(
                    "entity",
                    &format!("entity-{index}"),
                    &format!("codex:entity-{index}"),
                    "revision-1",
                    "decision-1",
                    &format!("source-token-{index}"),
                )
            })
            .collect();
        let source = graph_source_from_roster("project-1", roster).expect("source");
        assert_eq!(source.roster.len(), 513);
        let changed = source
            .roster
            .iter()
            .cloned()
            .map(|mut entry| {
                if entry.material_id == "entity-512" {
                    entry.source_object_identity = "codex:entity-changed".to_owned();
                }
                entry
            })
            .collect();
        let changed = graph_source_from_roster("project-1", changed).expect("changed source");
        assert_ne!(source.digest, changed.digest);
    }

    #[test]
    fn graph_source_rejects_duplicate_material_tuple_even_when_source_binding_differs() {
        let roster = vec![
            roster_entry(
                "evidence",
                "evidence-1",
                "codex:entity-1",
                "revision-1",
                "decision-1",
                "token-1",
            ),
            roster_entry(
                "evidence",
                "evidence-1",
                "codex:entity-1",
                "revision-1",
                "decision-1",
                "token-2",
            ),
        ];
        let error = graph_source_from_roster("project-1", roster)
            .expect_err("duplicate material tuples must fail closed")
            .to_string();
        assert!(
            error.contains("NIR1_GRAPH_ROSTER_DUPLICATE_MATERIAL"),
            "{error}"
        );
    }

    #[test]
    fn graph_work_control_cancels_streamed_digest() {
        let mut control = StopAt(GraphWorkStage::Digest);
        let error = graph_source_from_roster_with_control(
            "project-1",
            vec![roster_entry(
                "entity",
                "entity-1",
                "codex:entity-1",
                "revision-1",
                "decision-1",
                "token-1",
            )],
            &mut control,
        )
        .expect_err("digest cancellation must be terminal")
        .to_string();
        assert!(
            error.contains("NIR1_GRAPH_TEST_CANCELLED_Digest"),
            "{error}"
        );
    }

    #[test]
    fn graph_work_control_cancels_long_serialization_and_hash() {
        let roster = (0..1024)
            .map(|index| {
                roster_entry(
                    "entity",
                    &format!("entity-{index}"),
                    &format!("codex:entity-{index}"),
                    "revision-1",
                    "decision-1",
                    &format!("source-token-{index}"),
                )
            })
            .collect::<Vec<_>>();
        let source = GraphEligibilitySource {
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_owned(),
            roster: roster.clone(),
        };
        let snapshot = GraphIndexBuildSnapshot {
            project: "project-1".to_owned(),
            semantic_epoch: "epoch-1".to_owned(),
            source,
            prior: None,
            edges: Vec::new(),
            runtime_owner: 0,
            runtime_epoch: 0,
        };
        let mut serialization_control = StopAfter {
            stage: GraphWorkStage::Serialization,
            remaining: 4,
        };
        let serialization_error = snapshot
            .capacity_shape_with_control(&mut serialization_control)
            .expect_err("long JSON serialization must remain cancellable")
            .to_string();
        assert!(serialization_error.contains("NIR1_GRAPH_TEST_CANCELLED_AFTER_Serialization"));

        let mut digest_control = StopAfter {
            stage: GraphWorkStage::Digest,
            remaining: 12,
        };
        let digest_error = graph_source_from_roster_with_control(
            "project-1",
            roster,
            &mut digest_control,
        )
        .expect_err("long digest serialization must remain cancellable")
        .to_string();
        assert!(digest_error.contains("NIR1_GRAPH_TEST_CANCELLED_AFTER_Digest"));
    }

    #[test]
    fn counting_json_writer_preserves_typed_termination() {
        let values = vec![roster_entry(
            "entity",
            "entity-1",
            "codex:entity-1",
            "revision-1",
            "decision-1",
            "token-1",
        )];
        let mut control = TypedStop(GraphWorkStage::Serialization);
        let error = serialized_json_array_len_with_control(&values, &mut control)
            .expect_err("writer cancellation must remain typed");
        assert!(crate::narrative_extraction::source_revision::is_validation_terminated(&error));
    }

    #[test]
    fn input_edges_group_evidence_by_existing_source_identity() -> Result<()> {
        let source = GraphEligibilitySource {
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .into(),
            roster: vec![
                roster_entry(
                    "entity",
                    "entity-1",
                    "codex:entity-1",
                    "revision-1",
                    "decision-1",
                    "token-1",
                ),
                roster_entry(
                    "evidence",
                    "evidence-1",
                    "codex:entity-1",
                    "revision-1",
                    "decision-1",
                    "token-1",
                ),
            ],
        };
        let edges = input_edges("project-1", &source)?;
        assert_eq!(edges.len(), 2);
        assert!(edges
            .iter()
            .all(|edge| !edge.source_object_identity.starts_with("codex-evidence:")));
        let entity_edge = edges
            .iter()
            .find(|edge| edge.source_object_identity == "codex:entity-1")
            .expect("entity source edge");
        assert_eq!(entity_edge.read_set_json, "[\"token-1\"]");
        Ok(())
    }

    #[test]
    fn graph_sql_cancellation_clears_the_progress_handler_without_a_build_budget() -> Result<()> {
        let connection = Connection::open_in_memory()?;
        let query = "WITH RECURSIVE sequence(value) AS (
                         SELECT 1
                         UNION ALL
                         SELECT value + 1 FROM sequence WHERE value < 1000000
                     )
                     SELECT sum(value) FROM sequence";
        with_graph_sql_cancellation(&connection, None, || {
            connection
                .query_row(query, [], |row| row.get::<_, i64>(0))
                .map(|sum| assert_eq!(sum, 500_000_500_000))
                .map_err(Into::into)
        })?;

        let cancellation_epoch = Arc::new(AtomicU64::new(2));
        let cancellation_error =
            with_graph_sql_cancellation(&connection, Some((&cancellation_epoch, 1)), || {
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
