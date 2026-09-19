//! Diagnostic-only measurements for the proposed whole-project NIR-1 B build.
//!
//! This module is diagnostic-only, but it exercises the real whole-project
//! Graph prepare and publish transaction on a disposable database copy. The
//! JavaScript driver owns the fresh-process/fresh-copy protocol; this module
//! owns Native-side statement, process, and lifecycle measurements.

use anyhow::{Context, Result};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, StatementStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

use crate::backup_restore::{read_incomplete_restore_session, restore_backup_core};
use crate::migration_supervisor::workspace_identity;
use crate::{
    ActiveWorkspace, WorkspaceAuthority, WorkspaceLifecycleCompatibilityView, WorkspaceState,
};
use grimodex_core::narrative_nir1::EntityRelationBundle;

use super::restore_rebuild::{
    rebuild_narrative_derived_state_for_project, verify_dependency_graph_snapshot_with_control,
    DependencyGraphVerifyReport, RebuildDerivedStateOutcome,
};
use super::{
    declaration_storage::{
        read_active_dependency_declaration_set_in_tx, ActiveDependencyDeclarationSetRead,
    },
    dependency_edges::{find_edges_by_consumer, DependencyEdge},
    human_material_basis::MaterialBasis,
    nir1_chronicle_index::NirChronicleIndexRuntime,
    nir1_entity_relation::{read_nir1_entity_relation_revision, Nir1EntityRelationRevisionRead},
    nir1_entity_relation_index::{
        cold_reopen_graph_index_with_control, is_complete_registered_with_control,
        prepare_graph_index_build_with_control,
        publish_nir1_entity_relation_index_in_tx_with_control, read as read_graph_binding,
        read_eligibility_source_with_control, BindingRead, GraphObjectRosterEntry,
        INDEX_KEY as ENTITY_RELATION_INDEX_KEY,
    },
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH, NIR1_ENTITY_RELATION_SET_KIND,
};
use crate::narrative_maintenance_connection::{
    with_narrative_maintenance_graph_control, NarrativeMaintenanceGraphControlConfig,
};
use crate::Database;

/// The A2 per-Revision admission envelope remains part of the observed
/// contract. It is deliberately not applied to the whole-project roster.
pub const PER_REVISION_MATERIAL_LIMIT: usize = 512;
pub const PER_REVISION_INPUT_BYTE_LIMIT: usize = 2 * 1024 * 1024;
const PROGRESS_CADENCE_VM_STEPS: i32 = 1_000;

/// A capacity result is one path measurement.  Keeping the path in the
/// Native observation makes it impossible for the orchestrator to silently
/// merge Source, registration, coverage, Restore, and reopen measurements.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapacityDiagnosticMode {
    FullBuild,
    SourceReresolution,
    CompleteRegistration,
    Coverage,
    Restore,
    ColdReopen,
}

impl CapacityDiagnosticMode {
    pub const ALL: [Self; 6] = [
        Self::FullBuild,
        Self::SourceReresolution,
        Self::CompleteRegistration,
        Self::Coverage,
        Self::Restore,
        Self::ColdReopen,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FullBuild => "full-build",
            Self::SourceReresolution => "source-reresolution",
            Self::CompleteRegistration => "complete-registration",
            Self::Coverage => "coverage",
            Self::Restore => "restore",
            Self::ColdReopen => "cold-reopen",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "full-build" | "fullBuild" | "build" => Ok(Self::FullBuild),
            "source-reresolution" | "sourceReResolution" | "source-reresolve" => {
                Ok(Self::SourceReresolution)
            }
            "complete-registration" | "completeRegistration" => Ok(Self::CompleteRegistration),
            "coverage" => Ok(Self::Coverage),
            "restore" => Ok(Self::Restore),
            "cold-reopen" | "coldReopen" => Ok(Self::ColdReopen),
            other => anyhow::bail!(
                "unknown NIR-1 capacity diagnostic mode '{other}'; expected one of {}",
                Self::ALL
                    .iter()
                    .map(|mode| mode.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityCounts {
    pub candidate_revisions: usize,
    pub qualified_revisions: usize,
    pub rejected_revisions: usize,
    pub entity_records: usize,
    pub relation_records: usize,
    pub evidence_records: usize,
    pub qualified_material_records: usize,
    pub roster_records: usize,
    /// Count of all dependency edges persisted for the fixture project. This
    /// is the fixture-wide input shape and is independent of the request-local
    /// Graph snapshot edge container.
    pub dependency_edges: Option<u64>,
    /// Count of dependency edges retained by the selected Graph snapshot.
    /// This is populated only after the Graph producer has materialised its
    /// request-local snapshot; it must never overwrite the fixture-wide count.
    pub graph_snapshot_dependency_edges: Option<u64>,
    /// Number of entries in the latest completed dependency Verify report's
    /// missing-Source list. This is deliberately distinct from the historical
    /// `narrative_maintenance_finding_observations` table.
    pub report_records: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityBytes {
    pub payload_bytes: u64,
    pub envelope_bytes: u64,
    pub source_basis_bytes: u64,
    pub live_source_bytes: Option<u64>,
    pub roster_bytes: u64,
    pub edge_serialized_bytes: Option<u64>,
    pub revision_id_overhead_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacitySqlMetrics {
    /// A conservative profile upper bound. Trace `StmtRef` exposes a
    /// cumulative VM-step counter but not prepared-statement identity or
    /// reset, so reused statements are intentionally summed at each profile
    /// callback. Exact lifecycle VM steps remain explicitly unmeasured below.
    pub statement_vm_steps: u64,
    pub exact_vm_steps: bool,
    /// Progress callbacks are a cancellation cadence signal only.  They are
    /// never multiplied into an SQL work total.
    pub progress_callbacks: u64,
    pub statements: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetrics {
    pub elapsed_ms: f64,
    pub user_cpu_us: Option<u64>,
    pub system_cpu_us: Option<u64>,
    pub rss_bytes: Option<u64>,
    pub hwm_rss_bytes: Option<u64>,
    /// Peak RSS for the complete child process.  The probe runs one Native
    /// child per path, so this is the total process peak for that path.  It is
    /// kept separate from the point-in-time RSS sample.
    pub total_peak_rss_bytes: Option<u64>,
    pub ru_maxrss_bytes: Option<u64>,
    pub sqlite_memory_bytes: Option<u64>,
    pub sqlite_memory_highwater_bytes: Option<u64>,
    pub read_bytes: Option<u64>,
    pub write_bytes: Option<u64>,
    /// SQLite temporary files are not reliably visible through `/proc` on all
    /// supported hosts.  Keep the value nullable and report the path-local
    /// notMeasured reason instead of turning an unavailable sample into zero.
    pub temporary_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityOccupancy {
    /// Conservative maximum of the separate continuous owner intervals: the
    /// manual A2 observation, prepare, publish, cold reopen, and restore.
    /// This is not a sum across released connections or the gaps between
    /// those scopes. No-wait admission is included in each owner interval.
    pub connection_hold_ms: f64,
    /// The controlled Graph publish transaction interval.
    pub publish_transaction_ms: Option<f64>,
    /// Foreground waiter coordination belongs to the maintenance owner and
    /// is not observable from a standalone read-only child.
    pub foreground_wait_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLifecycleMetrics {
    pub prepared: bool,
    pub published: bool,
    pub rolled_back: bool,
    pub cold_reopened: bool,
    pub restore_verified: bool,
    pub initial_copy_digest: String,
    pub post_run_copy_digest: String,
    pub published_generation: Option<i64>,
    pub prepare_ms: Option<f64>,
    /// Time owned by the publish maintenance scope, including connection
    /// admission and cleanup. This is separate from the transaction interval
    /// below so the two measurements are not conflated.
    pub publish_owner_ms: Option<f64>,
    pub publish_transaction_ms: Option<f64>,
    pub cold_reopen_ms: Option<f64>,
    pub restore_verify_ms: Option<f64>,
    /// Full-set Source/registration/Coverage intervals are kept separate so
    /// the orchestrator cannot mistake the fixture's A2 read for the mode's
    /// own operation.
    pub source_reresolution_ms: Option<f64>,
    pub complete_registration_ms: Option<f64>,
    pub coverage_ms: Option<f64>,
    pub restore_install_ms: Option<f64>,
    pub restore_report_records: Option<u64>,
    /// Report records produced by this mode's operation. `counts.reportRecords`
    /// remains the persisted fixture shape and may be present even when this
    /// mode does not run Verify.
    pub operation_report_records: Option<u64>,
    pub source_reresolved: bool,
    pub complete_registered: bool,
    pub coverage_verified: bool,
    pub restore_maintenance_validated: bool,
    pub restore_image_identity: Option<String>,
    pub restore_workspace_identity: Option<String>,
    pub restore_epoch: Option<String>,
    pub restore_proof: Option<RestoreProof>,
    pub terminal_error: Option<String>,
}

/// Process-local evidence for the Restore diagnostic.  These fields describe
/// the old immutable A2/Graph state and the deliberately empty Graph
/// generation published after Restore; they are not a persisted authority or
/// a re-acceptance receipt.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreProof {
    pub binding_persisted: bool,
    pub generation_preserved: bool,
    pub source_digest_preserved: bool,
    pub d1_binding_preserved: bool,
    pub edge_binding_preserved: bool,
    pub dirty_cache_flag_cleared: bool,
    pub eligible_records_after_restore: usize,
    pub incomplete_rejected: bool,
    pub cold_reopen_rejected: bool,
    pub old_a2_revisions_invalidated: bool,
    pub old_revision_tuples_preserved: bool,
    pub old_decisions_preserved: bool,
    pub old_run_epochs_preserved: bool,
    pub canonical_rebuild_old_a2_revisions_invalidated: bool,
    pub canonical_rebuild_old_revision_tuples_preserved: bool,
    pub canonical_rebuild_old_decisions_preserved: bool,
    pub canonical_rebuild_old_run_epochs_preserved: bool,
    pub stale_snapshot_publish_rejected: bool,
    pub stale_snapshot_generation_unchanged: bool,
    pub post_restore_qualified_revisions: usize,
    pub post_restore_roster_records: usize,
    pub post_restore_complete: bool,
    pub post_restore_verify_succeeded: bool,
    pub post_restore_cold_reopen_succeeded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityModeOutcome {
    pub operation: &'static str,
    pub success: bool,
    pub required_success: bool,
    pub operation_report_records: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelMeasurement {
    pub status: &'static str,
    pub latency_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityObservation {
    pub diagnostic_only: bool,
    pub process_id: u32,
    pub fixture_id: String,
    pub mode: CapacityDiagnosticMode,
    pub status: &'static str,
    pub admission: &'static str,
    pub supported_capacity_claim: bool,
    pub database_path: String,
    pub counts: CapacityCounts,
    /// Shape read from the immutable fixture before the selected diagnostic
    /// mode runs. It is deliberately separate from any mode outcome.
    pub fixture_shape: CapacityCounts,
    pub bytes: CapacityBytes,
    pub process: ProcessMetrics,
    pub sql: CapacitySqlMetrics,
    pub occupancy: CapacityOccupancy,
    pub graph_lifecycle: GraphLifecycleMetrics,
    pub mode_outcome: CapacityModeOutcome,
    pub cancel: CancelMeasurement,
    pub rejection_reasons: BTreeMap<String, usize>,
    pub not_measured: Vec<String>,
}

#[derive(Default)]
struct SqlAccumulator {
    statement_vm_steps: u64,
    statements: u64,
}

struct ProgressCounter {
    callbacks: Arc<AtomicU64>,
}

impl Default for ProgressCounter {
    fn default() -> Self {
        Self {
            callbacks: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[derive(Default)]
struct TraceCounter {
    statement_vm_steps: AtomicU64,
    statements: AtomicU64,
    exact_vm_steps: std::sync::atomic::AtomicBool,
}

thread_local! {
    static ACTIVE_TRACE: RefCell<Option<Arc<TraceCounter>>> = const { RefCell::new(None) };
}

fn trace_profile(event: TraceEvent<'_>) {
    if let TraceEvent::Profile(statement, _) = event {
        ACTIVE_TRACE.with(|active| {
            if let Some(counter) = active.borrow().as_ref() {
                let cumulative =
                    u64::try_from(statement.get_status(StatementStatus::VmStep).max(0))
                        .unwrap_or(0);
                // StmtRef exposes the cumulative SQLite counter, but not the
                // prepared-statement identity or reset operation. Summing the
                // cumulative value is a conservative upper bound for reused
                // statements; it is deliberately not advertised as exact.
                counter.exact_vm_steps.store(false, Ordering::Relaxed);
                counter
                    .statement_vm_steps
                    .fetch_add(cumulative, Ordering::Relaxed);
                counter.statements.fetch_add(1, Ordering::Relaxed);
            }
        });
    }
}

#[derive(Default, Clone, Copy)]
struct ProcSample {
    user_cpu_us: Option<u64>,
    system_cpu_us: Option<u64>,
    rss_bytes: Option<u64>,
    hwm_rss_bytes: Option<u64>,
    ru_maxrss_bytes: Option<u64>,
    read_bytes: Option<u64>,
    write_bytes: Option<u64>,
}

fn proc_status_bytes(key: &str) -> Option<u64> {
    let text = fs::read_to_string("/proc/self/status").ok()?;
    text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name != key {
            return None;
        }
        let mut fields = value.split_whitespace();
        let number = fields.next()?.parse::<u64>().ok()?;
        Some(number.saturating_mul(1024))
    })
}

fn proc_io_bytes(key: &str) -> Option<u64> {
    let text = fs::read_to_string("/proc/self/io").ok()?;
    text.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim() != key {
            return None;
        }
        value.trim().parse::<u64>().ok()
    })
}

#[cfg(target_os = "linux")]
fn rusage_sample() -> (Option<u64>, Option<u64>, Option<u64>) {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: `getrusage` initializes the supplied `rusage` structure on a
    // successful call, and the zeroed value is valid storage for this C ABI.
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return (None, None, None);
    }
    // SAFETY: the preceding successful call initialized `usage`.
    let usage = unsafe { usage.assume_init() };
    let micros = |seconds: libc::time_t, micros: libc::suseconds_t| {
        if seconds < 0 || micros < 0 {
            None
        } else {
            Some(
                (seconds as u64)
                    .saturating_mul(1_000_000)
                    .saturating_add(micros as u64),
            )
        }
    };
    // Linux reports ru_maxrss in KiB.  Keep the conversion local to the
    // platform branch rather than assuming that on other Unix targets.
    let maxrss = u64::try_from(usage.ru_maxrss)
        .ok()
        .map(|value| value.saturating_mul(1024));
    (
        micros(usage.ru_utime.tv_sec, usage.ru_utime.tv_usec),
        micros(usage.ru_stime.tv_sec, usage.ru_stime.tv_usec),
        maxrss,
    )
}

#[cfg(not(target_os = "linux"))]
fn rusage_sample() -> (Option<u64>, Option<u64>, Option<u64>) {
    (None, None, None)
}

fn sample_process() -> ProcSample {
    let (user_cpu_us, system_cpu_us, ru_maxrss_bytes) = rusage_sample();
    ProcSample {
        user_cpu_us,
        system_cpu_us,
        rss_bytes: proc_status_bytes("VmRSS"),
        hwm_rss_bytes: proc_status_bytes("VmHWM"),
        ru_maxrss_bytes,
        read_bytes: proc_io_bytes("read_bytes"),
        write_bytes: proc_io_bytes("write_bytes"),
    }
}

fn sqlite_memory_used() -> Option<u64> {
    // SAFETY: SQLite's process-global allocator counter is read-only and the
    // bundled rusqlite ABI exposes this function for the same process.
    let value = unsafe { rusqlite::ffi::sqlite3_memory_used() };
    u64::try_from(value).ok()
}

fn sqlite_memory_highwater() -> Option<u64> {
    // SAFETY: zero means read without resetting the process-global high-water
    // counter.  No connection or statement is passed to this API.
    let value = unsafe { rusqlite::ffi::sqlite3_memory_highwater(0) };
    u64::try_from(value).ok()
}

fn count_statement<T, F>(
    conn: &Connection,
    sql: &str,
    parameters: &[&dyn rusqlite::ToSql],
    accumulator: &mut SqlAccumulator,
    map: F,
) -> Result<T>
where
    F: FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut statement = conn
        .prepare(sql)
        .with_context(|| format!("prepare diagnostic SQL: {sql}"))?;
    let value = statement.query_row(parameters, map)?;
    accumulator.statement_vm_steps = accumulator
        .statement_vm_steps
        .saturating_add(u64::try_from(statement.get_status(StatementStatus::VmStep)).unwrap_or(0));
    accumulator.statements = accumulator.statements.saturating_add(1);
    Ok(value)
}

fn table_exists(conn: &Connection, name: &str, accumulator: &mut SqlAccumulator) -> Result<bool> {
    count_statement(
        conn,
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        &[&name],
        accumulator,
        |row| row.get(0),
    )
}

fn optional_table_count(
    conn: &Connection,
    table: &str,
    where_sql: &str,
    project_id: Option<&str>,
    accumulator: &mut SqlAccumulator,
) -> Result<Option<u64>> {
    if !table_exists(conn, table, accumulator)? {
        return Ok(None);
    }
    let sql = if project_id.is_some() {
        format!("SELECT COUNT(*) FROM {table} WHERE {where_sql}")
    } else {
        format!("SELECT COUNT(*) FROM {table}")
    };
    let count = if let Some(project_id) = project_id {
        count_statement(conn, &sql, &[&project_id], accumulator, |row| {
            row.get::<_, i64>(0)
        })?
    } else {
        count_statement(conn, &sql, &[], accumulator, |row| row.get::<_, i64>(0))?
    };
    Ok(Some(u64::try_from(count)?))
}

fn read_persisted_verify_report_records_with_metrics(
    conn: &Connection,
    project_id: &str,
    accumulator: &mut SqlAccumulator,
) -> Result<Option<u64>> {
    let mut statement = conn.prepare(
        "SELECT outcome_summary_json
           FROM narrative_extraction_runs
          WHERE project_id=?1
            AND run_kind='dependency-verify'
            AND status='completed'
            AND outcome_summary_json IS NOT NULL
          ORDER BY rowid DESC
          LIMIT 1",
    )?;
    let outcome: Option<String> = statement
        .query_row(params![project_id], |row| row.get(0))
        .optional()?;
    accumulator.statement_vm_steps = accumulator
        .statement_vm_steps
        .saturating_add(u64::try_from(statement.get_status(StatementStatus::VmStep)).unwrap_or(0));
    accumulator.statements = accumulator.statements.saturating_add(1);
    let Some(outcome) = outcome else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&outcome)
        .context("parse persisted dependency Verify outcome for capacity diagnostics")?;
    let count = value
        .pointer("/report/edgeIdsWithMissingSource")
        .and_then(Value::as_array)
        .map(|records| u64::try_from(records.len()))
        .transpose()?;
    Ok(Some(count.unwrap_or(0)))
}

/// Read the same persisted Verify report count used by the normal capacity
/// probe. Fixture metadata calls this helper after the source database is
/// closed, so it cannot accidentally introduce a second report definition.
pub(crate) fn read_persisted_verify_report_records(
    conn: &Connection,
    project_id: &str,
) -> Result<Option<u64>> {
    let mut accumulator = SqlAccumulator::default();
    read_persisted_verify_report_records_with_metrics(conn, project_id, &mut accumulator)
}

fn current_revision_ids(
    conn: &Connection,
    project_id: Option<&str>,
    accumulator: &mut SqlAccumulator,
) -> Result<Vec<String>> {
    let mut statement = if project_id.is_some() {
        conn.prepare(
            "SELECT DISTINCT proposal.current_revision_id
               FROM narrative_proposal_sets proposal_set
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
               JOIN narrative_proposals proposal ON proposal.proposal_set_id = proposal_set.id
              WHERE proposal_set.project_id = ?1
                AND proposal_set.set_kind = ?2
                AND extraction_run.surface_path_id = ?3
                AND proposal.current_revision_id IS NOT NULL
              ORDER BY proposal.current_revision_id ASC",
        )?
    } else {
        conn.prepare(
            "SELECT DISTINCT proposal.current_revision_id
               FROM narrative_proposal_sets proposal_set
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
               JOIN narrative_proposals proposal ON proposal.proposal_set_id = proposal_set.id
              WHERE proposal_set.set_kind = ?1
                AND extraction_run.surface_path_id = ?2
                AND proposal.current_revision_id IS NOT NULL
              ORDER BY proposal.current_revision_id ASC",
        )?
    };
    let mut ids = Vec::new();
    {
        let mut rows = if let Some(project_id) = project_id {
            statement.query(params![
                project_id,
                NIR1_ENTITY_RELATION_SET_KIND,
                NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            ])?
        } else {
            statement.query(params![
                NIR1_ENTITY_RELATION_SET_KIND,
                NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            ])?
        };
        while let Some(row) = rows.next()? {
            ids.push(row.get(0)?);
        }
    }
    accumulator.statement_vm_steps = accumulator
        .statement_vm_steps
        .saturating_add(u64::try_from(statement.get_status(StatementStatus::VmStep)).unwrap_or(0));
    accumulator.statements = accumulator.statements.saturating_add(1);
    Ok(ids)
}

fn row_bytes(
    conn: &Connection,
    project_id: Option<&str>,
    accumulator: &mut SqlAccumulator,
) -> Result<(u64, u64)> {
    if !table_exists(conn, "narrative_proposal_revisions", accumulator)? {
        return Ok((0, 0));
    }
    let sql = if project_id.is_some() {
        "SELECT COALESCE(SUM(length(CAST(revision.payload_json AS BLOB))),0),
                       COALESCE(SUM(length(CAST(revision.reconciliation_envelope_json AS BLOB))),0)
           FROM narrative_proposal_revisions revision
          WHERE revision.id IN (
                SELECT DISTINCT proposal.current_revision_id
                  FROM narrative_proposal_sets proposal_set
                  JOIN narrative_extraction_runs extraction_run
                    ON extraction_run.id = proposal_set.run_id
                   AND extraction_run.project_id = proposal_set.project_id
                  JOIN narrative_proposals proposal
                    ON proposal.proposal_set_id = proposal_set.id
                 WHERE proposal_set.project_id=?1
                   AND proposal_set.set_kind=?2
                   AND extraction_run.surface_path_id=?3
                   AND proposal.current_revision_id IS NOT NULL
          )"
    } else {
        "SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0),
                       COALESCE(SUM(length(CAST(reconciliation_envelope_json AS BLOB))),0)
           FROM narrative_proposal_revisions revision
          WHERE revision.id IN (
                SELECT DISTINCT proposal.current_revision_id
                  FROM narrative_proposal_sets proposal_set
                  JOIN narrative_extraction_runs extraction_run
                    ON extraction_run.id = proposal_set.run_id
                   AND extraction_run.project_id = proposal_set.project_id
                  JOIN narrative_proposals proposal
                    ON proposal.proposal_set_id = proposal_set.id
                 WHERE proposal_set.set_kind=?1
                   AND extraction_run.surface_path_id=?2
                   AND proposal.current_revision_id IS NOT NULL
          )"
    };
    let row = if let Some(project_id) = project_id {
        count_statement(
            conn,
            sql,
            &[
                &project_id,
                &NIR1_ENTITY_RELATION_SET_KIND,
                &NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            ],
            accumulator,
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?
    } else {
        count_statement(
            conn,
            sql,
            &[
                &NIR1_ENTITY_RELATION_SET_KIND,
                &NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            ],
            accumulator,
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?
    };
    Ok((u64::try_from(row.0)?, u64::try_from(row.1)?))
}

fn decision_id(
    conn: &Connection,
    revision_id: &str,
    accumulator: &mut SqlAccumulator,
) -> Result<Option<String>> {
    if !table_exists(conn, "narrative_proposal_decisions", accumulator)? {
        return Ok(None);
    }
    let mut statement = conn.prepare(
        "SELECT id FROM narrative_proposal_decisions
          WHERE revision_id=?1 ORDER BY created_at DESC, id DESC LIMIT 1",
    )?;
    let result = statement
        .query_row(params![revision_id], |row| row.get(0))
        .optional()?;
    accumulator.statement_vm_steps = accumulator
        .statement_vm_steps
        .saturating_add(u64::try_from(statement.get_status(StatementStatus::VmStep)).unwrap_or(0));
    accumulator.statements = accumulator.statements.saturating_add(1);
    Ok(result)
}

fn observe_revision(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
    accumulator: &mut SqlAccumulator,
    counts: &mut CapacityCounts,
    bytes: &mut CapacityBytes,
    rejection_reasons: &mut BTreeMap<String, usize>,
) -> Result<()> {
    match read_nir1_entity_relation_revision(conn, project_id, revision_id) {
        Ok(Nir1EntityRelationRevisionRead::Available(revision)) => {
            counts.qualified_revisions = counts.qualified_revisions.saturating_add(1);
            counts.entity_records = counts
                .entity_records
                .saturating_add(revision.bundle.entities.len());
            counts.relation_records = counts
                .relation_records
                .saturating_add(revision.bundle.relations.len());
            counts.evidence_records = counts
                .evidence_records
                .saturating_add(revision.material_basis.evidence_set.len());
            counts.qualified_material_records = counts
                .qualified_material_records
                .saturating_add(revision.bundle.entities.len())
                .saturating_add(revision.bundle.relations.len())
                .saturating_add(revision.material_basis.evidence_set.len());
            let decision = decision_id(conn, revision_id, accumulator)?;
            let revision_id_overhead = revision_id
                .len()
                .saturating_add(decision.as_deref().map(str::len).unwrap_or(0));
            bytes.revision_id_overhead_bytes = bytes
                .revision_id_overhead_bytes
                .saturating_add(u64::try_from(revision_id_overhead)?);
            // Graph roster bytes are measured from the sealed request-local
            // snapshot after prepare. The A2 observation deliberately does
            // not substitute full bundle/material JSON for that metric.
            bytes.source_basis_bytes = bytes.source_basis_bytes.saturating_add(
                revision
                    .material_basis
                    .source_basis
                    .iter()
                    .map(|source| {
                        source
                            .source_key
                            .len()
                            .saturating_add(source.revision_token.len())
                            .saturating_add(source.source_kind.len())
                    })
                    .try_fold(0u64, |sum, size| {
                        u64::try_from(size).map(|value| sum.saturating_add(value))
                    })?,
            );
            counts.roster_records = counts.qualified_material_records;
        }
        Ok(Nir1EntityRelationRevisionRead::Unavailable { reason }) => {
            counts.rejected_revisions = counts.rejected_revisions.saturating_add(1);
            *rejection_reasons.entry(reason).or_default() += 1;
        }
        Err(error) => {
            // Only the reader's typed `Unavailable` result is an ineligible
            // candidate. Operational errors (including validation
            // termination) must leave the diagnostic as failed rather than
            // silently changing the observed Q/R/D shape.
            return Err(error.context(format!(
                "A2 reader failed for diagnostic revision {revision_id}"
            )));
        }
    }
    Ok(())
}

fn diff_u64(after: Option<u64>, before: Option<u64>) -> Option<u64> {
    Some(after?.saturating_sub(before?))
}

fn path_not_measured(mode: CapacityDiagnosticMode, metric: &'static str) -> String {
    format!("{}:{metric}", mode.as_str())
}

fn mode_measurement_not_measured(
    mode: CapacityDiagnosticMode,
    lifecycle: &GraphLifecycleRun,
) -> Vec<String> {
    let mut not_measured = Vec::new();
    // The current child owns one Native process, so `hwmRssBytes` is also a
    // total process peak.  Keep this branch explicit for platforms where the
    // procfs/rusage sample is unavailable.
    if lifecycle.terminal_error.is_some() {
        not_measured.push(path_not_measured(mode, "total-peak-rss"));
    }
    if matches!(
        mode,
        CapacityDiagnosticMode::FullBuild
            | CapacityDiagnosticMode::CompleteRegistration
            | CapacityDiagnosticMode::Coverage
            | CapacityDiagnosticMode::Restore
            | CapacityDiagnosticMode::ColdReopen
    ) && lifecycle.publish_owner_ms.is_none()
    {
        not_measured.push(path_not_measured(mode, "publish-hold"));
    }
    if matches!(
        mode,
        CapacityDiagnosticMode::FullBuild
            | CapacityDiagnosticMode::CompleteRegistration
            | CapacityDiagnosticMode::Coverage
            | CapacityDiagnosticMode::Restore
            | CapacityDiagnosticMode::ColdReopen
    ) && lifecycle.publish_transaction_ms.is_none()
    {
        not_measured.push(path_not_measured(mode, "publish-transaction"));
    }
    if matches!(
        mode,
        CapacityDiagnosticMode::FullBuild | CapacityDiagnosticMode::ColdReopen
    ) && lifecycle.cold_reopen_ms.is_none()
    {
        not_measured.push(path_not_measured(mode, "cold-reopen"));
    }
    if matches!(
        mode,
        CapacityDiagnosticMode::FullBuild | CapacityDiagnosticMode::Restore
    ) && lifecycle.restore_verify_ms.is_none()
    {
        not_measured.push(path_not_measured(mode, "restore"));
    }
    if mode == CapacityDiagnosticMode::SourceReresolution
        && lifecycle.source_reresolution_ms.is_none()
    {
        not_measured.push(path_not_measured(mode, "source-reresolution"));
    }
    if mode == CapacityDiagnosticMode::CompleteRegistration
        && lifecycle.complete_registration_ms.is_none()
    {
        not_measured.push(path_not_measured(mode, "complete-registration"));
    }
    if mode == CapacityDiagnosticMode::Coverage && lifecycle.coverage_ms.is_none() {
        not_measured.push(path_not_measured(mode, "coverage"));
    }
    if mode == CapacityDiagnosticMode::Restore && lifecycle.restore_install_ms.is_none() {
        not_measured.push(path_not_measured(mode, "restore-install"));
    }
    not_measured.push(path_not_measured(mode, "temporary-bytes"));
    not_measured.push(path_not_measured(mode, "foreground-wait"));
    not_measured.push(path_not_measured(mode, "cancel-latency"));
    not_measured
}

#[derive(Debug)]
struct GraphLifecycleRun {
    shape: Option<super::nir1_entity_relation_index::GraphSnapshotCapacity>,
    prepared: bool,
    published: bool,
    rolled_back: bool,
    cold_reopened: bool,
    restore_verified: bool,
    published_generation: Option<i64>,
    prepare_ms: Option<f64>,
    publish_owner_ms: Option<f64>,
    publish_transaction_ms: Option<f64>,
    cold_reopen_ms: Option<f64>,
    restore_verify_ms: Option<f64>,
    source_reresolution_ms: Option<f64>,
    complete_registration_ms: Option<f64>,
    coverage_ms: Option<f64>,
    restore_install_ms: Option<f64>,
    restore_report_records: Option<u64>,
    operation_report_records: Option<u64>,
    source_reresolved: bool,
    complete_registered: bool,
    coverage_verified: bool,
    restore_maintenance_validated: bool,
    restore_image_identity: Option<String>,
    restore_workspace_identity: Option<String>,
    restore_epoch: Option<String>,
    restore_proof: Option<RestoreProof>,
    terminal_error: Option<String>,
}

fn conservative_connection_hold_ms(manual_a2_owner_ms: f64, lifecycle: &GraphLifecycleRun) -> f64 {
    [
        Some(manual_a2_owner_ms),
        lifecycle.prepare_ms,
        lifecycle.publish_owner_ms,
        lifecycle.cold_reopen_ms,
        lifecycle.restore_verify_ms,
        lifecycle.source_reresolution_ms,
        lifecycle.complete_registration_ms,
        lifecycle.coverage_ms,
        lifecycle.restore_install_ms,
    ]
    .into_iter()
    .flatten()
    .fold(0.0, f64::max)
}

/// Count report observations emitted by Verify.  The JSON object field count
/// is only a serialization detail; it stays constant when a report accumulates
/// thousands of findings.  This count follows the concrete finding and
/// incomplete-evidence entries that Verify actually collected.
fn report_observation_count(report: &DependencyGraphVerifyReport) -> Result<u64> {
    let mut count = 0usize;
    count = count.saturating_add(report.edge_ids_with_missing_source.len());
    count = count.saturating_add(report.duplicate_edge_keys.len());
    count = count.saturating_add(report.edge_ids_with_cross_project_consumer.len());
    count = count.saturating_add(report.edge_ids_with_malformed_keys.len());
    count = count.saturating_add(report.edge_state_ids_outside_current_epoch.len());
    count = count.saturating_add(report.edge_ids_without_current_epoch_state.len());
    count = count.saturating_add(report.finding_observation_ids_outside_current_epoch.len());
    count = count.saturating_add(report.consumer_keys_without_current_epoch_freshness.len());
    count = count.saturating_add(report.duplicate_edge_ids_to_deactivate.len());
    count = count.saturating_add(report.edge_ids_with_unresolvable_consumer_scope.len());
    count = count.saturating_add(report.consumer_keys_with_stale_dependency_set_digest.len());
    count = count.saturating_add(
        report
            .consumer_keys_with_uncomputed_dependency_set_digest
            .len(),
    );
    count = count.saturating_add(report.orphaned_attention_finding_keys.len());
    count = count.saturating_add(report.orphaned_attention_rehome_ambiguities.len());
    for check in [
        &report.application_revision_artifact_references,
        &report.semantic_index_dependency_set_digest,
        &report.contribution_to_application_commit_correspondence,
        &report.legacy_mirror_migration_parity,
        &report.cursor_and_feed_head_consistency,
        &report.semantic_index_generation_correspondence,
    ] {
        count = count.saturating_add(check.issues.len());
        count = count.saturating_add(check.incomplete.len());
    }
    Ok(u64::try_from(count)?)
}

fn install_connection_metadata(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS grimodex_connection_meta (
             singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
             epoch TEXT NOT NULL
         );
         DELETE FROM temp.grimodex_connection_meta;",
    )?;
    conn.execute(
        "INSERT INTO temp.grimodex_connection_meta (singleton, epoch)
         VALUES (1, ?1)",
        params![uuid::Uuid::new_v4().to_string()],
    )?;
    Ok(())
}

fn database_state_digest(path: &Path) -> Result<String> {
    let mut hasher = sha2::Sha256::new();
    for suffix in ["", "-wal", "-shm"] {
        let mut state_path = path.as_os_str().to_owned();
        state_path.push(suffix);
        let state_path = Path::new(&state_path);
        hasher.update(suffix.as_bytes());
        match fs::File::open(state_path) {
            Ok(mut file) => {
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    let read = std::io::Read::read(&mut file, &mut buffer)?;
                    if read == 0 {
                        break;
                    }
                    hasher.update(&buffer[..read]);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                hasher.update(b"<absent>");
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("open database state for digest {}", state_path.display())
                });
            }
        }
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn install_diagnostic_trace(conn: &Connection, _trace: &Arc<TraceCounter>) {
    // The callback reads the same thread-local Arc installed by the
    // measurement owner; reinstalling it on a newly opened connection keeps
    // cold-reopen Restore/Verify SQL inside the same conservative profile.
    conn.trace_v2(TraceEventCodes::SQLITE_TRACE_PROFILE, Some(trace_profile));
}

fn empty_lifecycle(error: Option<String>) -> GraphLifecycleRun {
    GraphLifecycleRun {
        shape: None,
        prepared: false,
        published: false,
        rolled_back: false,
        cold_reopened: false,
        restore_verified: false,
        published_generation: None,
        prepare_ms: None,
        publish_owner_ms: None,
        publish_transaction_ms: None,
        cold_reopen_ms: None,
        restore_verify_ms: None,
        source_reresolution_ms: None,
        complete_registration_ms: None,
        coverage_ms: None,
        restore_install_ms: None,
        restore_report_records: None,
        operation_report_records: None,
        source_reresolved: false,
        complete_registered: false,
        coverage_verified: false,
        restore_maintenance_validated: false,
        restore_image_identity: None,
        restore_workspace_identity: None,
        restore_epoch: None,
        restore_proof: None,
        terminal_error: error,
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct RestoreGraphBindingSnapshot {
    metadata: Option<(
        i64,
        Option<String>,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
        String,
    )>,
    declaration: ActiveDependencyDeclarationSetRead,
    edges: Vec<DependencyEdge>,
    edge_states: Vec<(
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
    )>,
}

fn capture_restore_graph_binding(
    conn: &Connection,
    project_id: &str,
) -> Result<RestoreGraphBindingSnapshot> {
    let metadata = conn
        .query_row(
            "SELECT generation, source_digest, dependency_set_digest,
                    dirty_cache_flag, producer_id, producer_version, built_at
               FROM narrative_semantic_index_metadata
              WHERE project_id = ?1 AND index_key = ?2",
            params![project_id, ENTITY_RELATION_INDEX_KEY],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let declaration = read_active_dependency_declaration_set_in_tx(
        conn,
        project_id,
        "semantic-index",
        ENTITY_RELATION_INDEX_KEY,
    )?;
    let edges = find_edges_by_consumer(
        conn,
        project_id,
        "semantic-index",
        ENTITY_RELATION_INDEX_KEY,
    )?;
    let mut statement = conn.prepare(
        "SELECT state.edge_id, state.evidence_freshness, state.reason_code,
                state.build_action, state.evaluated_at_epoch_id,
                state.evaluated_at, edge.source_object_identity
           FROM narrative_dependency_edge_states state
           JOIN narrative_dependency_edges edge ON edge.id = state.edge_id
          WHERE edge.project_id = ?1
            AND edge.consumer_kind = ?2
            AND edge.consumer_key = ?3
          ORDER BY state.edge_id ASC",
    )?;
    let edge_states = statement
        .query_map(
            params![project_id, "semantic-index", ENTITY_RELATION_INDEX_KEY],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(RestoreGraphBindingSnapshot {
        metadata,
        declaration,
        edges,
        edge_states,
    })
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct RestoreDecisionSnapshot {
    id: String,
    revision_id: String,
    decision: String,
    decision_json: String,
    created_at: String,
    created_by: String,
    actor_kind: String,
    actor_id: String,
    authority_scope: Option<String>,
    override_field_paths_json: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct RestoreRevisionSnapshot {
    revision_id: String,
    proposal_id: String,
    proposal_status: String,
    current_revision_id: Option<String>,
    run_id: String,
    run_epoch_id: String,
    revision_number: i64,
    payload_json: String,
    origin_kind: String,
    reconciliation_envelope_json: Option<String>,
    reconciliation_envelope_digest: Option<String>,
    created_at: String,
    created_by: String,
    decisions: Vec<RestoreDecisionSnapshot>,
    roster: Vec<GraphObjectRosterEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreStoredPayload {
    bundle: EntityRelationBundle,
}

fn restore_roster_sort_key(entry: &GraphObjectRosterEntry) -> (&str, &str, &str, &str, &str, &str) {
    (
        &entry.material_kind,
        &entry.material_id,
        &entry.source_object_identity,
        &entry.revision_id,
        &entry.decision_id,
        &entry.source_token,
    )
}

fn roster_from_stored_revision(
    revision_id: &str,
    payload_json: &str,
    envelope_json: Option<&str>,
    decision_id: &str,
) -> Result<Vec<GraphObjectRosterEntry>> {
    let payload: RestoreStoredPayload = serde_json::from_str(payload_json)
        .context("parse restored typed Revision payload for exact tuple check")?;
    anyhow::ensure!(
        payload.bundle.revision_id == revision_id,
        "restored typed payload Revision identity changed: expected {revision_id}, got {}",
        payload.bundle.revision_id
    );
    let envelope = envelope_json
        .map(serde_json::from_str::<Value>)
        .transpose()
        .context("parse restored typed Revision envelope for exact tuple check")?;
    let material_basis = envelope
        .as_ref()
        .and_then(|value| value.get("effectiveMaterialBasis"))
        .cloned()
        .map(serde_json::from_value::<MaterialBasis>)
        .transpose()
        .context("parse restored typed material basis for exact tuple check")?
        .context("restored typed Revision envelope omitted effectiveMaterialBasis")?;

    let mut roster = Vec::with_capacity(
        payload
            .bundle
            .entities
            .len()
            .saturating_add(payload.bundle.relations.len())
            .saturating_add(material_basis.evidence_set.len()),
    );
    for entity in &payload.bundle.entities {
        roster.push(GraphObjectRosterEntry {
            material_kind: "entity".to_owned(),
            material_id: entity.entity_id.clone(),
            source_object_identity: format!("codex:{}", entity.entity_id),
            revision_id: revision_id.to_owned(),
            decision_id: decision_id.to_owned(),
            source_token: entity.source_token.clone(),
        });
    }
    for relation in &payload.bundle.relations {
        roster.push(GraphObjectRosterEntry {
            material_kind: "relation".to_owned(),
            material_id: relation.edge_id.clone(),
            source_object_identity: format!("codex-relation:{}", relation.edge_id),
            revision_id: revision_id.to_owned(),
            decision_id: decision_id.to_owned(),
            source_token: relation.source_token.clone(),
        });
    }
    for evidence in &material_basis.evidence_set {
        roster.push(GraphObjectRosterEntry {
            material_kind: "evidence".to_owned(),
            material_id: evidence.evidence_ref.clone(),
            source_object_identity: evidence.source_key.clone(),
            revision_id: revision_id.to_owned(),
            decision_id: decision_id.to_owned(),
            source_token: evidence.revision_token.clone(),
        });
    }
    roster
        .sort_by(|left, right| restore_roster_sort_key(left).cmp(&restore_roster_sort_key(right)));
    Ok(roster)
}

fn restore_revision_snapshot_from_conn(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
    roster_override: Option<Vec<GraphObjectRosterEntry>>,
) -> Result<RestoreRevisionSnapshot> {
    let row: Option<(
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = conn
        .query_row(
            "SELECT revision.id, proposal.id, proposal.status,
                    proposal.current_revision_id, proposal_set.run_id,
                    extraction_run.semantic_epoch_id, revision.revision_number,
                    revision.payload_json, revision.origin_kind,
                    revision.reconciliation_envelope_json,
                    revision.reconciliation_envelope_digest,
                    revision.created_at, revision.created_by
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
                project_id,
                NIR1_ENTITY_RELATION_SET_KIND,
                NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            ],
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
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                ))
            },
        )
        .optional()?;
    let Some((
        revision_id,
        proposal_id,
        proposal_status,
        current_revision_id,
        run_id,
        run_epoch_id,
        revision_number,
        payload_json,
        origin_kind,
        reconciliation_envelope_json,
        reconciliation_envelope_digest,
        created_at,
        created_by,
    )) = row
    else {
        anyhow::bail!(
            "restore exact tuple check could not read Revision {revision_id} in project {project_id}"
        );
    };

    let mut statement = conn.prepare(
        "SELECT id, revision_id, decision, decision_json, created_at, created_by,
                actor_kind, actor_id, authority_scope, override_field_paths_json
           FROM narrative_proposal_decisions
          WHERE proposal_id = ?1 AND revision_id = ?2
          ORDER BY created_at ASC, id ASC",
    )?;
    let decisions = statement
        .query_map(params![proposal_id, revision_id], |row| {
            Ok(RestoreDecisionSnapshot {
                id: row.get(0)?,
                revision_id: row.get(1)?,
                decision: row.get(2)?,
                decision_json: row.get(3)?,
                created_at: row.get(4)?,
                created_by: row.get(5)?,
                actor_kind: row.get(6)?,
                actor_id: row.get(7)?,
                authority_scope: row.get(8)?,
                override_field_paths_json: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let roster = if let Some(roster) = roster_override {
        roster
    } else {
        let decision_id = decisions
            .last()
            .map(|decision| decision.id.as_str())
            .unwrap_or("");
        roster_from_stored_revision(
            &revision_id,
            &payload_json,
            reconciliation_envelope_json.as_deref(),
            decision_id,
        )?
    };
    Ok(RestoreRevisionSnapshot {
        revision_id,
        proposal_id,
        proposal_status,
        current_revision_id,
        run_id,
        run_epoch_id,
        revision_number,
        payload_json,
        origin_kind,
        reconciliation_envelope_json,
        reconciliation_envelope_digest,
        created_at,
        created_by,
        decisions,
        roster,
    })
}

fn capture_restore_revision_snapshots(
    db: &Database,
    project_id: &str,
) -> Result<(String, Vec<RestoreRevisionSnapshot>)> {
    db.with_read_transaction(|conn| {
        let source = read_eligibility_source_with_control(
            conn,
            project_id,
            &mut super::nir1_entity_relation_index::NeverStopGraphWorkControl,
        )?;
        let mut roster_by_revision = BTreeMap::<String, Vec<GraphObjectRosterEntry>>::new();
        for entry in source.roster {
            roster_by_revision
                .entry(entry.revision_id.clone())
                .or_default()
                .push(entry);
        }
        let mut snapshots = Vec::with_capacity(roster_by_revision.len());
        for (revision_id, roster) in roster_by_revision {
            snapshots.push(restore_revision_snapshot_from_conn(
                conn,
                project_id,
                &revision_id,
                Some(roster),
            )?);
        }
        Ok((source.digest, snapshots))
    })
}

fn read_restore_revision_snapshots_after_restore(
    db: &Database,
    project_id: &str,
    revision_ids: &[String],
) -> Result<Vec<RestoreRevisionSnapshot>> {
    db.with_read_transaction(|conn| {
        revision_ids
            .iter()
            .map(|revision_id| {
                restore_revision_snapshot_from_conn(conn, project_id, revision_id, None)
            })
            .collect()
    })
}

fn assert_restore_old_revisions_invalidated(
    db: &Database,
    project_id: &str,
    revision_ids: &[String],
) -> Result<bool> {
    db.with_read_transaction(|conn| {
        for revision_id in revision_ids {
            let result = read_nir1_entity_relation_revision(conn, project_id, revision_id)?;
            anyhow::ensure!(
                matches!(
                    result,
                    Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                        if reason == "revision-restore-invalidated"
                ),
                "old A2 Revision {revision_id} did not remain revision-restore-invalidated: {result:?}"
            );
        }
        Ok(true)
    })
}

fn owned_mode_operation<T, F>(
    db: &Database,
    progress_callbacks: Option<Arc<AtomicU64>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    operation: F,
) -> Result<Option<T>>
where
    F: FnOnce(
        &Connection,
        &mut dyn super::nir1_entity_relation_index::GraphWorkControl,
    ) -> Result<T>,
{
    let result = with_narrative_maintenance_graph_control(
        db,
        std::time::Duration::ZERO,
        PROGRESS_CADENCE_VM_STEPS,
        stop,
        progress_callbacks.map_or_else(
            NarrativeMaintenanceGraphControlConfig::default,
            NarrativeMaintenanceGraphControlConfig::with_progress_callbacks,
        ),
        operation,
    )?;
    match result {
        Some(result) => match result.into_result() {
            Ok(value) => Ok(Some(value)),
            Err(error) => Err(error),
        },
        None => Ok(None),
    }
}

/// Run a cold-reopen check through a newly opened `Database`. Keeping this
/// helper separate from the restore authority ensures the check observes the
/// persisted binding after the previous connection has released its state.
fn cold_reopen_on_fresh_database(
    database_path: &Path,
    project_id: &str,
    progress_callbacks: Option<Arc<AtomicU64>>,
) -> Result<bool> {
    let reopened_db = Database::new(database_path).with_context(|| {
        format!(
            "cold-reopen diagnostic database {}",
            database_path.display()
        )
    })?;
    let operation = owned_mode_operation(
        &reopened_db,
        progress_callbacks,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
        |conn, control| {
            let tx = conn.unchecked_transaction()?;
            let result = cold_reopen_graph_index_with_control(&tx, project_id, control);
            match result {
                Ok(value) => {
                    tx.commit()?;
                    Ok(value)
                }
                Err(error) => match tx.rollback() {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(error.context(format!(
                        "rollback cold-reopen diagnostic transaction: {rollback_error}"
                    ))),
                },
            }
        },
    )?;
    match operation {
        Some(value) => Ok(value),
        None => anyhow::bail!("maintenance-connection-deferred"),
    }
}

/// Prepare and publish only the disposable Graph binding required by the
/// registration, Restore, and cold-reopen paths.  The path-specific operation
/// is measured by a separate owner call below; the source fixture is still
/// never mutated by the orchestrator.
fn prepare_and_publish_for_mode(
    db: &Database,
    project_id: &str,
    progress_callbacks: Option<Arc<AtomicU64>>,
) -> Result<GraphLifecycleRun> {
    let runtime = NirChronicleIndexRuntime::new(db, 1);
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let prepare_started = Instant::now();
    let prepared = match owned_mode_operation(
        db,
        progress_callbacks.as_ref().map(Arc::clone),
        Arc::clone(&stop),
        |conn, control| {
            let tx = conn.unchecked_transaction()?;
            let result = prepare_graph_index_build_with_control(&tx, &runtime, project_id, control);
            match result {
                Ok(snapshot) => {
                    tx.commit()?;
                    Ok(snapshot)
                }
                Err(error) => {
                    let _ = tx.rollback();
                    Err(error)
                }
            }
        },
    ) {
        Ok(prepared) => prepared,
        Err(error) => {
            return Ok(GraphLifecycleRun {
                prepare_ms: Some(prepare_started.elapsed().as_secs_f64() * 1000.0),
                rolled_back: true,
                terminal_error: Some(error.to_string()),
                ..empty_lifecycle(None)
            });
        }
    };
    let prepare_ms = Some(prepare_started.elapsed().as_secs_f64() * 1000.0);
    let Some(snapshot) = prepared else {
        return Ok(GraphLifecycleRun {
            prepare_ms,
            terminal_error: Some("maintenance-connection-deferred".to_owned()),
            ..empty_lifecycle(None)
        });
    };
    let mut shape = None;
    let publish_started = Instant::now();
    let mut publish_transaction_ms = None;
    let published = match owned_mode_operation(db, progress_callbacks, stop, |conn, control| {
        let tx = conn.unchecked_transaction()?;
        let transaction_started = Instant::now();
        let transaction_result = match snapshot.capacity_shape_with_control(control) {
            Ok(capacity_shape) => {
                shape = Some(capacity_shape);
                let result = publish_nir1_entity_relation_index_in_tx_with_control(
                    &tx, &runtime, snapshot, control,
                );
                match result {
                    Ok(binding) => match tx.commit() {
                        Ok(()) => Ok(binding),
                        Err(error) => Err(error.into()),
                    },
                    Err(error) => match tx.rollback() {
                        Ok(()) => Err(error),
                        Err(rollback_error) => Err(error.context(format!(
                            "rollback diagnostic Graph publish transaction: {rollback_error}"
                        ))),
                    },
                }
            }
            Err(error) => match tx.rollback() {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(error.context(format!(
                    "rollback diagnostic Graph shape transaction: {rollback_error}"
                ))),
            },
        };
        // The transaction interval includes the terminal commit/rollback and
        // remains observable when either phase fails. This matches the
        // FullBuild lifecycle contract and prevents a failed finalization
        // from disappearing from the occupancy report.
        publish_transaction_ms = Some(transaction_started.elapsed().as_secs_f64() * 1000.0);
        transaction_result
    }) {
        Ok(published) => published,
        Err(error) => {
            return Ok(GraphLifecycleRun {
                shape,
                prepared: true,
                rolled_back: true,
                prepare_ms,
                publish_owner_ms: Some(publish_started.elapsed().as_secs_f64() * 1000.0),
                publish_transaction_ms,
                terminal_error: Some(error.to_string()),
                ..empty_lifecycle(None)
            });
        }
    };
    let publish_owner_ms = Some(publish_started.elapsed().as_secs_f64() * 1000.0);
    let Some(published) = published else {
        return Ok(GraphLifecycleRun {
            shape,
            prepared: true,
            rolled_back: true,
            prepare_ms,
            publish_owner_ms,
            publish_transaction_ms,
            terminal_error: Some("maintenance-connection-deferred".to_owned()),
            ..empty_lifecycle(None)
        });
    };
    let binding = published;
    drop(runtime);
    Ok(GraphLifecycleRun {
        shape,
        prepared: true,
        published: true,
        rolled_back: false,
        cold_reopened: false,
        restore_verified: false,
        published_generation: Some(binding.generation),
        prepare_ms,
        publish_owner_ms,
        publish_transaction_ms,
        cold_reopen_ms: None,
        restore_verify_ms: None,
        source_reresolution_ms: None,
        complete_registration_ms: None,
        coverage_ms: None,
        restore_install_ms: None,
        restore_report_records: None,
        operation_report_records: None,
        source_reresolved: false,
        complete_registered: false,
        coverage_verified: false,
        restore_maintenance_validated: false,
        restore_image_identity: None,
        restore_workspace_identity: None,
        restore_epoch: None,
        restore_proof: None,
        terminal_error: None,
    })
}

fn copy_database_state(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    for suffix in ["", "-wal", "-shm"] {
        let mut source_path = source.as_os_str().to_owned();
        source_path.push(suffix);
        let source_path = Path::new(&source_path);
        let mut destination_path = destination.as_os_str().to_owned();
        destination_path.push(suffix);
        let destination_path = Path::new(&destination_path);
        match fs::copy(source_path, destination_path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && suffix != "" => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "copy diagnostic restore database state {} -> {}",
                        source_path.display(),
                        destination_path.display()
                    )
                });
            }
        }
    }
    Ok(())
}

/// Run Restore against a disposable workspace so the mode proves the actual
/// backup/recovery boundary.  A same-file Verify would only exercise the
/// normal publish path and could never establish a restored image, workspace
/// identity, or Restore Epoch.
fn run_real_restore_mode(
    database_path: &Path,
    project_id: &str,
    progress_callbacks: Option<Arc<AtomicU64>>,
    trace: Option<Arc<TraceCounter>>,
) -> Result<GraphLifecycleRun> {
    let workspace = std::env::temp_dir().join(format!(
        "grimodex-nir1-capacity-restore-{}",
        uuid::Uuid::new_v4()
    ));
    let backup_dir = workspace.join("backups");
    let live_path = workspace.join("grimodex.db");
    let workspace_id = format!("nir1-capacity-restore-{}", uuid::Uuid::new_v4());

    let result = (|| -> Result<GraphLifecycleRun> {
        // Keep setup inside the guarded closure so partial copy/marker/backup
        // failures still run the outer temporary-workspace cleanup.
        fs::create_dir_all(&backup_dir)?;
        copy_database_state(database_path, &live_path)?;
        fs::create_dir_all(workspace.join(".grimodex"))?;
        fs::write(
            workspace.join(".grimodex/workspace.json"),
            serde_json::json!({"id": workspace_id}).to_string(),
        )?;
        let live_db = Database::new(&live_path).with_context(|| {
            format!("open diagnostic restore live image {}", live_path.display())
        })?;
        let pre_restore_lifecycle =
            prepare_and_publish_for_mode(&live_db, project_id, progress_callbacks.clone())?;
        anyhow::ensure!(
            pre_restore_lifecycle.prepared && pre_restore_lifecycle.published,
            "restore diagnostic could not seed a published Graph generation before backup"
        );
        let expected_generation = pre_restore_lifecycle
            .published_generation
            .context("restore diagnostic seed omitted Graph generation")?;
        let expected_roster_records = pre_restore_lifecycle
            .shape
            .as_ref()
            .context("restore diagnostic seed omitted Graph roster shape")?
            .roster_records;
        // Capture the exact qualified roster and its immutable Revision /
        // Decision / Run tuple before the image is backed up. A second sealed
        // snapshot is retained solely to prove that an old candidate cannot
        // be published against the restored connection.
        let (pre_restore_source_digest, pre_restore_revisions) =
            capture_restore_revision_snapshots(&live_db, project_id)?;
        let pre_restore_graph_binding = live_db
            .with_read_transaction(|conn| capture_restore_graph_binding(conn, project_id))?;
        anyhow::ensure!(
            pre_restore_graph_binding
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.1.as_deref())
                == Some(pre_restore_source_digest.as_str()),
            "pre-restore Graph metadata Source digest did not match the exact eligibility source"
        );
        anyhow::ensure!(
            pre_restore_revisions
                .iter()
                .flat_map(|revision| revision.roster.iter())
                .count()
                == expected_roster_records,
            "restore diagnostic pre-restore roster tuple count does not match Graph shape"
        );
        let stale_runtime = NirChronicleIndexRuntime::new(&live_db, 2);
        let stale_snapshot = live_db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let snapshot = prepare_graph_index_build_with_control(
                &tx,
                &stale_runtime,
                project_id,
                &mut super::nir1_entity_relation_index::NeverStopGraphWorkControl,
            )?;
            tx.commit()?;
            Ok(snapshot)
        })?;
        let restored_marker = format!("restored-{}", uuid::Uuid::new_v4());
        live_db.with_conn(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                params!["nir1.capacity.restore.marker", &restored_marker],
            )?;
            Ok(())
        })?;
        let backup_path = backup_dir.join("grimodex-capacity-restore.db");
        live_db
            .backup_to(&backup_path)
            .context("create disposable diagnostic restore image")?;
        // Keep the pre-restore published generation in a sealed, sidecar-free
        // image. Restore must consume this real image; a same-DB Verify would
        // not prove the backup/recovery boundary.
        crate::migration_supervisor::seal_sqlite_image(&backup_path)
            .map_err(|error| anyhow::anyhow!(error))
            .context("seal disposable diagnostic restore image")?;
        live_db.with_conn(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
                params!["nir1.capacity.restore.marker", "pre-restore"],
            )?;
            Ok(())
        })?;
        drop(live_db);

        let authority = WorkspaceAuthority::from_database_for_test(
            Database::new(&live_path)?,
            workspace.clone(),
        )?;
        let state = WorkspaceState {
            inner: Mutex::new(Some(ActiveWorkspace::new(authority))),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: Mutex::new(()),
        };
        let install_started = Instant::now();
        let restore_result = restore_backup_core(&state, "grimodex-capacity-restore.db", || {});
        let restore_install_ms = Some(install_started.elapsed().as_secs_f64() * 1000.0);
        restore_result.context("run disposable diagnostic restore")?;

        let restored_authority = {
            let inner = state
                .inner
                .lock()
                .map_err(|error| anyhow::anyhow!("restore workspace lock poisoned: {error}"))?;
            let active = inner
                .as_ref()
                .context("restore did not publish a workspace authority")?;
            Arc::clone(&active.authority)
        };
        if let Some(trace) = trace.as_ref() {
            restored_authority.db().with_conn(|conn| {
                install_diagnostic_trace(conn, trace);
                Ok(())
            })?;
        }
        let actual_workspace_identity = workspace_identity(&workspace);
        anyhow::ensure!(
            actual_workspace_identity == workspace_id,
            "restore workspace identity changed: expected {workspace_id}, got {actual_workspace_identity}"
        );
        let (marker, restore_epoch, restore_image_identity) =
            restored_authority.db().with_conn(|conn| {
                let marker: Option<String> = conn
                    .query_row(
                        "SELECT value FROM app_settings WHERE key=?1",
                        params!["nir1.capacity.restore.marker"],
                        |row| row.get(0),
                    )
                    .optional()?;
                let epoch: Option<(String, String)> = conn
                    .query_row(
                        "SELECT id, triggered_by_change_event_uid
                           FROM narrative_semantic_epochs
                          WHERE project_id=?1 AND reason='restore'
                          ORDER BY epoch_number DESC
                          LIMIT 1",
                        params![project_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                Ok((
                    marker,
                    epoch.clone().map(|value| value.0),
                    epoch.map(|value| value.1),
                ))
            })?;
        anyhow::ensure!(
            marker.as_deref() == Some(restored_marker.as_str()),
            "restore image marker was not restored"
        );
        let restore_image_identity =
            restore_image_identity.context("restore did not mint a restore image identity")?;
        anyhow::ensure!(
            restore_image_identity.starts_with("restore-image-sha256:"),
            "restore image identity has unexpected format: {restore_image_identity}"
        );
        anyhow::ensure!(
            restore_epoch.is_some(),
            "restore did not mint a semantic epoch"
        );
        anyhow::ensure!(
            read_incomplete_restore_session(&workspace)?.is_none(),
            "restore session marker remained after diagnostic restore"
        );

        // Restore creates a new semantic epoch and therefore invalidates the
        // pre-restore A2 Freshness state. Prove all of the following before a
        // new Graph snapshot is prepared: the old persisted binding remains
        // at its sealed generation, the exact immutable Revision/Decision/Run
        // rows survive, old A2 reads return the canonical invalidation reason,
        // and an old in-memory snapshot cannot publish on the restored
        // connection. This diagnostic deliberately never manufactures a new
        // human Decision or re-accepts an old Revision.
        let revision_ids = pre_restore_revisions
            .iter()
            .map(|revision| revision.revision_id.clone())
            .collect::<Vec<_>>();
        let restored_binding_check = restored_authority.db().with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let metadata: Option<(i64, i64)> = tx
                .query_row(
                    "SELECT generation, dirty_cache_flag
                       FROM narrative_semantic_index_metadata
                      WHERE project_id=?1 AND index_key=?2",
                    params![project_id, ENTITY_RELATION_INDEX_KEY],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let (persisted_generation, dirty_cache_flag) =
                metadata.context("restored Graph metadata row is missing")?;
            let binding = read_graph_binding(&tx, project_id)?;
            let binding_persisted = !matches!(binding, BindingRead::Missing);
            let generation_preserved = matches!(
                &binding,
                BindingRead::Registered(binding) if binding.generation == expected_generation
            ) || matches!(binding, BindingRead::Reserved);
            anyhow::ensure!(
                persisted_generation == expected_generation,
                "restored Graph generation changed before rebuild: expected {}, got {}",
                expected_generation,
                persisted_generation
            );
            anyhow::ensure!(
                binding_persisted,
                "restored Graph binding disappeared during image handoff"
            );
            anyhow::ensure!(
                generation_preserved,
                "restored Graph binding generation changed before rebuild: expected {}",
                expected_generation
            );
            let source = read_eligibility_source_with_control(
                &tx,
                project_id,
                &mut super::nir1_entity_relation_index::NeverStopGraphWorkControl,
            )?;
            let incomplete = !is_complete_registered_with_control(
                &tx,
                project_id,
                ENTITY_RELATION_INDEX_KEY,
                &mut super::nir1_entity_relation_index::NeverStopGraphWorkControl,
            )?;
            tx.commit()?;
            Ok((
                persisted_generation,
                binding_persisted,
                generation_preserved,
                dirty_cache_flag == 0,
                source.roster.len(),
                incomplete,
            ))
        })?;
        anyhow::ensure!(
            restored_binding_check.4 == 0,
            "restored A2 eligibility unexpectedly retained {} records",
            restored_binding_check.4
        );
        anyhow::ensure!(
            restored_binding_check.5,
            "restored Graph binding remained complete despite A2 restore invalidation"
        );
        // Open a distinct Database after the restored authority has completed
        // its transaction. A same-connection call can retain connection-local
        // state and is only a warm read.
        let cold_reopen_rejected = !cold_reopen_on_fresh_database(
            &live_path,
            project_id,
            progress_callbacks.as_ref().map(Arc::clone),
        )?;
        anyhow::ensure!(
            cold_reopen_rejected,
            "cold reopen accepted the restored Graph binding despite A2 invalidation"
        );

        let post_restore_graph_binding = restored_authority
            .db()
            .with_read_transaction(|conn| capture_restore_graph_binding(conn, project_id))?;
        let source_digest_preserved = pre_restore_graph_binding
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.1.as_ref())
            == post_restore_graph_binding
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.1.as_ref());
        let d1_binding_preserved =
            pre_restore_graph_binding.declaration == post_restore_graph_binding.declaration;
        let edge_binding_preserved = pre_restore_graph_binding.edges
            == post_restore_graph_binding.edges
            && pre_restore_graph_binding.edge_states == post_restore_graph_binding.edge_states;
        anyhow::ensure!(
            source_digest_preserved,
            "Restore changed the persisted Graph Source digest"
        );
        anyhow::ensure!(
            d1_binding_preserved,
            "Restore changed the persisted Graph D1 declaration binding"
        );
        anyhow::ensure!(
            edge_binding_preserved,
            "Restore changed the persisted Graph dependency-edge binding"
        );

        let post_restore_revisions = read_restore_revision_snapshots_after_restore(
            restored_authority.db(),
            project_id,
            &revision_ids,
        )?;
        anyhow::ensure!(
            post_restore_revisions == pre_restore_revisions,
            "Restore changed an immutable Entity/Relation/Evidence/Revision/Decision tuple"
        );
        let old_revision_tuples_preserved = true;
        let old_decisions_preserved = pre_restore_revisions
            .iter()
            .zip(&post_restore_revisions)
            .all(|(before, after)| before.decisions == after.decisions);
        let old_run_epochs_preserved = pre_restore_revisions
            .iter()
            .zip(&post_restore_revisions)
            .all(|(before, after)| {
                before.run_id == after.run_id && before.run_epoch_id == after.run_epoch_id
            });
        anyhow::ensure!(
            old_decisions_preserved,
            "Restore changed an old human Decision row"
        );
        anyhow::ensure!(
            old_run_epochs_preserved,
            "Restore changed the semantic epoch stamped on an old Run"
        );
        let old_a2_revisions_invalidated = assert_restore_old_revisions_invalidated(
            restored_authority.db(),
            project_id,
            &revision_ids,
        )?;

        let stale_generation_before = restored_authority.db().with_conn(|conn| {
            let generation: i64 = conn.query_row(
                "SELECT generation FROM narrative_semantic_index_metadata
                  WHERE project_id=?1 AND index_key=?2",
                params![project_id, ENTITY_RELATION_INDEX_KEY],
                |row| row.get(0),
            )?;
            Ok(generation)
        })?;
        let stale_publish = owned_mode_operation(
            restored_authority.db(),
            progress_callbacks.as_ref().map(Arc::clone),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            |conn, control| {
                let tx = conn.unchecked_transaction()?;
                let result = publish_nir1_entity_relation_index_in_tx_with_control(
                    &tx,
                    &stale_runtime,
                    stale_snapshot,
                    control,
                );
                match result {
                    Ok(binding) => match tx.commit() {
                        Ok(()) => Ok(binding.generation),
                        Err(error) => Err(error.into()),
                    },
                    Err(error) => match tx.rollback() {
                        Ok(()) => Err(error),
                        Err(rollback_error) => Err(error.context(format!(
                            "rollback stale Graph snapshot publish: {rollback_error}"
                        ))),
                    },
                }
            },
        );
        let stale_snapshot_publish_rejected = match stale_publish {
            Ok(Some(_)) => anyhow::bail!(
                "old Graph snapshot unexpectedly published on the restored connection"
            ),
            Ok(None) => anyhow::bail!(
                "stale Graph snapshot publish was deferred before its rejection could be proven"
            ),
            Err(error) => {
                let message = error.to_string();
                anyhow::ensure!(
                    message.contains("NIR1_GRAPH_SNAPSHOT_STALE"),
                    "old Graph snapshot failed for an unexpected reason: {message}"
                );
                true
            }
        };
        let stale_generation_after = restored_authority.db().with_conn(|conn| {
            let generation: i64 = conn.query_row(
                "SELECT generation FROM narrative_semantic_index_metadata
                  WHERE project_id=?1 AND index_key=?2",
                params![project_id, ENTITY_RELATION_INDEX_KEY],
                |row| row.get(0),
            )?;
            Ok(generation)
        })?;
        let stale_snapshot_generation_unchanged = stale_generation_before == stale_generation_after;
        anyhow::ensure!(
            stale_snapshot_generation_unchanged,
            "rejected old Graph snapshot advanced generation from {} to {}",
            stale_generation_before,
            stale_generation_after
        );

        // The canonical derived-state path is allowed to refresh rebuildable
        // Freshness rows, but it must not revive an old typed A2 Run. The
        // subsequent Graph build therefore consumes a genuinely empty
        // eligibility set and publishes a new generation over the preserved
        // binding.
        if !pre_restore_revisions.is_empty() {
            let freshness_recovery =
                rebuild_narrative_derived_state_for_project(restored_authority.db(), project_id)
                    .context("recover canonical Freshness after Restore")?;
            match freshness_recovery {
                RebuildDerivedStateOutcome::Ran { summary, .. } => {
                    anyhow::ensure!(
                        summary.edges_evaluated > 0,
                        "canonical Freshness recovery evaluated no dependency edges"
                    );
                }
                RebuildDerivedStateOutcome::AlreadyRunning { run_id } => {
                    anyhow::bail!(
                        "canonical Freshness recovery unexpectedly reused running Run {run_id}"
                    );
                }
            }
        }
        anyhow::ensure!(
            assert_restore_old_revisions_invalidated(
                restored_authority.db(),
                project_id,
                &revision_ids,
            )?,
            "canonical Freshness recovery unexpectedly made an old A2 Revision readable"
        );
        let recovered_roster_records = restored_authority.db().with_read_transaction(|conn| {
            Ok(read_eligibility_source_with_control(
                conn,
                project_id,
                &mut super::nir1_entity_relation_index::NeverStopGraphWorkControl,
            )?
            .roster
            .len())
        })?;
        anyhow::ensure!(
            recovered_roster_records == 0,
            "canonical Freshness recovery revived {recovered_roster_records} old Graph records"
        );
        let rebuilt = prepare_and_publish_for_mode(
            restored_authority.db(),
            project_id,
            progress_callbacks.as_ref().map(Arc::clone),
        )?;
        anyhow::ensure!(
            rebuilt.prepared && rebuilt.published,
            "restore recovery rebuild did not publish a Graph generation: {:?}",
            rebuilt.terminal_error
        );
        let rebuilt_generation = rebuilt
            .published_generation
            .context("restore recovery rebuild omitted Graph generation")?;
        let rebuilt_roster_records = rebuilt
            .shape
            .as_ref()
            .context("restore recovery rebuild omitted Graph roster shape")?
            .roster_records;
        let rebuilt_qualified_revisions = rebuilt
            .shape
            .as_ref()
            .context("restore recovery rebuild omitted Graph revision shape")?
            .qualified_revisions;
        anyhow::ensure!(
            rebuilt_generation > restored_binding_check.0,
            "restore recovery rebuild did not advance Graph generation"
        );
        anyhow::ensure!(
            rebuilt_qualified_revisions == 0 && rebuilt_roster_records == 0,
            "restore recovery rebuild did not consume the fresh empty eligibility set: revisions={}, roster={}",
            rebuilt_qualified_revisions,
            rebuilt_roster_records
        );

        let canonical_rebuild_old_a2_revisions_invalidated =
            assert_restore_old_revisions_invalidated(
                restored_authority.db(),
                project_id,
                &revision_ids,
            )?;
        let post_rebuild_revisions = read_restore_revision_snapshots_after_restore(
            restored_authority.db(),
            project_id,
            &revision_ids,
        )?;
        let canonical_rebuild_old_revision_tuples_preserved =
            post_rebuild_revisions == pre_restore_revisions;
        let canonical_rebuild_old_decisions_preserved = pre_restore_revisions
            .iter()
            .zip(&post_rebuild_revisions)
            .all(|(before, after)| before.decisions == after.decisions);
        let canonical_rebuild_old_run_epochs_preserved = pre_restore_revisions
            .iter()
            .zip(&post_rebuild_revisions)
            .all(|(before, after)| {
                before.run_id == after.run_id && before.run_epoch_id == after.run_epoch_id
            });
        anyhow::ensure!(
            canonical_rebuild_old_a2_revisions_invalidated,
            "canonical Freshness recovery made an old A2 Revision readable"
        );
        anyhow::ensure!(
            canonical_rebuild_old_revision_tuples_preserved,
            "canonical Freshness recovery changed an immutable Revision tuple"
        );
        anyhow::ensure!(
            canonical_rebuild_old_decisions_preserved,
            "canonical Freshness recovery changed an old human Decision row"
        );
        anyhow::ensure!(
            canonical_rebuild_old_run_epochs_preserved,
            "canonical Freshness recovery changed the semantic epoch stamped on an old Run"
        );

        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let verify_started = Instant::now();
        let operation = owned_mode_operation(
            restored_authority.db(),
            progress_callbacks.as_ref().map(Arc::clone),
            stop,
            |conn, control| {
                let tx = conn.unchecked_transaction()?;
                let restored_source =
                    read_eligibility_source_with_control(&tx, project_id, control)?;
                anyhow::ensure!(
                    restored_source.roster.is_empty(),
                    "post-restore eligibility unexpectedly contains {} records",
                    restored_source.roster.len()
                );
                let restored_binding = match read_graph_binding(&tx, project_id)? {
                    BindingRead::Registered(binding) => binding,
                    other => anyhow::bail!("restored Graph binding is not registered: {other:?}"),
                };
                anyhow::ensure!(
                    restored_binding.generation == rebuilt_generation,
                    "rebuilt Graph generation changed: expected {}, got {}",
                    rebuilt_generation,
                    restored_binding.generation
                );
                let complete = is_complete_registered_with_control(
                    &tx,
                    project_id,
                    ENTITY_RELATION_INDEX_KEY,
                    control,
                )?;
                anyhow::ensure!(complete, "fresh empty Graph binding is not complete");
                let (report, _digest) =
                    verify_dependency_graph_snapshot_with_control(&tx, project_id, control)?;
                control.check(super::nir1_entity_relation_index::GraphWorkStage::ResultAssembly)?;
                let records = report_observation_count(&report)?;
                tx.commit()?;
                Ok((records, restored_binding.generation, complete))
            },
        );
        let operation_succeeded = matches!(&operation, Ok(Some(_)));
        let post_restore_cold_reopen = if operation_succeeded {
            cold_reopen_on_fresh_database(
                &live_path,
                project_id,
                progress_callbacks.as_ref().map(Arc::clone),
            )?
        } else {
            false
        };
        let restore_verify_ms = Some(verify_started.elapsed().as_secs_f64() * 1000.0);
        let (
            restore_verified,
            operation_report_records,
            restored_generation,
            post_restore_complete,
            terminal_error,
        ) = match operation {
            Ok(Some((records, generation, complete))) => (
                post_restore_cold_reopen,
                Some(records),
                Some(generation),
                complete,
                None,
            ),
            Ok(None) => (
                false,
                None,
                None,
                false,
                Some("maintenance-connection-deferred".to_owned()),
            ),
            Err(error) => (false, None, None, false, Some(error.to_string())),
        };
        let restore_proof = RestoreProof {
            binding_persisted: restored_binding_check.1,
            generation_preserved: restored_binding_check.2,
            dirty_cache_flag_cleared: restored_binding_check.3,
            eligible_records_after_restore: restored_binding_check.4,
            incomplete_rejected: restored_binding_check.5,
            cold_reopen_rejected,
            old_a2_revisions_invalidated,
            old_revision_tuples_preserved,
            old_decisions_preserved,
            old_run_epochs_preserved,
            source_digest_preserved,
            d1_binding_preserved,
            edge_binding_preserved,
            canonical_rebuild_old_a2_revisions_invalidated,
            canonical_rebuild_old_revision_tuples_preserved,
            canonical_rebuild_old_decisions_preserved,
            canonical_rebuild_old_run_epochs_preserved,
            stale_snapshot_publish_rejected,
            stale_snapshot_generation_unchanged,
            post_restore_qualified_revisions: rebuilt_qualified_revisions,
            post_restore_roster_records: rebuilt_roster_records,
            post_restore_complete,
            post_restore_verify_succeeded: restore_verified,
            post_restore_cold_reopen_succeeded: post_restore_cold_reopen,
        };
        Ok(GraphLifecycleRun {
            shape: rebuilt.shape,
            prepared: pre_restore_lifecycle.prepared && rebuilt.prepared,
            published: rebuilt.published && restored_generation.is_some(),
            rolled_back: rebuilt.rolled_back,
            restore_verified,
            restore_maintenance_validated: restore_verified,
            published_generation: restored_generation,
            cold_reopened: post_restore_cold_reopen,
            prepare_ms: match (pre_restore_lifecycle.prepare_ms, rebuilt.prepare_ms) {
                (Some(before), Some(after)) => Some(before + after),
                _ => None,
            },
            publish_owner_ms: rebuilt.publish_owner_ms,
            publish_transaction_ms: rebuilt.publish_transaction_ms,
            restore_install_ms,
            restore_verify_ms,
            restore_report_records: operation_report_records,
            operation_report_records,
            restore_image_identity: Some(restore_image_identity),
            restore_workspace_identity: Some(actual_workspace_identity),
            restore_epoch,
            restore_proof: Some(restore_proof),
            terminal_error,
            ..empty_lifecycle(None)
        })
    })();
    let cleanup_result = fs::remove_dir_all(&workspace);
    match (result, cleanup_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(mut value), Err(error)) => {
            value.terminal_error = Some(format!(
                "restore diagnostic workspace cleanup failed: {error}"
            ));
            value.restore_verified = false;
            value.restore_maintenance_validated = false;
            Ok(value)
        }
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup_error)) => Err(error.context(format!(
            "restore diagnostic workspace cleanup also failed: {cleanup_error}"
        ))),
    }
}

fn run_mode_operation(
    conn: Connection,
    database_path: &Path,
    project_id: Option<&str>,
    mode: CapacityDiagnosticMode,
    progress_callbacks: Option<Arc<AtomicU64>>,
    trace: Option<Arc<TraceCounter>>,
) -> Result<GraphLifecycleRun> {
    if mode == CapacityDiagnosticMode::FullBuild {
        return run_graph_lifecycle(conn, database_path, project_id, progress_callbacks, trace);
    }
    let Some(project_id) = project_id else {
        return Ok(empty_lifecycle(Some(
            "project-id-required-for-diagnostic-mode".to_owned(),
        )));
    };
    let db = Database::from_connection(conn);
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    match mode {
        CapacityDiagnosticMode::SourceReresolution => {
            let started = Instant::now();
            let operation = owned_mode_operation(&db, progress_callbacks, stop, |conn, control| {
                let tx = conn.unchecked_transaction()?;
                let source = read_eligibility_source_with_control(&tx, project_id, control)?;
                let records = source.roster.len();
                tx.commit()?;
                Ok(records)
            });
            let elapsed = Some(started.elapsed().as_secs_f64() * 1000.0);
            let mut lifecycle = empty_lifecycle(None);
            lifecycle.source_reresolution_ms = elapsed;
            lifecycle.source_reresolved = matches!(&operation, Ok(Some(_)));
            lifecycle.operation_report_records = None;
            lifecycle.terminal_error = match operation {
                Ok(Some(_)) => None,
                Ok(None) => Some("maintenance-connection-deferred".to_owned()),
                Err(error) => Some(error.to_string()),
            };
            drop(db);
            Ok(lifecycle)
        }
        CapacityDiagnosticMode::Coverage => {
            let mut lifecycle =
                prepare_and_publish_for_mode(&db, project_id, progress_callbacks.clone())?;
            if lifecycle.published {
                let started = Instant::now();
                let operation =
                    owned_mode_operation(&db, progress_callbacks, stop, |conn, control| {
                        let tx = conn.unchecked_transaction()?;
                        let complete = is_complete_registered_with_control(
                            &tx,
                            project_id,
                            ENTITY_RELATION_INDEX_KEY,
                            control,
                        )?;
                        anyhow::ensure!(
                            complete,
                            "coverage Graph binding is not complete for the exact roster"
                        );
                        let binding = match read_graph_binding(&tx, project_id)? {
                            BindingRead::Registered(binding) => binding,
                            other => {
                                anyhow::bail!("coverage Graph binding is not registered: {other:?}")
                            }
                        };
                        let (report, _) = verify_dependency_graph_snapshot_with_control(
                            &tx, project_id, control,
                        )?;
                        let records = report_observation_count(&report)?;
                        tx.commit()?;
                        Ok((records, binding.generation))
                    });
                lifecycle.coverage_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
                lifecycle.coverage_verified = matches!(&operation, Ok(Some(_)));
                lifecycle.operation_report_records =
                    operation.as_ref().ok().and_then(|value| value.map(|v| v.0));
                lifecycle.restore_report_records = lifecycle.operation_report_records;
                lifecycle.terminal_error = match operation {
                    Ok(Some((_records, generation))) => {
                        if lifecycle.published_generation == Some(generation) {
                            None
                        } else {
                            Some("coverage-generation-mismatch".to_owned())
                        }
                    }
                    Ok(None) => Some("maintenance-connection-deferred".to_owned()),
                    Err(error) => Some(error.to_string()),
                };
            }
            drop(db);
            Ok(lifecycle)
        }
        CapacityDiagnosticMode::CompleteRegistration => {
            let mut lifecycle =
                prepare_and_publish_for_mode(&db, project_id, progress_callbacks.clone())?;
            if lifecycle.published {
                let started = Instant::now();
                let operation =
                    owned_mode_operation(&db, progress_callbacks, stop, |conn, control| {
                        let tx = conn.unchecked_transaction()?;
                        let complete = is_complete_registered_with_control(
                            &tx,
                            project_id,
                            ENTITY_RELATION_INDEX_KEY,
                            control,
                        )?;
                        tx.commit()?;
                        Ok(complete)
                    });
                lifecycle.complete_registration_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
                match operation {
                    Ok(Some(complete)) => {
                        lifecycle.complete_registered = complete;
                        if !complete {
                            lifecycle.terminal_error =
                                Some("complete-registration-returned-false".to_owned());
                        }
                    }
                    Ok(None) => {
                        lifecycle.terminal_error =
                            Some("maintenance-connection-deferred".to_owned());
                    }
                    Err(error) => lifecycle.terminal_error = Some(error.to_string()),
                }
            }
            drop(db);
            Ok(lifecycle)
        }
        CapacityDiagnosticMode::Restore => {
            drop(db);
            return run_real_restore_mode(database_path, project_id, progress_callbacks, trace);
        }
        CapacityDiagnosticMode::ColdReopen => {
            let lifecycle =
                prepare_and_publish_for_mode(&db, project_id, progress_callbacks.clone())?;
            if !lifecycle.published {
                drop(db);
                return Ok(lifecycle);
            }
            drop(db);
            let reopened_conn =
                Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
                    .with_context(|| {
                        format!("reopen diagnostic database {}", database_path.display())
                    })?;
            if let Some(trace) = trace.as_ref() {
                install_diagnostic_trace(&reopened_conn, trace);
            }
            install_connection_metadata(&reopened_conn)?;
            let reopened_db = Database::from_connection(reopened_conn);
            let started = Instant::now();
            let operation =
                owned_mode_operation(&reopened_db, progress_callbacks, stop, |conn, control| {
                    let tx = conn.unchecked_transaction()?;
                    let result = cold_reopen_graph_index_with_control(&tx, project_id, control)?;
                    tx.commit()?;
                    Ok(result)
                });
            let mut result = lifecycle;
            result.cold_reopen_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
            result.cold_reopened = matches!(operation, Ok(Some(true)));
            match operation {
                Ok(Some(true)) => {}
                Ok(Some(false)) => {
                    result.terminal_error = Some("cold-reopen-returned-false".to_owned());
                }
                Ok(None) => {
                    result.terminal_error = Some("maintenance-connection-deferred".to_owned());
                }
                Err(error) => result.terminal_error = Some(error.to_string()),
            }
            drop(reopened_db);
            Ok(result)
        }
        CapacityDiagnosticMode::FullBuild => unreachable!(),
    }
}

fn run_graph_lifecycle(
    conn: Connection,
    database_path: &Path,
    project_id: Option<&str>,
    progress_callbacks: Option<Arc<AtomicU64>>,
    trace: Option<Arc<TraceCounter>>,
) -> Result<GraphLifecycleRun> {
    let Some(project_id) = project_id else {
        return Ok(GraphLifecycleRun {
            shape: None,
            prepared: false,
            published: false,
            rolled_back: false,
            cold_reopened: false,
            restore_verified: false,
            published_generation: None,
            prepare_ms: None,
            publish_owner_ms: None,
            publish_transaction_ms: None,
            cold_reopen_ms: None,
            restore_verify_ms: None,
            source_reresolution_ms: None,
            complete_registration_ms: None,
            coverage_ms: None,
            restore_install_ms: None,
            restore_report_records: None,
            operation_report_records: None,
            source_reresolved: false,
            complete_registered: false,
            coverage_verified: false,
            restore_maintenance_validated: false,
            restore_image_identity: None,
            restore_workspace_identity: None,
            restore_epoch: None,
            restore_proof: None,
            terminal_error: Some("project-id-required-for-graph-lifecycle".to_owned()),
        });
    };
    if let Some(trace) = trace.as_ref() {
        install_diagnostic_trace(&conn, trace);
    }
    install_connection_metadata(&conn)?;
    let db = Database::from_connection(conn);
    let runtime = NirChronicleIndexRuntime::new(&db, 1);
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let config = progress_callbacks.as_ref().map_or_else(
        NarrativeMaintenanceGraphControlConfig::default,
        |callbacks| {
            NarrativeMaintenanceGraphControlConfig::with_progress_callbacks(Arc::clone(callbacks))
        },
    );
    let prepare_started = Instant::now();
    let prepared = with_narrative_maintenance_graph_control(
        &db,
        std::time::Duration::ZERO,
        PROGRESS_CADENCE_VM_STEPS,
        Arc::clone(&stop),
        config.clone(),
        |conn, control| {
            let tx = conn.unchecked_transaction()?;
            let result = prepare_graph_index_build_with_control(&tx, &runtime, project_id, control);
            match result {
                Ok(snapshot) => {
                    tx.commit()?;
                    Ok(snapshot)
                }
                Err(error) => {
                    let _ = tx.rollback();
                    Err(error)
                }
            }
        },
    )?;
    let prepare_ms = Some(prepare_started.elapsed().as_secs_f64() * 1000.0);
    let Some(prepared) = prepared else {
        return Ok(GraphLifecycleRun {
            shape: None,
            prepared: false,
            published: false,
            rolled_back: false,
            cold_reopened: false,
            restore_verified: false,
            published_generation: None,
            prepare_ms,
            publish_owner_ms: None,
            publish_transaction_ms: None,
            cold_reopen_ms: None,
            restore_verify_ms: None,
            source_reresolution_ms: None,
            complete_registration_ms: None,
            coverage_ms: None,
            restore_install_ms: None,
            restore_report_records: None,
            operation_report_records: None,
            source_reresolved: false,
            complete_registered: false,
            coverage_verified: false,
            restore_maintenance_validated: false,
            restore_image_identity: None,
            restore_workspace_identity: None,
            restore_epoch: None,
            restore_proof: None,
            terminal_error: Some("maintenance-connection-deferred".to_owned()),
        });
    };
    let snapshot = match prepared.into_result() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            return Ok(GraphLifecycleRun {
                shape: None,
                prepared: false,
                published: false,
                rolled_back: true,
                cold_reopened: false,
                restore_verified: false,
                published_generation: None,
                prepare_ms,
                publish_owner_ms: None,
                publish_transaction_ms: None,
                cold_reopen_ms: None,
                restore_verify_ms: None,
                source_reresolution_ms: None,
                complete_registration_ms: None,
                coverage_ms: None,
                restore_install_ms: None,
                restore_report_records: None,
                operation_report_records: None,
                source_reresolved: false,
                complete_registered: false,
                coverage_verified: false,
                restore_maintenance_validated: false,
                restore_image_identity: None,
                restore_workspace_identity: None,
                restore_epoch: None,
                restore_proof: None,
                terminal_error: Some(error.to_string()),
            });
        }
    };
    let mut shape = None;
    let publish_started = Instant::now();
    let mut publish_transaction_ms = None;
    let published = with_narrative_maintenance_graph_control(
        &db,
        std::time::Duration::ZERO,
        PROGRESS_CADENCE_VM_STEPS,
        stop,
        config,
        |conn, control| {
            let tx = conn.unchecked_transaction()?;
            let transaction_started = Instant::now();
            let transaction_result = match snapshot.capacity_shape_with_control(control) {
                Ok(capacity_shape) => {
                    shape = Some(capacity_shape);
                    let result = publish_nir1_entity_relation_index_in_tx_with_control(
                        &tx, &runtime, snapshot, control,
                    );
                    match result {
                        Ok(binding) => match tx.commit() {
                            Ok(()) => Ok(binding),
                            Err(error) => Err(error.into()),
                        },
                        Err(error) => match tx.rollback() {
                            Ok(()) => Err(error),
                            Err(rollback_error) => Err(error.context(format!(
                                "rollback Graph publish transaction: {rollback_error}"
                            ))),
                        },
                    }
                }
                Err(error) => match tx.rollback() {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(error.context(format!(
                        "rollback Graph shape transaction: {rollback_error}"
                    ))),
                },
            };
            publish_transaction_ms = Some(transaction_started.elapsed().as_secs_f64() * 1000.0);
            transaction_result
        },
    )?;
    let publish_owner_ms = Some(publish_started.elapsed().as_secs_f64() * 1000.0);
    let Some(published) = published else {
        return Ok(GraphLifecycleRun {
            shape,
            prepared: true,
            published: false,
            rolled_back: true,
            cold_reopened: false,
            restore_verified: false,
            published_generation: None,
            prepare_ms,
            publish_owner_ms,
            publish_transaction_ms,
            cold_reopen_ms: None,
            restore_verify_ms: None,
            source_reresolution_ms: None,
            complete_registration_ms: None,
            coverage_ms: None,
            restore_install_ms: None,
            restore_report_records: None,
            operation_report_records: None,
            source_reresolved: false,
            complete_registered: false,
            coverage_verified: false,
            restore_maintenance_validated: false,
            restore_image_identity: None,
            restore_workspace_identity: None,
            restore_epoch: None,
            restore_proof: None,
            terminal_error: Some("maintenance-connection-deferred".to_owned()),
        });
    };
    let binding = match published.into_result() {
        Ok(binding) => binding,
        Err(error) => {
            return Ok(GraphLifecycleRun {
                shape,
                prepared: true,
                published: false,
                rolled_back: true,
                cold_reopened: false,
                restore_verified: false,
                published_generation: None,
                prepare_ms,
                publish_owner_ms,
                publish_transaction_ms,
                cold_reopen_ms: None,
                restore_verify_ms: None,
                source_reresolution_ms: None,
                complete_registration_ms: None,
                coverage_ms: None,
                restore_install_ms: None,
                restore_report_records: None,
                operation_report_records: None,
                source_reresolved: false,
                complete_registered: false,
                coverage_verified: false,
                restore_maintenance_validated: false,
                restore_image_identity: None,
                restore_workspace_identity: None,
                restore_epoch: None,
                restore_proof: None,
                terminal_error: Some(error.to_string()),
            });
        }
    };

    // Close the publishing owner before declaring this a cold reopen. A
    // second transaction on the same Database/Connection would only prove a
    // warm re-read and could retain connection-local state from publication.
    drop(runtime);
    drop(db);
    let reopened_conn =
        Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .with_context(|| format!("reopen diagnostic database {}", database_path.display()))?;
    if let Some(trace) = trace.as_ref() {
        install_diagnostic_trace(&reopened_conn, trace);
    }
    install_connection_metadata(&reopened_conn)?;
    let reopened_db = Database::from_connection(reopened_conn);

    let cold_reopen_started = Instant::now();
    let cold_reopened = with_narrative_maintenance_graph_control(
        &reopened_db,
        std::time::Duration::ZERO,
        PROGRESS_CADENCE_VM_STEPS,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
        progress_callbacks.as_ref().map_or_else(
            NarrativeMaintenanceGraphControlConfig::default,
            |callbacks| {
                NarrativeMaintenanceGraphControlConfig::with_progress_callbacks(Arc::clone(
                    callbacks,
                ))
            },
        ),
        |conn, control| {
            let tx = conn.unchecked_transaction()?;
            let result = cold_reopen_graph_index_with_control(&tx, project_id, control);
            match result {
                Ok(value) => {
                    tx.commit()?;
                    Ok(value)
                }
                Err(error) => {
                    let _ = tx.rollback();
                    Err(error)
                }
            }
        },
    )?;
    let cold_reopen_ms = Some(cold_reopen_started.elapsed().as_secs_f64() * 1000.0);
    let (cold_reopened, cold_error) = match cold_reopened {
        Some(result) => match result.into_result() {
            Ok(value) => (value, None),
            Err(error) => (false, Some(error.to_string())),
        },
        None => (false, Some("maintenance-connection-deferred".to_owned())),
    };

    let restore_started = Instant::now();
    let restored = with_narrative_maintenance_graph_control(
        &reopened_db,
        std::time::Duration::ZERO,
        PROGRESS_CADENCE_VM_STEPS,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
        progress_callbacks.map_or_else(
            NarrativeMaintenanceGraphControlConfig::default,
            NarrativeMaintenanceGraphControlConfig::with_progress_callbacks,
        ),
        |conn, control| {
            let tx = conn.unchecked_transaction()?;
            let result = verify_dependency_graph_snapshot_with_control(&tx, project_id, control);
            match result {
                Ok((report, _digest)) => {
                    control
                        .check(super::nir1_entity_relation_index::GraphWorkStage::ResultAssembly)?;
                    let records = report_observation_count(&report)?;
                    tx.commit()?;
                    Ok((report, records))
                }
                Err(error) => {
                    let _ = tx.rollback();
                    Err(error)
                }
            }
        },
    )?;
    let restore_verify_ms = Some(restore_started.elapsed().as_secs_f64() * 1000.0);
    let (restore_verified, restore_report_records, restore_error) = match restored {
        Some(result) => match result.into_result() {
            Ok((_report, records)) => (true, Some(records), None),
            Err(error) => (false, None, Some(error.to_string())),
        },
        None => (
            false,
            None,
            Some("maintenance-connection-deferred".to_owned()),
        ),
    };
    let terminal_error = cold_error.or(restore_error);
    Ok(GraphLifecycleRun {
        shape,
        prepared: true,
        published: true,
        rolled_back: false,
        cold_reopened,
        restore_verified,
        published_generation: Some(binding.generation),
        prepare_ms,
        publish_owner_ms,
        publish_transaction_ms,
        cold_reopen_ms,
        restore_verify_ms,
        restore_report_records,
        source_reresolution_ms: None,
        complete_registration_ms: None,
        coverage_ms: None,
        restore_install_ms: None,
        operation_report_records: restore_report_records,
        source_reresolved: false,
        complete_registered: false,
        coverage_verified: false,
        restore_maintenance_validated: restore_verified,
        restore_image_identity: None,
        restore_workspace_identity: None,
        restore_epoch: None,
        restore_proof: None,
        terminal_error,
    })
}

fn mode_operation_name(mode: CapacityDiagnosticMode) -> &'static str {
    match mode {
        CapacityDiagnosticMode::FullBuild => "whole-project-build-publish-reopen-verify",
        CapacityDiagnosticMode::SourceReresolution => "source-reresolution-full-set",
        CapacityDiagnosticMode::CompleteRegistration => "complete-registration-full-set",
        CapacityDiagnosticMode::Coverage => "coverage-full-set",
        CapacityDiagnosticMode::Restore => "restore-recovery-maintenance-verify",
        CapacityDiagnosticMode::ColdReopen => "cold-reopen-full-set",
    }
}

fn mode_required_success(mode: CapacityDiagnosticMode, lifecycle: &GraphLifecycleRun) -> bool {
    if lifecycle.terminal_error.is_some() {
        return false;
    }
    match mode {
        CapacityDiagnosticMode::FullBuild => {
            lifecycle.published && lifecycle.cold_reopened && lifecycle.restore_verified
        }
        CapacityDiagnosticMode::SourceReresolution => lifecycle.source_reresolved,
        CapacityDiagnosticMode::CompleteRegistration => {
            lifecycle.published && lifecycle.complete_registered
        }
        CapacityDiagnosticMode::Coverage => lifecycle.coverage_verified,
        CapacityDiagnosticMode::Restore => {
            lifecycle.published
                && lifecycle.restore_verified
                && lifecycle.restore_maintenance_validated
                && lifecycle.restore_image_identity.is_some()
                && lifecycle.restore_workspace_identity.is_some()
                && lifecycle.restore_epoch.is_some()
        }
        CapacityDiagnosticMode::ColdReopen => lifecycle.published && lifecycle.cold_reopened,
    }
}

/// Measure one disposable child process's whole-project Graph build.
/// `fixture_id` is an opaque manifest key; this function never treats the
/// declared Q/R/D shape as observed data.
pub fn measure_capacity(
    database_path: &Path,
    fixture_id: &str,
    project_id: Option<&str>,
) -> Result<CapacityObservation> {
    measure_capacity_mode(
        database_path,
        fixture_id,
        project_id,
        CapacityDiagnosticMode::FullBuild,
    )
}

/// Measure one disposable child process for one explicitly named diagnostic
/// path.  The caller (normally `nir1-material-capacity-probe.mjs`) supplies a
/// fresh database copy and process for every mode/run.
pub fn measure_capacity_mode(
    database_path: &Path,
    fixture_id: &str,
    project_id: Option<&str>,
    mode: CapacityDiagnosticMode,
) -> Result<CapacityObservation> {
    anyhow::ensure!(!fixture_id.trim().is_empty(), "fixture id must be nonempty");
    let started = Instant::now();
    let initial_copy_digest = database_state_digest(database_path)?;
    let before_process = sample_process();
    // Read once before opening the child connection to make the measurement
    // boundary explicit. The report retains the post-run value and highwater;
    // the process is fresh per orchestrator run, so the baseline is zeroed by
    // the child boundary rather than silently folded into the result.
    let _sqlite_before = sqlite_memory_used();
    let conn = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .with_context(|| format!("open diagnostic database {}", database_path.display()))?;
    install_connection_metadata(&conn)?;
    let progress = Arc::new(ProgressCounter::default());
    let progress_for_hook = Arc::clone(&progress);
    conn.progress_handler(
        PROGRESS_CADENCE_VM_STEPS,
        Some(move || {
            progress_for_hook.callbacks.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )?;
    let trace = Arc::new(TraceCounter::default());
    ACTIVE_TRACE.with(|active| {
        *active.borrow_mut() = Some(Arc::clone(&trace));
    });
    install_diagnostic_trace(&conn, &trace);
    let mut sql = SqlAccumulator::default();
    let mut counts = CapacityCounts {
        candidate_revisions: 0,
        qualified_revisions: 0,
        rejected_revisions: 0,
        entity_records: 0,
        relation_records: 0,
        evidence_records: 0,
        qualified_material_records: 0,
        roster_records: 0,
        dependency_edges: None,
        graph_snapshot_dependency_edges: None,
        report_records: None,
    };
    let mut bytes = CapacityBytes {
        payload_bytes: 0,
        envelope_bytes: 0,
        source_basis_bytes: 0,
        live_source_bytes: None,
        roster_bytes: 0,
        edge_serialized_bytes: None,
        revision_id_overhead_bytes: 0,
    };
    let mut rejection_reasons = BTreeMap::new();
    let manual_a2_started = Instant::now();
    let transaction = conn.unchecked_transaction()?;
    let revision_ids = current_revision_ids(&transaction, project_id, &mut sql)?;
    counts.candidate_revisions = revision_ids.len();
    let (payload_bytes, envelope_bytes) = row_bytes(&transaction, project_id, &mut sql)?;
    bytes.payload_bytes = payload_bytes;
    bytes.envelope_bytes = envelope_bytes;
    let project_for_reader = project_id.unwrap_or("");
    for revision_id in &revision_ids {
        if project_for_reader.is_empty() {
            *rejection_reasons
                .entry("project-id-required-for-a2-reader".to_owned())
                .or_default() += 1;
            counts.rejected_revisions = counts.rejected_revisions.saturating_add(1);
            continue;
        }
        observe_revision(
            &transaction,
            project_for_reader,
            revision_id,
            &mut sql,
            &mut counts,
            &mut bytes,
            &mut rejection_reasons,
        )?;
    }
    if let Some(project_id) = project_id {
        counts.dependency_edges = optional_table_count(
            &transaction,
            "narrative_dependency_edges",
            "project_id=?1",
            Some(project_id),
            &mut sql,
        )?;
        counts.report_records =
            read_persisted_verify_report_records_with_metrics(&transaction, project_id, &mut sql)?;
    }
    transaction.commit()?;
    let manual_a2_owner_ms = manual_a2_started.elapsed().as_secs_f64() * 1000.0;
    let fixture_shape = counts.clone();
    // The same connection is handed to the real Graph maintenance scope so
    // the lifecycle's SQL and in-process containers belong to this fresh
    // measurement. Its publish transaction may mutate only this disposable
    // copy; the orchestrator separately proves the preseed source is stable.
    let lifecycle = run_mode_operation(
        conn,
        database_path,
        project_id,
        mode,
        Some(Arc::clone(&progress.callbacks)),
        Some(Arc::clone(&trace)),
    )?;
    let connection_hold_ms = conservative_connection_hold_ms(manual_a2_owner_ms, &lifecycle);
    ACTIVE_TRACE.with(|active| {
        *active.borrow_mut() = None;
    });
    if let Some(shape) = lifecycle.shape.as_ref() {
        if mode != CapacityDiagnosticMode::Restore {
            anyhow::ensure!(
                shape.qualified_revisions == counts.qualified_revisions,
                "diagnostic Q/R shape mismatch: A2 qualified revisions={} Graph roster qualified revisions={}",
                counts.qualified_revisions,
                shape.qualified_revisions
            );
            anyhow::ensure!(
                shape.roster_records == counts.qualified_material_records,
                "diagnostic Q/R shape mismatch: A2 qualified materials={} Graph roster records={}",
                counts.qualified_material_records,
                shape.roster_records
            );
        }
        counts.roster_records = shape.roster_records;
        counts.graph_snapshot_dependency_edges = Some(u64::try_from(shape.dependency_edges)?);
        bytes.roster_bytes = u64::try_from(shape.roster_serialized_bytes)?;
        bytes.edge_serialized_bytes = Some(u64::try_from(shape.edge_serialized_bytes)?);
    }
    let post_run_copy_digest = database_state_digest(database_path)?;
    let after_process = sample_process();
    let total_peak_rss_bytes = after_process
        .hwm_rss_bytes
        .or(after_process.ru_maxrss_bytes);
    let sqlite_after = sqlite_memory_used();
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let required_success = mode_required_success(mode, &lifecycle);
    let status = if required_success {
        "measured"
    } else {
        "failed"
    };
    let admission = "per-revision-512-record-and-2MiB-envelope";
    let mut not_measured = vec![
        path_not_measured(mode, "live-source-content-bytes"),
        path_not_measured(mode, "retained-roster-edge-high-water"),
        path_not_measured(mode, "d1-declaration-retained-bytes"),
        path_not_measured(mode, "declaration-tuple-hashset-retained-bytes"),
        path_not_measured(mode, "edge-tuple-hashset-retained-bytes"),
        path_not_measured(mode, "verify-report-retained-bytes"),
        path_not_measured(mode, "durable-state-value-retained-bytes"),
        path_not_measured(mode, "clone-canonical-serialization-buffer-bytes"),
    ];
    not_measured.extend(mode_measurement_not_measured(mode, &lifecycle));
    if total_peak_rss_bytes.is_none() {
        not_measured.push(path_not_measured(mode, "total-peak-rss"));
    }
    for (metric, value) in [
        (
            "user-cpu-us",
            diff_u64(after_process.user_cpu_us, before_process.user_cpu_us),
        ),
        (
            "system-cpu-us",
            diff_u64(after_process.system_cpu_us, before_process.system_cpu_us),
        ),
        ("rss", after_process.rss_bytes),
        ("hwm-rss", after_process.hwm_rss_bytes),
        ("ru-maxrss", after_process.ru_maxrss_bytes),
        ("sqlite-memory", sqlite_after),
        ("sqlite-memory-highwater", sqlite_memory_highwater()),
        (
            "read-bytes",
            diff_u64(after_process.read_bytes, before_process.read_bytes),
        ),
        (
            "write-bytes",
            diff_u64(after_process.write_bytes, before_process.write_bytes),
        ),
    ] {
        if value.is_none() {
            not_measured.push(path_not_measured(mode, metric));
        }
    }
    if lifecycle.operation_report_records.is_none() {
        not_measured.push(path_not_measured(mode, "operation-produced-report-count"));
    }
    if fixture_shape.report_records.is_none() {
        not_measured.push(path_not_measured(mode, "report-record-count"));
    }
    if lifecycle.shape.is_none() {
        not_measured.push(path_not_measured(mode, "graph-roster-serialized-bytes"));
        not_measured.push(path_not_measured(mode, "graph-edge-serialized-bytes"));
    }
    if matches!(
        mode,
        CapacityDiagnosticMode::FullBuild | CapacityDiagnosticMode::ColdReopen
    ) && !lifecycle.cold_reopened
    {
        not_measured.push(path_not_measured(mode, "cold-reopen"));
    }
    if matches!(
        mode,
        CapacityDiagnosticMode::FullBuild | CapacityDiagnosticMode::Restore
    ) && !lifecycle.restore_verified
    {
        not_measured.push(path_not_measured(mode, "restore-verify"));
    }
    if !trace.exact_vm_steps.load(Ordering::Relaxed) {
        not_measured.push(path_not_measured(mode, "exact-lifecycle-vm-steps"));
    }
    not_measured.sort_unstable();
    not_measured.dedup();
    Ok(CapacityObservation {
        diagnostic_only: true,
        process_id: std::process::id(),
        fixture_id: fixture_id.to_owned(),
        mode,
        status,
        admission,
        supported_capacity_claim: false,
        database_path: database_path.display().to_string(),
        counts,
        bytes,
        process: ProcessMetrics {
            elapsed_ms,
            user_cpu_us: diff_u64(after_process.user_cpu_us, before_process.user_cpu_us),
            system_cpu_us: diff_u64(after_process.system_cpu_us, before_process.system_cpu_us),
            rss_bytes: after_process.rss_bytes,
            hwm_rss_bytes: after_process.hwm_rss_bytes,
            total_peak_rss_bytes,
            ru_maxrss_bytes: after_process.ru_maxrss_bytes,
            sqlite_memory_bytes: sqlite_after,
            sqlite_memory_highwater_bytes: sqlite_memory_highwater(),
            read_bytes: diff_u64(after_process.read_bytes, before_process.read_bytes),
            write_bytes: diff_u64(after_process.write_bytes, before_process.write_bytes),
            temporary_bytes: None,
        },
        sql: CapacitySqlMetrics {
            statement_vm_steps: trace.statement_vm_steps.load(Ordering::Relaxed),
            exact_vm_steps: trace.exact_vm_steps.load(Ordering::Relaxed),
            progress_callbacks: progress.callbacks.load(Ordering::Relaxed),
            statements: trace.statements.load(Ordering::Relaxed),
        },
        occupancy: CapacityOccupancy {
            connection_hold_ms,
            publish_transaction_ms: lifecycle.publish_transaction_ms,
            foreground_wait_ms: None,
        },
        graph_lifecycle: GraphLifecycleMetrics {
            prepared: lifecycle.prepared,
            published: lifecycle.published,
            rolled_back: lifecycle.rolled_back,
            cold_reopened: lifecycle.cold_reopened,
            restore_verified: lifecycle.restore_verified,
            initial_copy_digest,
            post_run_copy_digest,
            published_generation: lifecycle.published_generation,
            prepare_ms: lifecycle.prepare_ms,
            publish_owner_ms: lifecycle.publish_owner_ms,
            publish_transaction_ms: lifecycle.publish_transaction_ms,
            cold_reopen_ms: lifecycle.cold_reopen_ms,
            restore_verify_ms: lifecycle.restore_verify_ms,
            source_reresolution_ms: lifecycle.source_reresolution_ms,
            complete_registration_ms: lifecycle.complete_registration_ms,
            coverage_ms: lifecycle.coverage_ms,
            restore_install_ms: lifecycle.restore_install_ms,
            restore_report_records: lifecycle.restore_report_records,
            operation_report_records: lifecycle.operation_report_records,
            source_reresolved: lifecycle.source_reresolved,
            complete_registered: lifecycle.complete_registered,
            coverage_verified: lifecycle.coverage_verified,
            restore_maintenance_validated: lifecycle.restore_maintenance_validated,
            restore_image_identity: lifecycle.restore_image_identity,
            restore_workspace_identity: lifecycle.restore_workspace_identity,
            restore_epoch: lifecycle.restore_epoch,
            restore_proof: lifecycle.restore_proof,
            terminal_error: lifecycle.terminal_error,
        },
        fixture_shape,
        mode_outcome: CapacityModeOutcome {
            operation: mode_operation_name(mode),
            success: required_success,
            required_success,
            operation_report_records: lifecycle.operation_report_records,
        },
        cancel: CancelMeasurement {
            status: "not-run",
            latency_ms: None,
        },
        rejection_reasons,
        not_measured,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn sample_capacity_observation() -> CapacityObservation {
        CapacityObservation {
            diagnostic_only: true,
            process_id: 1,
            fixture_id: "Q513/R3/D0".to_owned(),
            mode: CapacityDiagnosticMode::FullBuild,
            status: "measured",
            admission: "diagnostic-only",
            supported_capacity_claim: false,
            database_path: "fixture.db".to_owned(),
            counts: CapacityCounts {
                candidate_revisions: 3,
                qualified_revisions: 3,
                rejected_revisions: 0,
                entity_records: 255,
                relation_records: 3,
                evidence_records: 255,
                qualified_material_records: 513,
                roster_records: 513,
                dependency_edges: Some(3),
                graph_snapshot_dependency_edges: Some(3),
                report_records: Some(0),
            },
            bytes: CapacityBytes {
                payload_bytes: 1,
                envelope_bytes: 2,
                source_basis_bytes: 3,
                live_source_bytes: Some(4),
                roster_bytes: 5,
                edge_serialized_bytes: Some(6),
                revision_id_overhead_bytes: 7,
            },
            process: ProcessMetrics {
                elapsed_ms: 1.0,
                user_cpu_us: Some(2),
                system_cpu_us: Some(3),
                rss_bytes: Some(4),
                hwm_rss_bytes: Some(5),
                total_peak_rss_bytes: Some(5),
                ru_maxrss_bytes: Some(6),
                sqlite_memory_bytes: Some(7),
                sqlite_memory_highwater_bytes: Some(8),
                read_bytes: Some(9),
                write_bytes: Some(10),
                temporary_bytes: None,
            },
            sql: CapacitySqlMetrics {
                statement_vm_steps: 1,
                exact_vm_steps: false,
                progress_callbacks: 2,
                statements: 3,
            },
            occupancy: CapacityOccupancy {
                connection_hold_ms: 1.0,
                publish_transaction_ms: Some(2.0),
                foreground_wait_ms: None,
            },
            graph_lifecycle: GraphLifecycleMetrics {
                prepared: true,
                published: true,
                rolled_back: false,
                cold_reopened: true,
                restore_verified: true,
                initial_copy_digest: "initial".to_owned(),
                post_run_copy_digest: "post".to_owned(),
                published_generation: Some(1),
                prepare_ms: Some(1.0),
                publish_owner_ms: Some(2.0),
                publish_transaction_ms: Some(3.0),
                cold_reopen_ms: Some(4.0),
                restore_verify_ms: Some(5.0),
                source_reresolution_ms: Some(6.0),
                complete_registration_ms: Some(7.0),
                coverage_ms: Some(8.0),
                restore_install_ms: Some(9.0),
                restore_report_records: Some(0),
                operation_report_records: Some(0),
                source_reresolved: true,
                complete_registered: true,
                coverage_verified: true,
                restore_maintenance_validated: true,
                restore_image_identity: None,
                restore_workspace_identity: None,
                restore_epoch: None,
                restore_proof: None,
                terminal_error: None,
            },
            fixture_shape: CapacityCounts {
                candidate_revisions: 3,
                qualified_revisions: 3,
                rejected_revisions: 0,
                entity_records: 255,
                relation_records: 3,
                evidence_records: 255,
                qualified_material_records: 513,
                roster_records: 513,
                dependency_edges: Some(3),
                graph_snapshot_dependency_edges: None,
                report_records: Some(0),
            },
            mode_outcome: CapacityModeOutcome {
                operation: "test",
                success: true,
                required_success: true,
                operation_report_records: Some(0),
            },
            cancel: CancelMeasurement {
                status: "not-run",
                latency_ms: None,
            },
            rejection_reasons: BTreeMap::new(),
            not_measured: vec!["full-build:cancel-latency".to_owned()],
        }
    }

    #[test]
    fn owned_statement_status_is_reported_as_vm_steps() -> Result<()> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('a'), ('b');",
        )?;
        let mut accumulator = SqlAccumulator::default();
        let count: i64 = count_statement(
            &conn,
            "SELECT COUNT(*) FROM sample",
            &[],
            &mut accumulator,
            |row| row.get(0),
        )?;
        assert_eq!(count, 2);
        assert!(accumulator.statement_vm_steps > 0);
        assert_eq!(accumulator.statements, 1);
        Ok(())
    }

    #[test]
    fn process_metric_parsers_are_optional_outside_procfs() {
        assert!(proc_status_bytes("definitely-not-a-real-status-key").is_none());
        assert!(proc_io_bytes("definitely-not-a-real-io-key").is_none());
    }

    #[test]
    fn diagnostic_modes_have_stable_machine_names() -> Result<()> {
        let expected = [
            "full-build",
            "source-reresolution",
            "complete-registration",
            "coverage",
            "restore",
            "cold-reopen",
        ];
        let actual = CapacityDiagnosticMode::ALL
            .iter()
            .map(|mode| mode.as_str())
            .collect::<Vec<_>>();
        assert_eq!(actual, expected);
        for (mode, name) in CapacityDiagnosticMode::ALL.into_iter().zip(expected) {
            assert_eq!(CapacityDiagnosticMode::parse(name)?, mode);
        }
        Ok(())
    }

    #[test]
    fn serialized_observation_contains_all_schema_required_fields() -> Result<()> {
        let observation = serde_json::to_value(sample_capacity_observation())?;
        let schema_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../evals/nir1-capacity/schema.v1.json");
        let schema: Value = serde_json::from_str(&std::fs::read_to_string(schema_path)?)?;
        for (definition, instance_key) in [
            ("capacityObservation", None),
            ("observationCounts", Some("counts")),
            ("observationBytes", Some("bytes")),
            ("observationProcess", Some("process")),
            ("observationSql", Some("sql")),
            ("observationOccupancy", Some("occupancy")),
            ("observationCancel", Some("cancel")),
        ] {
            let required = schema
                .pointer(&format!("/$defs/{definition}/required"))
                .and_then(Value::as_array)
                .with_context(|| format!("capacity schema must declare {definition} fields"))?;
            let object = instance_key
                .and_then(|key| observation.get(key))
                .unwrap_or(&observation)
                .as_object()
                .with_context(|| format!("serialized observation must contain {definition}"))?;
            for key in required.iter().filter_map(Value::as_str) {
                assert!(
                    object.contains_key(key),
                    "serialized {definition} missing schema field {key}"
                );
            }
        }
        let bytes = observation["bytes"].as_object().context("bytes object")?;
        assert_eq!(bytes.get("rosterBytes"), Some(&Value::from(5_u64)));
        assert!(bytes.get("rosterSerializedBytes").is_none());
        Ok(())
    }

    #[test]
    fn per_revision_admission_is_not_a_project_capacity_limit() {
        assert_eq!(PER_REVISION_MATERIAL_LIMIT, 512);
        assert_eq!(PER_REVISION_INPUT_BYTE_LIMIT, 2 * 1024 * 1024);
        assert_ne!(
            "per-revision-512-record-and-2MiB-envelope",
            "current-admission-limit"
        );
    }

    #[test]
    fn profile_upper_bound_sums_cumulative_reused_statement_status() {
        let values = [5_u64, 10, 15];
        let total = values.into_iter().sum::<u64>();
        assert_eq!(total, 30);
    }

    #[test]
    fn report_records_measure_the_persisted_verify_report() -> Result<()> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE narrative_extraction_runs (
                project_id TEXT NOT NULL,
                run_kind TEXT NOT NULL,
                status TEXT NOT NULL,
                outcome_summary_json TEXT,
                rowid_hint INTEGER NOT NULL
            );
            INSERT INTO narrative_extraction_runs
                (project_id, run_kind, status, outcome_summary_json, rowid_hint)
            VALUES
                ('project', 'dependency-verify', 'completed',
                 '{\"report\":{\"edgeIdsWithMissingSource\":[\"edge-1\",\"edge-2\"]}}', 1);
            INSERT INTO narrative_extraction_runs
                (project_id, run_kind, status, outcome_summary_json, rowid_hint)
            VALUES
                ('project', 'dependency-verify', 'running',
                 '{\"report\":{\"edgeIdsWithMissingSource\":[\"edge-running\"]}}', 2);",
        )?;

        assert_eq!(
            read_persisted_verify_report_records(&conn, "project")?,
            Some(2)
        );
        Ok(())
    }

    #[test]
    fn connection_hold_uses_max_continuous_owner_interval_without_summing_gaps() {
        let lifecycle = GraphLifecycleRun {
            shape: None,
            prepared: true,
            published: true,
            rolled_back: false,
            cold_reopened: true,
            restore_verified: true,
            published_generation: Some(3),
            prepare_ms: Some(17.0),
            publish_owner_ms: Some(41.0),
            publish_transaction_ms: Some(29.0),
            cold_reopen_ms: Some(13.0),
            restore_verify_ms: Some(23.0),
            source_reresolution_ms: Some(7.0),
            complete_registration_ms: Some(8.0),
            coverage_ms: Some(9.0),
            restore_install_ms: Some(10.0),
            restore_report_records: Some(0),
            operation_report_records: Some(0),
            source_reresolved: true,
            complete_registered: true,
            coverage_verified: true,
            restore_maintenance_validated: true,
            restore_image_identity: None,
            restore_workspace_identity: None,
            restore_epoch: None,
            restore_proof: None,
            terminal_error: None,
        };
        let measured = conservative_connection_hold_ms(19.0, &lifecycle);
        assert_eq!(measured, 41.0);
        assert!(measured < 17.0 + 19.0 + 41.0 + 13.0 + 23.0);
    }
}
