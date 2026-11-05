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
    Database,
};

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
        let outcome: anyhow::Result<(String, bool, usize, f64, Option<(usize, f64)>)> = db
            .with_participant_read_transaction(&participant, |conn| {
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
                Ok((variant, fallback, documents, prepare_ms, reusable))
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

        let (variant, fallback, documents, prepare_ms, reusable, error) = match outcome {
            Ok((variant, fallback, documents, prepare_ms, reusable)) => {
                (variant, fallback, documents, prepare_ms, reusable, None)
            }
            Err(error) => (
                "Error".to_owned(),
                false,
                0,
                0.0,
                None,
                Some(format!("{error:#}")),
            ),
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
