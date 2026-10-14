//! Canonical seed-local Graph reader. Product entry points remain closed.
//!
//! Discovery borrows the existing Revision -> Source reverse index. A private
//! registration proves the complete B binding on this exact read connection;
//! changed committed state requires owned maintenance, never a query-time scan.
//!
//! The ordinary reader (`open`, `register_with_control`, `query`) owns its own
//! connection and is compiled only for tests and the material diagnostics. Its
//! logical ledger also charges the transient estimates that the product
//! worker's fixed arena replaces, so it is not the product query path. The
//! product query is the isolated worker (`open_for_worker`,
//! `query_for_worker_with_maintenance`).

pub mod c_query_freshness;
pub mod c_query_worker;
mod candidates;
mod input;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "retained-memory seams remain unconnected; the ledger is a defensive logical limit, not a physical-memory proof"
    )
)]
mod memory;
#[cfg(test)]
mod oracle_tests;
mod scenes;
#[cfg(test)]
mod tests;
pub mod worker_frame;
pub mod worker_projection;

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{ensure, Result};
use grimodex_core::narrative_nir1::{
    EntityInput, GraphEdgeInput, ScopeBinding, ScopeValue, MAX_GRAPH_EDGES, MAX_GRAPH_HOPS,
    MAX_GRAPH_INPUT_BYTES, MAX_GRAPH_NODES, MAX_GRAPH_RECORDS, MAX_GRAPH_SCENES,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::nir1_capacity::{self, CapacityBudget};
use super::nir1_chronicle_index::read_identity::ReadIdentity;
#[cfg(test)]
use super::nir1_entity_relation::evaluate_nir1_entity_relation_disclosure;
use super::nir1_entity_relation::{
    evaluate_nir1_entity_relation_disclosure_shared, Nir1EntityRelationDisclosure,
    Nir1EntityRelationDisclosureRead, Nir1ProjectReads,
};
use super::nir1_entity_relation_index::{
    is_complete_registered_with_scratch, GraphProgressCallback, GraphWorkControl, GraphWorkStage,
    INDEX_KEY,
};
use super::source_revision::{
    validation_terminated, ValidationTerminated, ValidationTerminationReason,
};
use crate::narrative_maintenance_connection::{
    with_narrative_maintenance_graph_control, NarrativeMaintenanceGraphControlConfig,
};
use crate::nir1_pinned_snapshot::with_pinned_snapshot;
use crate::state::WorkspaceAuthority;
use crate::workspace_lifecycle::WorkspaceParticipant;

#[cfg(feature = "nir1-material-diagnostics")]
pub(crate) use self::input::{A2SqlObservation, A3SqlObservation};
use self::memory::{RetainedLedger, RetainedPart};
use self::scenes::{SceneJoinBudget, ScenePinLocator};
use self::worker_frame::{
    PreCleanup, SceneAssociationLengths, UnavailableReason, WorkerCause, WorkerSite,
    MAX_SCENE_SECTION_BYTES, SCENE_SECTION_HEADER_BYTES,
};

pub(crate) const QUERY_SQL_STEPS: u64 = 100_000;
pub(crate) const QUERY_DEADLINE: Duration = Duration::from_millis(100);
const QUERY_MAX_PAGES: usize = 32;
// JSON/A2/A3 parsing allocates typed values and fixed per-record metadata
// before the qualified material can be moved into the shared cache.  Reserve
// a deliberately conservative amount before entering that Rust phase.  This
// is a fail-closed guard, not an allocator measurement or a completion claim.
const TRANSIENT_JSON_MULTIPLIER: usize = 8;
const TRANSIENT_BYTES_PER_ROW: usize = 4 * 1024;

#[cfg(test)]
thread_local! {
    /// Test-only: every Revision of a query reads the project-level state
    /// itself, as `evaluate_nir1_entity_relation_disclosure` does, instead of
    /// using the reads the query made once. The admission is unchanged: this
    /// is the oracle for the response, not for the budget.
    static UNSHARED_PROJECT_READS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
thread_local! {
    /// SQL VM steps charged to the latest `query_with_deadline_observed` on
    /// this thread (the budget's own count, so it is the quantity capped by
    /// `QUERY_SQL_STEPS`). Test-only; a query that returns before it creates its
    /// budget leaves the previous value.
    static LAST_QUERY_SQL_STEPS: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
thread_local! {
    /// Records the latest query on this thread admitted for an available
    /// Graph (`QueryUsage::rows`, the quantity capped by `MAX_GRAPH_RECORDS`).
    /// Test-only: the query's own count, so tests compare it with the stored
    /// rows instead of re-deriving it. A query that does not reach an
    /// available Graph leaves the previous value.
    static LAST_QUERY_ROWS: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

#[cfg(feature = "nir1-material-diagnostics")]
#[derive(Debug, Default)]
pub(crate) struct StageObservation {
    pub(crate) pre_snapshot_identity_seal_ns: Option<u64>,
    pub(crate) indexed_candidate_page_ns: Option<u64>,
    pub(crate) a2_preflight_ns: Option<u64>,
    pub(crate) a2_sql: A2SqlObservation,
    pub(crate) a3_preflight_ns: Option<u64>,
    pub(crate) a3_sql: A3SqlObservation,
    pub(crate) a3_evaluation_ns: Option<u64>,
    pub(crate) cleanup_post_stamp_ns: Option<u64>,
    pub(crate) work_result_error: bool,
    pub(crate) post_stamp_error: bool,
    pub(crate) deadline_observed_at_collapse: bool,
    pub(crate) unattributed: bool,
    timing_overflow_mask: u8,
}

#[cfg(not(feature = "nir1-material-diagnostics"))]
#[derive(Default)]
struct StageObservation;

#[cfg(feature = "nir1-material-diagnostics")]
#[derive(Clone, Copy)]
enum ObservedStage {
    PreSnapshotIdentitySeal,
    IndexedCandidatePage,
    A2Preflight,
    A3Preflight,
    A3Evaluation,
    CleanupPostStamp,
}

#[cfg(feature = "nir1-material-diagnostics")]
fn record_observed_stage(
    observation: &mut Option<&mut StageObservation>,
    stage: ObservedStage,
    started: Option<Instant>,
) {
    let (Some(observation), Some(started)) = (observation.as_deref_mut(), started) else {
        return;
    };
    let (index, slot) = match stage {
        ObservedStage::PreSnapshotIdentitySeal => {
            (0, &mut observation.pre_snapshot_identity_seal_ns)
        }
        ObservedStage::IndexedCandidatePage => (1, &mut observation.indexed_candidate_page_ns),
        ObservedStage::A2Preflight => (2, &mut observation.a2_preflight_ns),
        ObservedStage::A3Preflight => (3, &mut observation.a3_preflight_ns),
        ObservedStage::A3Evaluation => (4, &mut observation.a3_evaluation_ns),
        ObservedStage::CleanupPostStamp => (5, &mut observation.cleanup_post_stamp_ns),
    };
    let bit = 1 << index;
    if observation.timing_overflow_mask & bit != 0 {
        return;
    }
    let elapsed_ns = u64::try_from(started.elapsed().as_nanos()).ok();
    let total = match (*slot, elapsed_ns) {
        (Some(previous), Some(elapsed)) => previous.checked_add(elapsed),
        (None, Some(elapsed)) => Some(elapsed),
        (_, None) => None,
    };
    if let Some(total) = total {
        *slot = Some(total);
    } else {
        *slot = None;
        observation.timing_overflow_mask |= bit;
        observation.unattributed = true;
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Nir1GraphRequest {
    pub project_id: String,
    pub query_scene_id: String,
    pub seed_entity_id: String,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Nir1GraphRegistrationStage {
    Maintenance,
    Setup,
    PreflightIdentity,
    OwnerSetup,
    BeginSnapshot,
    PinnedIdentity,
    SemanticIndex,
    SourceIndex,
    Seal,
    PostflightIdentity,
}

fn set_registration_stage(
    observer: &mut Option<&mut Nir1GraphRegistrationStage>,
    stage: Nir1GraphRegistrationStage,
) {
    if let Some(observer) = observer.as_deref_mut() {
        *observer = stage;
    }
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

/// One Entity reached through one or more qualified Revisions.
///
/// The node's identity is the Entity ID and every field of its `EntityInput`
/// except the Scope (type, label, source token, Evidence): a Revision that
/// carries the same Entity ID with different identity fields contradicts the
/// first one and refuses the whole Graph. The Scope belongs to the binding
/// (the Revision) that carries it: a person reviewed under several Scenes has
/// one Scope per review, so `binding_scopes[i]` is the Scope of this Entity in
/// `bindings[i]`'s Revision, and no version is dropped or renamed away.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1GraphNode {
    /// Shared with every edge that references this endpoint.  Graph output is
    /// still serialized as the same object shape, but the reader does not
    /// retain one deep EntityInput clone per incident edge.  This is the
    /// first binding's version, so its Scope is `binding_scopes[0]`; read the
    /// Scope of a binding from `binding_scopes`.
    pub entity: Arc<EntityInput>,
    pub hop: u8,
    pub bindings: Vec<Arc<Nir1GraphMaterialBinding>>,
    /// Same length and order as `bindings`.
    pub binding_scopes: Vec<Arc<ScopeBinding>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1GraphEdge {
    pub relation: Arc<GraphEdgeInput>,
    pub from: Arc<EntityInput>,
    pub to: Arc<EntityInput>,
    pub binding: Arc<Nir1GraphMaterialBinding>,
}

/// One explicit pin of a reached Entity, located in the same snapshot and
/// QueryUsage as its representative path. A pin is a request-local locator,
/// not Relation evidence or Scene eligibility; Native qualifies it later.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1GraphSceneAssociation {
    pub scene_id: String,
    /// The A1 binding incarnation; None when the Scene has no binding row.
    pub scene_incarnation_id: Option<String>,
    /// `v{version}@{updated_at}` of the Scene row. Never the body.
    pub scene_source_token: String,
    /// The A1 binding source token; present exactly with the incarnation.
    pub scene_scope_token: Option<String>,
    pub pin_rowid: i64,
    pub pin_entry_id: String,
    pub pin_created_at: String,
    pub path_hop: u8,
    /// Indices into `edges`, in traversal order from the seed.
    pub path_edge_indices: Vec<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1QualifiedGraph {
    pub seed_entity_id: String,
    pub generation: i64,
    pub nodes: Vec<Nir1GraphNode>,
    pub edges: Vec<Nir1GraphEdge>,
    /// Distinct pinned Scenes of the complete enumeration. Diagnostic only;
    /// never an eligibility, ranking or acceptance input.
    pub scene_total: usize,
    /// The first `MAX_GRAPH_SCENES` Scenes in tuple order.
    pub scenes: Vec<Nir1GraphSceneAssociation>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Seal {
    generation: i64,
    source: String,
    dependency: String,
    semantic_epoch: String,
}

struct PendingRegistration {
    project: String,
    identity: ReadIdentity,
    seal: Seal,
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

/// Native-internal owner of Graph reader state and its completeness proof.
/// Ordinary readers (tests and diagnostics only) own a dedicated connection; the
/// isolated worker borrows its authority Database connection so registration
/// and query share one handle.
enum ReaderConnection {
    #[cfg(any(test, feature = "nir1-material-diagnostics"))]
    Owned(Connection),
    Borrowed,
    Closed,
}

enum QueryPath<'a> {
    #[cfg(any(test, feature = "nir1-material-diagnostics"))]
    Reader,
    #[cfg(any(test, feature = "nir1-material-diagnostics"))]
    Worker,
    WorkerMaintenance(&'a mut dyn GraphWorkControl),
}

impl ReaderConnection {
    #[cfg(any(test, feature = "nir1-material-diagnostics"))]
    fn as_ref(&self) -> Option<&Connection> {
        match self {
            Self::Owned(conn) => Some(conn),
            Self::Borrowed | Self::Closed => None,
        }
    }

    #[cfg(test)]
    fn is_none(&self) -> bool {
        self.as_ref().is_none()
    }
}

pub struct Nir1GraphReader {
    connection: ReaderConnection,
    registration: Option<Registration>,
    pending_registration: Option<PendingRegistration>,
    cancelled: Arc<AtomicBool>,
    epoch_signal: Arc<AtomicU64>,
    epoch: u64,
    participant: Option<WorkspaceParticipant>,
    authority: Arc<WorkspaceAuthority>,
}

impl Nir1GraphReader {
    /// Ordinary reader on its own read-only connection. Tests and diagnostics
    /// only: the product query runs in the isolated worker (`open_for_worker`).
    #[cfg(any(test, feature = "nir1-material-diagnostics"))]
    pub fn open(
        authority: Arc<WorkspaceAuthority>,
        participant: WorkspaceParticipant,
    ) -> Result<Self> {
        ensure!(!participant.stop_requested()?, "NIR1_GRAPH_READER_CLOSED");
        let conn = Connection::open_with_flags(
            authority.path().join("grimodex.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(Duration::ZERO)?;
        conn.execute_batch("PRAGMA temp_store=MEMORY; PRAGMA cache_size=-128; PRAGMA mmap_size=0;
            CREATE TEMP TABLE grimodex_connection_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch TEXT NOT NULL);")?;
        conn.execute(
            "INSERT INTO temp.grimodex_connection_meta VALUES(1,?1)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        conn.execute_batch("PRAGMA query_only=ON")?;
        Self::new(authority, participant, ReaderConnection::Owned(conn))
    }

    /// Build reader state for the isolated worker's already-open authority
    /// connection. Registration and query methods must borrow that same handle.
    #[doc(hidden)]
    pub fn open_for_worker(
        authority: Arc<WorkspaceAuthority>,
        participant: WorkspaceParticipant,
    ) -> Result<Self> {
        Self::new(authority, participant, ReaderConnection::Borrowed)
    }

    fn new(
        authority: Arc<WorkspaceAuthority>,
        participant: WorkspaceParticipant,
        connection: ReaderConnection,
    ) -> Result<Self> {
        ensure!(!participant.stop_requested()?, "NIR1_GRAPH_READER_CLOSED");
        let runtime = authority.nir_chronicle_index_runtime();
        let epoch = runtime
            .native_reader_epoch()?
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_RUNTIME_UNAVAILABLE"))?;
        let epoch_signal = runtime.native_build_cancellation_epoch();
        ensure!(
            epoch_signal.load(Ordering::Acquire) == epoch && !participant.stop_requested()?,
            "NIR1_GRAPH_READER_CLOSED"
        );
        Ok(Self {
            connection,
            registration: None,
            pending_registration: None,
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
    /// or supplied generation can mint a registration. Ordinary readers only
    /// (tests and diagnostics).
    #[cfg(any(test, feature = "nir1-material-diagnostics"))]
    pub fn register_with_control(
        &mut self,
        project: &str,
        owner: &mut dyn GraphWorkControl,
    ) -> Result<bool> {
        let conn = self.take_owned_connection()?;
        let mut current_heap = |operation: &mut dyn FnMut()| {
            operation();
            true
        };
        let result =
            self.register_with_control_observed(&conn, project, owner, None, &mut current_heap);
        self.connection = ReaderConnection::Owned(conn);
        match result {
            Ok(true) => {
                self.publish_pending_registration()?;
                Ok(true)
            }
            Ok(false) => {
                self.pending_registration = None;
                Ok(false)
            }
            Err(error) => {
                self.pending_registration = None;
                Err(error)
            }
        }
    }

    fn register_with_control_observed(
        &mut self,
        conn: &Connection,
        project: &str,
        owner: &mut dyn GraphWorkControl,
        mut observer: Option<&mut Nir1GraphRegistrationStage>,
        scratch_scope: &mut dyn FnMut(&mut dyn FnMut()) -> bool,
    ) -> Result<bool> {
        set_registration_stage(&mut observer, Nir1GraphRegistrationStage::Setup);
        self.registration = None;
        self.pending_registration = None;
        ensure!(
            owner.allows_full_eligibility(),
            "NIR1_GRAPH_REGISTRATION_REQUIRES_MAINTENANCE_OWNER"
        );
        self.check()?;
        set_registration_stage(&mut observer, Nir1GraphRegistrationStage::PreflightIdentity);
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
        set_registration_stage(&mut observer, Nir1GraphRegistrationStage::OwnerSetup);
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
            set_registration_stage(&mut observer, Nir1GraphRegistrationStage::BeginSnapshot);
            conn.execute_batch("BEGIN DEFERRED")?;
            set_registration_stage(&mut observer, Nir1GraphRegistrationStage::PinnedIdentity);
            ensure!(
                ReadIdentity::read(conn)?.as_ref() == Some(&before),
                "NIR1_GRAPH_REGISTRATION_DRIFT"
            );
            lifecycle.check(GraphWorkStage::CompleteRegistration)?;
            // rowid is only a cursor, not a material identity. Producer writes
            // auto-allocate positive rowids; reject malformed imported cursors.
            set_registration_stage(&mut observer, Nir1GraphRegistrationStage::SemanticIndex);
            let nonpositive: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM narrative_dependency_edges WHERE project_id=?1 AND rowid<=0)", [project], |r| r.get(0))?;
            if nonpositive
                || !is_complete_registered_with_scratch(
                    conn,
                    project,
                    INDEX_KEY,
                    &mut registration_owner,
                    scratch_scope,
                )?
            {
                return Ok(None);
            }
            set_registration_stage(&mut observer, Nir1GraphRegistrationStage::SourceIndex);
            if !candidates::verify_complete_source_index(conn, project, &mut registration_owner)? {
                return Ok(None);
            }
            lifecycle.check(GraphWorkStage::CompleteRegistration)?;
            set_registration_stage(&mut observer, Nir1GraphRegistrationStage::Seal);
            let seal = read_seal(conn, project)?;
            Ok(seal)
        })();
        let result = self.finish_read(conn, result, owner_scope)?;
        let result = match result {
            Err(error) => match registration_owner.check(GraphWorkStage::CompleteRegistration) {
                Err(owner_error) => Err(owner_error),
                Ok(()) => Err(error),
            },
            Ok(value) => Ok(value),
        }?;
        set_registration_stage(
            &mut observer,
            Nir1GraphRegistrationStage::PostflightIdentity,
        );
        self.check()?;
        registration_owner.check(GraphWorkStage::CompleteRegistration)?;
        let current = ReadIdentity::read_unpinned(conn)?;
        self.check()?;
        registration_owner.check(GraphWorkStage::CompleteRegistration)?;
        if current.as_ref() != Some(&before) {
            return Ok(false);
        }
        if let Some(seal) = result {
            // Deep-copy the verified authority into ordinary Q-owned reader state.
            // Worker query code cannot use it until the outer maintenance scope and
            // the worker's permanent zero-live scratch seal have both succeeded.
            self.pending_registration = Some(PendingRegistration {
                project: project.to_owned(),
                identity: before.clone(),
                seal: seal.clone(),
            });
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Register under the authority Database's no-wait maintenance owner;
    /// worker reader state borrows that connection, and publishes only after
    /// the supplied scratch-seal operation succeeds following outer cleanup.
    pub fn register_with_worker_maintenance(
        &mut self,
        project: &str,
        seal_scratch: impl FnOnce() -> bool,
    ) -> Result<bool> {
        let mut current_heap = |operation: &mut dyn FnMut()| {
            operation();
            true
        };
        self.register_with_worker_maintenance_observed(
            project,
            None,
            &mut current_heap,
            seal_scratch,
        )
    }

    #[doc(hidden)]
    pub fn register_with_worker_maintenance_diagnostic(
        &mut self,
        project: &str,
        stage: &mut Nir1GraphRegistrationStage,
        scratch_scope: impl FnMut(&mut dyn FnMut()) -> bool,
        seal_scratch: impl FnOnce() -> bool,
    ) -> Result<bool> {
        *stage = Nir1GraphRegistrationStage::Maintenance;
        self.register_with_worker_maintenance_observed(
            project,
            Some(stage),
            scratch_scope,
            seal_scratch,
        )
    }

    fn register_with_worker_maintenance_observed(
        &mut self,
        project: &str,
        observer: Option<&mut Nir1GraphRegistrationStage>,
        mut scratch_scope: impl FnMut(&mut dyn FnMut()) -> bool,
        seal_scratch: impl FnOnce() -> bool,
    ) -> Result<bool> {
        self.registration = None;
        self.pending_registration = None;
        ensure!(
            matches!(&self.connection, ReaderConnection::Borrowed),
            "NIR1_GRAPH_WORKER_REQUIRES_BORROWED_CONNECTION"
        );
        let authority = Arc::clone(&self.authority);
        let result = with_narrative_maintenance_graph_control(
            &authority,
            Duration::ZERO,
            1_000,
            Arc::new(AtomicBool::new(false)),
            NarrativeMaintenanceGraphControlConfig::default(),
            |conn, control| {
                self.register_with_control_observed(
                    conn,
                    project,
                    control,
                    observer,
                    &mut scratch_scope,
                )
            },
        );
        let registered = match result {
            Ok(Some(result)) => match result.into_result() {
                Ok(registered) => registered,
                Err(error) => {
                    self.pending_registration = None;
                    return Err(error);
                }
            },
            Ok(None) => {
                self.pending_registration = None;
                return Ok(false);
            }
            Err(error) => {
                self.pending_registration = None;
                return Err(error);
            }
        };
        if !registered {
            self.pending_registration = None;
            return Ok(false);
        }
        if let Err(error) = self.check() {
            self.pending_registration = None;
            return Err(error);
        }
        if !seal_scratch() {
            self.pending_registration = None;
            anyhow::bail!("NIR1_GRAPH_WORKER_SCRATCH_SEAL_FAILED");
        }
        self.publish_pending_registration()?;
        Ok(true)
    }

    fn publish_pending_registration(&mut self) -> Result<()> {
        if let Err(error) = self.check() {
            self.pending_registration = None;
            return Err(error);
        }
        let Some(pending) = self.pending_registration.take() else {
            anyhow::bail!("NIR1_GRAPH_REGISTRATION_PENDING_REQUIRED");
        };
        self.registration = Some(Registration {
            project: pending.project,
            identity: pending.identity,
            seal: pending.seal,
        });
        Ok(())
    }

    /// Ordinary reader query. Tests and diagnostics only: it charges the
    /// transient estimates that the product worker's fixed arena replaces.
    #[cfg(any(test, feature = "nir1-material-diagnostics"))]
    pub fn query(&mut self, request: &Nir1GraphRequest) -> Result<Nir1GraphResponse> {
        let conn = self.take_owned_connection()?;
        let result = self.query_with_deadline_observed(
            &conn,
            request,
            QUERY_DEADLINE,
            QUERY_SQL_STEPS,
            None,
            QueryPath::Reader,
        );
        self.connection = ReaderConnection::Owned(conn);
        result
    }

    /// Diagnostic reason tags for the isolated worker binary only; not a product API.
    /// It needs an ordinary reader's connection, so it is tests and diagnostics only.
    #[cfg(any(test, feature = "nir1-material-diagnostics"))]
    #[doc(hidden)]
    pub fn query_for_worker(&mut self, request: &Nir1GraphRequest) -> Result<Nir1GraphResponse> {
        let conn = self.take_owned_connection()?;
        let result = self.query_with_deadline_observed(
            &conn,
            request,
            QUERY_DEADLINE,
            QUERY_SQL_STEPS,
            None,
            QueryPath::Worker,
        );
        self.connection = ReaderConnection::Owned(conn);
        result
    }

    /// Run the worker query against the authority-owned connection under its
    /// existing maintenance lock, cancellation hook, and cleanup/quarantine.
    #[doc(hidden)]
    pub fn query_for_worker_with_maintenance(
        &mut self,
        request: &Nir1GraphRequest,
    ) -> Result<Nir1GraphResponse> {
        self.query_for_worker_with_maintenance_deadline(request, QUERY_DEADLINE)
    }

    fn query_for_worker_with_maintenance_deadline(
        &mut self,
        request: &Nir1GraphRequest,
        duration: Duration,
    ) -> Result<Nir1GraphResponse> {
        ensure!(
            matches!(&self.connection, ReaderConnection::Borrowed),
            "NIR1_GRAPH_WORKER_REQUIRES_BORROWED_CONNECTION"
        );
        let authority = Arc::clone(&self.authority);
        let result = with_narrative_maintenance_graph_control(
            authority.db(),
            Duration::ZERO,
            1_000,
            Arc::new(AtomicBool::new(false)),
            NarrativeMaintenanceGraphControlConfig::default(),
            |conn, control| {
                self.query_with_deadline_observed(
                    conn,
                    request,
                    duration,
                    QUERY_SQL_STEPS,
                    None,
                    QueryPath::WorkerMaintenance(control),
                )
            },
        )?;
        result
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_WORKER_MAINTENANCE_DEFERRED"))?
            .into_result()
    }

    #[cfg(test)]
    fn query_with_deadline(
        &mut self,
        request: &Nir1GraphRequest,
        duration: Duration,
        sql_steps: u64,
    ) -> Result<Nir1GraphResponse> {
        let conn = self.take_owned_connection()?;
        let result = self.query_with_deadline_observed(
            &conn,
            request,
            duration,
            sql_steps,
            None,
            QueryPath::Reader,
        );
        self.connection = ReaderConnection::Owned(conn);
        result
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    pub(crate) fn query_with_stage_observation(
        &mut self,
        request: &Nir1GraphRequest,
    ) -> (Result<Nir1GraphResponse>, StageObservation) {
        self.query_with_stage_observation_and_deadline(request, QUERY_DEADLINE, QUERY_SQL_STEPS)
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    fn query_with_stage_observation_and_deadline(
        &mut self,
        request: &Nir1GraphRequest,
        duration: Duration,
        sql_steps: u64,
    ) -> (Result<Nir1GraphResponse>, StageObservation) {
        let mut observation = StageObservation::default();
        let conn = match self.take_owned_connection() {
            Ok(conn) => conn,
            Err(error) => return (Err(error), observation),
        };
        let result = self.query_with_deadline_observed(
            &conn,
            request,
            duration,
            sql_steps,
            Some(&mut observation),
            QueryPath::Reader,
        );
        self.connection = ReaderConnection::Owned(conn);
        (result, observation)
    }

    fn query_with_deadline_observed(
        &mut self,
        conn: &Connection,
        request: &Nir1GraphRequest,
        duration: Duration,
        sql_steps: u64,
        mut _observation: Option<&mut StageObservation>,
        path: QueryPath<'_>,
    ) -> Result<Nir1GraphResponse> {
        let deadline = Instant::now() + duration;
        let (worker_path, external_owner) = match path {
            #[cfg(any(test, feature = "nir1-material-diagnostics"))]
            QueryPath::Reader => (false, None),
            #[cfg(any(test, feature = "nir1-material-diagnostics"))]
            QueryPath::Worker => (true, None),
            QueryPath::WorkerMaintenance(owner) => (true, Some(owner)),
        };
        validate_request(request)?;
        if self.check().is_err() {
            return Ok(unavailable(request, UnavailableReason::ReaderUnavailable));
        }
        let Some(registration) = self.registration.as_ref() else {
            return Ok(unavailable(
                request,
                UnavailableReason::RegistrationRequired,
            ));
        };
        if registration.project != request.project_id {
            return Ok(unavailable(
                request,
                UnavailableReason::RegistrationProjectMismatch,
            ));
        }
        let identity = registration.identity.clone();
        let expected_seal = registration.seal.clone();
        let budget = CapacityBudget::new(sql_steps, deadline);
        let owner_stopped = Arc::new(AtomicBool::new(false));
        let (external_stop, external_deadline, finalization_signal, external_progress) =
            external_owner
                .as_deref()
                .map_or((None, None, None, None), |owner| {
                    (
                        owner.stop_signal(),
                        owner.progress_deadline(),
                        owner.finalization_signal(),
                        owner.progress_callback(),
                    )
                });
        let owner_scope = self.install_owner_with_stop(
            conn,
            Some(Arc::clone(&owner_stopped)),
            external_stop,
            external_deadline,
            finalization_signal,
            external_progress,
        )?;
        let mut owner = QueryOwnerControl {
            reader: self.control(Some(deadline)),
            maintenance: external_owner,
            stopped: owner_stopped,
        };
        let result = nir1_capacity::with_capacity_scope(
            conn,
            Some(Arc::clone(&budget)),
            &mut owner,
            |_, control| {
                #[cfg(feature = "nir1-material-diagnostics")]
                let pre_snapshot_started = _observation.as_ref().map(|_| Instant::now());
                let pre_snapshot_result = (|| -> Result<()> {
                    // The pinned identity check below detects changes before this
                    // snapshot; the post-rollback stamp detects changes during it.
                    // Avoid a redundant five-statement unpinned read here.
                    control.check(GraphWorkStage::Page)?;
                    conn.execute_batch("BEGIN DEFERRED")?;
                    ensure!(
                        ReadIdentity::read(conn)?.as_ref() == Some(&identity),
                        "NIR1_GRAPH_QUERY_DRIFT"
                    );
                    // This scalar identity read may finish after the deadline
                    // without reaching the progress cadence.
                    control.check(GraphWorkStage::Page)?;
                    ensure!(
                        read_seal(conn, &request.project_id)?.as_ref() == Some(&expected_seal),
                        "NIR1_GRAPH_QUERY_SEAL_DRIFT"
                    );
                    Ok(())
                })();
                #[cfg(feature = "nir1-material-diagnostics")]
                record_observed_stage(
                    &mut _observation,
                    ObservedStage::PreSnapshotIdentitySeal,
                    pre_snapshot_started,
                );
                pre_snapshot_result?;
                #[cfg(feature = "nir1-c-query-test-seam")]
                if worker_path
                    && std::env::var_os("NIR1_C_QUERY_TEST_SQL_STEPS")
                        .is_some_and(|value| value.to_str() == Some("over-limit"))
                {
                    // Bounded real SQLite work on this borrowed connection, transaction,
                    // and CapacityBudget; never used by a default-feature worker.
                    let _: i64 = conn.query_row(
                        "WITH RECURSIVE step_probe(n) AS (
                             VALUES(1) UNION ALL
                             SELECT n + 1 FROM step_probe WHERE n < 200000
                         ) SELECT sum(n) FROM step_probe",
                        [],
                        |row| row.get(0),
                    )?;
                }
                // The seal read above is an ordinary table-reading statement of
                // this transaction: SQLite compared the pinned snapshot's schema
                // cookie with the connection's schema cache when it started, so
                // the cache is now the snapshot's schema. Only this window
                // answers table presence from it; registration and every other
                // reader keep their SQL checks.
                with_pinned_snapshot(conn, || {
                    query_in_snapshot(
                        conn,
                        request,
                        &expected_seal,
                        control,
                        &mut _observation,
                        worker_path,
                    )
                })
            },
        );
        let pre_cleanup_status = worker_path.then(|| {
            worker_work_status(
                &result,
                Instant::now() >= deadline,
                budget.sql_steps_used() > sql_steps,
            )
        });
        #[cfg(feature = "nir1-material-diagnostics")]
        if result.is_err() {
            if let Some(observation) = _observation.as_deref_mut() {
                observation.work_result_error = true;
            }
        }
        #[cfg(feature = "nir1-material-diagnostics")]
        let cleanup_post_stamp_started = _observation.as_ref().map(|_| Instant::now());
        let query_outcome = (|| -> Result<Nir1GraphResponse> {
            let result = self.finish_read(conn, result, owner_scope)?;
            let current = nir1_capacity::with_capacity_scope(
                conn,
                Some(Arc::clone(&budget)),
                &mut owner,
                |_, control| {
                    let identity = ReadIdentity::read_unpinned(conn)?;
                    control.check(GraphWorkStage::ResultAssembly)?;
                    Ok(identity)
                },
            );
            let current_identity = match current {
                Ok(identity) => identity,
                Err(error) => {
                    // A capacity/deadline failure during the post-cleanup stamp
                    // is a bounded query failure.  It is not evidence of an
                    // identity drift and must not consume registration.
                    #[cfg(feature = "nir1-material-diagnostics")]
                    if let Some(observation) = _observation.as_deref_mut() {
                        observation.post_stamp_error = true;
                        observation.deadline_observed_at_collapse |= Instant::now() >= deadline;
                        observation.unattributed = true;
                    }
                    let reason = if worker_path {
                        worker_refusal_reason(
                            WorkerSite::PostStamp,
                            &error,
                            Instant::now() >= deadline,
                            budget.sql_steps_used() > sql_steps,
                            pre_cleanup_status,
                        )
                        .to_string()
                    } else {
                        "query-budget-or-validation-failed".to_owned()
                    };
                    return Ok(unavailable_response(request, &reason));
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
                self.pending_registration = None;
                #[cfg(feature = "nir1-material-diagnostics")]
                if let Some(observation) = _observation.as_deref_mut() {
                    observation.unattributed = true;
                }
                return Ok(unavailable(request, UnavailableReason::RegistrationDrift));
            }
            let reader_invalidated = self.check().is_err();
            let deadline_observed = !reader_invalidated && Instant::now() >= deadline;
            if reader_invalidated || deadline_observed {
                self.registration = None;
                self.pending_registration = None;
                #[cfg(feature = "nir1-material-diagnostics")]
                if let Some(observation) = _observation.as_deref_mut() {
                    observation.deadline_observed_at_collapse |= deadline_observed;
                    observation.unattributed |= reader_invalidated;
                }
                return Ok(unavailable(request, UnavailableReason::QueryInvalidated));
            }
            match result {
                Ok(response) => Ok(response),
                Err(error) => {
                    #[cfg(feature = "nir1-material-diagnostics")]
                    if let Some(observation) = _observation.as_deref_mut() {
                        observation.unattributed = true;
                    }
                    let reason = if worker_path {
                        worker_refusal_reason(
                            WorkerSite::Work,
                            &error,
                            Instant::now() >= deadline,
                            budget.sql_steps_used() > sql_steps,
                            pre_cleanup_status,
                        )
                        .to_string()
                    } else {
                        "query-budget-or-validation-failed".to_owned()
                    };
                    Ok(unavailable_response(request, &reason))
                }
            }
        })();
        #[cfg(feature = "nir1-material-diagnostics")]
        {
            record_observed_stage(
                &mut _observation,
                ObservedStage::CleanupPostStamp,
                cleanup_post_stamp_started,
            );
            if query_outcome.is_err() {
                if let Some(observation) = _observation.as_deref_mut() {
                    observation.unattributed = true;
                }
            }
        }
        #[cfg(test)]
        LAST_QUERY_SQL_STEPS.set(Some(budget.sql_steps_used()));
        query_outcome
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
        conn: &Connection,
        result: Result<T>,
        owner_scope: nir1_capacity::ProgressOwnerRestore,
    ) -> Result<Result<T>> {
        // Disable only SQLite's live callback before rollback. Keep the outer
        // maintenance owner registered so restoring this nested scope reinstalls it.
        let clear = owner_scope.clear_for_cleanup(conn);
        let rollback = if conn.is_autocommit() {
            Ok(())
        } else {
            conn.execute_batch("ROLLBACK")
        };
        let restore = owner_scope.restore(conn);
        if rollback.is_err() || clear.is_err() || restore.is_err() || !conn.is_autocommit() {
            self.cancelled.store(true, Ordering::Release);
            self.registration = None;
            self.pending_registration = None;
            anyhow::bail!("NIR1_GRAPH_READER_CLEANUP_FAILED");
        }
        Ok(result)
    }

    /// Close owned reader connections; worker-borrowed connections remain owned
    /// by the enclosing WorkspaceAuthority Database.
    pub fn close(&mut self) -> Result<()> {
        self.cancelled.store(true, Ordering::Release);
        self.registration = None;
        self.pending_registration = None;
        match std::mem::replace(&mut self.connection, ReaderConnection::Closed) {
            #[cfg(any(test, feature = "nir1-material-diagnostics"))]
            ReaderConnection::Owned(conn) => {
                if let Err((conn, _)) = conn.close() {
                    self.connection = ReaderConnection::Owned(conn);
                    anyhow::bail!("NIR1_GRAPH_READER_CLOSE_FAILED");
                }
            }
            ReaderConnection::Borrowed | ReaderConnection::Closed => {}
        }
        self.participant = None;
        Ok(())
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    pub(super) fn sqlite_memory_for_diagnostic(
        &self,
    ) -> Result<super::nir1_graph_memory_diagnostics::SqliteConnectionMemory> {
        let conn = self.owned_connection()?;
        super::nir1_graph_memory_diagnostics::sqlite_connection_memory_status(conn)
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    pub(crate) fn is_closed_for_diagnostic(&self) -> bool {
        matches!(self.connection, ReaderConnection::Closed) && self.participant.is_none()
    }

    #[cfg(any(test, feature = "nir1-material-diagnostics"))]
    fn take_owned_connection(&mut self) -> Result<Connection> {
        match std::mem::replace(&mut self.connection, ReaderConnection::Closed) {
            ReaderConnection::Owned(conn) => Ok(conn),
            connection @ (ReaderConnection::Borrowed | ReaderConnection::Closed) => {
                self.connection = connection;
                Err(anyhow::anyhow!("NIR1_GRAPH_READER_CLOSED"))
            }
        }
    }

    #[cfg(feature = "nir1-material-diagnostics")]
    fn owned_connection(&self) -> Result<&Connection> {
        match &self.connection {
            ReaderConnection::Owned(conn) => Ok(conn),
            ReaderConnection::Borrowed | ReaderConnection::Closed => {
                Err(anyhow::anyhow!("NIR1_GRAPH_READER_CLOSED"))
            }
        }
    }

    pub fn workspace_identity(&self) -> u64 {
        self.authority.identity()
    }
}

fn worker_work_status<T>(
    result: &Result<T>,
    deadline_elapsed: bool,
    sql_steps_exhausted: bool,
) -> PreCleanup {
    if deadline_elapsed {
        PreCleanup::DeadlineAlreadyCrossed
    } else {
        match result {
            Ok(_) => PreCleanup::WorkOk,
            Err(_) if sql_steps_exhausted => PreCleanup::WorkFailed(WorkerCause::Steps),
            Err(error) => PreCleanup::WorkFailed(worker_refusal_cause(error, false, false)),
        }
    }
}

/// Compose an allowlisted worker reason. Assembly and the parent's parser
/// share the closed `worker_frame` enums; no error text reaches the frame.
fn worker_refusal_reason(
    site: WorkerSite,
    error: &anyhow::Error,
    deadline_elapsed: bool,
    sql_steps_exhausted: bool,
    pre_cleanup: Option<PreCleanup>,
) -> UnavailableReason {
    let cause = match (site, pre_cleanup) {
        (WorkerSite::Work, Some(PreCleanup::WorkFailed(cause))) => cause,
        (WorkerSite::Work, Some(PreCleanup::DeadlineAlreadyCrossed)) => WorkerCause::Deadline,
        _ => worker_refusal_cause(error, deadline_elapsed, sql_steps_exhausted),
    };
    UnavailableReason::Worker {
        site,
        cause,
        pre_cleanup,
    }
}

fn worker_refusal_cause(
    error: &anyhow::Error,
    deadline_elapsed: bool,
    sql_steps_exhausted: bool,
) -> WorkerCause {
    if error.chain().any(|cause| {
        cause
            .downcast_ref::<rusqlite::Error>()
            .is_some_and(|error| matches!(error, rusqlite::Error::SqliteFailure(code, _) if code.code == rusqlite::ErrorCode::OutOfMemory))
    }) {
        return WorkerCause::SqliteNoMem;
    }
    // The Scene join marks its own resource refusals, including the shared
    // QueryUsage ones it reaches, so it is matched first.
    for (marker, cause) in [
        (SCENE_LIMIT_MARKER, WorkerCause::SceneLimit),
        (NODE_LIMIT_MARKER, WorkerCause::NodeLimit),
        (EDGE_LIMIT_MARKER, WorkerCause::EdgeLimit),
        (
            VERSION_CONFLICT_MARKER,
            WorkerCause::EndpointVersionConflict,
        ),
        (
            "NIR1_GRAPH_CANDIDATE_LIMIT",
            WorkerCause::CandidateRecordLimit,
        ),
        (
            "NIR1_GRAPH_REVISION_RECORD_LIMIT",
            WorkerCause::RevisionRecordLimit,
        ),
        (
            "NIR1_GRAPH_DISCLOSURE_RECORD_LIMIT",
            WorkerCause::DisclosureRecordLimit,
        ),
        ("NIR1_GRAPH_READ_LIMIT", WorkerCause::ReadRecordLimit),
    ] {
        if error.chain().any(|error| error.to_string() == marker) {
            return cause;
        }
    }
    match error.downcast_ref::<ValidationTerminated>() {
        Some(termination) => match termination.reason {
            ValidationTerminationReason::TimedOut => WorkerCause::Deadline,
            ValidationTerminationReason::CapacityExceeded => {
                match (deadline_elapsed, sql_steps_exhausted) {
                    (true, true) => WorkerCause::DeadlineOrSteps,
                    (true, false) => WorkerCause::Deadline,
                    (false, true) => WorkerCause::Steps,
                    (false, false) => WorkerCause::ValidationCapacityExceeded,
                }
            }
            ValidationTerminationReason::ContextUnavailable => {
                WorkerCause::ValidationContextUnavailable
            }
            ValidationTerminationReason::Cancelled => WorkerCause::ValidationCancelled,
            ValidationTerminationReason::Closed => WorkerCause::ValidationClosed,
            ValidationTerminationReason::WorkspaceGenerationChanged => {
                WorkerCause::ValidationWorkspaceGenerationChanged
            }
            ValidationTerminationReason::ForegroundPreempted => {
                WorkerCause::ValidationForegroundPreempted
            }
            ValidationTerminationReason::CleanupFailed => WorkerCause::ValidationCleanupFailed,
        },
        None => WorkerCause::Other,
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

struct QueryOwnerControl<'a> {
    reader: ReaderControl,
    maintenance: Option<&'a mut dyn GraphWorkControl>,
    stopped: Arc<AtomicBool>,
}

impl GraphWorkControl for QueryOwnerControl<'_> {
    fn check(&mut self, stage: GraphWorkStage) -> Result<()> {
        self.reader.check(stage)?;
        if self.stopped.load(Ordering::Acquire) {
            return Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "NIR1 Graph maintenance owner stopped",
            ));
        }
        if let Some(owner) = self.maintenance.as_deref_mut() {
            if let Err(error) = owner.check(stage) {
                self.stopped.store(true, Ordering::Release);
                return Err(error);
            }
        }
        Ok(())
    }

    fn progress_callback(&self) -> Option<GraphProgressCallback> {
        self.maintenance
            .as_deref()
            .and_then(GraphWorkControl::progress_callback)
    }

    fn stop_signal(&self) -> Option<Arc<AtomicBool>> {
        self.maintenance
            .as_deref()
            .and_then(GraphWorkControl::stop_signal)
    }

    fn progress_deadline(&self) -> Option<Instant> {
        self.maintenance
            .as_deref()
            .and_then(GraphWorkControl::progress_deadline)
    }

    fn finalization_signal(&self) -> Option<Arc<AtomicBool>> {
        self.maintenance
            .as_deref()
            .and_then(GraphWorkControl::finalization_signal)
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
    /// caller must still account every live container before relying on the
    /// defensive logical bound, which is not a physical-memory proof.
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

    fn admit_transient_material_reserve(
        &mut self,
        raw_bytes: usize,
        rows: usize,
        worker_path: bool,
    ) -> Result<()> {
        // The isolated worker's fixed query arena replaces this estimate; keep
        // it for ordinary readers, which have no physical arena bound.
        if worker_path {
            return Ok(());
        }
        self.admit_retained(transient_material_reserve(raw_bytes, rows)?)
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

fn retained_scope_binding(scope: &ScopeBinding) -> Result<usize> {
    let mut total = std::mem::size_of::<ScopeBinding>();
    retained_add(&mut total, retained_scope_value(&scope.reading))?;
    retained_add(&mut total, retained_scope_value(&scope.story))?;
    retained_add(&mut total, retained_scope_value(&scope.auto))?;
    retained_add(&mut total, retained_string(&scope.phase))?;
    retained_add(&mut total, retained_string(&scope.reveal))?;
    if let Some(pov) = &scope.pov {
        retained_add(&mut total, retained_string(pov))?;
    }
    retained_add(&mut total, retained_string(&scope.authority_revision))?;
    Ok(total)
}

fn retained_entity(entity: &EntityInput) -> Result<usize> {
    let mut total = std::mem::size_of::<EntityInput>();
    retained_add(&mut total, retained_string(&entity.entity_id))?;
    retained_add(&mut total, retained_string(&entity.entity_type))?;
    retained_add(&mut total, retained_string(&entity.label))?;
    retained_add(&mut total, retained_string(&entity.source_token))?;
    retained_add(&mut total, retained_scope_binding(&entity.scope)?)?;
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
    _observation: &mut Option<&mut StageObservation>,
    worker_path: bool,
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
        return Ok(unavailable(request, UnavailableReason::SeedNotFound));
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
    // The project-level reads shared by every Revision of this query, read at
    // the first Revision that reaches A3 (see the A3 block below), and the
    // bytes they were admitted for.
    let mut project_reads: Option<Nir1ProjectReads> = None;
    let mut project_read_bytes = 0usize;
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
            #[cfg(feature = "nir1-material-diagnostics")]
            let candidate_page_started = _observation.as_ref().map(|_| Instant::now());
            let page_result = candidates::read_candidate_page_with_admission(
                conn,
                &request.project_id,
                &entity_id,
                cursor,
                MAX_GRAPH_RECORDS - usage.rows,
                MAX_GRAPH_INPUT_BYTES - usage.bytes,
                |rows, bytes| usage.admit(rows, bytes),
            );
            #[cfg(feature = "nir1-material-diagnostics")]
            record_observed_stage(
                _observation,
                ObservedStage::IndexedCandidatePage,
                candidate_page_started,
            );
            let page = page_result?;
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
            // A short page ends the source only when it returned fewer rows
            // than it asked for; a page truncated by the remaining record
            // budget must reach the has-more probe above.
            if count < page_limit {
                break;
            }
        }
        usage.admit_retained(
            std::mem::size_of::<Vec<(Arc<GraphEdgeInput>, String)>>()
                + MAX_GRAPH_EDGES * std::mem::size_of::<(Arc<GraphEdgeInput>, String)>(),
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
                #[cfg(feature = "nir1-material-diagnostics")]
                let a2_started = _observation.as_ref().map(|_| Instant::now());
                #[cfg(feature = "nir1-material-diagnostics")]
                let revision_preflight = input::preflight_revision_observed(
                    conn,
                    &request.project_id,
                    &revision_id,
                    MAX_GRAPH_RECORDS - usage.rows,
                    MAX_GRAPH_INPUT_BYTES - usage.bytes,
                    _observation.as_deref_mut().map(|value| &mut value.a2_sql),
                );
                #[cfg(not(feature = "nir1-material-diagnostics"))]
                let revision_preflight = input::preflight_revision(
                    conn,
                    &request.project_id,
                    &revision_id,
                    MAX_GRAPH_RECORDS - usage.rows,
                    MAX_GRAPH_INPUT_BYTES - usage.bytes,
                );
                #[cfg(feature = "nir1-material-diagnostics")]
                record_observed_stage(_observation, ObservedStage::A2Preflight, a2_started);
                let qualified = if let Some(admission) = revision_preflight? {
                    let revision_admission = admission;
                    usage.admit(revision_admission.rows, revision_admission.bytes)?;
                    #[cfg(feature = "nir1-material-diagnostics")]
                    let a3_preflight_started = _observation.as_ref().map(|_| Instant::now());
                    // The reads every Revision of this query shares (the live
                    // Scope authority, the latest Epoch, the query Scene) are
                    // admitted once, here, before the first of them, and read
                    // once below. What belongs to one Revision is admitted for
                    // each.
                    let first_project_reads = project_reads.is_none();
                    if first_project_reads {
                        #[cfg(feature = "nir1-material-diagnostics")]
                        let shared_preflight = input::preflight_project_reads_observed(
                            conn,
                            &request.project_id,
                            &request.query_scene_id,
                            MAX_GRAPH_RECORDS - usage.rows,
                            MAX_GRAPH_INPUT_BYTES - usage.bytes,
                            _observation.as_deref_mut().map(|value| &mut value.a3_sql),
                        );
                        #[cfg(not(feature = "nir1-material-diagnostics"))]
                        let shared_preflight = input::preflight_project_reads(
                            conn,
                            &request.project_id,
                            &request.query_scene_id,
                            MAX_GRAPH_RECORDS - usage.rows,
                            MAX_GRAPH_INPUT_BYTES - usage.bytes,
                        );
                        let shared_admission = shared_preflight?;
                        usage.admit(shared_admission.rows, shared_admission.bytes)?;
                        usage.admit_transient_material_reserve(
                            shared_admission.bytes,
                            shared_admission.rows,
                            worker_path,
                        )?;
                        project_read_bytes = shared_admission.bytes;
                    }
                    #[cfg(feature = "nir1-material-diagnostics")]
                    let disclosure_preflight = input::preflight_disclosure_revision_observed(
                        conn,
                        &request.project_id,
                        &revision_id,
                        revision_admission.payload_bytes,
                        project_read_bytes,
                        MAX_GRAPH_RECORDS - usage.rows,
                        MAX_GRAPH_INPUT_BYTES - usage.bytes,
                        _observation.as_deref_mut().map(|value| &mut value.a3_sql),
                    );
                    #[cfg(not(feature = "nir1-material-diagnostics"))]
                    let disclosure_preflight = input::preflight_disclosure_revision(
                        conn,
                        &request.project_id,
                        &revision_id,
                        revision_admission.payload_bytes,
                        project_read_bytes,
                        MAX_GRAPH_RECORDS - usage.rows,
                        MAX_GRAPH_INPUT_BYTES - usage.bytes,
                    );
                    #[cfg(feature = "nir1-material-diagnostics")]
                    record_observed_stage(
                        _observation,
                        ObservedStage::A3Preflight,
                        a3_preflight_started,
                    );
                    let disclosure_admission = disclosure_preflight?;
                    usage.admit(disclosure_admission.rows, disclosure_admission.bytes)?;
                    usage.admit_transient_material_reserve(
                        revision_admission
                            .bytes
                            .checked_add(disclosure_admission.bytes)
                            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_RETAINED_LIMIT"))?,
                        revision_admission
                            .rows
                            .checked_add(disclosure_admission.rows)
                            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_RETAINED_LIMIT"))?,
                        worker_path,
                    )?;
                    control.check(GraphWorkStage::A2)?;
                    #[cfg(feature = "nir1-material-diagnostics")]
                    let a3_started = _observation.as_ref().map(|_| Instant::now());
                    if first_project_reads {
                        project_reads = Some(Nir1ProjectReads::load(
                            conn,
                            &request.project_id,
                            &request.query_scene_id,
                        )?);
                    }
                    let reads = project_reads
                        .as_ref()
                        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_PROJECT_READS_MISSING"))?;
                    #[cfg(test)]
                    let qualified = if UNSHARED_PROJECT_READS.get() {
                        // The Revision reading the project-level state itself:
                        // the oracle the shared evaluation is compared with.
                        evaluate_nir1_entity_relation_disclosure(
                            conn,
                            &request.project_id,
                            &revision_id,
                            &request.query_scene_id,
                        )
                    } else {
                        evaluate_nir1_entity_relation_disclosure_shared(
                            conn,
                            &request.project_id,
                            &revision_id,
                            &request.query_scene_id,
                            reads,
                        )
                    };
                    #[cfg(not(test))]
                    let qualified = evaluate_nir1_entity_relation_disclosure_shared(
                        conn,
                        &request.project_id,
                        &revision_id,
                        &request.query_scene_id,
                        reads,
                    );
                    #[cfg(feature = "nir1-material-diagnostics")]
                    record_observed_stage(_observation, ObservedStage::A3Evaluation, a3_started);
                    let qualified = qualified?;
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
                        retained_string(&revision_id)
                            + std::mem::size_of::<(Arc<GraphEdgeInput>, String)>(),
                    )?;
                    incident.push((Arc::clone(relation), revision_id.clone()));
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
        incident.sort_by(|a, b| a.0.edge_id.cmp(&b.0.edge_id).then(a.1.cmp(&b.1)));
        for (relation, revision_id) in incident {
            control.check(GraphWorkStage::Edge)?;
            let material = revisions
                .get(&revision_id)
                .and_then(Option::as_ref)
                .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_REVISION_MISSING"))?;
            let edge_id = &relation.edge_id;
            let target = if relation.from_entity_id == entity_id {
                &relation.to_entity_id
            } else {
                &relation.from_entity_id
            };
            if !hops.contains_key(target) {
                ensure!(hops.len() < MAX_GRAPH_NODES, NODE_LIMIT_MARKER);
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
                    + retained_string(edge_id)
                    + std::mem::size_of::<(String, String)>()
                    + std::mem::size_of::<Nir1GraphEdge>()
                    + 4 * std::mem::size_of::<usize>(),
            )?;
            let key = (revision_id.clone(), edge_id.clone());
            if edges.contains_key(&key) {
                continue;
            }
            ensure!(edges.len() < MAX_GRAPH_EDGES, EDGE_LIMIT_MARKER);
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
                    relation: Arc::clone(&relation),
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
    // Same snapshot, QueryUsage and control as the paths; an incomplete
    // enumeration refuses the whole Graph instead of returning a prefix.
    let (scene_total, scenes) = join_scene_pins(
        conn,
        request,
        &ordered_nodes,
        &ordered_edges,
        &mut usage,
        control,
    )
    .map_err(scene_join_failure)?;
    let response_scope_bytes = scope_revision.as_ref().map_or(0, retained_string);
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
            scene_total,
            scenes,
        }),
        reason: None,
    };
    // The worker's bounded binary frame is the actual result; a JSON count-only
    // pass would traverse the same response again before that frame is encoded.
    if !worker_path {
        let mut counter = OutputCounter {
            bytes: 0,
            usage: &mut usage,
            control,
        };
        serde_json::to_writer(&mut counter, &response)?;
        control.check(GraphWorkStage::Serialization)?;
    }
    #[cfg(test)]
    LAST_QUERY_ROWS.set(Some(usage.rows));
    Ok(response)
}

/// The semantic Graph limits and the contradiction check, each with the
/// marker its refusal carries. The worker maps every marker to its own typed
/// cause; the ordinary reader keeps its single generic reason.
const NODE_LIMIT_MARKER: &str = "NIR1_GRAPH_NODE_LIMIT";
const EDGE_LIMIT_MARKER: &str = "NIR1_GRAPH_EDGE_LIMIT";
const VERSION_CONFLICT_MARKER: &str = "NIR1_GRAPH_ENDPOINT_VERSION_CONFLICT";

/// Context for every resource refusal of the Scene join (category `limit`).
const SCENE_LIMIT_MARKER: &str = "NIR1_GRAPH_SCENE_LIMIT";
const SCENE_RESOURCE_MARKERS: [&str; 9] = [
    "NIR1_GRAPH_SCENE_READ_LIMIT",
    "NIR1_GRAPH_SCENE_INPUT_LIMIT",
    "NIR1_GRAPH_SCENE_QUERY_RESOURCE_LIMIT",
    "NIR1_GRAPH_SCENE_PIN_LIMIT",
    "NIR1_GRAPH_SCENE_FRAME_LIMIT",
    "NIR1_GRAPH_QUERY_RESOURCE_LIMIT",
    "NIR1_GRAPH_READ_LIMIT",
    "NIR1_GRAPH_INPUT_LIMIT",
    "NIR1_GRAPH_RETAINED_LIMIT",
];

/// Mark resource exhaustion inside the join as `scene-limit`. SQL steps,
/// deadline and cancellation keep their typed ValidationTerminated cause.
fn scene_join_failure(error: anyhow::Error) -> anyhow::Error {
    if error.downcast_ref::<ValidationTerminated>().is_none()
        && error
            .chain()
            .any(|cause| SCENE_RESOURCE_MARKERS.contains(&cause.to_string().as_str()))
    {
        error.context(SCENE_LIMIT_MARKER)
    } else {
        error
    }
}

/// A reached Entity (hop >= 1) and its representative path.
#[derive(Clone, Copy, Debug)]
struct ReachedEntity<'g> {
    entity_id: &'g str,
    hop: u8,
    /// Frame edge indices in traversal order; the first `hop` are used.
    path: [usize; MAX_GRAPH_HOPS as usize],
}

impl ReachedEntity<'_> {
    fn path(&self) -> &[usize] {
        &self.path[..usize::from(self.hop)]
    }
}

/// The Graph traversal rule: a relation is followed from its source, and
/// also from its target when it is symmetric.
fn traversed<'g>(relation: &'g GraphEdgeInput, from: &str) -> Option<&'g str> {
    if relation.from_entity_id == from {
        Some(&relation.to_entity_id)
    } else if relation.directionality == "symmetric" && relation.to_entity_id == from {
        Some(&relation.from_entity_id)
    } else {
        None
    }
}

fn path_edge_ids<'g>(
    edges: &'g [Nir1GraphEdge],
    path: &'g [usize],
) -> impl Iterator<Item = &'g [u8]> + 'g {
    path.iter()
        .map(|index| edges[*index].relation.edge_id.as_bytes())
}

/// Equal-length paths by (edge ID bytes..., frame indices...). The frame index
/// only separates the same edge ID carried by different Revisions.
fn compare_paths(edges: &[Nir1GraphEdge], left: &[usize], right: &[usize]) -> std::cmp::Ordering {
    path_edge_ids(edges, left)
        .cmp(path_edge_ids(edges, right))
        .then_with(|| left.cmp(right))
}

/// The minimum direct step from `from` to `to`.
fn minimum_step(edges: &[Nir1GraphEdge], from: &str, to: &str) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (index, edge) in edges.iter().enumerate() {
        if traversed(&edge.relation, from) == Some(to)
            && best.is_none_or(|best| {
                compare_paths(edges, &[index], &[best]) == std::cmp::Ordering::Less
            })
        {
            best = Some(index);
        }
    }
    best
}

/// Rank reached Entities by (hop, representative edge IDs, Entity ID), all
/// IDs as UTF-8 bytes. The hop is the BFS shortest distance, so a
/// representative path is a shortest path; for a hop-2 Entity the first
/// edge is compared before the second, so each hop-1 Entity's own minimum
/// first step yields the minimum over every pair.
fn rank_reached_entities<'g>(
    seed: &str,
    nodes: &'g [Nir1GraphNode],
    edges: &'g [Nir1GraphEdge],
) -> Result<Vec<ReachedEntity<'g>>> {
    let mut reached = Vec::with_capacity(MAX_GRAPH_NODES);
    for node in nodes.iter().filter(|node| node.hop == 1) {
        let first = minimum_step(edges, seed, &node.entity.entity_id)
            .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_PATH_MISSING"))?;
        reached.push(ReachedEntity {
            entity_id: &node.entity.entity_id,
            hop: 1,
            path: [first, 0],
        });
    }
    let hop_one = reached.len();
    for node in nodes.iter().filter(|node| node.hop == 2) {
        let mut best: Option<[usize; 2]> = None;
        for intermediate in &reached[..hop_one] {
            let Some(second) = minimum_step(edges, intermediate.entity_id, &node.entity.entity_id)
            else {
                continue;
            };
            let candidate = [intermediate.path[0], second];
            if best.is_none_or(|best| {
                compare_paths(edges, &candidate, &best) == std::cmp::Ordering::Less
            }) {
                best = Some(candidate);
            }
        }
        reached.push(ReachedEntity {
            entity_id: &node.entity.entity_id,
            hop: 2,
            path: best.ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_PATH_MISSING"))?,
        });
    }
    reached.sort_by(|left, right| {
        left.hop
            .cmp(&right.hop)
            .then_with(|| path_edge_ids(edges, left.path()).cmp(path_edge_ids(edges, right.path())))
            .then_with(|| left.entity_id.as_bytes().cmp(right.entity_id.as_bytes()))
    });
    Ok(reached)
}

/// The first pin seen for a Scene in rank order: its representative.
struct FirstPin {
    rank: usize,
    pin: ScenePinLocator,
}

/// Enumerate every explicit pin of every reached Entity in the Graph's own
/// snapshot, QueryUsage and control, then keep the first `MAX_GRAPH_SCENES`
/// distinct Scenes in tuple order. The seed's pins never contribute, and no
/// Scene body is read.
fn join_scene_pins(
    conn: &Connection,
    request: &Nir1GraphRequest,
    nodes: &[Nir1GraphNode],
    edges: &[Nir1GraphEdge],
    usage: &mut QueryUsage,
    control: &mut dyn GraphWorkControl,
) -> Result<(usize, Vec<Nir1GraphSceneAssociation>)> {
    control.check(GraphWorkStage::Page)?;
    usage.admit_retained(
        std::mem::size_of::<Vec<ReachedEntity<'_>>>()
            + MAX_GRAPH_NODES * std::mem::size_of::<ReachedEntity<'_>>(),
    )?;
    let reached = rank_reached_entities(&request.seed_entity_id, nodes, edges)?;
    if reached.is_empty() {
        return Ok((0, Vec::new()));
    }
    // One cumulative instance for the whole Graph, limited to the shared
    // remainder; never one budget per Entity or Scene.
    let mut budget = SceneJoinBudget::new(
        MAX_GRAPH_RECORDS.saturating_sub(usage.rows),
        MAX_GRAPH_INPUT_BYTES.saturating_sub(usage.bytes),
    );
    usage.admit_retained(std::mem::size_of::<BTreeMap<String, FirstPin>>())?;
    let mut first_pins: BTreeMap<String, FirstPin> = BTreeMap::new();
    for (rank, entity) in reached.iter().enumerate() {
        let mut cursor = 0i64;
        loop {
            control.check(GraphWorkStage::Page)?;
            // The bound Entity ID is materialized for every page and probe.
            let key_bytes = entity.entity_id.len();
            budget.admit(0, key_bytes)?;
            usage.admit(0, key_bytes)?;
            if usage.rows == MAX_GRAPH_RECORDS || usage.pages == QUERY_MAX_PAGES {
                let mut check = || control.check(GraphWorkStage::Page);
                let more = scenes::scene_pins_remain(
                    conn,
                    &request.project_id,
                    entity.entity_id,
                    cursor,
                    &mut check,
                )?;
                ensure!(!more, "NIR1_GRAPH_SCENE_PIN_LIMIT");
                break;
            }
            let page_limit = (MAX_GRAPH_RECORDS - usage.rows).min(scenes::PIN_PAGE_ROWS);
            usage.admit_retained(scenes::pin_page_scratch_bytes(page_limit)?)?;
            let page = {
                let mut check = || control.check(GraphWorkStage::Row);
                scenes::read_scene_pin_page_with_admission(
                    conn,
                    &request.project_id,
                    entity.entity_id,
                    cursor,
                    page_limit,
                    &mut budget,
                    &mut check,
                    |rows, bytes| usage.admit(rows, bytes),
                )?
            };
            usage.pages += 1;
            let count = page.len();
            for pin in page {
                control.check(GraphWorkStage::Row)?;
                cursor = pin.rowid;
                if !first_pins.contains_key(&pin.scene_id) {
                    usage.admit_retained(
                        retained_string(&pin.scene_id) * 2
                            + retained_string(&pin.entry_id)
                            + retained_string(&pin.created_at)
                            + std::mem::size_of::<FirstPin>()
                            + 8 * std::mem::size_of::<usize>(),
                    )?;
                    first_pins.insert(pin.scene_id.clone(), FirstPin { rank, pin });
                }
            }
            // As with candidates, only a page shorter than it asked for ends
            // the Entity; a page cut by the shared remainder reaches the probe.
            if count < page_limit {
                break;
            }
        }
    }
    let scene_total = first_pins.len();
    // (rank, Scene ID): ranks in order, each rank's Scenes in map order.
    usage.admit_retained(
        std::mem::size_of::<Vec<&FirstPin>>() + MAX_GRAPH_SCENES * std::mem::size_of::<&FirstPin>(),
    )?;
    let mut selected: Vec<&FirstPin> = Vec::with_capacity(MAX_GRAPH_SCENES);
    'ranks: for rank in 0..reached.len() {
        control.check(GraphWorkStage::Sort)?;
        for first in first_pins.values().filter(|first| first.rank == rank) {
            if selected.len() == MAX_GRAPH_SCENES {
                break 'ranks;
            }
            selected.push(first);
        }
    }
    usage.admit_retained(
        std::mem::size_of::<Vec<Nir1GraphSceneAssociation>>()
            + selected.len() * std::mem::size_of::<Nir1GraphSceneAssociation>(),
    )?;
    let mut associations = Vec::with_capacity(selected.len());
    let mut section_bytes = SCENE_SECTION_HEADER_BYTES;
    for first in selected {
        control.check(GraphWorkStage::Source)?;
        let entity = &reached[first.rank];
        let pin = &first.pin;
        let tokens = {
            let mut check = || control.check(GraphWorkStage::Source);
            scenes::read_scene_frame_tokens(
                conn,
                &request.project_id,
                &pin.scene_id,
                &mut budget,
                &mut check,
                |lengths| {
                    // The frame's Scene-section cap is checked before any
                    // token is materialized.
                    let association = SceneAssociationLengths {
                        scene_id: pin.scene_id.len(),
                        scene_incarnation_id: lengths.incarnation_id,
                        scene_source_token: lengths.source_token,
                        scene_scope_token: lengths.scope_token,
                        pin_entry_id: pin.entry_id.len(),
                        pin_created_at: pin.created_at.len(),
                        path_edge_count: usize::from(entity.hop),
                    };
                    section_bytes = association
                        .encoded_bytes()
                        .and_then(|bytes| section_bytes.checked_add(bytes))
                        .ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_SCENE_FRAME_LIMIT"))?;
                    ensure!(
                        section_bytes <= MAX_SCENE_SECTION_BYTES,
                        "NIR1_GRAPH_SCENE_FRAME_LIMIT"
                    );
                    let token_bytes = lengths.bytes()?;
                    usage.admit(lengths.rows, token_bytes)?;
                    usage.admit_retained(
                        token_bytes
                            + pin.scene_id.len()
                            + pin.entry_id.len()
                            + pin.created_at.len()
                            + std::mem::size_of::<Vec<u16>>()
                            + usize::from(entity.hop) * std::mem::size_of::<u16>(),
                    )
                },
            )?
        };
        let path_edge_indices = entity
            .path()
            .iter()
            .map(|index| u16::try_from(*index))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        associations.push(Nir1GraphSceneAssociation {
            scene_id: pin.scene_id.clone(),
            scene_incarnation_id: tokens.incarnation_id,
            scene_source_token: tokens.source_token,
            scene_scope_token: tokens.scope_token,
            pin_rowid: pin.rowid,
            pin_entry_id: pin.entry_id.clone(),
            pin_created_at: pin.created_at.clone(),
            path_hop: entity.hop,
            path_edge_indices,
        });
    }
    control.check(GraphWorkStage::ResultAssembly)?;
    Ok((scene_total, associations))
}

/// Whether two versions of an Entity are one node: every field but the Scope.
/// The Scope is the one field a review legitimately changes for the same
/// Entity (the Scene the review was made under), so it is compared per
/// binding, never here. The exhaustive destructuring makes a new
/// `EntityInput` field a compile error until it is classified.
fn same_node_identity(node: &EntityInput, other: &EntityInput) -> bool {
    let EntityInput {
        entity_id,
        entity_type,
        label,
        source_token,
        scope: _,
        evidence,
    } = node;
    *entity_id == other.entity_id
        && *entity_type == other.entity_type
        && *label == other.label
        && *source_token == other.source_token
        && *evidence == other.evidence
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
            same_node_identity(&node.entity, &entity),
            VERSION_CONFLICT_MARKER
        );
        if !node
            .bindings
            .iter()
            .any(|b| b.revision_id == binding.revision_id)
        {
            // Every node owns two bounded Vecs, one binding and one Scope per
            // Revision. Their complete possible capacity was reserved (and
            // charged) with the node, so these pushes cannot trigger an
            // uncharged Vec growth and do not pay MAX_GRAPH_RECORDS again for
            // every edge. What each push adds is the Scope it keeps.
            usage.admit_retained(binding_scope_retained_bytes(&entity.scope)?)?;
            node.bindings.push(binding);
            node.binding_scopes.push(Arc::new(entity.scope.clone()));
        }
    } else {
        usage.admit_retained(
            retained_string(&entity.entity_id)
                + std::mem::size_of::<Nir1GraphNode>()
                + std::mem::size_of::<Vec<Arc<Nir1GraphMaterialBinding>>>()
                + MAX_GRAPH_RECORDS * std::mem::size_of::<Arc<Nir1GraphMaterialBinding>>()
                + std::mem::size_of::<Vec<Arc<ScopeBinding>>>()
                + MAX_GRAPH_RECORDS * std::mem::size_of::<Arc<ScopeBinding>>()
                + binding_scope_retained_bytes(&entity.scope)?
                + 8 * std::mem::size_of::<usize>(),
        )?;
        let scope = Arc::new(entity.scope.clone());
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
                binding_scopes: {
                    let mut scopes = Vec::with_capacity(MAX_GRAPH_RECORDS);
                    scopes.push(scope);
                    scopes
                },
            },
        );
    }
    Ok(())
}

/// The bytes one node keeps for one binding's Scope: the Scope, its `Arc`
/// control block and the pointer the node's Vec holds.
fn binding_scope_retained_bytes(scope: &ScopeBinding) -> Result<usize> {
    let mut total = retained_scope_binding(scope)?;
    retained_add(&mut total, 2 * std::mem::size_of::<usize>())?;
    Ok(total)
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
    Ok(unavailable(
        request,
        UnavailableReason::RegistrationRequired,
    ))
}

/// An unavailable response whose reason is a member of the frame allowlist.
fn unavailable(request: &Nir1GraphRequest, reason: UnavailableReason) -> Nir1GraphResponse {
    unavailable_response(request, &reason.to_string())
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
