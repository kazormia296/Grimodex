//! DEV-ONLY (branch `claude/irb-prepare-timing`, never merged).
//!
//! Replays the related-scenes IR build's prepare (the read half of
//! `electron/native/grimodex-node/src/related_scenes/build.rs::build_once`)
//! against a COPY of a finished PD-evaluation database and prints one JSON
//! line with a per-stage breakdown. The same harness measures a branch that has
//! DR-IRB-1 (commit a40bb2a0) cherry-picked, so the two JSON lines compare.
//!
//! Run (release profile; the original DB is never opened for writing, it is
//! copied with its `-wal`/`-shm` into a temp dir first):
//!
//! ```text
//! GRIMODEX_IRB_TIMING_DB=/path/to/m-ja-2-final.db \
//! GRIMODEX_IRB_TIMING_PROJECT=fusion-ir \
//!   cargo test -p grimodex-db --release irb_prepare_timing -- --ignored --nocapture
//! ```
//!
//! Env
//! - `GRIMODEX_IRB_TIMING_DB`       (required) source database file.
//! - `GRIMODEX_IRB_TIMING_PROJECT`  (required) project id (e.g. `fusion-ir`).
//! - `GRIMODEX_IRB_TIMING_REPS`     repetitions, 1..=3 (default 1).
//! - `GRIMODEX_IRB_TIMING_PROBE_MS` foreground probe period (default 50).
//! - `GRIMODEX_IRB_TIMING_KEEP=1`   keep the temp copy (default: delete).
//!
//! stdout: a single line starting with `IRB_TIMING_JSON ` followed by JSON.
//! Stage times are inclusive and nest (see `crate::irb_timing`), so they are
//! not additive; `audit_count_share` = (both audit COUNT stages) /
//! `snapshot.total` answers "how much of prepare is the ai_audit_events COUNT".
//!
//! Publish-side reads and scale (`publishReads`, `scale`)
//!
//! After each rep's prepare (and after the foreground probe has stopped), the
//! same plan is used to time the READ-ONLY stages that production
//! `publish_chronicle_index_build_scoped` runs under the same single
//! `Mutex<Connection>`. The shape mirrors production: `Database::
//! with_participant_sql_scope` -> `BEGIN IMMEDIATE` -> stages -> `ROLLBACK`
//! (written by hand here, because `with_immediate_transaction` commits on Ok
//! and the nir1 capacity commit hook is not on this path). Nothing is
//! written; `autocommit_after_rollback` must be true.
//!
//! `publishReads` (one object per rep, inside `reps[]`)
//! - `stages.runtime_epoch`: `runtime.current_epoch` (cheap).
//! - `stages.snapshot_current`: `build::snapshot_current_with_control` as one
//!   call. `result.current` MUST be true: it short-circuits on the first
//!   mismatch (a false value means the number undershoots production).
//! - `stages.snapshot_current_parts.*`: the heavy parts of snapshot_current
//!   timed separately in the same order (binding, roster_source, input_guard,
//!   pending, evaluate_owned_edges). They run after the whole call, so they
//!   are warm; compare their sum with `snapshot_current`, not with prepare.
//!   Not replayed (one-row reads, expected to be a few ms at most):
//!   `is_generic_freshness_canonical`, `get_current_epoch`, and the
//!   `projects.language` SELECT, so sum(parts) is slightly below
//!   `snapshot_current`.
//! - `stages.audit_chain`: `verify_ai_audit_chain_for_scope(conn,
//!   Some(project), None)`, the whole-chain walk inside `verify_outcomes`.
//!   Production skips it when there are no outcomes; here it always runs.
//! - `stages.read_verified_evidence`: per-candidate calls, cumulative
//!   (`total_ms`), `max_ms`, `slowest[]`, and sizes (`evidence_artifacts_read`
//!   = artifacts fetched and parsed, `verified_items`). Production runs this
//!   after the vector INSERT; the tables read are not written by publish.
//! - `stages.verify_execution_sql_approx`: APPROXIMATION of the per-outcome
//!   `verify_execution` (SQL + JSON parse of up to 6 audit rows) using
//!   execution ids of `semantic_embedding_index` taken from the copy. It is
//!   sampled (`sampled` vs `wanted`) and does not check any value.
//! - `input_guard_breakdown[]`: the 18 `input_guard` queries replayed one by
//!   one (rows, bytes, ms, SHA-256 included) to show which table dominates.
//! - `tx_ms` (includes helper stages: do not read it as the hold time; the
//!   lower bound of the production hold is `production_read_stages_ms`): wall time from BEGIN to just before ROLLBACK (all stages above
//!   plus breakdown/approx helpers, so it is NOT the production hold time).
//!   `production_read_stages_ms` = runtime_epoch + snapshot_current +
//!   audit_chain + read_verified_evidence: a lower bound of the production
//!   publish hold, because `verify_execution` per outcome, the vector INSERTs,
//!   the declaration/edge rewrite, the second edge evaluation and COMMIT are
//!   not measured. `scope_ms` also includes the participant SQL scope hooks.
//! - `spans`: any `crate::irb_timing` spans hit during this phase (prepare's
//!   spans are reset before it).
//! - Conditions: runs right after prepare on the same warm connection
//!   (prepare's rep 0 was cold), with `TimingControl` (never cancels).
//!
//! `scale` (top level, measured once on the copy with SQL; `candidates` from
//! the first rep's plan)
//! - `sql.proposal_revisions` (ALL revisions of the project; the reviewed roster
//!   count is `candidates.roster_revisions`), `sql.runs`, `sql.stage_receipts`
//!   (`distinct_run_ids`, `receipt_json_bytes`), `sql.ai_audit_project`
//!   (all rows of the project scope), `sql.ai_audit_input_guard_subset` (rows
//!   `input_guard` hashes: execution in a stage receipt), `sql.ai_audit_embedding`
//!   (path `semantic_embedding_index`), `sql.artifacts` (payload_json bytes,
//!   and the `evidence.resolved@1` subset), `sql.edges_per_revision`
//!   (`proposal-revision` dependency edges per consumer_key: mean/max),
//!   `sql.semantic_index_edges`. Bytes are `LENGTH(CAST(.. AS BLOB))`.
//! - `candidates`: from the plan: `roster_revisions`, `candidates`,
//!   `distinct_owning_runs`, `snapshot_edges`, and sum/mean/max per candidate
//!   of `sources` (the source edges a candidate contributes), `evidence`
//!   entries and `evidence_artifacts`.
//!
//! What this does and does not reproduce
//! - Same functions as production: `prepare_chronicle_index_build_with_control`
//!   inside `Database::with_participant_read_transaction`, with a control that
//!   overrides exactly what `RelatedScenesBuildControl` overrides
//!   (`allows_full_eligibility = true`, no stop signal). Its `check()` never
//!   cancels (the native one polls participant/safe-mode/epoch flags).
//! - Only the `Ready` path is measured. The runtime here is a fresh
//!   `NirChronicleIndexRuntime::new(&db, 1)` whose `proofs` map is empty, so
//!   `current_proof_with_control` returns `None` and `AlreadyUsable` is not
//!   reached (production keeps proofs in `db.nir_chronicle_index_runtime()`
//!   and re-checks a stale proof via `proof_current_observed`; that check is
//!   NOT reproduced). Right after an approval the production binding is dirty,
//!   which is the same `Ready` path. The `AlreadyUsable` fallback below
//!   (`fallback_direct`) is kept only as a safety net and should stay false.
//! - The participant SQL scope is built with `ParticipantSqlControl::default()`
//!   (no deadline, no stop), exactly as `with_participant_read_transaction`
//!   does in production, so a long prepare is never cut off by a timeout here.
//!   The participant path does not yield to foreground waiters (only the
//!   separate `try_lock_narrative_maintenance` path does), so the probe cannot
//!   abort the prepare; any prepare error is reported in `reps[].error`.
//! - Source DB: use only a finished run's database (e.g. `*-final.db`). The
//!   db, `-wal` and `-shm` are copied one after another without a checkpoint
//!   guard, so a live DB can give an inconsistent copy. Permission bits are
//!   reset to 0644 on the copy so a read-only (0444) source still opens.
//! - Cold start: rep 0 runs on a freshly opened connection (cold page and
//!   statement caches); the production build loop reuses one warm connection.
//!   Read `GRIMODEX_IRB_TIMING_REPS=2` or `3` and compare rep 1.. with the
//!   same rep number when comparing against a DR-IRB-1 run.
//! - The foreground probe is a single thread: while one `with_conn` waits
//!   (seconds), no further sample is taken (coordinated omission), so
//!   `p50/p90/p99` hide the wait. Read `max_ms`, `slowest[]` and
//!   `prepare_window_ms`; the longest RTT can undershoot the real wait by up
//!   to one probe period. `corrected_*` adds the samples a fixed-rate prober
//!   would have taken (rtt - k * period for k >= 1) HdrHistogram-style.
//! - The foreground probe uses `Database::with_conn` (the same single
//!   `Mutex<Connection>` that the native `db_execute` path waits on). It is not
//!   the Electron IPC path, so it excludes IPC and renderer time.

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use super::{build::read_snapshot_with_control, *};
use crate::{
    narrative_extraction::{GraphWorkControl, GraphWorkStage},
    workspace_lifecycle::WorkspaceParticipant,
    Database,
};
use rusqlite::{params, types::ValueRef, Connection};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const COUNTERS: [&str; 3] = [
    "snapshot.roster_revisions",
    "snapshot.preflight_passed",
    "snapshot.candidates",
];

#[derive(Default)]
struct TimingControl {
    checks: u64,
}

impl GraphWorkControl for TimingControl {
    fn check(&mut self, _stage: GraphWorkStage) -> anyhow::Result<()> {
        self.checks += 1;
        Ok(())
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

fn ms(duration: Duration) -> f64 {
    round3(duration.as_secs_f64() * 1000.0)
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn env_required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

/// `fs::copy` carries permission bits; make the copy owner-writable.
fn make_writable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).expect("chmod copy");
}

/// Copy `source` (and `-wal`/`-shm` when present) to a private temp dir.
fn copy_database(source: &Path) -> (PathBuf, PathBuf) {
    assert!(source.is_file(), "source database not found: {source:?}");
    let dir = std::env::temp_dir().join(format!("irb-timing-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let target = dir.join("workspace.db");
    std::fs::copy(source, &target).expect("copy database");
    make_writable(&target);
    for suffix in ["-wal", "-shm"] {
        let mut from = source.as_os_str().to_owned();
        from.push(suffix);
        let from = PathBuf::from(from);
        if from.is_file() {
            let mut to = target.as_os_str().to_owned();
            to.push(suffix);
            let to = PathBuf::from(to);
            std::fs::copy(&from, &to).expect("copy sidecar");
            make_writable(&to);
        }
    }
    (dir, target)
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f64 * q).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

/// `(offset_ms since the probe started, round trip ms)` samples.
fn probe_summary(samples: &[(f64, f64)], window: Option<(f64, f64)>, period_ms: f64) -> Value {
    let mut rtts: Vec<f64> = samples.iter().map(|(_, rtt)| *rtt).collect();
    rtts.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let mut slowest: Vec<&(f64, f64)> = samples.iter().collect();
    slowest.sort_by(|a, b| b.1.partial_cmp(&a.1).expect("finite"));
    // Coordinated-omission correction: a sample that waited longer than one
    // period stands for the samples that would have been taken meanwhile.
    let mut corrected: Vec<f64> = Vec::new();
    for rtt in &rtts {
        corrected.push(*rtt);
        if period_ms > 0.0 {
            let mut virtual_rtt = rtt - period_ms;
            while virtual_rtt > 0.0 {
                corrected.push(virtual_rtt);
                virtual_rtt -= period_ms;
            }
        }
    }
    corrected.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    json!({
        "samples": samples.len(),
        "corrected_samples": corrected.len(),
        "corrected_p50_ms": round3(percentile(&corrected, 0.50)),
        "corrected_p90_ms": round3(percentile(&corrected, 0.90)),
        "corrected_p99_ms": round3(percentile(&corrected, 0.99)),
        "min_ms": rtts.first().copied().map(round3),
        "p50_ms": round3(percentile(&rtts, 0.50)),
        "p90_ms": round3(percentile(&rtts, 0.90)),
        "p99_ms": round3(percentile(&rtts, 0.99)),
        "max_ms": rtts.last().copied().map(round3),
        "over_100ms": rtts.iter().filter(|v| **v > 100.0).count(),
        "over_1000ms": rtts.iter().filter(|v| **v > 1_000.0).count(),
        "over_10000ms": rtts.iter().filter(|v| **v > 10_000.0).count(),
        "prepare_window_ms": window.map(|(start, end)| json!([round3(start), round3(end)])),
        "slowest": slowest
            .iter()
            .take(10)
            .map(|(at, rtt)| json!({"start_ms": round3(*at), "rtt_ms": round3(*rtt)}))
            .collect::<Vec<_>>(),
    })
}

fn count_rows(db: &Database, sql: &str, project: &str) -> Value {
    db.with_conn(|conn| {
        let has_param = sql.contains("?1");
        let value: i64 = if has_param {
            conn.query_row(sql, [project], |row| row.get(0))?
        } else {
            conn.query_row(sql, [], |row| row.get(0))?
        };
        Ok(json!(value))
    })
    .unwrap_or_else(|error| json!(format!("error: {error}")))
}

/// One row of named columns as a JSON object (a `scale` SQL helper).
fn query_object(db: &Database, sql: &str, project: &str) -> Value {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(sql)?;
        let names: Vec<String> = statement
            .column_names()
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        let object = statement.query_row([project], |row| {
            let mut map = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(round3(v)),
                    ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                    ValueRef::Blob(v) => json!(format!("<blob {} bytes>", v.len())),
                };
                map.insert(name.clone(), value);
            }
            Ok(Value::Object(map))
        })?;
        Ok(object)
    })
    .unwrap_or_else(|error| json!(format!("error: {error:#}")))
}

/// Scale of the data the publish-side reads walk, by SQL (outside any timer).
fn sql_scale(db: &Database, project: &str) -> Value {
    const AUDIT_BYTES: &str = "COALESCE(SUM(LENGTH(CAST(a.payload AS BLOB))),0) AS payload_bytes,
         COALESCE(MAX(a.sequence),0) AS max_sequence";
    let audit_all = format!(
        "SELECT COUNT(*) AS n_rows, {AUDIT_BYTES} FROM ai_audit_events a
          WHERE a.scope_id='project:'||?1"
    );
    let audit_guard = format!(
        "SELECT COUNT(*) AS n_rows, {AUDIT_BYTES} FROM ai_audit_events a
          WHERE a.project_id=?1 AND EXISTS(SELECT 1 FROM narrative_extraction_stage_receipts r
                WHERE r.project_id=?1 AND r.stage_execution_id=a.execution_id)"
    );
    let audit_embedding = format!(
        "SELECT COUNT(*) AS n_rows, {AUDIT_BYTES} FROM ai_audit_events a
          WHERE a.scope_id='project:'||?1 AND a.path_id='semantic_embedding_index'"
    );
    json!({
        "proposal_revisions": query_object(db,
            "SELECT COUNT(*) AS n FROM narrative_proposal_revisions r
               JOIN narrative_proposals p ON p.id=r.proposal_id
               JOIN narrative_proposal_sets s ON s.id=p.proposal_set_id
              WHERE s.project_id=?1", project),
        "runs": query_object(db,
            "SELECT COUNT(*) AS n FROM narrative_extraction_runs WHERE project_id=?1", project),
        "stage_receipts": query_object(db,
            "SELECT COUNT(*) AS n, COUNT(DISTINCT run_id) AS distinct_run_ids,
                    COALESCE(SUM(LENGTH(CAST(receipt_json AS BLOB))),0) AS receipt_json_bytes
               FROM narrative_extraction_stage_receipts WHERE project_id=?1", project),
        "ai_audit_project": query_object(db, &audit_all, project),
        "ai_audit_input_guard_subset": query_object(db, &audit_guard, project),
        "ai_audit_embedding": query_object(db, &audit_embedding, project),
        "artifacts": query_object(db,
            "SELECT COUNT(*) AS n,
                    COALESCE(SUM(LENGTH(CAST(a.payload_json AS BLOB))),0) AS payload_json_bytes,
                    COALESCE(SUM(CASE WHEN a.artifact_kind='evidence.resolved@1' THEN 1 ELSE 0 END),0)
                        AS evidence_resolved_n,
                    COALESCE(SUM(CASE WHEN a.artifact_kind='evidence.resolved@1'
                        THEN LENGTH(CAST(a.payload_json AS BLOB)) ELSE 0 END),0)
                        AS evidence_resolved_bytes
               FROM narrative_extraction_artifacts a
               JOIN narrative_extraction_runs r ON r.id=a.run_id
              WHERE r.project_id=?1", project),
        "edges_per_revision": query_object(db,
            "SELECT COUNT(*) AS consumers, COALESCE(AVG(c),0) AS mean_edges,
                    COALESCE(MAX(c),0) AS max_edges, COALESCE(SUM(c),0) AS total_edges
               FROM (SELECT COUNT(*) AS c FROM narrative_dependency_edges
                      WHERE project_id=?1 AND consumer_kind='proposal-revision'
                      GROUP BY consumer_key)", project),
        "semantic_index_edges": query_object(db,
            "SELECT COUNT(*) AS n FROM narrative_dependency_edges
              WHERE project_id=?1 AND consumer_kind='semantic-index'", project),
    })
}

fn distribution(values: &[usize]) -> Value {
    let sum: usize = values.iter().sum();
    json!({
        "sum": sum,
        "mean": round3(if values.is_empty() { 0.0 } else { sum as f64 / values.len() as f64 }),
        "max": values.iter().copied().max().unwrap_or(0),
    })
}

/// Per-candidate sizes of the snapshot a plan carries.
fn candidate_scale(plan: &NirIndexBuildPlan) -> Value {
    let snapshot = &plan.snapshot;
    let sources: Vec<usize> = snapshot
        .candidates
        .iter()
        .map(|c| c.sources.len())
        .collect();
    let evidence: Vec<usize> = snapshot
        .candidates
        .iter()
        .map(|c| c.evidence.len())
        .collect();
    let artifacts: Vec<usize> = snapshot
        .candidates
        .iter()
        .map(|c| c.evidence_artifacts.len())
        .collect();
    let runs: HashSet<&str> = snapshot
        .candidates
        .iter()
        .map(|c| c.owning_run_id.as_str())
        .collect();
    json!({
        "candidates": snapshot.candidates.len(),
        "distinct_owning_runs": runs.len(),
        "snapshot_edges": snapshot.edges.len(),
        "sources_per_candidate": distribution(&sources),
        "evidence_entries_per_candidate": distribution(&evidence),
        "evidence_artifacts_per_candidate": distribution(&artifacts),
    })
}

fn run_stage<T>(
    stages: &mut serde_json::Map<String, Value>,
    name: &str,
    body: impl FnOnce() -> anyhow::Result<T>,
    describe: impl FnOnce(&T) -> Value,
) {
    let started = Instant::now();
    let result = body();
    let took = ms(started.elapsed());
    let entry = match result {
        Ok(value) => json!({"ms": took, "result": describe(&value)}),
        Err(error) => json!({"ms": took, "error": format!("{error:#}")}),
    };
    stages.insert(name.to_owned(), entry);
}

/// One `input_guard` query replayed: rows, bytes streamed into the digest.
fn guard_query(conn: &Connection, query: &str, project: &str) -> anyhow::Result<(u64, u64)> {
    let mut hash = Sha256::new();
    let mut statement = conn.prepare(query)?;
    let columns = statement.column_count();
    let mut rows = statement.query([project])?;
    let (mut count, mut bytes) = (0u64, 0u64);
    while let Some(row) = rows.next()? {
        count += 1;
        for column in 0..columns {
            match row.get_ref(column)? {
                ValueRef::Null => hash.update(b"null"),
                ValueRef::Integer(value) => hash.update(value.to_le_bytes()),
                ValueRef::Real(value) => hash.update(value.to_bits().to_le_bytes()),
                ValueRef::Text(value) | ValueRef::Blob(value) => {
                    bytes += value.len() as u64;
                    hash.update(value);
                }
            }
        }
    }
    let _ = hash.finalize();
    Ok((count, bytes))
}

fn input_guard_breakdown(conn: &Connection, project: &str) -> Value {
    let entries: Vec<Value> = super::input_guard::QUERIES
        .iter()
        .enumerate()
        .map(|(index, query)| {
            let table = query
                .split("FROM ")
                .nth(1)
                .and_then(|rest| rest.split_whitespace().next())
                .unwrap_or("?");
            let started = Instant::now();
            let result = guard_query(conn, query, project);
            let took = ms(started.elapsed());
            match result {
                Ok((rows, bytes)) => {
                    json!({"index": index, "table": table, "rows": rows, "bytes": bytes, "ms": took})
                }
                Err(error) => {
                    json!({"index": index, "table": table, "ms": took, "error": format!("{error:#}")})
                }
            }
        })
        .collect();
    Value::Array(entries)
}

/// APPROXIMATION of `audit::verify_execution` (SQL + JSON parse only): the
/// real one needs the embedding outcomes, which this harness does not have.
fn verify_execution_sql_approx(
    conn: &Connection,
    project: &str,
    wanted: usize,
) -> anyhow::Result<Value> {
    let scope = format!("project:{project}");
    let ids: Vec<String> = {
        let mut statement = conn.prepare(
            "SELECT execution_id FROM ai_audit_events
              WHERE scope_id=?1 AND path_id='semantic_embedding_index'
                AND event_type='execution.started' LIMIT ?2",
        )?;
        let rows = statement.query_map(params![scope, wanted as i64], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<String>>>()?
    };
    let (mut total, mut max) = (Duration::ZERO, Duration::ZERO);
    let (mut rows_seen, mut payload_bytes) = (0u64, 0u64);
    for execution in &ids {
        let started = Instant::now();
        let mut statement = conn.prepare(
            "SELECT project_id,operation_id,path_id,event_type,payload
               FROM ai_audit_events WHERE scope_id=?1 AND execution_id=?2
              ORDER BY sequence LIMIT 6",
        )?;
        let rows = statement
            .query_map(params![scope, execution], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (_, _, _, _, raw) in &rows {
            rows_seen += 1;
            payload_bytes += raw.len() as u64;
            let _: Value = serde_json::from_str(raw)?;
        }
        let took = started.elapsed();
        total += took;
        max = max.max(took);
    }
    Ok(json!({
        "wanted": wanted,
        "sampled": ids.len(),
        "total_ms": ms(total),
        "mean_ms": round3(if ids.is_empty() { 0.0 } else { ms(total) / ids.len() as f64 }),
        "max_ms": ms(max),
        "rows": rows_seen,
        "payload_bytes": payload_bytes,
        "note": "approximation of verify_execution: SQL + JSON parse only, no value checks",
    }))
}

fn read_verified_evidence_stage(
    conn: &Connection,
    project: &str,
    plan: &NirIndexBuildPlan,
) -> Value {
    let (mut total, mut max) = (Duration::ZERO, Duration::ZERO);
    let (mut errors, mut empty, mut verified_items) = (0u64, 0u64, 0u64);
    let (mut artifacts_read, mut entries) = (0u64, 0u64);
    let mut per_call: Vec<(f64, usize, usize, usize)> = Vec::new();
    let mut first_error: Option<String> = None;
    for candidate in &plan.snapshot.candidates {
        artifacts_read += candidate.evidence_artifacts.len() as u64;
        entries += candidate.evidence.len() as u64;
        let started = Instant::now();
        let result = super::evidence::read_verified_evidence(conn, project, candidate);
        let took = started.elapsed();
        total += took;
        max = max.max(took);
        let verified = match result {
            Ok(items) => {
                if items.is_empty() {
                    empty += 1;
                }
                verified_items += items.len() as u64;
                items.len()
            }
            Err(error) => {
                errors += 1;
                first_error.get_or_insert_with(|| format!("{error:#}"));
                0
            }
        };
        per_call.push((
            ms(took),
            candidate.evidence_artifacts.len(),
            candidate.evidence.len(),
            verified,
        ));
    }
    per_call.sort_by(|a, b| b.0.partial_cmp(&a.0).expect("finite"));
    let calls = plan.snapshot.candidates.len();
    json!({
        "calls": calls,
        "total_ms": ms(total),
        "mean_ms": round3(if calls == 0 { 0.0 } else { ms(total) / calls as f64 }),
        "max_ms": ms(max),
        "errors": errors,
        "first_error": first_error,
        "empty_candidates": empty,
        "evidence_artifacts_read": artifacts_read,
        "evidence_entries": entries,
        "verified_items": verified_items,
        "slowest": per_call.iter().take(3).map(|(took, artifacts, entries, verified)| {
            json!({"ms": took, "artifacts": artifacts, "evidence_entries": entries, "verified": verified})
        }).collect::<Vec<_>>(),
    })
}

/// The read-only stages of production publish, in production order. Stage
/// errors are recorded, never propagated, so the caller always rolls back.
fn publish_read_stages(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
    plan: &NirIndexBuildPlan,
    control: &mut TimingControl,
) -> Value {
    let snapshot = &plan.snapshot;
    let mut stages = serde_json::Map::new();
    run_stage(
        &mut stages,
        "runtime_epoch",
        || runtime.current_epoch(conn),
        |epoch| json!({"matches_plan": *epoch == Ok(plan.runtime_epoch)}),
    );
    run_stage(
        &mut stages,
        "snapshot_current",
        || super::build::snapshot_current_with_control(conn, project, snapshot, &mut *control),
        |current| json!({"current": current}),
    );
    let mut parts = serde_json::Map::new();
    run_stage(
        &mut parts,
        "binding",
        || {
            let registered = matches!(
                super::binding::read(conn, project)?,
                super::binding::BindingRead::Registered(_)
            );
            let complete = super::binding::is_complete_registered(conn, project, super::INDEX_KEY)?;
            Ok((registered, complete))
        },
        |(registered, complete)| json!({"registered": registered, "complete": complete}),
    );
    run_stage(
        &mut parts,
        "roster_source",
        || super::source::read_eligibility_source_with_control(conn, project, &mut *control),
        |source| {
            json!({
                "revisions": source.revisions.len(),
                "digest_matches": source.digest == snapshot.roster_digest,
            })
        },
    );
    run_stage(
        &mut parts,
        "input_guard",
        || super::input_guard::read(conn, project, &mut *control),
        |digest| json!({"digest_matches": *digest == snapshot.input_guard}),
    );
    run_stage(
        &mut parts,
        "pending",
        || super::super::revision_eligibility::pending::read(conn, project, &snapshot.edges),
        |feed| json!({"ok": feed.is_ok(), "feed_matches": feed.as_ref().ok() == Some(&snapshot.feed)}),
    );
    run_stage(
        &mut parts,
        "evaluate_owned_edges",
        || {
            super::super::restore_rebuild::evaluate_owned_edges_from_db_in_tx_with_control(
                conn,
                project,
                &snapshot.edges,
                &mut *control,
            )
        },
        |observations| {
            let all_fresh = observations.iter().all(|o| {
                o.freshness == super::super::evaluator::EvidenceFreshness::Fresh
                    && o.build_action == super::super::evaluator::BuildAction::None
                    && o.reason_code.is_none()
            });
            json!({"edges": observations.len(), "all_fresh": all_fresh})
        },
    );
    stages.insert("snapshot_current_parts".to_owned(), Value::Object(parts));
    run_stage(
        &mut stages,
        "audit_chain",
        || crate::ai_audit::verify_ai_audit_chain_for_scope(conn, Some(project), None),
        |verify| {
            json!({
                "ok": verify.ok,
                "verified_through_sequence": verify.verified_through_sequence,
                "broken_at_sequence": verify.broken_at_sequence,
            })
        },
    );
    stages.insert(
        "read_verified_evidence".to_owned(),
        read_verified_evidence_stage(conn, project, plan),
    );
    run_stage(
        &mut stages,
        "verify_execution_sql_approx",
        || verify_execution_sql_approx(conn, project, snapshot.candidates.len()),
        |value| value.clone(),
    );
    stages.insert(
        "input_guard_breakdown".to_owned(),
        input_guard_breakdown(conn, project),
    );
    Value::Object(stages)
}

/// Production publish shape: participant SQL scope -> BEGIN IMMEDIATE ->
/// read stages -> (here) ROLLBACK. Nothing is written.
fn measure_publish_reads(
    db: &Database,
    participant: &WorkspaceParticipant,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
    plan: &NirIndexBuildPlan,
) -> Value {
    crate::irb_timing::reset();
    let scope_started = Instant::now();
    let scoped = db.with_participant_sql_scope(participant, |conn| {
        let mut control = TimingControl::default();
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let tx_started = Instant::now();
        let measured = publish_read_stages(conn, runtime, project, plan, &mut control);
        let tx_ms = ms(tx_started.elapsed());
        let rollback = conn.execute_batch("ROLLBACK");
        let autocommit_after = conn.is_autocommit();
        rollback?;
        Ok((measured, tx_ms, autocommit_after, control.checks))
    });
    let scope_ms = ms(scope_started.elapsed());
    let mut spans = serde_json::Map::new();
    for (name, calls, value) in crate::irb_timing::snapshot() {
        spans.insert(
            name.to_owned(),
            json!({"calls": calls, "total_ms": round3(value as f64 / 1e6)}),
        );
    }
    match scoped {
        Ok((measured, tx_ms, autocommit_after, checks)) => {
            let stage_ms = |name: &str| measured[name]["ms"].as_f64().unwrap_or(0.0);
            let evidence_ms = measured["read_verified_evidence"]["total_ms"]
                .as_f64()
                .unwrap_or(0.0);
            json!({
                "stages": measured,
                "production_read_stages_ms": round3(
                    stage_ms("runtime_epoch")
                        + stage_ms("snapshot_current")
                        + stage_ms("audit_chain")
                        + evidence_ms
                ),
                "tx_ms": tx_ms,
                "scope_ms": scope_ms,
                "autocommit_after_rollback": autocommit_after,
                "control_checks": checks,
                "spans": spans,
            })
        }
        Err(error) => json!({"error": format!("{error:#}"), "scope_ms": scope_ms, "spans": spans}),
    }
}

#[test]
#[ignore = "dev-only: needs GRIMODEX_IRB_TIMING_DB / GRIMODEX_IRB_TIMING_PROJECT"]
fn irb_prepare_timing() {
    let source = PathBuf::from(env_required("GRIMODEX_IRB_TIMING_DB"));
    let project = env_required("GRIMODEX_IRB_TIMING_PROJECT");
    let reps: usize = std::env::var("GRIMODEX_IRB_TIMING_REPS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1)
        .clamp(1, 3);
    let probe_period = Duration::from_millis(
        std::env::var("GRIMODEX_IRB_TIMING_PROBE_MS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(50),
    );
    let keep = std::env::var("GRIMODEX_IRB_TIMING_KEEP").as_deref() == Ok("1");

    let (dir, copy) = copy_database(&source);
    let db = Arc::new(Database::new(&copy).expect("open copy"));
    // Best effort and outside every timed region: a no-op for a database the
    // same code produced; a newer schema only prints a warning.
    if let Err(error) = db.migrate() {
        eprintln!("irb-timing: migrate on copy failed (continuing): {error:#}");
    }
    let runtime = NirChronicleIndexRuntime::new(&db, 1);

    let core = crate::WorkspaceLifecycleCore::new();
    core.set_ready(crate::LiveBinding::new(
        "/tmp/workspace",
        "workspace-1",
        1,
        1,
    ))
    .expect("ready workspace");
    let participant = core.begin_workspace_participant().expect("participant");

    let db_shape = json!({
        "ai_audit_events": count_rows(&db, "SELECT COUNT(*) FROM ai_audit_events", &project),
        "ai_audit_events_project": count_rows(
            &db,
            "SELECT COUNT(*) FROM ai_audit_events WHERE project_id = ?1",
            &project,
        ),
        "stage_receipts": count_rows(
            &db,
            "SELECT COUNT(*) FROM narrative_extraction_stage_receipts WHERE project_id = ?1",
            &project,
        ),
        "proposal_revisions": count_rows(
            &db,
            "SELECT COUNT(*) FROM narrative_proposal_revisions",
            &project,
        ),
        "nir1_vectors": count_rows(
            &db,
            "SELECT COUNT(*) FROM narrative_nir1_chronicle_vectors WHERE project_id = ?1",
            &project,
        ),
    });

    let sql_scale_value = sql_scale(&db, &project);
    let mut candidate_scale_value = Value::Null;
    let mut rep_results = Vec::new();
    for rep in 0..reps {
        // build_once's first transaction (scheduling hint).
        let hint_started = Instant::now();
        let rebuild_requested = db
            .with_participant_read_transaction(&participant, |conn| {
                runtime.rebuild_requested(conn, &project)
            })
            .map(|value| format!("{value:?}"))
            .unwrap_or_else(|error| format!("error: {error:#}"));
        let rebuild_requested_ms = ms(hint_started.elapsed());

        crate::irb_timing::reset();

        // Foreground probe: a short SELECT every `probe_period` through the
        // same connection mutex a foreground read waits on.
        let done = Arc::new(AtomicBool::new(false));
        let probe_origin = Instant::now();
        let probe = {
            let db = Arc::clone(&db);
            let done = Arc::clone(&done);
            thread::spawn(move || {
                let mut samples: Vec<(f64, f64)> = Vec::new();
                while !done.load(Ordering::Acquire) {
                    let started = Instant::now();
                    let at = started.duration_since(probe_origin).as_secs_f64() * 1000.0;
                    let result = db.with_conn(|conn| {
                        Ok(conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))?)
                    });
                    let rtt = started.elapsed().as_secs_f64() * 1000.0;
                    if result.is_ok() {
                        samples.push((at, rtt));
                    }
                    thread::sleep(probe_period);
                }
                samples
            })
        };
        // A few baseline samples before the connection is taken.
        thread::sleep(Duration::from_millis(250));

        let prepare_started = Instant::now();
        let window_start = prepare_started.duration_since(probe_origin).as_secs_f64() * 1000.0;
        let mut control = TimingControl::default();
        let outcome: anyhow::Result<(
            String,
            bool,
            usize,
            f64,
            Option<(usize, f64)>,
            Option<NirIndexBuildPlan>,
        )> = db.with_participant_read_transaction(&participant, |conn| {
            let variant: String;
            let mut fallback = false;
            let mut documents = 0usize;
            let mut plan: Option<NirIndexBuildPlan> = None;
            match prepare_chronicle_index_build_with_control(
                conn,
                &runtime,
                &project,
                &mut control,
            )? {
                NirIndexBuildRead::Ready {
                    plan: ready,
                    documents: docs,
                } => {
                    variant = "Ready".to_owned();
                    documents = docs.len();
                    plan = Some(ready);
                }
                NirIndexBuildRead::AlreadyUsable => {
                    fallback = true;
                    let runtime_epoch = runtime.current_epoch(conn)?;
                    match (
                        runtime_epoch,
                        read_snapshot_with_control(conn, &project, &mut control)?,
                    ) {
                        (Ok(runtime_epoch), Ok(snapshot)) => {
                            documents = snapshot.candidates.len();
                            variant = "AlreadyUsable+snapshot_direct".to_owned();
                            plan = Some(NirIndexBuildPlan {
                                project: project.clone(),
                                owner: runtime.owner(),
                                runtime_epoch,
                                snapshot,
                            });
                        }
                        (epoch, snapshot) => {
                            variant = format!(
                                "AlreadyUsable+snapshot_unavailable epoch={:?} snapshot={:?}",
                                epoch.err(),
                                snapshot.err()
                            );
                        }
                    }
                }
                NirIndexBuildRead::Unavailable { reason } => {
                    variant = format!("Unavailable({reason:?})");
                }
            }
            let prepare_ms = ms(prepare_started.elapsed());
            // build_once's reusable-embeddings step, when a cached model
            // identity can be derived from the vectors table.
            let reusable = match plan.as_ref() {
                Some(plan) => {
                    let identity: Option<NirEmbeddingIdentity> = conn
                        .query_row(
                            "SELECT model_id, artifact_sha256, tokenizer_sha256,
                                        embedding_dim, chunker_version
                                   FROM narrative_nir1_chronicle_vectors
                                  WHERE project_id = ?1 LIMIT 1",
                            [&project],
                            |row| {
                                Ok(NirEmbeddingIdentity {
                                    model_id: row.get(0)?,
                                    artifact_sha256: row.get(1)?,
                                    tokenizer_sha256: row.get(2)?,
                                    embedding_dim: usize::try_from(row.get::<_, i64>(3)?)
                                        .unwrap_or(0),
                                    chunker_version: row.get(4)?,
                                })
                            },
                        )
                        .optional()?;
                    match identity {
                        Some(identity) => {
                            let started = Instant::now();
                            let reused = read_reusable_chronicle_embeddings(
                                conn, &runtime, plan, &identity,
                            )?;
                            Some((reused.len(), ms(started.elapsed())))
                        }
                        None => None,
                    }
                }
                None => None,
            };
            Ok((variant, fallback, documents, prepare_ms, reusable, plan))
        });
        let prepare_tx_ms = ms(prepare_started.elapsed());
        let window_end = prepare_started
            .elapsed()
            .as_secs_f64()
            .mul_add(1000.0, window_start);
        // A few trailing samples after release.
        thread::sleep(Duration::from_millis(250));
        done.store(true, Ordering::Release);
        let samples = probe.join().expect("probe thread");

        let snapshot = crate::irb_timing::snapshot();
        let mut stages = serde_json::Map::new();
        let mut counters = serde_json::Map::new();
        let (mut audit_calls, mut audit_ns) = (0u64, 0u128);
        let (mut validate_calls, mut total_ns) = (0u64, 0u128);
        for (name, calls, value) in &snapshot {
            if COUNTERS.contains(name) {
                counters.insert((*name).to_owned(), json!(*value as u64));
                continue;
            }
            if name.starts_with("audit_count.") {
                audit_calls += calls;
                audit_ns += value;
            }
            if *name == "validate_receipt_lifecycle_binding" {
                validate_calls = *calls;
            }
            if *name == "snapshot.total" {
                total_ns = *value;
            }
            stages.insert(
                (*name).to_owned(),
                json!({"calls": calls, "total_ms": round3(*value as f64 / 1e6)}),
            );
        }
        let audit_share = (total_ns > 0).then(|| round3(audit_ns as f64 / total_ns as f64));

        let (variant, fallback, documents, prepare_ms, reusable, error, plan) = match outcome {
            Ok((variant, fallback, documents, prepare_ms, reusable, plan)) => (
                variant, fallback, documents, prepare_ms, reusable, None, plan,
            ),
            Err(error) => (
                "Error".to_owned(),
                false,
                0,
                0.0,
                None,
                Some(format!("{error:#}")),
                None,
            ),
        };
        // Publish-side read stages on the same plan, after the probe stopped
        // (see the header): read-only, rolled back.
        let publish_reads = match plan.as_ref() {
            Some(plan) => {
                if candidate_scale_value.is_null() {
                    let mut value = candidate_scale(plan);
                    value["roster_revisions"] = counters
                        .get("snapshot.roster_revisions")
                        .cloned()
                        .unwrap_or(Value::Null);
                    candidate_scale_value = value;
                }
                measure_publish_reads(&db, &participant, &runtime, &project, plan)
            }
            None => Value::Null,
        };
        rep_results.push(json!({
            "rep": rep,
            "variant": variant,
            "fallback_direct": fallback,
            "error": error,
            "rebuild_requested": rebuild_requested,
            "rebuild_requested_ms": rebuild_requested_ms,
            "prepare_ms": prepare_ms,
            "prepare_tx_ms": prepare_tx_ms,
            "documents": documents,
            "control_checks": control.checks,
            "validate_receipt_lifecycle_binding_calls": validate_calls,
            "audit_count_calls": audit_calls,
            "audit_count_ms": round3(audit_ns as f64 / 1e6),
            "audit_count_share": audit_share,
            "counters": counters,
            "stages": stages,
            "publishReads": publish_reads,
            "reusable_embeddings": reusable
                .map(|(count, took)| json!({"reused": count, "ms": took})),
            "foreground_probe": probe_summary(
                &samples,
                Some((window_start, window_end)),
                probe_period.as_secs_f64() * 1000.0,
            ),
        }));
    }

    drop(participant);
    drop(core);
    let line = json!({
        "tool": "irb-prepare-timing",
        "source_db": source.display().to_string(),
        "project": project,
        "probe_period_ms": probe_period.as_millis() as u64,
        "db": db_shape,
        "scale": {"sql": sql_scale_value, "candidates": candidate_scale_value},
        "reps": rep_results,
    });
    println!("IRB_TIMING_JSON {line}");
    drop(runtime);
    drop(db);
    if keep {
        eprintln!("irb-timing: kept copy at {dir:?}");
    } else {
        let _ = std::fs::remove_dir_all(&dir);
    }
}
