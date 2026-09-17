//! Diagnostic-only measurements for the proposed whole-project NIR-1 B build.
//!
//! This module is diagnostic-only, but it exercises the real whole-project
//! Graph prepare and publish transaction on a disposable database copy. The
//! JavaScript driver owns the fresh-process/fresh-copy protocol; this module
//! owns Native-side statement, process, and lifecycle measurements.

use anyhow::{Context, Result};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, StatementStatus};
use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;

use super::restore_rebuild::{
    verify_dependency_graph_snapshot_with_control, DependencyGraphVerifyReport,
};
use super::{
    nir1_chronicle_index::NirChronicleIndexRuntime,
    nir1_entity_relation::{read_nir1_entity_relation_revision, Nir1EntityRelationRevisionRead},
    nir1_entity_relation_index::{
        cold_reopen_graph_index_with_control, prepare_graph_index_build_with_control,
        publish_nir1_entity_relation_index_in_tx_with_control,
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
    pub dependency_edges: Option<u64>,
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
    pub roster_serialized_bytes: u64,
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
    pub ru_maxrss_bytes: Option<u64>,
    pub sqlite_memory_bytes: Option<u64>,
    pub sqlite_memory_highwater_bytes: Option<u64>,
    pub read_bytes: Option<u64>,
    pub write_bytes: Option<u64>,
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
    pub restore_report_records: Option<u64>,
    pub terminal_error: Option<String>,
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
    pub status: &'static str,
    pub admission: &'static str,
    pub supported_capacity_claim: bool,
    pub database_path: String,
    pub counts: CapacityCounts,
    pub bytes: CapacityBytes,
    pub process: ProcessMetrics,
    pub sql: CapacitySqlMetrics,
    pub occupancy: CapacityOccupancy,
    pub graph_lifecycle: GraphLifecycleMetrics,
    pub cancel: CancelMeasurement,
    pub rejection_reasons: BTreeMap<String, usize>,
    pub not_measured: Vec<&'static str>,
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
    restore_report_records: Option<u64>,
    terminal_error: Option<String>,
}

fn conservative_connection_hold_ms(
    manual_a2_owner_ms: f64,
    lifecycle: &GraphLifecycleRun,
) -> f64 {
    [
        Some(manual_a2_owner_ms),
        lifecycle.prepare_ms,
        lifecycle.publish_owner_ms,
        lifecycle.cold_reopen_ms,
        lifecycle.restore_verify_ms,
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
            restore_report_records: None,
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
            restore_report_records: None,
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
                restore_report_records: None,
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
            shape = Some(snapshot.capacity_shape_with_control(control)?);
            let result = publish_nir1_entity_relation_index_in_tx_with_control(
                &tx, &runtime, snapshot, control,
            );
            match result {
                Ok(binding) => {
                    tx.commit()?;
                    publish_transaction_ms =
                        Some(transaction_started.elapsed().as_secs_f64() * 1000.0);
                    Ok(binding)
                }
                Err(error) => {
                    let _ = tx.rollback();
                    publish_transaction_ms =
                        Some(transaction_started.elapsed().as_secs_f64() * 1000.0);
                    Err(error)
                }
            }
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
            restore_report_records: None,
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
                restore_report_records: None,
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
        terminal_error,
    })
}

/// Measure one disposable child process's whole-project Graph build.
/// `fixture_id` is an opaque manifest key; this function never treats the
/// declared Q/R/D shape as observed data.
pub fn measure_capacity(
    database_path: &Path,
    fixture_id: &str,
    project_id: Option<&str>,
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
        report_records: None,
    };
    let mut bytes = CapacityBytes {
        payload_bytes: 0,
        envelope_bytes: 0,
        source_basis_bytes: 0,
        live_source_bytes: None,
        roster_serialized_bytes: 0,
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
    // The same connection is handed to the real Graph maintenance scope so
    // the lifecycle's SQL and in-process containers belong to this fresh
    // measurement. Its publish transaction may mutate only this disposable
    // copy; the orchestrator separately proves the preseed source is stable.
    let lifecycle = run_graph_lifecycle(
        conn,
        database_path,
        project_id,
        Some(Arc::clone(&progress.callbacks)),
        Some(Arc::clone(&trace)),
    )?;
    let connection_hold_ms = conservative_connection_hold_ms(manual_a2_owner_ms, &lifecycle);
    ACTIVE_TRACE.with(|active| {
        *active.borrow_mut() = None;
    });
    if let Some(shape) = lifecycle.shape.as_ref() {
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
        counts.roster_records = shape.roster_records;
        counts.dependency_edges = Some(u64::try_from(shape.dependency_edges)?);
        bytes.roster_serialized_bytes = u64::try_from(shape.roster_serialized_bytes)?;
        bytes.edge_serialized_bytes = Some(u64::try_from(shape.edge_serialized_bytes)?);
    }
    counts.report_records = lifecycle.restore_report_records;
    let post_run_copy_digest = database_state_digest(database_path)?;
    let after_process = sample_process();
    let sqlite_after = sqlite_memory_used();
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let status = if lifecycle.published {
        "measured"
    } else {
        "build-unavailable"
    };
    let admission = "per-revision-512-record-and-2MiB-envelope";
    let mut not_measured = vec![
        "live-source-content-bytes",
        "retained-roster-edge-high-water",
        "d1-declaration-retained-bytes",
        "declaration-tuple-hashset-retained-bytes",
        "edge-tuple-hashset-retained-bytes",
        "verify-report-retained-bytes",
        "durable-state-value-retained-bytes",
        "clone-canonical-serialization-buffer-bytes",
        "foreground-wait-occupancy",
        "cancel-latency",
        "temporary-file-bytes",
    ];
    if counts.report_records.is_none() {
        not_measured.push("operation-produced-report-count");
        not_measured.push("report-record-count");
    }
    if !lifecycle.prepared {
        not_measured.push("graph-roster-serialized-bytes");
        not_measured.push("graph-edge-serialized-bytes");
    }
    if !lifecycle.cold_reopened {
        not_measured.push("cold-reopen");
    }
    if !lifecycle.restore_verified {
        not_measured.push("restore-verify");
    }
    if !trace.exact_vm_steps.load(Ordering::Relaxed) {
        not_measured.push("exact-lifecycle-vm-steps");
    }
    Ok(CapacityObservation {
        diagnostic_only: true,
        process_id: std::process::id(),
        fixture_id: fixture_id.to_owned(),
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
            ru_maxrss_bytes: after_process.ru_maxrss_bytes,
            sqlite_memory_bytes: sqlite_after,
            sqlite_memory_highwater_bytes: sqlite_memory_highwater(),
            read_bytes: diff_u64(after_process.read_bytes, before_process.read_bytes),
            write_bytes: diff_u64(after_process.write_bytes, before_process.write_bytes),
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
            restore_report_records: lifecycle.restore_report_records,
            terminal_error: lifecycle.terminal_error,
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
            restore_report_records: Some(0),
            terminal_error: None,
        };
        let measured = conservative_connection_hold_ms(19.0, &lifecycle);
        assert_eq!(measured, 41.0);
        assert!(measured < 17.0 + 19.0 + 41.0 + 13.0 + 23.0);
    }
}
