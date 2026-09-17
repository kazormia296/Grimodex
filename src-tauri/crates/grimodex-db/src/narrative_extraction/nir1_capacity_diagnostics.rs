//! Diagnostic-only measurements for the proposed whole-project NIR-1 B build.
//!
//! This module deliberately does not build or publish an Index.  It opens an
//! existing database read-only, reuses the public A2 reader for the exact
//! current Revision qualification step, and reports the shape and resources
//! observed while walking those Revisions.  The JavaScript driver owns the
//! fresh-process/fresh-copy protocol; this module owns the Native-side
//! statement and process measurements.

use anyhow::{Context, Result};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, StatementStatus};
use serde::Serialize;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Instant;

use super::{
    read_nir1_entity_relation_revision, Nir1EntityRelationRevisionRead,
    NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH, NIR1_ENTITY_RELATION_SET_KIND,
};

/// This is the current per-request admission boundary.  It is intentionally
/// used only to label the diagnostic result while the whole-project Index
/// builder is not yet wired into this probe.  It is not a proposed build
/// capacity and must not be read as a supported-size contract.
pub const CURRENT_ADMISSION_MATERIAL_LIMIT: usize = 512;
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
    pub roster_bytes: u64,
    pub revision_id_overhead_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacitySqlMetrics {
    /// Available because this probe prepares each statement itself and reads
    /// SQLite's `SQLITE_STMTSTATUS_VM_STEP` immediately after completion.
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
    /// This is the read-only connection hold interval in this process.
    pub connection_hold_ms: f64,
    /// No publish transaction is opened by this diagnostic.
    pub publish_transaction_ms: Option<f64>,
    /// Foreground waiter coordination belongs to the maintenance owner and
    /// is not observable from a standalone read-only child.
    pub foreground_wait_ms: Option<f64>,
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
    pub cancel: CancelMeasurement,
    pub rejection_reasons: BTreeMap<String, usize>,
    pub not_measured: Vec<&'static str>,
}

#[derive(Default)]
struct SqlAccumulator {
    statement_vm_steps: u64,
    statements: u64,
}

#[derive(Default)]
struct ProgressCounter {
    callbacks: AtomicU64,
}

#[derive(Default)]
struct TraceCounter {
    statement_vm_steps: AtomicU64,
    statements: AtomicU64,
}

thread_local! {
    static ACTIVE_TRACE: RefCell<Option<Arc<TraceCounter>>> = const { RefCell::new(None) };
}

fn trace_profile(event: TraceEvent<'_>) {
    if let TraceEvent::Profile(statement, _) = event {
        ACTIVE_TRACE.with(|active| {
            if let Some(counter) = active.borrow().as_ref() {
                counter.statement_vm_steps.fetch_add(
                    u64::try_from(statement.get_status(StatementStatus::VmStep)).unwrap_or(0),
                    Ordering::Relaxed,
                );
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
        "SELECT COALESCE(SUM(length(revision.payload_json)),0),
                       COALESCE(SUM(length(revision.reconciliation_envelope_json)),0)
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
        "SELECT COALESCE(SUM(length(payload_json)),0),
                       COALESCE(SUM(length(reconciliation_envelope_json)),0)
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RosterRecord<'a> {
    material_kind: &'a str,
    material_id: &'a str,
    source_key: &'a str,
    revision_id: &'a str,
    decision_id: Option<&'a str>,
    source_token: &'a str,
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
            let bundle = serde_json::to_vec(&revision.bundle)?;
            let material = serde_json::to_vec(&revision.material_basis)?;
            bytes.roster_bytes = bytes
                .roster_bytes
                .saturating_add(u64::try_from(bundle.len().saturating_add(material.len()))?);
            for entity in &revision.bundle.entities {
                let source = entity.source_token.as_str();
                let record = RosterRecord {
                    material_kind: "entity",
                    material_id: entity.entity_id.as_str(),
                    source_key: source,
                    revision_id,
                    decision_id: decision.as_deref(),
                    source_token: source,
                };
                bytes.roster_bytes = bytes
                    .roster_bytes
                    .saturating_add(u64::try_from(serde_json::to_vec(&record)?.len())?);
            }
            for relation in &revision.bundle.relations {
                let source = relation.source_token.as_str();
                let record = RosterRecord {
                    material_kind: "relation",
                    material_id: relation.edge_id.as_str(),
                    source_key: source,
                    revision_id,
                    decision_id: decision.as_deref(),
                    source_token: source,
                };
                bytes.roster_bytes = bytes
                    .roster_bytes
                    .saturating_add(u64::try_from(serde_json::to_vec(&record)?.len())?);
            }
            for evidence in &revision.material_basis.evidence_set {
                let record = RosterRecord {
                    material_kind: "evidence",
                    material_id: evidence.evidence_ref.as_str(),
                    source_key: evidence.source_key.as_str(),
                    revision_id,
                    decision_id: decision.as_deref(),
                    source_token: evidence.revision_token.as_str(),
                };
                bytes.roster_bytes = bytes
                    .roster_bytes
                    .saturating_add(u64::try_from(serde_json::to_vec(&record)?.len())?);
            }
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
            counts.rejected_revisions = counts.rejected_revisions.saturating_add(1);
            *rejection_reasons
                .entry("reader-error".to_owned())
                .or_default() += 1;
            tracing::debug!(revision_id, error = %error, "capacity diagnostic A2 reader error");
        }
    }
    Ok(())
}

fn diff_u64(after: Option<u64>, before: Option<u64>) -> Option<u64> {
    Some(after?.saturating_sub(before?))
}

/// Measure one read-only child process's view of the current A2 material.
/// `fixture_id` is an opaque manifest key; this function never treats the
/// declared Q/R/D shape as observed data.
pub fn measure_capacity(
    database_path: &Path,
    fixture_id: &str,
    project_id: Option<&str>,
) -> Result<CapacityObservation> {
    anyhow::ensure!(!fixture_id.trim().is_empty(), "fixture id must be nonempty");
    let started = Instant::now();
    let before_process = sample_process();
    // Read once before opening the child connection to make the measurement
    // boundary explicit. The report retains the post-run value and highwater;
    // the process is fresh per orchestrator run, so the baseline is zeroed by
    // the child boundary rather than silently folded into the result.
    let _sqlite_before = sqlite_memory_used();
    let conn = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("open diagnostic database {}", database_path.display()))?;
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
    conn.trace_v2(TraceEventCodes::SQLITE_TRACE_PROFILE, Some(trace_profile));
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
        roster_bytes: 0,
        revision_id_overhead_bytes: 0,
    };
    let mut rejection_reasons = BTreeMap::new();
    let transaction_started = Instant::now();
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
    let connection_hold_ms = transaction_started.elapsed().as_secs_f64() * 1000.0;
    conn.progress_handler(0, None::<fn() -> bool>)?;
    conn.trace_v2(TraceEventCodes::empty(), None);
    ACTIVE_TRACE.with(|active| {
        *active.borrow_mut() = None;
    });
    let after_process = sample_process();
    let sqlite_after = sqlite_memory_used();
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let qualified_material_records = counts.qualified_material_records;
    let (status, admission) = if qualified_material_records > CURRENT_ADMISSION_MATERIAL_LIMIT {
        (
            "current-admission-limit",
            "blocked-by-current-reader-admission-limit",
        )
    } else {
        ("measured", "diagnostic-only")
    };
    let mut not_measured = vec![
        "live-source-content-bytes",
        "whole-build-total-peak-memory",
        "simultaneous-roster-edge-high-water",
        "publish-transaction-occupancy",
        "foreground-wait-occupancy",
        "cancel-latency",
        "temporary-file-bytes",
        "whole-project-index-publication",
        "persistent-index-generation",
    ];
    if counts.dependency_edges.is_none() {
        not_measured.push("dependency-edge-count");
    }
    if counts.report_records.is_none() {
        not_measured.push("report-record-count");
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
            exact_vm_steps: true,
            progress_callbacks: progress.callbacks.load(Ordering::Relaxed),
            statements: trace.statements.load(Ordering::Relaxed),
        },
        occupancy: CapacityOccupancy {
            connection_hold_ms,
            publish_transaction_ms: None,
            foreground_wait_ms: None,
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
    fn statement_status_is_reported_as_exact_vm_steps() -> Result<()> {
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
    fn admission_label_is_diagnostic_and_does_not_claim_capacity() {
        assert_eq!(CURRENT_ADMISSION_MATERIAL_LIMIT, 512);
        let status = if 513 > CURRENT_ADMISSION_MATERIAL_LIMIT {
            "current-admission-limit"
        } else {
            "measured"
        };
        assert_eq!(status, "current-admission-limit");
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
}
