//! Canonical seed-local Graph reader. Product entry points remain closed.
//!
//! Discovery borrows the existing Revision -> Source reverse index. A private
//! registration proves the complete B binding on this exact read connection;
//! changed committed state requires owned maintenance, never a query-time scan.

mod candidates;
mod input;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "retained-memory seams remain unconnected; Graph memory acceptance is HOLD"
    )
)]
mod memory;
#[cfg(test)]
mod oracle_tests;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "Scene join foundations await confirmed target-body authority; Graph remains closed"
    )
)]
mod scenes;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{ensure, Result};
use grimodex_core::narrative_nir1::{
    EntityInput, GraphEdgeInput, ScopeValue, MAX_GRAPH_EDGES, MAX_GRAPH_HOPS,
    MAX_GRAPH_INPUT_BYTES, MAX_GRAPH_NODES, MAX_GRAPH_RECORDS,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::nir1_capacity::{self, CapacityBudget};
use super::nir1_chronicle_index::read_identity::ReadIdentity;
use super::nir1_entity_relation::{
    evaluate_nir1_entity_relation_disclosure, Nir1EntityRelationDisclosure,
    Nir1EntityRelationDisclosureRead,
};
use super::nir1_entity_relation_index::{
    is_complete_registered_with_control, GraphProgressCallback, GraphWorkControl, GraphWorkStage,
    INDEX_KEY,
};
use super::source_revision::{validation_terminated, ValidationTerminationReason};
use crate::state::WorkspaceAuthority;
use crate::workspace_lifecycle::WorkspaceParticipant;

use self::memory::{RetainedLedger, RetainedPart};

const QUERY_SQL_STEPS: u64 = 100_000;
const QUERY_DEADLINE: Duration = Duration::from_millis(8);
const QUERY_MAX_PAGES: usize = 32;
// JSON/A2/A3 parsing allocates typed values and fixed per-record metadata
// before the qualified material can be moved into the shared cache.  Reserve
// a deliberately conservative amount before entering that Rust phase.  This
// is a fail-closed guard, not an allocator measurement or a completion claim.
const TRANSIENT_JSON_MULTIPLIER: usize = 8;
const TRANSIENT_BYTES_PER_ROW: usize = 4 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Nir1GraphRequest {
    pub project_id: String,
    pub query_scene_id: String,
    pub seed_entity_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1GraphResponse {
    pub status: &'static str,
    pub project_id: String,
    pub query_scene_id: String,
    pub scope_revision: Option<String>,
    pub graph: Option<Nir1QualifiedGraph>,
    pub reason: Option<String>,
}

/// Each edge and endpoint keeps its exact immutable material identity. Scope
/// Scene IDs are deliberately absent: they do not prove a body occurrence.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1GraphMaterialBinding {
    pub revision_id: String,
    pub decision_id: String,
    pub decision_token: String,
    pub freshness_token: String,
    pub scope_authority_revision: String,
    pub query_scene_source_token: String,
    pub query_scene_scope_token: String,
    pub query_scene_incarnation_id: String,
    pub reveal_state_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1GraphNode {
    /// Shared with every edge that references this endpoint.  Graph output is
    /// still serialized as the same object shape, but the reader does not
    /// retain one deep EntityInput clone per incident edge.
    pub entity: Arc<EntityInput>,
    pub hop: u8,
    pub bindings: Vec<Arc<Nir1GraphMaterialBinding>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1GraphEdge {
    pub relation: Arc<GraphEdgeInput>,
    pub from: Arc<EntityInput>,
    pub to: Arc<EntityInput>,
    pub binding: Arc<Nir1GraphMaterialBinding>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1QualifiedGraph {
    pub seed_entity_id: String,
    pub generation: i64,
    pub nodes: Vec<Nir1GraphNode>,
    pub edges: Vec<Nir1GraphEdge>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Seal {
    generation: i64,
    source: String,
    dependency: String,
    semantic_epoch: String,
}

struct Registration {
    project: String,
    identity: ReadIdentity,
    seal: Seal,
}

/// The A3 disclosure contains several validation-only structures (material
/// basis, freshness rows, scene proof sets and the exact Decision).  Keeping
/// that whole object for every frontier candidate made the graph's retained
/// working set scale with validation internals.  Move only the qualified
/// Entity/Relation material and its binding into an explicitly shared cache;
/// endpoint and binding Arcs are then reused by nodes and edges.
struct QualifiedGraphMaterial {
    revision_id: String,
    binding: Arc<Nir1GraphMaterialBinding>,
    entities: Vec<Arc<EntityInput>>,
    relations: Vec<Arc<GraphEdgeInput>>,
}

impl QualifiedGraphMaterial {
    fn from_disclosure(disclosure: Box<Nir1EntityRelationDisclosure>) -> Result<Self> {
        let Nir1EntityRelationDisclosure {
            revision,
            decision_token,
            freshness_token,
            query_scene_source_token,
            query_scene_incarnation_id,
            query_scene_scope_token,
            scope_authority_revision,
            reveal_state_token,
            ..
        } = *disclosure;
        let revision = *revision;
        let decision_id = revision
            .decision
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_DECISION_MISSING"))?
            .id()
            .to_owned();
        let revision_id = revision.revision_id;
        let bundle = revision.bundle;
        let binding = Arc::new(Nir1GraphMaterialBinding {
            revision_id: revision_id.clone(),
            decision_id,
            decision_token,
            freshness_token,
            scope_authority_revision,
            query_scene_source_token,
            query_scene_scope_token,
            query_scene_incarnation_id,
            reveal_state_token,
        });
        // Move each typed input into one Arc.  The graph output reuses these
        // allocations rather than cloning large Evidence/quote payloads for
        // every incident edge.
        let entities = bundle.entities.into_iter().map(Arc::new).collect();
        let relations = bundle.relations.into_iter().map(Arc::new).collect();
        Ok(Self {
            revision_id,
            binding,
            entities,
            relations,
        })
    }

    fn entity(&self, entity_id: &str) -> Option<&Arc<EntityInput>> {
        self.entities
            .iter()
            .find(|entity| entity.entity_id == entity_id)
    }

    fn relation(&self, edge_id: &str) -> Option<&Arc<GraphEdgeInput>> {
        self.relations
            .iter()
            .find(|relation| relation.edge_id == edge_id)
    }
}

/// A cancellation request is sticky. A stopped reader cannot be revived by
/// resetting a renderer field; its connection must finish cleanup and close.
#[derive(Clone)]
pub struct Nir1GraphCancellation(Arc<AtomicBool>);
impl Nir1GraphCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Native-internal owner of a dedicated reader and its completeness proof.
/// The shell must drop/close this owner during lifecycle drain. Its participant
/// and shared workspace lease remain held until the connection actually closes.
pub struct Nir1GraphReader {
    connection: Option<Connection>,
    registration: Option<Registration>,
    cancelled: Arc<AtomicBool>,
    epoch_signal: Arc<AtomicU64>,
    epoch: u64,
    participant: Option<WorkspaceParticipant>,
    authority: Arc<WorkspaceAuthority>,
}

impl Nir1GraphReader {
    pub fn open(
        authority: Arc<WorkspaceAuthority>,
        participant: WorkspaceParticipant,
    ) -> Result<Self> {
        ensure!(!participant.stop_requested()?, "NIR1_GRAPH_READER_CLOSED");
        let runtime = authority.nir_chronicle_index_runtime();
        let epoch = runtime
            .native_reader_epoch()?
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_RUNTIME_UNAVAILABLE"))?;
        let epoch_signal = runtime.native_build_cancellation_epoch();
        let conn = Connection::open_with_flags(
            authority.path().join("grimodex.db"),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(Duration::ZERO)?;
        conn.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA cache_size=-128; PRAGMA mmap_size=0;
            CREATE TEMP TABLE grimodex_connection_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL);")?;
        conn.execute(
            "INSERT INTO temp.grimodex_connection_meta VALUES(1,?1)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        conn.execute_batch("PRAGMA query_only=ON")?;
        ensure!(
            epoch_signal.load(Ordering::Acquire) == epoch && !participant.stop_requested()?,
            "NIR1_GRAPH_READER_CLOSED"
        );
        Ok(Self {
            connection: Some(conn),
            registration: None,
            cancelled: Arc::new(AtomicBool::new(false)),
            epoch_signal,
            epoch,
            participant: Some(participant),
            authority,
        })
    }

    pub fn cancellation(&self) -> Nir1GraphCancellation {
        Nir1GraphCancellation(Arc::clone(&self.cancelled))
    }

    /// Full validation belongs to an already-admitted maintenance owner. This
    /// runs after publication on a fresh read transaction; no write transaction
    /// or supplied generation can mint a registration.
    pub fn register_with_control(
        &mut self,
        project: &str,
        owner: &mut dyn GraphWorkControl,
    ) -> Result<bool> {
        self.registration = None;
        ensure!(
            owner.allows_full_eligibility(),
            "NIR1_GRAPH_REGISTRATION_REQUIRES_MAINTENANCE_OWNER"
        );
        self.check()?;
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_READER_CLOSED"))?;
        let before = ReadIdentity::read_unpinned(conn)?
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_REGISTRATION_DRIFT"))?;
        let mut lifecycle = self.control(None);
        // The maintenance owner is borrowed and cannot be retained directly
        // by SQLite's `'static` progress callback.  Compose its first typed
        // stop into a sticky flag that the callback observes, while all
        // regular owner checks still run through the wrapper below.
        let owner_stopped = Arc::new(AtomicBool::new(false));
        let external_stop = owner.stop_signal();
        let external_deadline = owner.progress_deadline();
        let finalization_signal = owner.finalization_signal();
        let owner_progress = owner
            .progress_callback()
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_REGISTRATION_OWNER_PROGRESS_UNAVAILABLE"))?;
        let owner_scope = self.install_owner_with_stop(
            conn,
            Some(Arc::clone(&owner_stopped)),
            external_stop,
            external_deadline,
            finalization_signal,
            Some(owner_progress),
        )?;
        let mut registration_owner = OwnerStopControl {
            inner: owner,
            stopped: Arc::clone(&owner_stopped),
        };
        let result = (|| {
            // The callback covers the interval inside SQLite; retain a Rust
            // boundary before BEGIN so an owner closure can stop the attempt
            // before the private registration transaction is opened.
            registration_owner.check(GraphWorkStage::CompleteRegistration)?;
            conn.execute_batch("BEGIN DEFERRED")?;
            ensure!(
                ReadIdentity::read(conn)?.as_ref() == Some(&before),
                "NIR1_GRAPH_REGISTRATION_DRIFT"
            );
            lifecycle.check(GraphWorkStage::CompleteRegistration)?;
            // rowid is only a cursor, not a material identity. Producer writes
            // auto-allocate positive rowids; reject malformed imported cursors.
            let nonpositive: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM narrative_dependency_edges WHERE project_id=?1 AND rowid<=0)", [project], |r| r.get(0))?;
            if nonpositive
                || !is_complete_registered_with_control(
                    conn,
                    project,
                    INDEX_KEY,
                    &mut registration_owner,
                )?
                || !candidates::verify_complete_source_index(
                    conn,
                    project,
                    &mut registration_owner,
                )?
            {
                return Ok(None);
            }
            lifecycle.check(GraphWorkStage::CompleteRegistration)?;
            let seal = read_seal(conn, project)?;
            Ok(seal)
        })();
        let result = self.finish_read(result, Some(owner_scope))?;
        let result = match result {
            Err(error) => match registration_owner.check(GraphWorkStage::CompleteRegistration) {
                Err(owner_error) => Err(owner_error),
                Ok(()) => Err(error),
            },
            Ok(value) => Ok(value),
        }?;
        self.check()?;
        registration_owner.check(GraphWorkStage::CompleteRegistration)?;
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_READER_CLOSED"))?;
        if ReadIdentity::read_unpinned(conn)?.as_ref() != Some(&before) {
            return Ok(false);
        }
        if let Some(seal) = result {
            self.registration = Some(Registration {
                project: project.to_owned(),
                identity: before,
                seal,
            });
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn query(&mut self, request: &Nir1GraphRequest) -> Result<Nir1GraphResponse> {
        self.query_with_deadline(request, QUERY_DEADLINE, QUERY_SQL_STEPS)
    }

    fn query_with_deadline(
        &mut self,
        request: &Nir1GraphRequest,
        duration: Duration,
        sql_steps: u64,
    ) -> Result<Nir1GraphResponse> {
        let deadline = Instant::now() + duration;
        validate_request(request)?;
        if self.check().is_err() {
            return Ok(unavailable_response(request, "reader-unavailable"));
        }
        let Some(registration) = self.registration.as_ref() else {
            return Ok(unavailable_response(request, "registration-required"));
        };
        if registration.project != request.project_id {
            return Ok(unavailable_response(
                request,
                "registration-project-mismatch",
            ));
        }
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_READER_CLOSED"))?;
        let identity = registration.identity.clone();
        let expected_seal = registration.seal.clone();
        let budget = CapacityBudget::new(sql_steps, deadline);
        let mut owner = self.control(Some(deadline));
        let owner_scope = self.install_owner(conn)?;
        let result = nir1_capacity::with_capacity_scope(
            conn,
            Some(Arc::clone(&budget)),
            &mut owner,
            |_, control| {
                ensure!(
                    ReadIdentity::read_unpinned(conn)?.as_ref() == Some(&identity),
                    "NIR1_GRAPH_QUERY_DRIFT"
                );
                // A short identity read can finish after the deadline without
                // reaching the progress cadence. Do not open the snapshot
                // transaction after that late read.
                control.check(GraphWorkStage::Page)?;
                conn.execute_batch("BEGIN DEFERRED")?;
                ensure!(
                    ReadIdentity::read(conn)?.as_ref() == Some(&identity),
                    "NIR1_GRAPH_QUERY_DRIFT"
                );
                ensure!(
                    read_seal(conn, &request.project_id)?.as_ref() == Some(&expected_seal),
                    "NIR1_GRAPH_QUERY_SEAL_DRIFT"
                );
                query_in_snapshot(conn, request, &expected_seal, control)
            },
        );
        let result = self.finish_read(result, Some(owner_scope))?;
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_READER_CLOSED"))?;
        let current =
            nir1_capacity::with_capacity_scope(conn, Some(budget), &mut owner, |_, control| {
                let identity = ReadIdentity::read_unpinned(conn)?;
                control.check(GraphWorkStage::ResultAssembly)?;
                Ok(identity)
            });
        let current_identity = match current {
            Ok(identity) => identity,
            Err(_) => {
                // A capacity/deadline failure during the post-cleanup stamp
                // is a bounded query failure.  It is not evidence of an
                // identity drift and must not consume registration.
                return Ok(unavailable_response(
                    request,
                    "query-budget-or-validation-failed",
                ));
            }
        };
        let identity_drift = current_identity.as_ref() != Some(&identity);
        let query_drift = result.as_ref().err().is_some_and(|error| {
            error.chain().any(|cause| {
                matches!(
                    cause.to_string().as_str(),
                    "NIR1_GRAPH_QUERY_DRIFT" | "NIR1_GRAPH_QUERY_SEAL_DRIFT"
                )
            })
        });
        if identity_drift || query_drift {
            self.registration = None;
            return Ok(unavailable_response(request, "registration-drift"));
        }
        if self.check().is_err() || Instant::now() >= deadline {
            self.registration = None;
            return Ok(unavailable_response(request, "query-invalidated"));
        }
        match result {
            Ok(response) => Ok(response),
            Err(_) => Ok(unavailable_response(
                request,
                "query-budget-or-validation-failed",
            )),
        }
    }

    fn control(&self, deadline: Option<Instant>) -> ReaderControl {
        ReaderControl {
            cancelled: Arc::clone(&self.cancelled),
            epoch_signal: Arc::clone(&self.epoch_signal),
            epoch: self.epoch,
            participant: self.participant.clone(),
            deadline,
        }
    }

    fn check(&self) -> Result<()> {
        self.control(None).check(GraphWorkStage::Page)
    }

    fn install_owner(&self, conn: &Connection) -> Result<nir1_capacity::ProgressOwnerRestore> {
        self.install_owner_with_stop(conn, None, None, None, None, None)
    }

    fn install_owner_with_stop(
        &self,
        conn: &Connection,
        owner_check_stop: Option<Arc<AtomicBool>>,
        external_stop: Option<Arc<AtomicBool>>,
        external_deadline: Option<Instant>,
        finalization_signal: Option<Arc<AtomicBool>>,
        owner_progress: Option<GraphProgressCallback>,
    ) -> Result<nir1_capacity::ProgressOwnerRestore> {
        let mut control = self.control(None);
        let owner_progress = nir1_capacity::push_progress_owner(conn, 1_000, move || {
            let finalization_granted = finalization_signal
                .as_ref()
                .is_some_and(|signal| signal.load(Ordering::Acquire));
            control.check(GraphWorkStage::Row).is_err()
                || (!finalization_granted
                    && (owner_check_stop
                        .as_ref()
                        .is_some_and(|stopped| stopped.load(Ordering::Acquire))
                        || external_stop
                            .as_ref()
                            .is_some_and(|stopped| stopped.load(Ordering::Acquire))
                        || external_deadline.is_some_and(|deadline| Instant::now() >= deadline)
                        || owner_progress.as_ref().is_some_and(|check| check())))
        })?;
        Ok(owner_progress)
    }

    /// Retain the connection and participant on cleanup failure. No further
    /// query may use it; explicit close or Drop still owns physical teardown.
    fn finish_read<T>(
        &mut self,
        result: Result<T>,
        owner_scope: Option<nir1_capacity::ProgressOwnerRestore>,
    ) -> Result<Result<T>> {
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_READER_CLOSED"))?;
        // The existing maintenance terminal order clears the callback once
        // statements are gone, before rollback (which must not be interrupted).
        let clear = nir1_capacity::set_progress_owner(conn, 0, None::<fn() -> bool>);
        let rollback = if conn.is_autocommit() {
            Ok(())
        } else {
            conn.execute_batch("ROLLBACK")
        };
        let restore = owner_scope.map(|scope| scope.restore(conn));
        if rollback.is_err()
            || clear.is_err()
            || restore.is_some_and(|value| value.is_err())
            || !conn.is_autocommit()
        {
            self.cancelled.store(true, Ordering::Release);
            self.registration = None;
            anyhow::bail!("NIR1_GRAPH_READER_CLEANUP_FAILED");
        }
        Ok(result)
    }

    pub fn close(&mut self) -> Result<()> {
        self.cancelled.store(true, Ordering::Release);
        self.registration = None;
        if let Some(conn) = self.connection.take() {
            if let Err((conn, _)) = conn.close() {
                self.connection = Some(conn);
                anyhow::bail!("NIR1_GRAPH_READER_CLOSE_FAILED");
            }
        }
        self.participant = None;
        Ok(())
    }

    pub fn workspace_identity(&self) -> u64 {
        self.authority.identity()
    }
}

struct ReaderControl {
    cancelled: Arc<AtomicBool>,
    epoch_signal: Arc<AtomicU64>,
    epoch: u64,
    participant: Option<WorkspaceParticipant>,
    deadline: Option<Instant>,
}
impl GraphWorkControl for ReaderControl {
    fn check(&mut self, _: GraphWorkStage) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire)
            || self.epoch_signal.load(Ordering::Acquire) != self.epoch
            || self
                .participant
                .as_ref()
                .is_none_or(|p| p.stop_requested().unwrap_or(true))
        {
            return Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "NIR1 Graph reader stopped",
            ));
        }
        if self.deadline.is_some_and(|d| Instant::now() >= d) {
            return Err(validation_terminated(
                ValidationTerminationReason::TimedOut,
                "NIR1 Graph query deadline",
            ));
        }
        Ok(())
    }
}

/// Bridges a borrowed maintenance owner into the connection-local callback
/// without retaining the owner past the registration call.  Once an owner
/// check observes a stop, the callback remains stopped until cleanup closes
/// the read attempt.
struct OwnerStopControl<'a> {
    inner: &'a mut dyn GraphWorkControl,
    stopped: Arc<AtomicBool>,
}

impl GraphWorkControl for OwnerStopControl<'_> {
    fn check(&mut self, stage: GraphWorkStage) -> Result<()> {
        let result = self.inner.check(stage);
        if result.is_err() {
            self.stopped.store(true, Ordering::Release);
        }
        result
    }

    fn allows_full_eligibility(&self) -> bool {
        self.inner.allows_full_eligibility()
    }

    fn progress_callback(&self) -> Option<GraphProgressCallback> {
        self.inner.progress_callback()
    }

    fn stop_signal(&self) -> Option<Arc<AtomicBool>> {
        self.inner.stop_signal()
    }

    fn progress_deadline(&self) -> Option<Instant> {
        self.inner.progress_deadline()
    }

    fn finalization_signal(&self) -> Option<Arc<AtomicBool>> {
        self.inner.finalization_signal()
    }
}

fn read_seal(conn: &Connection, project: &str) -> Result<Option<Seal>> {
    Ok(conn.query_row("SELECT m.generation,m.source_digest,m.dependency_set_digest,f.semantic_epoch_id
       FROM narrative_semantic_index_metadata m JOIN narrative_consumer_freshness f
       ON f.project_id=m.project_id AND f.consumer_kind='semantic-index' AND f.consumer_key=m.index_key
       JOIN narrative_semantic_epochs e ON e.id=f.semantic_epoch_id AND e.project_id=m.project_id
       WHERE m.project_id=?1 AND m.index_key=?2 AND m.dirty_cache_flag=0
       AND f.evidence_freshness='fresh' AND f.build_action='none'",
       params![project, INDEX_KEY], |r| Ok(Seal { generation:r.get(0)?,source:r.get(1)?,dependency:r.get(2)?,semantic_epoch:r.get(3)? })).optional()?)
}

#[derive(Default)]
struct QueryUsage {
    rows: usize,
    bytes: usize,
    pages: usize,
    /// Heap retained by qualified material and the response graph.  Stored
    /// input bytes alone are insufficient because JSON/A2 expands strings,
    /// vectors and typed records before the graph is serialized.
    retained_bytes: usize,
    /// One monotonic peak ledger covers the raw input, retained estimates and
    /// bytes actually handed to serde.  It is deliberately conservative: a
    /// caller must still account every live container before claiming the
    /// hard bound.
    peak: RetainedLedger,
}
impl QueryUsage {
    fn admit(&mut self, rows: usize, bytes: usize) -> Result<()> {
        self.peak.admit(RetainedPart::CandidatePage, bytes)?;
        self.rows = self
            .rows
            .checked_add(rows)
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_READ_LIMIT"))?;
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_INPUT_LIMIT"))?;
        ensure!(
            self.rows <= MAX_GRAPH_RECORDS && self.bytes <= MAX_GRAPH_INPUT_BYTES,
            "NIR1_GRAPH_QUERY_RESOURCE_LIMIT"
        );
        Ok(())
    }

    fn admit_retained(&mut self, bytes: usize) -> Result<()> {
        self.peak.admit(RetainedPart::A2A3Material, bytes)?;
        self.retained_bytes = self
            .retained_bytes
            .checked_add(bytes)
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_RETAINED_LIMIT"))?;
        ensure!(
            self.retained_bytes <= MAX_GRAPH_INPUT_BYTES,
            "NIR1_GRAPH_RETAINED_LIMIT"
        );
        Ok(())
    }

    fn admit_output(&mut self, bytes: usize) -> Result<()> {
        self.peak.admit(RetainedPart::Serialization, bytes)
    }
}

fn retained_add(total: &mut usize, value: usize) -> Result<()> {
    *total = total
        .checked_add(value)
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_RETAINED_LIMIT"))?;
    Ok(())
}

fn retained_string(value: &String) -> usize {
    // Include the String descriptor and its current allocation.  This uses
    // capacity rather than len so serde's growth reserve is charged too.
    std::mem::size_of::<String>() + value.capacity()
}

fn retained_scope_value(value: &ScopeValue) -> usize {
    std::mem::size_of::<ScopeValue>()
        + match value {
            ScopeValue::Any { purpose } => purpose.as_ref().map_or(0, retained_string),
            ScopeValue::Exact { value }
            | ScopeValue::NotApplicable { reason: value }
            | ScopeValue::Unavailable { reason: value } => retained_string(value),
            ScopeValue::LegacyAbsent | ScopeValue::Unresolved => 0,
        }
}

fn retained_entity(entity: &EntityInput) -> Result<usize> {
    let mut total = std::mem::size_of::<EntityInput>();
    retained_add(&mut total, retained_string(&entity.entity_id))?;
    retained_add(&mut total, retained_string(&entity.entity_type))?;
    retained_add(&mut total, retained_string(&entity.label))?;
    retained_add(&mut total, retained_string(&entity.source_token))?;
    retained_add(&mut total, std::mem::size_of_val(&entity.scope))?;
    retained_add(&mut total, retained_scope_value(&entity.scope.reading))?;
    retained_add(&mut total, retained_scope_value(&entity.scope.story))?;
    retained_add(&mut total, retained_scope_value(&entity.scope.auto))?;
    retained_add(&mut total, retained_string(&entity.scope.phase))?;
    retained_add(&mut total, retained_string(&entity.scope.reveal))?;
    if let Some(pov) = &entity.scope.pov {
        retained_add(&mut total, retained_string(pov))?;
    }
    retained_add(
        &mut total,
        retained_string(&entity.scope.authority_revision),
    )?;
    retained_add(
        &mut total,
        std::mem::size_of::<Vec<grimodex_core::narrative_nir1::EvidenceInput>>()
            + entity.evidence.capacity()
                * std::mem::size_of::<grimodex_core::narrative_nir1::EvidenceInput>(),
    )?;
    for evidence in &entity.evidence {
        retained_add(&mut total, retained_string(&evidence.evidence_id))?;
        retained_add(&mut total, retained_string(&evidence.source_ref))?;
        retained_add(&mut total, retained_string(&evidence.quote))?;
    }
    Ok(total)
}

fn retained_relation(relation: &GraphEdgeInput) -> Result<usize> {
    let mut total = std::mem::size_of::<GraphEdgeInput>();
    retained_add(&mut total, retained_string(&relation.edge_id))?;
    retained_add(&mut total, retained_string(&relation.from_entity_id))?;
    retained_add(&mut total, retained_string(&relation.to_entity_id))?;
    retained_add(&mut total, retained_string(&relation.relation_type))?;
    retained_add(&mut total, retained_string(&relation.directionality))?;
    retained_add(&mut total, retained_string(&relation.source_token))?;
    retained_add(
        &mut total,
        std::mem::size_of::<Vec<String>>()
            + relation.evidence_ids.capacity() * std::mem::size_of::<String>(),
    )?;
    for evidence_id in &relation.evidence_ids {
        retained_add(&mut total, retained_string(evidence_id))?;
    }
    Ok(total)
}

fn retained_binding(binding: &Nir1GraphMaterialBinding) -> Result<usize> {
    let mut total = std::mem::size_of::<Nir1GraphMaterialBinding>();
    for value in [
        &binding.revision_id,
        &binding.decision_id,
        &binding.decision_token,
        &binding.freshness_token,
        &binding.scope_authority_revision,
        &binding.query_scene_source_token,
        &binding.query_scene_scope_token,
        &binding.query_scene_incarnation_id,
        &binding.reveal_state_token,
    ] {
        retained_add(&mut total, retained_string(value))?;
    }
    Ok(total)
}

fn retained_material(material: &QualifiedGraphMaterial) -> Result<usize> {
    let mut total = std::mem::size_of::<QualifiedGraphMaterial>();
    retained_add(&mut total, retained_string(&material.revision_id))?;
    retained_add(&mut total, retained_binding(&material.binding)?)?;
    retained_add(&mut total, 2 * std::mem::size_of::<usize>())?; // Arc control block
    retained_add(
        &mut total,
        std::mem::size_of::<Vec<Arc<EntityInput>>>()
            + material.entities.capacity() * std::mem::size_of::<Arc<EntityInput>>(),
    )?;
    retained_add(
        &mut total,
        std::mem::size_of::<Vec<Arc<GraphEdgeInput>>>()
            + material.relations.capacity() * std::mem::size_of::<Arc<GraphEdgeInput>>(),
    )?;
    for entity in &material.entities {
        retained_add(&mut total, retained_entity(entity)?)?;
        retained_add(&mut total, 2 * std::mem::size_of::<usize>())?;
    }
    for relation in &material.relations {
        retained_add(&mut total, retained_relation(relation)?)?;
        retained_add(&mut total, 2 * std::mem::size_of::<usize>())?;
    }
    Ok(total)
}

fn transient_material_reserve(raw_bytes: usize, rows: usize) -> Result<usize> {
    raw_bytes
        .checked_mul(TRANSIENT_JSON_MULTIPLIER)
        .and_then(|bytes| {
            rows.checked_mul(TRANSIENT_BYTES_PER_ROW)
                .and_then(|rows| bytes.checked_add(rows))
        })
        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_RETAINED_LIMIT"))
}

fn query_in_snapshot(
    conn: &Connection,
    request: &Nir1GraphRequest,
    seal: &Seal,
    control: &mut dyn GraphWorkControl,
) -> Result<Nir1GraphResponse> {
    let mut usage = QueryUsage::default();
    usage.admit(
        0,
        request.project_id.len() + request.query_scene_id.len() + request.seed_entity_id.len(),
    )?;
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM codex_entries WHERE project_id=?1 AND id=?2)",
        params![request.project_id, request.seed_entity_id],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(unavailable_response(request, "seed-not-found"));
    }
    let revision_capacity = MAX_GRAPH_RECORDS;
    let frontier_capacity = MAX_GRAPH_NODES;
    usage.admit_retained(
        std::mem::size_of::<HashMap<String, Option<Arc<QualifiedGraphMaterial>>>>()
            + revision_capacity
                * std::mem::size_of::<(String, Option<Arc<QualifiedGraphMaterial>>)>(),
    )?;
    usage.admit_retained(
        std::mem::size_of::<VecDeque<(String, u8)>>()
            + frontier_capacity * std::mem::size_of::<(String, u8)>()
            + retained_string(&request.seed_entity_id),
    )?;
    let mut revisions: HashMap<String, Option<Arc<QualifiedGraphMaterial>>> =
        HashMap::with_capacity(revision_capacity);
    let mut frontier = VecDeque::with_capacity(frontier_capacity);
    frontier.push_back((request.seed_entity_id.clone(), 0u8));
    usage.admit_retained(
        retained_string(&request.seed_entity_id)
            + std::mem::size_of::<(String, u8)>()
            + 8 * std::mem::size_of::<usize>(),
    )?;
    let mut hops = BTreeMap::from([(request.seed_entity_id.clone(), 0u8)]);
    let mut nodes: BTreeMap<String, Nir1GraphNode> = BTreeMap::new();
    let mut edges: BTreeMap<(String, String), Nir1GraphEdge> = BTreeMap::new();
    let mut scope_revision = None;
    while let Some((entity_id, hop)) = frontier.pop_front() {
        control.check(GraphWorkStage::Page)?;
        if hop >= MAX_GRAPH_HOPS {
            continue;
        }
        let mut cursor = 0i64;
        let mut candidates = BTreeSet::new();
        loop {
            control.check(GraphWorkStage::Page)?;
            // The bound source key is materialized for every indexed page and
            // for the final has-more probe. Charge it before constructing the
            // SQLite parameter so a large frontier ID cannot bypass the
            // shared query byte budget.
            usage.admit(0, candidates::source_input_bytes(&entity_id)?)?;
            if usage.rows == MAX_GRAPH_RECORDS || usage.pages == QUERY_MAX_PAGES {
                let more: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM narrative_dependency_edges INDEXED BY idx_narrative_dependency_edges_source WHERE project_id=?1 AND source_object_identity=?2 AND rowid>?3)", params![request.project_id,format!("codex:{entity_id}"),cursor], |r|r.get(0))?;
                ensure!(!more, "NIR1_GRAPH_CANDIDATE_LIMIT");
                break;
            }
            let page_limit = (MAX_GRAPH_RECORDS - usage.rows).min(16);
            usage.admit_retained(candidates::candidate_page_scratch_bytes(page_limit)?)?;
            let page = candidates::read_candidate_page_with_admission(
                conn,
                &request.project_id,
                &entity_id,
                cursor,
                MAX_GRAPH_RECORDS - usage.rows,
                MAX_GRAPH_INPUT_BYTES - usage.bytes,
                |rows, bytes| usage.admit(rows, bytes),
            )?;
            usage.pages += 1;
            let count = page.len();
            for row in page {
                control.check(GraphWorkStage::Row)?;
                cursor = row.cursor;
                if row.consumer_kind == "proposal-revision" {
                    let revision_id = row.revision_id;
                    if !candidates.contains(&revision_id) {
                        usage.admit_retained(
                            retained_string(&revision_id) + 64 * std::mem::size_of::<usize>(),
                        )?;
                        candidates.insert(revision_id);
                    }
                }
            }
            if count < 16 {
                break;
            }
        }
        usage.admit_retained(
            std::mem::size_of::<Vec<(String, String)>>()
                + MAX_GRAPH_EDGES * std::mem::size_of::<(String, String)>(),
        )?;
        let mut incident = Vec::with_capacity(MAX_GRAPH_EDGES);
        for revision_id in candidates {
            if !revisions.contains_key(&revision_id) {
                usage.admit_retained(
                    retained_string(&revision_id)
                        + std::mem::size_of::<input::RevisionAdmission>()
                        + 8 * std::mem::size_of::<usize>(),
                )?;
                control.check(GraphWorkStage::A2)?;
                let qualified = if let Some(admission) = input::preflight_revision(
                    conn,
                    &request.project_id,
                    &revision_id,
                    MAX_GRAPH_RECORDS - usage.rows,
                    MAX_GRAPH_INPUT_BYTES - usage.bytes,
                )? {
                    let revision_admission = admission;
                    usage.admit(revision_admission.rows, revision_admission.bytes)?;
                    let disclosure_admission = input::preflight_disclosure_with_payload_bytes(
                        conn,
                        &request.project_id,
                        &revision_id,
                        &request.query_scene_id,
                        revision_admission.payload_bytes,
                        MAX_GRAPH_RECORDS - usage.rows,
                        MAX_GRAPH_INPUT_BYTES - usage.bytes,
                    )?;
                    usage.admit(disclosure_admission.rows, disclosure_admission.bytes)?;
                    usage.admit_retained(transient_material_reserve(
                        revision_admission
                            .bytes
                            .checked_add(disclosure_admission.bytes)
                            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_RETAINED_LIMIT"))?,
                        revision_admission
                            .rows
                            .checked_add(disclosure_admission.rows)
                            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_RETAINED_LIMIT"))?,
                    )?)?;
                    control.check(GraphWorkStage::A2)?;
                    let qualified = evaluate_nir1_entity_relation_disclosure(
                        conn,
                        &request.project_id,
                        &revision_id,
                        &request.query_scene_id,
                    )?;
                    control.check(GraphWorkStage::A2)?;
                    match qualified {
                        Nir1EntityRelationDisclosureRead::Eligible(value) => {
                            let material = QualifiedGraphMaterial::from_disclosure(value)?;
                            usage.admit_retained(retained_material(&material)?)?;
                            Some(Arc::new(material))
                        }
                        Nir1EntityRelationDisclosureRead::Unavailable { .. } => None,
                    }
                } else {
                    None
                };
                revisions.insert(revision_id.clone(), qualified);
            }
            let Some(Some(material)) = revisions.get(&revision_id) else {
                continue;
            };
            if let Some(expected) = &scope_revision {
                ensure!(
                    expected == &material.binding.scope_authority_revision,
                    "NIR1_GRAPH_SCOPE_MISMATCH"
                );
            } else {
                usage
                    .admit_retained(retained_string(&material.binding.scope_authority_revision))?;
                scope_revision = Some(material.binding.scope_authority_revision.clone());
            }
            for relation in &material.relations {
                control.check(GraphWorkStage::Material)?;
                if relation.from_entity_id == entity_id
                    || (relation.directionality == "symmetric"
                        && relation.to_entity_id == entity_id)
                {
                    usage.admit_retained(
                        retained_string(&relation.edge_id)
                            + retained_string(&revision_id)
                            + std::mem::size_of::<(String, String)>(),
                    )?;
                    incident.push((relation.edge_id.clone(), revision_id.clone()));
                }
            }
            // An explicitly selected qualified isolated Entity is still a node.
            if let Some(entity) = material.entity(&entity_id) {
                add_node(
                    &mut nodes,
                    &mut usage,
                    Arc::clone(entity),
                    hop,
                    Arc::clone(&material.binding),
                )?;
            }
        }
        incident.sort();
        for (edge_id, revision_id) in incident {
            control.check(GraphWorkStage::Edge)?;
            let material = revisions
                .get(&revision_id)
                .and_then(Option::as_ref)
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_REVISION_MISSING"))?;
            let relation = material
                .relation(&edge_id)
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_EDGE_MISSING"))?;
            let target = if relation.from_entity_id == entity_id {
                &relation.to_entity_id
            } else {
                &relation.from_entity_id
            };
            if !hops.contains_key(target) {
                ensure!(hops.len() < MAX_GRAPH_NODES, "NIR1_GRAPH_NODE_LIMIT");
                usage.admit_retained(
                    retained_string(target) * 2
                        + std::mem::size_of::<(String, u8)>() * 2
                        + 8 * std::mem::size_of::<usize>(),
                )?;
                hops.insert(target.clone(), hop + 1);
                frontier.push_back((target.clone(), hop + 1));
            }
            usage.admit_retained(
                retained_string(&revision_id)
                    + retained_string(&edge_id)
                    + std::mem::size_of::<(String, String)>()
                    + std::mem::size_of::<Nir1GraphEdge>()
                    + 4 * std::mem::size_of::<usize>(),
            )?;
            let key = (revision_id.clone(), edge_id);
            if edges.contains_key(&key) {
                continue;
            }
            ensure!(edges.len() < MAX_GRAPH_EDGES, "NIR1_GRAPH_EDGE_LIMIT");
            let from = material
                .entity(&relation.from_entity_id)
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ENDPOINT_MISSING"))?;
            let to = material
                .entity(&relation.to_entity_id)
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ENDPOINT_MISSING"))?;
            add_node(
                &mut nodes,
                &mut usage,
                Arc::clone(from),
                *hops
                    .get(&from.entity_id)
                    .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ENDPOINT_UNREACHED"))?,
                Arc::clone(&material.binding),
            )?;
            add_node(
                &mut nodes,
                &mut usage,
                Arc::clone(to),
                *hops
                    .get(&to.entity_id)
                    .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_ENDPOINT_UNREACHED"))?,
                Arc::clone(&material.binding),
            )?;
            edges.insert(
                key,
                Nir1GraphEdge {
                    relation: Arc::clone(relation),
                    from: Arc::clone(from),
                    to: Arc::clone(to),
                    binding: Arc::clone(&material.binding),
                },
            );
        }
    }
    control.check(GraphWorkStage::ResultAssembly)?;
    usage.admit_retained(
        std::mem::size_of::<Vec<Nir1GraphNode>>()
            + MAX_GRAPH_NODES * std::mem::size_of::<Nir1GraphNode>()
            + std::mem::size_of::<Vec<Nir1GraphEdge>>()
            + MAX_GRAPH_EDGES * std::mem::size_of::<Nir1GraphEdge>(),
    )?;
    let mut ordered_nodes = Vec::with_capacity(MAX_GRAPH_NODES);
    ordered_nodes.extend(nodes.into_values());
    ordered_nodes.sort_unstable_by(|a, b| {
        a.hop
            .cmp(&b.hop)
            .then(a.entity.entity_id.cmp(&b.entity.entity_id))
    });
    let mut ordered_edges = Vec::with_capacity(MAX_GRAPH_EDGES);
    ordered_edges.extend(edges.into_values());
    let response_scope_bytes = scope_revision
        .as_ref()
        .map_or(0, retained_string);
    usage.admit_retained(
        std::mem::size_of::<Nir1GraphResponse>()
            + retained_string(&request.project_id)
            + retained_string(&request.query_scene_id)
            + response_scope_bytes
            + std::mem::size_of::<Nir1QualifiedGraph>()
            + retained_string(&request.seed_entity_id)
            // The node/edge Vec backing allocations were admitted above and
            // are moved into the response without another heap allocation.
            + 2 * std::mem::size_of::<usize>(),
    )?;
    let response = Nir1GraphResponse {
        status: "available",
        project_id: request.project_id.clone(),
        query_scene_id: request.query_scene_id.clone(),
        scope_revision,
        graph: Some(Nir1QualifiedGraph {
            seed_entity_id: request.seed_entity_id.clone(),
            generation: seal.generation,
            nodes: ordered_nodes,
            edges: ordered_edges,
        }),
        reason: None,
    };
    let mut counter = OutputCounter {
        bytes: 0,
        usage: &mut usage,
        control,
    };
    serde_json::to_writer(&mut counter, &response)?;
    control.check(GraphWorkStage::Serialization)?;
    Ok(response)
}

fn add_node(
    nodes: &mut BTreeMap<String, Nir1GraphNode>,
    usage: &mut QueryUsage,
    entity: Arc<EntityInput>,
    hop: u8,
    binding: Arc<Nir1GraphMaterialBinding>,
) -> Result<()> {
    if let Some(node) = nodes.get_mut(&entity.entity_id) {
        ensure!(
            node.entity.as_ref() == entity.as_ref(),
            "NIR1_GRAPH_ENDPOINT_VERSION_CONFLICT"
        );
        if !node
            .bindings
            .iter()
            .any(|b| b.revision_id == binding.revision_id)
        {
            // Every node owns one bounded binding Vec. Reserve its complete
            // possible capacity before the first allocation; subsequent
            // pushes therefore cannot trigger an uncharged Vec growth and do
            // not pay MAX_GRAPH_RECORDS again for every edge.
            node.bindings.push(binding);
        }
    } else {
        usage.admit_retained(
            retained_string(&entity.entity_id)
                + std::mem::size_of::<Nir1GraphNode>()
                + std::mem::size_of::<Vec<Arc<Nir1GraphMaterialBinding>>>()
                + MAX_GRAPH_RECORDS * std::mem::size_of::<Arc<Nir1GraphMaterialBinding>>()
                + 8 * std::mem::size_of::<usize>(),
        )?;
        nodes.insert(
            entity.entity_id.clone(),
            Nir1GraphNode {
                entity,
                hop,
                bindings: {
                    let mut bindings = Vec::with_capacity(MAX_GRAPH_RECORDS);
                    bindings.push(binding);
                    bindings
                },
            },
        );
    }
    Ok(())
}

struct OutputCounter<'a> {
    bytes: usize,
    usage: &'a mut QueryUsage,
    control: &'a mut dyn GraphWorkControl,
}
impl std::io::Write for OutputCounter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.control
            .check(GraphWorkStage::Serialization)
            .map_err(std::io::Error::other)?;
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .ok_or_else(|| std::io::Error::other("NIR1_GRAPH_OUTPUT_LIMIT"))?;
        self.usage
            .admit_output(bytes.len())
            .map_err(std::io::Error::other)?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn validate_request(request: &Nir1GraphRequest) -> Result<()> {
    ensure!(
        [
            &request.project_id,
            &request.query_scene_id,
            &request.seed_entity_id
        ]
        .iter()
        .all(|s| !s.is_empty() && s.trim() == s.as_str())
            && request
                .project_id
                .len()
                .saturating_add(request.query_scene_id.len())
                .saturating_add(request.seed_entity_id.len())
                <= MAX_GRAPH_INPUT_BYTES,
        "NIR1_GRAPH_INVALID_REQUEST"
    );
    Ok(())
}

/// Compatibility entry cannot turn live catalog objects into approved Graph.
/// Only the dedicated Native reader's owned registration authorizes queries.
pub fn read_nir1_graph(
    _conn: &Connection,
    request: &Nir1GraphRequest,
) -> Result<Nir1GraphResponse> {
    validate_request(request)?;
    Ok(unavailable_response(request, "registration-required"))
}

fn unavailable_response(request: &Nir1GraphRequest, reason: &str) -> Nir1GraphResponse {
    Nir1GraphResponse {
        status: "unavailable",
        project_id: request.project_id.clone(),
        query_scene_id: request.query_scene_id.clone(),
        scope_revision: None,
        graph: None,
        reason: Some(reason.to_owned()),
    }
}
