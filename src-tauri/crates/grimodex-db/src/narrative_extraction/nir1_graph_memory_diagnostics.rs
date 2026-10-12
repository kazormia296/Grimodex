//! Opt-in, observation-only measurement of one registered canonical Graph query.
//!
//! This diagnostic is available only with `nir1-material-diagnostics`. It
//! snapshots the caller's closed fixture DB into a private temporary copy,
//! prepares and publishes the existing Graph index there, registers a normal
//! `Nir1GraphReader`, and measures only the reader's query call. It does not
//! activate or publish Graph in a product workspace.

use std::{
    ffi::OsString,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};

use anyhow::{ensure, Context, Result};
use grimodex_core::narrative_nir1::MAX_GRAPH_INPUT_BYTES;
use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    nir1_entity_relation_index::{
        prepare_graph_index_build_with_control,
        publish_nir1_entity_relation_index_in_tx_with_control, GraphWorkControl,
    },
    nir1_graph::{
        A2SqlObservation, A3SqlObservation, Nir1GraphReader, Nir1GraphRequest,
        StageObservation as ReaderStageObservation,
    },
};
use crate::{
    narrative_maintenance_connection::{
        with_narrative_maintenance_graph_control, NarrativeMaintenanceGraphControlConfig,
    },
    Database, WorkspaceAuthority, WorkspaceLifecycleCore,
};

const PROGRESS_CADENCE_VM_STEPS: i32 = 1_000;
const MAX_CLI_PATH_BYTES: usize = 4_096;
const SQLITE_STATUS_MEMORY_USED: i32 = rusqlite::ffi::SQLITE_STATUS_MEMORY_USED;

/// Per-connection SQLite DBSTATUS estimates, not an additive memory bound.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SqliteConnectionMemory {
    pub cache_bytes_approx: u64,
    pub schema_bytes_approx: u64,
    pub statement_bytes_approx: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CQueryMemoryObservation {
    /// Observation-only status; this value is never a memory-bound PASS.
    pub status: &'static str,
    pub claims_hard_two_mib_bound: bool,
    pub project_id: String,
    pub query_scene_id: String,
    pub seed_entity_id: String,
    pub source_snapshot_verified_unchanged: bool,
    pub preparation: StageObservation,
    pub registration: RegistrationObservation,
    pub query: QueryObservation,
    pub rust_allocator: RustAllocatorObservation,
    pub sqlite: SqliteMemoryObservation,
    /// Managed-only pre-READY snapshot: authority, then dedicated reader.
    /// Keep the legacy observer JSON unchanged.
    #[serde(skip_serializing)]
    pub sqlite_registered_connections: Option<(SqliteConnectionMemory, SqliteConnectionMemory)>,
    pub cleanup: CleanupObservation,
    pub coverage: Vec<&'static str>,
    pub unknowns: Vec<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageObservation {
    pub status: &'static str,
    pub elapsed_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationObservation {
    pub status: &'static str,
    pub registered: bool,
    pub elapsed_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryObservation {
    pub status: &'static str,
    pub reason: Option<String>,
    pub elapsed_ms: f64,
    pub available_nodes: Option<usize>,
    pub available_edges: Option<usize>,
    pub stage_observation: QueryStageObservation,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryStageObservation {
    pub pre_snapshot_identity_seal_ns: Option<u64>,
    pub indexed_candidate_page_ns: Option<u64>,
    pub a2_preflight_ns: Option<u64>,
    pub a2_sql: QueryA2SqlObservation,
    pub a3_preflight_ns: Option<u64>,
    pub a3_sql: QueryA3SqlObservation,
    pub a3_evaluation_ns: Option<u64>,
    pub cleanup_post_stamp_ns: Option<u64>,
    pub work_result_error: bool,
    pub post_stamp_error: bool,
    pub deadline_observed_at_collapse: bool,
    pub unattributed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryA2SqlObservation {
    pub length_ns: Option<u64>,
    pub count_ns: Option<u64>,
    pub related_ns: [Option<u64>; 10],
    pub error_slot: Option<u8>,
    pub overflow_mask: u16,
    pub unattributed: bool,
}

impl From<A2SqlObservation> for QueryA2SqlObservation {
    fn from(observation: A2SqlObservation) -> Self {
        Self {
            length_ns: observation.length_ns,
            count_ns: observation.count_ns,
            related_ns: observation.related_ns,
            error_slot: observation.error_slot,
            overflow_mask: observation.overflow_mask,
            unattributed: observation.unattributed,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryA3SqlObservation {
    pub timings_ns: [Option<u64>; 23],
    pub error_slot: Option<u8>,
    pub overflow_mask: u32,
    pub unattributed: bool,
}

impl From<A3SqlObservation> for QueryA3SqlObservation {
    fn from(observation: A3SqlObservation) -> Self {
        Self {
            timings_ns: observation.timings_ns,
            error_slot: observation.error_slot,
            overflow_mask: observation.overflow_mask,
            unattributed: observation.unattributed,
        }
    }
}

impl From<ReaderStageObservation> for QueryStageObservation {
    fn from(observation: ReaderStageObservation) -> Self {
        Self {
            pre_snapshot_identity_seal_ns: observation.pre_snapshot_identity_seal_ns,
            indexed_candidate_page_ns: observation.indexed_candidate_page_ns,
            a2_preflight_ns: observation.a2_preflight_ns,
            a2_sql: observation.a2_sql.into(),
            a3_preflight_ns: observation.a3_preflight_ns,
            a3_sql: observation.a3_sql.into(),
            a3_evaluation_ns: observation.a3_evaluation_ns,
            cleanup_post_stamp_ns: observation.cleanup_post_stamp_ns,
            work_result_error: observation.work_result_error,
            post_stamp_error: observation.post_stamp_error,
            deadline_observed_at_collapse: observation.deadline_observed_at_collapse,
            unattributed: observation.unattributed,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RustAllocatorObservation {
    pub method: &'static str,
    pub baseline_requested_live_bytes: u64,
    pub query_window_peak_requested_live_bytes: u64,
    pub query_window_incremental_peak_bytes: u64,
    pub requested_live_bytes_after_query: u64,
    pub coverage: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteMemoryObservation {
    pub memstatus_verified: bool,
    pub method: &'static str,
    pub baseline_bytes: u64,
    pub query_window_highwater_bytes: u64,
    pub query_window_incremental_highwater_bytes: u64,
    pub current_bytes_after_query: u64,
    pub scope: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupObservation {
    pub status: &'static str,
    pub reader_closed: bool,
    pub workspace_participant_released: bool,
    pub disposable_database_removed: bool,
    pub elapsed_ms: f64,
    pub process_exit_contract: &'static str,
}

/// Snapshot the main database and its SQLite WAL/SHM sidecars, then run one
/// real registered Graph query against the private copy. The callbacks belong
/// to the isolated binary's process-local Rust allocator wrapper.
pub fn run_c_query_memory_diagnostic(
    source_database_path: &Path,
    project_id: &str,
    query_scene_id: &str,
    seed_entity_id: &str,
    begin_rust_window: impl FnOnce() -> u64,
    finish_rust_window: impl FnOnce() -> (u64, u64),
) -> Result<CQueryMemoryObservation> {
    run_c_query_memory_diagnostic_with_ready_hook(
        source_database_path,
        project_id,
        query_scene_id,
        seed_entity_id,
        begin_rust_window,
        finish_rust_window,
        || Ok(()),
    )
}

/// Like [`run_c_query_memory_diagnostic`], with a synchronous diagnostic-only
/// continuation hook after successful registration and before query-window
/// baselines are reset. Hook errors skip the query and still run explicit
/// reader, participant, and temporary-database cleanup.
pub fn run_c_query_memory_diagnostic_with_ready_hook(
    source_database_path: &Path,
    project_id: &str,
    query_scene_id: &str,
    seed_entity_id: &str,
    begin_rust_window: impl FnOnce() -> u64,
    finish_rust_window: impl FnOnce() -> (u64, u64),
    ready_continue: impl FnOnce() -> Result<()>,
) -> Result<CQueryMemoryObservation> {
    validate_request(project_id, query_scene_id, seed_entity_id)?;
    ensure!(
        source_database_path.as_os_str().to_string_lossy().len() <= MAX_CLI_PATH_BYTES,
        "diagnostic database path exceeds {MAX_CLI_PATH_BYTES} bytes"
    );
    let source_metadata =
        fs::symlink_metadata(source_database_path).context("inspect fixture database file")?;
    ensure!(
        source_metadata.file_type().is_file(),
        "fixture database must be a regular file, not a symlink"
    );

    let temp_dir = TemporaryDirectory::create()?;
    let database_path = temp_dir.path.join("grimodex.db");
    let preparation_started = Instant::now();
    let source_state = copy_preseed_database(source_database_path, &database_path)?;
    let copied_ms = elapsed_ms(preparation_started);

    let mut result = run_on_copy(
        &database_path,
        &temp_dir.path,
        project_id,
        query_scene_id,
        seed_entity_id,
        || Ok(begin_rust_window()),
        || Ok(finish_rust_window()),
        ready_continue,
        false,
    );

    let cleanup_started = Instant::now();
    let source_unchanged = snapshot_database(source_database_path)
        .map(|state| state == source_state)
        .unwrap_or(false);
    let remove_result = temp_dir.remove();
    match result.as_mut() {
        Ok(observation) => {
            observation.preparation.elapsed_ms += copied_ms;
            observation.cleanup.elapsed_ms += elapsed_ms(cleanup_started);
            observation.cleanup.disposable_database_removed = remove_result.is_ok();
            observation.source_snapshot_verified_unchanged = source_unchanged;
        }
        Err(_) => {}
    }
    ensure!(
        source_unchanged,
        "source fixture database changed during the diagnostic"
    );
    remove_result.context("remove disposable Graph query database")?;
    result
}

/// Manager-owned diagnostic variant: all copies remain in the verified runtime
/// leaf until systemd retires it. No legacy temporary directory is constructed.
/// The binary validates this root before calling; this is not a product API.
pub fn run_managed_c_query_memory_diagnostic(
    source_database_path: &Path,
    runtime_root: &Path,
    project_id: &str,
    query_scene_id: &str,
    seed_entity_id: &str,
    begin_window: impl FnOnce() -> Result<u64>,
    finish_window: impl FnOnce() -> Result<(u64, u64)>,
    ready_continue: impl FnOnce() -> Result<()>,
) -> Result<CQueryMemoryObservation> {
    validate_request(project_id, query_scene_id, seed_entity_id)?;
    ensure!(
        source_database_path.parent() == Some(runtime_root),
        "managed source outside runtime root"
    );
    // Nir1GraphReader::open uses authority.path()/grimodex.db. The disposable
    // writer and canonical reader must open the same manager-owned copy.
    let database_path = runtime_root.join("grimodex.db");
    for suffix in ["", "-wal", "-shm", "-journal"] {
        ensure!(
            matches!(fs::symlink_metadata(sidecar_path(&database_path, suffix)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound),
            "managed query destination already exists"
        );
    }
    let preparation_started = Instant::now();
    let source_state = copy_preseed_database(source_database_path, &database_path)?;
    let copied_ms = elapsed_ms(preparation_started);
    let mut result = run_on_copy(
        &database_path,
        runtime_root,
        project_id,
        query_scene_id,
        seed_entity_id,
        begin_window,
        finish_window,
        ready_continue,
        true,
    );
    ensure!(
        snapshot_database(source_database_path)? == source_state,
        "managed source changed during diagnostic"
    );
    if let Ok(observation) = result.as_mut() {
        observation.preparation.elapsed_ms += copied_ms;
        observation.source_snapshot_verified_unchanged = true;
        observation.cleanup.process_exit_contract = "reader closed and participant released; files retained for manager retirement; parent must verify exit and directory removal";
    }
    result
}

fn run_on_copy(
    database_path: &Path,
    workspace_path: &Path,
    project_id: &str,
    query_scene_id: &str,
    seed_entity_id: &str,
    begin_rust_window: impl FnOnce() -> Result<u64>,
    finish_rust_window: impl FnOnce() -> Result<(u64, u64)>,
    ready_continue: impl FnOnce() -> Result<()>,
    construct_request_after_epoch: bool,
) -> Result<CQueryMemoryObservation> {
    let preparation_started = Instant::now();
    let database = Database::new(database_path).context("open disposable fixture database")?;
    let authority =
        WorkspaceAuthority::from_database_for_test(database, workspace_path.to_path_buf())?;
    ensure!(
        sqlite_memory_status(false)?.0 > 0,
        "SQLite MEMSTATUS is disabled or unavailable"
    );
    let runtime = authority.nir_chronicle_index_runtime();
    let seed_exists: bool = authority.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM codex_entries WHERE project_id=?1 AND id=?2)",
            params![project_id, seed_entity_id],
            |row| row.get(0),
        )?)
    })?;
    ensure!(
        seed_exists,
        "seed entity id does not exist in the selected project"
    );
    let scene_exists: bool = authority.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM tree_nodes WHERE project_id=?1 AND id=?2 AND node_type='scene')",
            params![project_id, query_scene_id],
            |row| row.get(0),
        )?)
    })?;
    ensure!(
        scene_exists,
        "query scene id does not exist in the selected project"
    );

    let snapshot = with_maintenance_control(&authority, |conn, control| {
        let transaction = conn.unchecked_transaction()?;
        match prepare_graph_index_build_with_control(&transaction, runtime, project_id, control) {
            Ok(snapshot) => {
                transaction.commit()?;
                Ok(snapshot)
            }
            Err(error) => match transaction.rollback() {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(error.context(format!(
                    "rollback disposable Graph preparation: {rollback_error}"
                ))),
            },
        }
    })?;
    let published = with_maintenance_control(&authority, |conn, control| {
        let transaction = conn.unchecked_transaction()?;
        match publish_nir1_entity_relation_index_in_tx_with_control(
            &transaction,
            runtime,
            snapshot,
            control,
        ) {
            Ok(binding) => {
                transaction.commit()?;
                Ok(binding)
            }
            Err(error) => match transaction.rollback() {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(error.context(format!(
                    "rollback disposable Graph publication: {rollback_error}"
                ))),
            },
        }
    })?;
    drop(published);

    let lifecycle = WorkspaceLifecycleCore::new();
    let participant = lifecycle.begin_workspace_participant()?;
    let mut reader = Nir1GraphReader::open(Arc::clone(&authority), participant)?;
    let mut request_before_epoch = (!construct_request_after_epoch).then(|| Nir1GraphRequest {
        project_id: project_id.to_owned(),
        query_scene_id: query_scene_id.to_owned(),
        seed_entity_id: seed_entity_id.to_owned(),
    });
    let mut begin_rust_window = Some(begin_rust_window);
    let preparation = StageObservation {
        status: "complete",
        elapsed_ms: elapsed_ms(preparation_started),
    };
    let mut sqlite_registered_connections = None;
    let operation = (|| -> Result<(RegistrationObservation, QueryObservation, RustAllocatorObservation, SqliteMemoryObservation)> {
        let registration_started = Instant::now();
        let registered = with_maintenance_control(&authority, |_, control| {
            reader.register_with_control(project_id, control)
        })?;
        ensure!(registered, "canonical Graph registration was incomplete");
        let registration_elapsed_ms = elapsed_ms(registration_started);
        if construct_request_after_epoch {
            // Read only, reset=0, before READY/epoch: no cache/config change and
            // no extra diagnostic work in the timed canonical query.
            sqlite_registered_connections = Some((
                authority.with_conn(sqlite_connection_memory_status)?,
                reader.sqlite_memory_for_diagnostic()?,
            ));
        }
        ready_continue()?;
        let registration = RegistrationObservation {
            status: "complete",
            registered: true,
            elapsed_ms: registration_elapsed_ms,
        };

        // The managed diagnostic arms shared admission immediately after the
        // registered handshake, before constructing/copying request strings.
        let rust_baseline_after_epoch = if construct_request_after_epoch {
            Some(
                begin_rust_window
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("allocator epoch callback missing"))?()?,
            )
        } else {
            None
        };
        let (sqlite_baseline_bytes, _) = sqlite_memory_status(true)?;
        ensure!(sqlite_baseline_bytes > 0, "SQLite MEMSTATUS is disabled or unavailable");
        let rust_baseline_bytes = match rust_baseline_after_epoch {
            Some(value) => value,
            None => begin_rust_window
                .take()
                .ok_or_else(|| anyhow::anyhow!("allocator epoch callback missing"))?()?,
        };
        let request = match request_before_epoch.take() {
            Some(request) => request,
            None => Nir1GraphRequest {
                project_id: project_id.to_owned(),
                query_scene_id: query_scene_id.to_owned(),
                seed_entity_id: seed_entity_id.to_owned(),
            },
        };
        let query_started = Instant::now();
        let (response, stage_observation) = reader.query_with_stage_observation(&request);
        let query_elapsed_ms = elapsed_ms(query_started);
        let (rust_current, rust_peak) = finish_rust_window()?;
        let (sqlite_current, sqlite_peak) = sqlite_memory_status(false)?;
        ensure!(sqlite_peak >= sqlite_baseline_bytes, "SQLite memory highwater reset did not hold");

        let (query_status, reason, available_nodes, available_edges) = match response {
            Ok(response) => {
                let graph_counts = response.graph.as_ref().map(|graph| (graph.nodes.len(), graph.edges.len()));
                (
                    response.status,
                    response.reason,
                    graph_counts.map(|counts| counts.0),
                    graph_counts.map(|counts| counts.1),
                )
            }
            Err(_) => ("error", Some("query-error".to_owned()), None, None),
        };
        let query = QueryObservation {
            status: query_status,
            reason,
            elapsed_ms: query_elapsed_ms,
            available_nodes,
            available_edges,
            stage_observation: stage_observation.into(),
        };
        let rust_allocator = RustAllocatorObservation {
            method: "isolated binary GlobalAlloc wrapper; requested live Rust bytes",
            baseline_requested_live_bytes: rust_baseline_bytes,
            query_window_peak_requested_live_bytes: rust_peak.max(rust_current),
            query_window_incremental_peak_bytes: rust_peak.max(rust_current).saturating_sub(rust_baseline_bytes),
            requested_live_bytes_after_query: rust_current,
            coverage: "successful Rust allocator requests and matching frees; excludes allocator metadata and non-Rust allocations",
        };
        let sqlite = SqliteMemoryObservation {
            memstatus_verified: true,
            method: "sqlite3_status64(SQLITE_STATUS_MEMORY_USED), highwater reset immediately before query",
            baseline_bytes: sqlite_baseline_bytes,
            query_window_highwater_bytes: sqlite_peak,
            query_window_incremental_highwater_bytes: sqlite_peak.saturating_sub(sqlite_baseline_bytes),
            current_bytes_after_query: sqlite_current,
            scope: "process-global SQLite allocations across the isolated diagnostic process's connections",
        };
        Ok((registration, query, rust_allocator, sqlite))
    })();

    let cleanup_started = Instant::now();
    let reader_close = reader.close();
    let participant_released = lifecycle.workspace_participant_count()? == 0;
    let reader_closed = reader.is_closed_for_diagnostic();
    drop(reader);
    drop(authority);
    let cleanup_elapsed_ms = elapsed_ms(cleanup_started);
    ensure!(
        reader_closed,
        "Graph reader connection remained open after close"
    );
    ensure!(
        participant_released,
        "Graph reader workspace participant was not released"
    );
    reader_close.context("close registered Graph reader")?;
    let (registration, query, rust_allocator, sqlite) = operation?;

    let available = query.status == "available"
        && query.available_nodes.is_some()
        && query.available_edges.is_some();
    Ok(CQueryMemoryObservation {
        status: if available { "observation-only" } else { "query-unavailable" },
        claims_hard_two_mib_bound: false,
        project_id: project_id.to_owned(),
        query_scene_id: query_scene_id.to_owned(),
        seed_entity_id: seed_entity_id.to_owned(),
        source_snapshot_verified_unchanged: false,
        preparation,
        registration,
        query,
        rust_allocator,
        sqlite,
        sqlite_registered_connections,
        cleanup: CleanupObservation {
            status: "complete",
            reader_closed,
            workspace_participant_released: participant_released,
            disposable_database_removed: false,
            elapsed_ms: cleanup_elapsed_ms,
            process_exit_contract: "exit 0 only after explicit reader close, participant release, connection drop, and disposable DB removal; kill/timeout is incomplete failure",
        },
        coverage: vec![
            "One real Nir1GraphReader::query call with a successfully completed existing registration.",
            "Query window starts after fixture copy, Graph index preparation/publication, and reader registration; response remains alive through both memory snapshots.",
            "SQLite MEMSTATUS was verified by a positive SQLITE_STATUS_MEMORY_USED current value before the measured query.",
            "The source main/WAL/SHM/rollback-journal snapshot is compared before and after; Graph writes target only the private copy.",
        ],
        unknowns: vec![
            "This single observation does not prove the hard 2 MiB contract or cover other fixtures, malformed/oversize input, repeated cancellation, or concurrent product requests.",
            "Rust allocator requested bytes exclude allocator bookkeeping, non-Rust allocation, and process RSS.",
            "SQLite MEMORY_USED is process-global and includes idle diagnostic SQLite connections; it does not identify one connection's allocation.",
            "Separate Rust and SQLite peaks are reported independently and are not a universal total-memory bound.",
            "Source hashes cannot prove the caller's closed/checkpointed precondition or exclude a transient concurrent writer that restores identical bytes.",
        ],
    })
}

fn with_maintenance_control<T>(
    database: &Database,
    operation: impl FnOnce(&Connection, &mut dyn GraphWorkControl) -> Result<T>,
) -> Result<T> {
    let controlled = with_narrative_maintenance_graph_control(
        database,
        Duration::ZERO,
        PROGRESS_CADENCE_VM_STEPS,
        Arc::new(AtomicBool::new(false)),
        NarrativeMaintenanceGraphControlConfig::default(),
        operation,
    )?;
    controlled
        .ok_or_else(|| anyhow::anyhow!("diagnostic maintenance connection was deferred"))?
        .into_result()
}

fn validate_request(project_id: &str, query_scene_id: &str, seed_entity_id: &str) -> Result<()> {
    ensure!(
        [project_id, query_scene_id, seed_entity_id]
            .iter()
            .all(|value| !value.is_empty() && value.trim() == *value),
        "Graph diagnostic IDs must be nonempty and have no leading/trailing whitespace"
    );
    ensure!(
        project_id
            .len()
            .saturating_add(query_scene_id.len())
            .saturating_add(seed_entity_id.len())
            <= MAX_GRAPH_INPUT_BYTES,
        "Graph diagnostic IDs exceed the existing query input budget"
    );
    Ok(())
}

pub(super) fn sqlite_connection_memory_status(conn: &Connection) -> Result<SqliteConnectionMemory> {
    let read = |operation| -> Result<u64> {
        let mut current = 0;
        let mut highwater = 0;
        // SAFETY: conn remains borrowed and open; these documented read-only
        // DBSTATUS operations use valid output pointers and never reset counters.
        let result = unsafe {
            rusqlite::ffi::sqlite3_db_status(
                conn.handle(),
                operation,
                &mut current,
                &mut highwater,
                0,
            )
        };
        ensure!(
            result == rusqlite::ffi::SQLITE_OK,
            "SQLite DBSTATUS read failed"
        );
        ensure!(current >= 0, "SQLite DBSTATUS returned a negative counter");
        Ok(u64::try_from(current)?)
    };
    Ok(SqliteConnectionMemory {
        cache_bytes_approx: read(rusqlite::ffi::SQLITE_DBSTATUS_CACHE_USED)?,
        schema_bytes_approx: read(rusqlite::ffi::SQLITE_DBSTATUS_SCHEMA_USED)?,
        statement_bytes_approx: read(rusqlite::ffi::SQLITE_DBSTATUS_STMT_USED)?,
    })
}

fn sqlite_memory_status(reset_highwater: bool) -> Result<(u64, u64)> {
    let mut current = 0i64;
    let mut highwater = 0i64;
    // SAFETY: SQLite documents sqlite3_status64 as a process-global counter
    // read; both output pointers are valid for the duration of this call.
    let result = unsafe {
        rusqlite::ffi::sqlite3_status64(
            SQLITE_STATUS_MEMORY_USED,
            &mut current,
            &mut highwater,
            if reset_highwater { 1 } else { 0 },
        )
    };
    ensure!(
        result == rusqlite::ffi::SQLITE_OK,
        "SQLite MEMORY_USED status query failed"
    );
    ensure!(
        current >= 0 && highwater >= 0,
        "SQLite MEMORY_USED returned a negative counter"
    );
    Ok((u64::try_from(current)?, u64::try_from(highwater)?))
}

fn copy_preseed_database(source: &Path, destination: &Path) -> Result<DatabaseSnapshot> {
    let source_state = snapshot_database(source)?;
    ensure!(
        source_state.main.present && source_state.main.bytes > 0,
        "fixture database file is empty"
    );
    ensure!(
        !source_state.journal.present,
        "fixture DB has a rollback journal; require a closed, checkpointed fixture"
    );
    for (source_component, suffix, component) in [
        (source.to_path_buf(), "", &source_state.main),
        (sidecar_path(source, "-wal"), "-wal", &source_state.wal),
        (sidecar_path(source, "-shm"), "-shm", &source_state.shm),
    ] {
        let destination_component = sidecar_path(destination, suffix);
        if component.present {
            fs::copy(&source_component, &destination_component)
                .with_context(|| format!("copy fixture database {suffix} component"))?;
            let mut permissions = fs::metadata(&source_component)?.permissions();
            permissions.set_readonly(false);
            fs::set_permissions(&destination_component, permissions)?;
        }
    }
    ensure!(
        snapshot_database(source)? == source_state,
        "fixture DB main/WAL/SHM changed while the private copy was created"
    );
    ensure!(
        snapshot_database(destination)? == source_state,
        "private fixture DB copy differs from the source main/WAL/SHM snapshot"
    );
    Ok(source_state)
}

fn snapshot_database(path: &Path) -> Result<DatabaseSnapshot> {
    Ok(DatabaseSnapshot {
        main: snapshot_file(path)?,
        wal: snapshot_file(&sidecar_path(path, "-wal"))?,
        shm: snapshot_file(&sidecar_path(path, "-shm"))?,
        journal: snapshot_file(&sidecar_path(path, "-journal"))?,
    })
}

fn snapshot_file(path: &Path) -> Result<FileSnapshot> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileSnapshot::absent())
        }
        Err(error) => {
            return Err(error).with_context(|| format!("inspect DB component {}", path.display()))
        }
    };
    ensure!(
        metadata.file_type().is_file(),
        "database component must be a regular file"
    );
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(FileSnapshot {
        present: true,
        bytes: metadata.len(),
        digest: hex::encode(hasher.finalize()),
    })
}

fn sidecar_path(database: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = database.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileSnapshot {
    present: bool,
    bytes: u64,
    digest: String,
}

impl FileSnapshot {
    fn absent() -> Self {
        Self {
            present: false,
            bytes: 0,
            digest: String::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DatabaseSnapshot {
    main: FileSnapshot,
    wal: FileSnapshot,
    shm: FileSnapshot,
    journal: FileSnapshot,
}

struct TemporaryDirectory {
    path: PathBuf,
    removed: bool,
}

impl TemporaryDirectory {
    fn create() -> Result<Self> {
        let path =
            std::env::temp_dir().join(format!("grimodex-nir1-c-query-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).context("create private disposable DB directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            path,
            removed: false,
        })
    }

    fn remove(mut self) -> Result<()> {
        fs::remove_dir_all(&self.path).context("remove private disposable DB directory")?;
        self.removed = true;
        Ok(())
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        if !self.removed {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_status_is_connection_local_and_does_not_reset_or_mutate() -> Result<()> {
        let populated = Connection::open_in_memory()?;
        let empty = Connection::open_in_memory()?;
        populated
            .execute_batch("CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES(7)")?;
        let before = sqlite_connection_memory_status(&populated)?;
        let other = sqlite_connection_memory_status(&empty)?;
        assert!(before.cache_bytes_approx > 0);
        assert!(before.schema_bytes_approx > other.schema_bytes_approx);
        assert_eq!(before.statement_bytes_approx, 0);
        let statement = populated.prepare("SELECT value FROM sample")?;
        let active = sqlite_connection_memory_status(&populated)?;
        assert!(active.statement_bytes_approx > 0);
        assert_eq!(active, sqlite_connection_memory_status(&populated)?);
        assert_eq!(other, sqlite_connection_memory_status(&empty)?);
        drop(statement);
        assert_eq!(
            sqlite_connection_memory_status(&populated)?.statement_bytes_approx,
            0
        );
        assert_eq!(
            populated.query_row("SELECT value FROM sample", [], |row| row.get::<_, i64>(0))?,
            7
        );
        Ok(())
    }

    #[test]
    fn rejects_invalid_cli_ids_before_database_work() {
        assert!(validate_request("project", "scene", "seed").is_ok());
        assert!(validate_request(" project", "scene", "seed").is_err());
        assert!(validate_request("project", "", "seed").is_err());
        let oversized = "x".repeat(MAX_GRAPH_INPUT_BYTES + 1);
        assert!(validate_request(&oversized, "scene", "seed").is_err());
    }

    #[test]
    fn query_stage_observation_preserves_missing_timings_and_failure_flags() -> Result<()> {
        let mut observed = ReaderStageObservation::default();
        observed.pre_snapshot_identity_seal_ns = Some(11);
        observed.a2_preflight_ns = Some(22);
        observed.a2_sql.length_ns = Some(3);
        observed.a2_sql.related_ns[1] = Some(5);
        observed.a2_sql.error_slot = Some(3);
        observed.a3_sql.timings_ns[9] = Some(8);
        observed.a3_sql.error_slot = Some(10);
        observed.work_result_error = true;
        observed.deadline_observed_at_collapse = true;

        let serialized = serde_json::to_value(QueryStageObservation::from(observed))?;
        assert_eq!(
            serialized,
            serde_json::json!({
                "preSnapshotIdentitySealNs": 11,
                "indexedCandidatePageNs": null,
                "a2PreflightNs": 22,
                "a2Sql": {
                    "lengthNs": 3,
                    "countNs": null,
                    "relatedNs": [null, 5, null, null, null, null, null, null, null, null],
                    "errorSlot": 3,
                    "overflowMask": 0,
                    "unattributed": false,
                },
                "a3PreflightNs": null,
                "a3Sql": {
                    "timingsNs": [null, null, null, null, null, null, null, null, null, 8,
                                  null, null, null, null, null, null, null, null, null, null,
                                  null, null, null],
                    "errorSlot": 10,
                    "overflowMask": 0,
                    "unattributed": false,
                },
                "a3EvaluationNs": null,
                "cleanupPostStampNs": null,
                "workResultError": true,
                "postStampError": false,
                "deadlineObservedAtCollapse": true,
                "unattributed": false,
            })
        );
        Ok(())
    }

    #[test]
    fn database_snapshot_copy_preserves_sidecars_without_mutating_source() -> Result<()> {
        let source_dir = TemporaryDirectory::create()?;
        let copy_dir = TemporaryDirectory::create()?;
        let source = source_dir.path.join("source.db");
        let destination = copy_dir.path.join("grimodex.db");
        use std::io::Write;

        File::create(&source)?.write_all(b"fixture")?;
        File::create(sidecar_path(&source, "-wal"))?.write_all(b"wal")?;
        let before = snapshot_database(&source)?;
        copy_preseed_database(&source, &destination)?;
        assert_eq!(snapshot_database(&source)?, before);
        assert_eq!(snapshot_database(&destination)?, before);
        Ok(())
    }
}
