//! The candidate-loop Freshness reads (DR-IRB-6) never change what a prepare
//! decides: they only skip reading the project's Scope authority and a Run's
//! sealed documents again for another candidate of the same read snapshot.
use std::{collections::BTreeMap, io::Read as _, path::PathBuf};

use flate2::read::GzDecoder;
use grimodex_core::{
    narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
    narrative_scope_dependency_projection::ScopeDependencyIdentity,
};
use rusqlite::Connection;
use serde_json::Value;

use super::{source::read_eligibility_source, test_support::Fixture};
use crate::{
    narrative_extraction::{
        nir1_capacity::project_read_probe::{self, Read},
        nir1_entity_relation_index::{GraphWorkControl, GraphWorkStage},
        project_scope_authority::load_live_project_scope_authority,
        retrieval_admission::build::{
            finalize_build_candidate_with_control, preflight_build_candidate,
            BuildCandidatePreflight,
        },
        scene_scope::{preload_material_scene_scopes, MaterialSceneScopeCache},
        scope_authority_runtime::load_sealed_snapshot_document_bindings_in_tx,
        source_revision::{
            resolve_source_revision_with_control_and_reads, validation_terminated,
            CandidateFreshnessReads, ValidationTerminationReason,
        },
    },
    Database,
};

/// The cold database of two approved children, each in its own Run.
struct TwoRuns {
    db: Database,
    path: PathBuf,
    manifest: Value,
}

impl TwoRuns {
    fn new() -> Self {
        let mut bytes = Vec::new();
        GzDecoder::new(
            include_bytes!("../../../tests/support/nir1-two-window-cold.db.gz").as_slice(),
        )
        .read_to_end(&mut bytes)
        .expect("two-window cold fixture");
        let path = std::env::temp_dir().join(format!(
            "nir1-freshness-share-two-runs-{}.db",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, bytes).expect("private copy");
        let db = Database::new(&path).expect("open private copy");
        db.migrate().expect("migrate private copy");
        let manifest = serde_json::from_str(include_str!(
            "../../../tests/support/nir1-two-window-cold.json"
        ))
        .expect("provenance");
        Self { db, path, manifest }
    }

    fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }

    fn run(&self, index: usize) -> String {
        self.manifest["normalApprovedChildren"][index]["runId"]
            .as_str()
            .expect("run")
            .to_owned()
    }
}

impl Drop for TwoRuns {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// How the finalize loop reaches the Scope-dependency Sources.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Sharing {
    /// `reads: None`, the path every other caller takes.
    Without,
    /// New reads for every candidate: nothing is shared between candidates.
    PerCandidate,
    /// One reads for the whole loop, as the prepare does.
    Shared,
}

const ALL: [Sharing; 3] = [Sharing::Without, Sharing::PerCandidate, Sharing::Shared];

/// A write that changes no input of any decision.
const PROBE_WRITE: &str = "INSERT INTO temp.share_probe VALUES (1)";

/// Records every `control.check`; stops (as a cancelled owner would) at the
/// `stop_at`-th and applies a statement to the connection at the `write_at`-th.
struct Observed<'a> {
    log: Vec<String>,
    stop_at: Option<usize>,
    write: Option<(&'a Connection, usize, &'a str)>,
}

impl GraphWorkControl for Observed<'_> {
    fn check(&mut self, stage: GraphWorkStage) -> anyhow::Result<()> {
        self.log.push(format!("{stage:?}"));
        let n = self.log.len();
        if let Some((conn, at, sql)) = self.write {
            if n == at {
                conn.execute(sql, [])?;
            }
        }
        if self.stop_at == Some(n) {
            return Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "stopped by the test owner",
            ));
        }
        Ok(())
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

/// What the prepare holds when it enters its finalize loop.
struct Prepared {
    authority: NarrativeProjectScopeAuthorityV1,
    cache: MaterialSceneScopeCache,
    preflights: Vec<BuildCandidatePreflight>,
}

/// The prepare's own steps before the finalize loop (`read_snapshot_with_control`).
fn prepare(tx: &Connection, project: &str) -> Prepared {
    let authority = load_live_project_scope_authority(
        tx,
        project,
        &format!("project:scope-authority:{project}"),
    )
    .expect("live scope");
    let roster = read_eligibility_source(tx, project).expect("roster");
    let mut preflights = Vec::new();
    for revision in &roster.revisions {
        if let Ok(preflight) =
            preflight_build_candidate(tx, project, revision, &authority).expect("preflight")
        {
            preflights.push(preflight);
        }
    }
    let keys = preflights
        .iter()
        .flat_map(|preflight| preflight.material_source_keys.iter().cloned())
        .collect::<Vec<_>>();
    let cache = preload_material_scene_scopes(tx, project, &keys).expect("material scopes");
    Prepared {
        authority,
        cache,
        preflights,
    }
}

/// One finalize loop: its decisions (one line per candidate, the error that
/// ends the loop last), the checks the control saw, and the project reads.
struct Run {
    lines: Vec<String>,
    log: Vec<String>,
    reads: BTreeMap<Read, usize>,
}

impl Run {
    fn reads(&self, read: Read) -> usize {
        self.reads.get(&read).copied().unwrap_or(0)
    }

    fn admitted(&self) -> usize {
        self.lines
            .iter()
            .filter(|line| line.starts_with("Ok(BuildCandidate"))
            .count()
    }
}

fn finalize_loop(
    conn: &mut Connection,
    project: &str,
    prepared: Prepared,
    sharing: Sharing,
    control: &mut Observed<'_>,
) -> Run {
    let Prepared {
        authority,
        cache,
        preflights,
    } = prepared;
    let mut lines = Vec::new();
    let ((), reads) = project_read_probe::recording(|| {
        let mut shared = CandidateFreshnessReads::default();
        for preflight in preflights {
            if let Err(error) = control.check(GraphWorkStage::Row) {
                lines.push(format!("error: {error:#}"));
                break;
            }
            let mut own = CandidateFreshnessReads::default();
            let reads = match sharing {
                Sharing::Without => None,
                Sharing::PerCandidate => Some(&mut own),
                Sharing::Shared => Some(&mut shared),
            };
            match finalize_build_candidate_with_control(
                conn, project, &authority, preflight, &cache, control, reads,
            ) {
                Ok(decision) => lines.push(format!("{decision:?}")),
                Err(error) => {
                    lines.push(format!("error: {error:#}"));
                    break;
                }
            }
        }
    });
    Run {
        lines,
        log: std::mem::take(&mut control.log),
        reads,
    }
}

#[derive(Clone, Copy, Default)]
struct Plan<'a> {
    /// Statement applied after the prepare steps and before the loops.
    tamper: &'a str,
    stop_at: Option<usize>,
    write_at: Option<usize>,
    /// What the write at `write_at` executes; empty is [`PROBE_WRITE`].
    write_sql: &'a str,
    /// Schema statement applied after `tamper` (it changes no row, so it is
    /// not required to).
    tamper_ddl: &'a str,
}

/// The finalize loop in each way of sharing, in one transaction (rolled back):
/// every way prepares first, then the tamper is applied, so a candidate that
/// passed the preflight meets the changed database in its Freshness. Each way
/// runs in its own savepoint that is rolled back, so a write made by the
/// control reaches only the way that made it.
fn runs(db: &Database, project: &str, plan: Plan<'_>) -> Vec<Run> {
    db.with_conn_mut(|conn| {
        let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
        tx.execute_batch("CREATE TEMP TABLE share_probe(x)")?;
        let prepared = ALL
            .iter()
            .map(|_| prepare(&tx, project))
            .collect::<Vec<_>>();
        if !plan.tamper.is_empty() {
            let changed = tx.execute(plan.tamper, [])?;
            anyhow::ensure!(changed > 0, "tamper must change a row: {}", plan.tamper);
        }
        if !plan.tamper_ddl.is_empty() {
            tx.execute_batch(plan.tamper_ddl)?;
        }
        let writer = crate::test_support::same_handle_writer(&tx);
        let runs = ALL
            .iter()
            .zip(prepared)
            .map(|(sharing, prepared)| {
                let write_sql = if plan.write_sql.is_empty() {
                    PROBE_WRITE
                } else {
                    plan.write_sql
                };
                let mut control = Observed {
                    log: Vec::new(),
                    stop_at: plan.stop_at,
                    write: plan.write_at.map(|at| (&writer, at, write_sql)),
                };
                tx.execute_batch("SAVEPOINT way")?;
                let run = finalize_loop(&mut tx, project, prepared, *sharing, &mut control);
                tx.execute_batch("ROLLBACK TO way; RELEASE way")?;
                Ok(run)
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        tx.rollback()?;
        Ok(runs)
    })
    .expect("finalize loops")
}

fn assert_same_decisions(runs: &[Run], what: &str) {
    for (run, sharing) in runs.iter().zip(ALL).skip(1) {
        assert_eq!(run.lines, runs[0].lines, "{what}: decisions, {sharing:?}");
        assert_eq!(run.log, runs[0].log, "{what}: control.check, {sharing:?}");
    }
}

/// The `control.check` positions (1-based) a scan visits instead of every one.
/// A scan is a finalize loop in three ways of sharing per position (and three
/// prepares), which makes the scans the slowest tests of this module in a debug
/// build, so they visit: the first and the last position; around each candidate
/// boundary (the `Row` check that starts a candidate) the position before, the
/// boundary and the one after it; in the candidate's first edge (the checks of
/// a candidate run Source x5, Edge x2 per edge) the first Edge check and the
/// first check of the second edge; and every `SCAN_STEP`-th position, to land
/// inside the later edges. That covers every kind of stage change (Row to
/// Source, Source to Edge, Edge to Source, Edge to Row) at both candidates.
const SCAN_STEP: usize = 30;

fn scanned_positions(log: &[String]) -> Vec<usize> {
    let total = log.len();
    let mut positions = std::collections::BTreeSet::from([1, total]);
    for (index, stage) in log.iter().enumerate() {
        let at = index + 1;
        if stage == "Row" {
            positions.extend(
                [at.wrapping_sub(1), at, at + 1, at + 6, at + 8]
                    .into_iter()
                    .filter(|p| (1..=total).contains(p)),
            );
        }
        if at % SCAN_STEP == 0 {
            positions.insert(at);
        }
    }
    positions.into_iter().collect()
}

/// How many Scope-dependency Sources the candidates' edges name, and in how
/// many Runs.
fn scope_edges(db: &Database) -> (usize, usize) {
    db.with_read_transaction(|tx| {
        Ok(tx.query_row(
            "SELECT COUNT(*), COUNT(DISTINCT owning_run_id) FROM narrative_dependency_edges
              WHERE consumer_kind='proposal-revision'
                AND source_object_identity LIKE 'scope-dependency:v1:%'",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? as usize,
                    row.get::<_, i64>(1)? as usize,
                ))
            },
        )?)
    })
    .expect("scope-dependency edges")
}

/// The two cold databases: a Run with two Roots, and two Runs.
fn each_fixture(check: impl Fn(&str, &Database, &str, &[String])) {
    let one = Fixture::new();
    let run = one.manifest["runId"].as_str().expect("run").to_owned();
    check("one Run", &one.db, one.project(), &[run]);
    let two = TwoRuns::new();
    check(
        "two Runs",
        &two.db,
        two.project(),
        &[two.run(0), two.run(1)],
    );
}

#[test]
fn sharing_the_reads_changes_neither_decisions_nor_checks() {
    each_fixture(|name, db, project, _| {
        let runs = runs(db, project, Plan::default());
        assert!(runs[0].admitted() >= 2, "{name}: {:?}", runs[0].lines);
        assert_same_decisions(&runs, name);
        assert!(!runs[0].log.is_empty());
    });
}

#[test]
fn the_loop_reads_the_scope_once_and_each_run_once_without_sharing_per_edge() {
    each_fixture(|name, db, project, run_ids| {
        let (edges, edge_runs) = scope_edges(db);
        assert!(edges >= 2, "{name}: the candidates name Scope dependencies");
        assert_eq!(edge_runs, run_ids.len(), "{name}");
        let runs = runs(db, project, Plan::default());
        let [without, per_candidate, shared] = &runs[..] else {
            panic!("three runs")
        };
        // One Scope-dependency edge per candidate: the ordinary path (and new
        // reads per candidate) reads the Scope authority and the Run's sealed
        // documents for every edge.
        for run in [without, per_candidate] {
            assert_eq!(run.reads(Read::AuthorityTree), edges, "{name}");
            assert_eq!(run.reads(Read::ScopeExtension), edges, "{name}");
            assert_eq!(run.reads(Read::SealedDocuments), edges, "{name}");
        }
        // The shared loop reads the Scope once and each Run once.
        assert_eq!(shared.reads(Read::AuthorityTree), 1, "{name}");
        assert_eq!(shared.reads(Read::ScopeExtension), 1, "{name}");
        assert_eq!(shared.reads(Read::SealedDocuments), run_ids.len(), "{name}");
    });
}

/// Each change, and whether it must show in the decisions. An invalid Scene
/// Scope binding only moves the Scope authority's extension digest (the
/// candidates' Scope dependencies are not bound to it), so it must read the
/// same with the Scope read collecting the bindings (shared) or not (ordinary),
/// and need not change a decision.
fn tampers(run_ids: &[String]) -> Vec<(&'static str, String, bool)> {
    vec![
        (
            "a Scene moved on (CurrentSourceNotFresh)",
            "UPDATE tree_nodes SET version = version + 1 WHERE node_type = 'scene'".into(),
            true,
        ),
        (
            "the Scope authority moved (Scene no longer live)",
            "UPDATE tree_nodes SET archived_at = '2026-11-06T00:00:00.000Z' \
             WHERE node_type = 'scene'"
                .into(),
            true,
        ),
        (
            "a Scene Scope binding made invalid (collect or not)",
            "UPDATE narrative_scene_scope_bindings SET source_token = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'".into(),
            false,
        ),
        (
            "a sealed corpus artifact altered (payloadDigest)",
            format!(
                "UPDATE narrative_extraction_artifacts SET payload_digest='sha256:tampered' \
                 WHERE run_id='{}' AND artifact_kind='source.snapshot@1'",
                run_ids[0]
            ),
            true,
        ),
        (
            "a Run's snapshot digest altered",
            format!(
                "UPDATE narrative_extraction_runs SET snapshot_digest='sha256:tampered' \
                 WHERE id='{}'",
                run_ids[run_ids.len() - 1]
            ),
            true,
        ),
    ]
}

#[test]
fn a_changed_source_gives_the_same_decisions_with_or_without_sharing() {
    each_fixture(|name, db, project, run_ids| {
        let baseline = runs(db, project, Plan::default());
        for (what, sql, reaches) in tampers(run_ids) {
            let plan = Plan {
                tamper: &sql,
                ..Plan::default()
            };
            let tampered = runs(db, project, plan);
            assert_same_decisions(&tampered, &format!("{name}, {what}"));
            if reaches {
                assert_ne!(
                    tampered[0].lines, baseline[0].lines,
                    "{name}, {what}: the change must reach the decision"
                );
            }
        }
    });
}

/// A Run whose sealed documents cannot be verified fails every candidate of the
/// Run the same way, however many there are: the failure is read again for each
/// (only a success is kept), while the Scope read it never reached is not.
#[test]
fn a_failed_sealed_read_is_not_kept_for_the_next_candidate() {
    let f = Fixture::new();
    let run = f.manifest["runId"].as_str().expect("run").to_owned();
    let (edges, _) = scope_edges(&f.db);
    assert!(edges >= 2);
    let sql = format!(
        "UPDATE narrative_extraction_artifacts SET payload_digest='sha256:tampered' \
         WHERE run_id='{run}' AND artifact_kind='source.snapshot@1'"
    );
    let plan = Plan {
        tamper: &sql,
        ..Plan::default()
    };
    let runs = runs(&f.db, f.project(), plan);
    assert_same_decisions(&runs, "sealed corpus altered");
    assert_eq!(runs[0].admitted(), 0, "{:?}", runs[0].lines);
    assert!(
        runs[0]
            .lines
            .iter()
            .all(|line| line.contains("CurrentSourceUnavailable")),
        "{:?}",
        runs[0].lines
    );
    let shared = &runs[2];
    assert_eq!(
        shared.reads(Read::SealedDocuments),
        edges,
        "read again for every edge"
    );
    assert_eq!(
        shared.reads(Read::AuthorityTree),
        1,
        "the Scope read was a success"
    );
}

/// A Run that fails does not change the decision of a Run that does not.
#[test]
fn a_failing_run_leaves_the_other_run_of_the_same_loop_as_it_was() {
    let f = TwoRuns::new();
    let sql = format!(
        "UPDATE narrative_extraction_runs SET snapshot_digest='sha256:tampered' WHERE id='{}'",
        f.run(0)
    );
    let baseline = runs(&f.db, f.project(), Plan::default());
    let plan = Plan {
        tamper: &sql,
        ..Plan::default()
    };
    let runs = runs(&f.db, f.project(), plan);
    assert_same_decisions(&runs, "one Run broken");
    assert_eq!(runs[0].admitted(), 1, "{:?}", runs[0].lines);
    let kept = runs[0]
        .lines
        .iter()
        .position(|line| line.starts_with("Ok(BuildCandidate"))
        .expect("the intact Run's candidate");
    assert_eq!(runs[0].lines[kept], baseline[0].lines[kept]);
}

/// The sequence of `control.check` calls is the same however the reads are
/// shared, and a stop at any of the scanned positions (see
/// [`scanned_positions`]) ends the loop at the same place with the same error.
#[test]
fn a_stop_at_any_check_ends_the_loop_at_the_same_place() {
    each_fixture(|name, db, project, _| {
        let log = runs(db, project, Plan::default())[0].log.clone();
        assert!(log.len() >= 10, "{name}: {}", log.len());
        for stop in scanned_positions(&log) {
            let plan = Plan {
                stop_at: Some(stop),
                ..Plan::default()
            };
            let runs = runs(db, project, plan);
            assert_same_decisions(&runs, &format!("{name}, stop at {stop}"));
            assert_eq!(runs[0].log.len(), stop, "{name}: the loop ends at the stop");
            let last = runs[0].lines.last().expect("a line");
            assert!(
                last.starts_with("error: ") && last.contains("stopped by the test owner"),
                "{name}, stop at {stop}: {last}"
            );
        }
    });
}

/// DR-IRB-6's contract is that a `control.check` does not write to the
/// connection. A control that does is detected by `total_changes()`: the reads
/// are dropped and read again, and the decisions are still those of the
/// ordinary path. (Scanned positions: see [`scanned_positions`]. The write here
/// changes no input of a decision; the next test writes one that does.)
#[test]
fn a_write_during_a_check_discards_the_shared_reads() {
    each_fixture(|name, db, project, run_ids| {
        let without = runs(db, project, Plan::default());
        let (edges, _) = scope_edges(db);
        let mut authority_reads = std::collections::BTreeSet::new();
        for at in scanned_positions(&without[0].log) {
            let plan = Plan {
                write_at: Some(at),
                ..Plan::default()
            };
            let runs = runs(db, project, plan);
            assert_same_decisions(&runs, &format!("{name}, write at {at}"));
            assert_eq!(runs[0].lines, without[0].lines, "{name}: a write elsewhere");
            let shared = &runs[2];
            authority_reads.insert(shared.reads(Read::AuthorityTree));
            assert!(shared.reads(Read::SealedDocuments) <= edges);
            assert!(shared.reads(Read::SealedDocuments) >= run_ids.len());
        }
        assert_eq!(
            authority_reads.into_iter().collect::<Vec<_>>(),
            vec![1, edges],
            "{name}: a write between two candidates makes the next one read the Scope again"
        );
    });
}

/// A control that writes an input of the decisions, at the start of the loop
/// and between the two candidates: the three ways decide the same, and the
/// shared reads show the changed value (the write is not hidden by a memo made
/// before it).
#[test]
fn a_write_of_an_input_during_a_check_is_seen_by_the_shared_reads() {
    let writes = [
        (
            "the Scope authority moves (every Scene archived)",
            "UPDATE tree_nodes SET archived_at = '2026-11-06T00:00:00.000Z' \
             WHERE node_type = 'scene'",
            true,
        ),
        (
            "a Scene moves on",
            "UPDATE tree_nodes SET version = version + 1 WHERE node_type = 'scene'",
            false,
        ),
    ];
    each_fixture(|name, db, project, _| {
        let without = runs(db, project, Plan::default());
        let rows = without[0]
            .log
            .iter()
            .enumerate()
            .filter(|(_, stage)| *stage == "Row")
            .map(|(index, _)| index + 1)
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 2, "{name}: two candidates, {rows:?}");
        let (edges, _) = scope_edges(db);
        for (what, sql, moves_scope) in writes {
            // At the first check: before anything is read. At the second
            // candidate's boundary: after the first candidate's reads were
            // shared and kept.
            for at in [rows[0], rows[1]] {
                let plan = Plan {
                    write_at: Some(at),
                    write_sql: sql,
                    ..Plan::default()
                };
                let runs = runs(db, project, plan);
                let which = format!("{name}, {what}, write at {at}");
                assert_same_decisions(&runs, &which);
                let first = at == rows[0];
                assert_eq!(
                    runs[0].lines[0] == without[0].lines[0],
                    !first,
                    "{which}: the first candidate sees the write only if it was made before it"
                );
                assert_ne!(
                    runs[0].lines[1], without[0].lines[1],
                    "{which}: the second candidate sees the write"
                );
                let shared = &runs[2];
                assert_eq!(shared.lines, runs[0].lines, "{which}");
                if moves_scope && !first {
                    assert_eq!(
                        shared.reads(Read::AuthorityTree),
                        edges,
                        "{which}: the Scope is read again after the write"
                    );
                }
            }
        }
    });
}

/// An autocommit connection has no snapshot to share: the ordinary path (whose
/// own savepoint makes one) decides, exactly as it does without reads.
#[test]
fn an_autocommit_connection_shares_nothing() {
    let f = Fixture::new();
    let project = f.project().to_owned();
    let (edges, _) = scope_edges(&f.db);
    let mut results = Vec::new();
    for sharing in [Sharing::Without, Sharing::Shared] {
        let prepared =
            f.db.with_read_transaction(|tx| Ok(prepare(tx, &project)))
                .expect("prepare");
        let run =
            f.db.with_conn_mut(|conn| {
                assert!(conn.is_autocommit());
                let mut control = Observed {
                    log: Vec::new(),
                    stop_at: None,
                    write: None,
                };
                Ok(finalize_loop(
                    conn,
                    &project,
                    prepared,
                    sharing,
                    &mut control,
                ))
            })
            .expect("autocommit loop");
        results.push(run);
    }
    assert_eq!(results[0].lines, results[1].lines);
    assert_eq!(results[0].log, results[1].log);
    assert!(results[0].admitted() >= 2, "{:?}", results[0].lines);
    assert!(results.iter().all(|run| run
        .lines
        .iter()
        .all(|line| !line.contains("TRANSACTION_REQUIRED"))));
    assert_eq!(results[1].reads(Read::AuthorityTree), edges);
    assert_eq!(results[1].reads(Read::SealedDocuments), edges);
}

/// The reads belong to one loop of one transaction: the next prepare reads the
/// database as it then is.
#[test]
fn the_next_prepare_does_not_see_the_previous_prepares_reads() {
    let f = Fixture::new();
    let project = f.project().to_owned();
    let prepare = || {
        f.db.with_read_transaction(|tx| {
            Ok(super::build::read_snapshot(tx, &project)?
                .map(|snapshot| snapshot.candidates.len())
                .map_err(|reason| format!("{reason:?}")))
        })
        .expect("prepare")
    };
    let before = prepare();
    assert!(matches!(before, Ok(count) if count >= 2), "{before:?}");
    assert_eq!(prepare(), before, "an identical prepare decides the same");
    f.db.with_conn(|conn| {
        let changed = conn.execute(
            "UPDATE tree_nodes SET version = version + 1 WHERE node_type = 'scene'",
            [],
        )?;
        anyhow::ensure!(changed > 0);
        Ok(())
    })
    .expect("durable change between prepares");
    let after = prepare();
    assert_ne!(
        after, before,
        "the second prepare sees the change: {after:?}"
    );
}

/// A Scope read that fails (a tree the Scope authority rejects, which the
/// preflight of the same candidates did not see) is not kept: every candidate
/// reads it again and fails the same way as without sharing.
#[test]
fn a_failed_scope_read_is_not_kept_for_the_next_candidate() {
    // A Scene that owns a live child: `NEX_PROJECT_SCOPE_AUTHORITY_TREE_INVALID`.
    let sql = "UPDATE tree_nodes SET parent_id = \
                   (SELECT id FROM tree_nodes WHERE node_type = 'scene' ORDER BY id LIMIT 1) \
                WHERE id = \
                   (SELECT id FROM tree_nodes WHERE node_type = 'scene' ORDER BY id DESC LIMIT 1)";
    each_fixture(|name, db, project, _| {
        let (edges, _) = scope_edges(db);
        let plan = Plan {
            tamper: sql,
            ..Plan::default()
        };
        let runs = runs(db, project, plan);
        assert_same_decisions(&runs, &format!("{name}, a tree the Scope rejects"));
        assert_eq!(runs[0].admitted(), 0, "{name}: {:?}", runs[0].lines);
        for run in &runs {
            assert_eq!(
                run.reads(Read::AuthorityTree),
                edges,
                "{name}: a failed Scope read is made again for every edge"
            );
        }
    });
}

/// Reads are for one project: a call for another project discards them, so
/// each project's result is what the ordinary path gives, in either order.
#[test]
fn reads_first_used_for_one_project_are_not_used_for_another() {
    let f = Fixture::new();
    let project = f.project().to_owned();
    let other = "not-the-fixture-project";
    let (run, key) =
        f.db.with_read_transaction(|tx| {
            Ok(tx.query_row(
                "SELECT owning_run_id, source_object_identity FROM narrative_dependency_edges
                  WHERE consumer_kind='proposal-revision'
                    AND source_object_identity LIKE 'scope-dependency:v1:%' LIMIT 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )?)
        })
        .expect("a Scope-dependency edge");
    let resolve =
        |conn: &mut Connection, project: &str, reads: Option<&mut CandidateFreshnessReads>| {
            let mut control = Observed {
                log: Vec::new(),
                stop_at: None,
                write: None,
            };
            resolve_source_revision_with_control_and_reads(
                conn,
                project,
                &run,
                "scope-dependency-projection-v1",
                &key,
                &mut control,
                reads,
            )
            .map(|current| format!("{current:?}"))
            .map_err(|error| format!("{error:#}"))
        };
    let (ordinary, ordinary_other, sequence, reads) =
        f.db.with_read_transaction(|tx| {
            let ordinary = resolve(tx, &project, None);
            let ordinary_other = resolve(tx, other, None);
            let mut shared = CandidateFreshnessReads::default();
            let ((sequence, ()), reads) = project_read_probe::recording(|| {
                let sequence = [
                    resolve(tx, &project, Some(&mut shared)),
                    resolve(tx, &project, Some(&mut shared)),
                    resolve(tx, other, Some(&mut shared)),
                    resolve(tx, &project, Some(&mut shared)),
                ];
                (sequence, ())
            });
            Ok((ordinary, ordinary_other, sequence, reads))
        })
        .expect("resolutions");
    assert!(ordinary.is_ok(), "{ordinary:?}");
    assert!(ordinary_other.is_err(), "{ordinary_other:?}");
    assert_eq!(sequence[0], ordinary);
    assert_eq!(sequence[1], ordinary);
    assert_eq!(sequence[2], ordinary_other, "not the first project's Scope");
    assert_eq!(sequence[3], ordinary, "not the other project's reads");
    // First project: read once and shared. Other project: its attempt reads
    // (and fails). First project again: the reads were discarded, so read again.
    assert_eq!(reads.get(&Read::AuthorityTree).copied(), Some(3));
}

/// Resolves a Scope-dependency Source as the finalize loop's edge evaluation
/// does, with or without the loop's reads; `Err` is the error's full text.
fn resolve_scope_dependency(
    conn: &mut Connection,
    project: &str,
    run: &str,
    key: &str,
    reads: Option<&mut CandidateFreshnessReads>,
) -> std::result::Result<String, String> {
    let mut control = Observed {
        log: Vec::new(),
        stop_at: None,
        write: None,
    };
    resolve_source_revision_with_control_and_reads(
        conn,
        project,
        run,
        "scope-dependency-projection-v1",
        key,
        &mut control,
        reads,
    )
    .map(|current| format!("{current:?}"))
    .map_err(|error| format!("{error:#}"))
}

/// The Scope-dependency Source key of a Run's candidate.
const SCOPE_DEPENDENCY_KEY_OF_RUN: &str =
    "SELECT source_object_identity FROM narrative_dependency_edges
      WHERE consumer_kind='proposal-revision'
        AND source_object_identity LIKE 'scope-dependency:v1:%'
        AND owning_run_id = ?1
      LIMIT 1";

/// One candidate whose edges name two Scope dependencies of the same Run. The
/// cold fixtures bind one per candidate, and a candidate's edge set is sealed in
/// its declaration digest, so a second edge cannot be added to them; the two
/// Sources are therefore resolved as the loop's edge evaluation resolves a
/// candidate's edges, one after the other with the same reads. The second
/// identity anchors on the Run's other sealed document. Both decide as the
/// ordinary path does, with one Scope read and one read of the Run's sealed
/// documents.
#[test]
fn two_scope_dependencies_of_one_run_in_one_candidate_read_the_run_once() {
    let f = TwoRuns::new();
    let project = f.project().to_owned();
    let (run, first_key, documents) =
        f.db.with_read_transaction(|tx| {
            for index in 0..2 {
                let run = f.run(index);
                let documents = load_sealed_snapshot_document_bindings_in_tx(tx, &project, &run)?;
                if documents.len() >= 2 {
                    let key = tx.query_row(SCOPE_DEPENDENCY_KEY_OF_RUN, [&run], |row| {
                        row.get::<_, String>(0)
                    })?;
                    return Ok((run, key, documents));
                }
            }
            anyhow::bail!("no Run of the fixture sealed two documents")
        })
        .expect("the Run with two sealed documents");
    let first = ScopeDependencyIdentity::from_source_key(&first_key).expect("identity");
    let other = documents
        .iter()
        .find(|document| document.document_ref != first.reveal_document_ref)
        .expect("the Run's other sealed document");
    let second = ScopeDependencyIdentity {
        reveal_document_ref: other.document_ref.clone(),
        reveal_scene_ref: format!("scene:{}", other.node_id),
        ..first.clone()
    };
    let second_key = second.source_key().expect("second key");
    assert_ne!(second_key, first_key);
    let (ordinary, shared, reads) =
        f.db.with_read_transaction(|tx| {
            let ordinary = [
                resolve_scope_dependency(tx, &project, &run, &first_key, None),
                resolve_scope_dependency(tx, &project, &run, &second_key, None),
            ];
            let mut loop_reads = CandidateFreshnessReads::default();
            let (shared, reads) = project_read_probe::recording(|| {
                [
                    resolve_scope_dependency(tx, &project, &run, &first_key, Some(&mut loop_reads)),
                    resolve_scope_dependency(
                        tx,
                        &project,
                        &run,
                        &second_key,
                        Some(&mut loop_reads),
                    ),
                ]
            });
            Ok((ordinary, shared, reads))
        })
        .expect("resolutions");
    assert!(ordinary[0].is_ok() && ordinary[1].is_ok(), "{ordinary:?}");
    assert_ne!(ordinary[0], ordinary[1], "two Scope dependencies");
    assert_eq!(shared, ordinary);
    assert_eq!(reads.get(&Read::AuthorityTree).copied(), Some(1));
    assert_eq!(reads.get(&Read::ScopeExtension).copied(), Some(1));
    assert_eq!(reads.get(&Read::SealedDocuments).copied(), Some(1));
}

/// The prepare (`read_snapshot`, whose finalize loop shares its reads) admits
/// exactly the candidates the loop without reads admits, with the same content.
#[test]
fn the_prepare_admits_what_the_loop_without_reads_admits() {
    each_fixture(|name, db, project, _| {
        let (admitted, lines) = db
            .with_read_transaction(|tx| {
                let snapshot = super::build::read_snapshot(tx, project)?
                    .unwrap_or_else(|reason| panic!("{name}: prepare unavailable: {reason:?}"));
                let admitted = snapshot
                    .candidates
                    .iter()
                    .map(|candidate| format!("Ok({candidate:?})"))
                    .collect::<Vec<_>>();
                let prepared = prepare(tx, project);
                let mut control = Observed {
                    log: Vec::new(),
                    stop_at: None,
                    write: None,
                };
                let run = finalize_loop(tx, project, prepared, Sharing::Without, &mut control);
                Ok((admitted, run.lines))
            })
            .expect("prepare and loop");
        assert!(admitted.len() >= 2, "{name}: {admitted:?}");
        let loop_admitted = lines
            .iter()
            .filter(|line| line.starts_with("Ok(BuildCandidate"))
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(admitted, loop_admitted, "{name}");
    });
}

/// Renames the table the Run's sealed documents are read from, under a
/// savepoint, so the next read of them is a storage error; `UNHIDE` undoes it.
const HIDE: &str = "SAVEPOINT hide; \
    ALTER TABLE narrative_extraction_artifacts RENAME TO hidden_extraction_artifacts";
const UNHIDE: &str = "ROLLBACK TO hide; RELEASE hide";

/// A storage error inside the shared path (the Run's sealed documents cannot be
/// read) is reported exactly as the ordinary path reports it, and is not kept:
/// with the table back, the same reads resolve again. The Scope read, which
/// succeeded before the error, is kept.
#[test]
fn a_storage_error_in_the_shared_path_is_the_ordinary_paths_error_and_is_not_kept() {
    let f = Fixture::new();
    let project = f.project().to_owned();
    let run = f.manifest["runId"].as_str().expect("run").to_owned();
    let key =
        f.db.with_read_transaction(|tx| {
            Ok(tx.query_row(SCOPE_DEPENDENCY_KEY_OF_RUN, [&run], |row| {
                row.get::<_, String>(0)
            })?)
        })
        .expect("a Scope-dependency edge");
    let (ordinary, ordinary_hidden, shared, reads) =
        f.db.with_conn_mut(|conn| {
            let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
            let ordinary = resolve_scope_dependency(&mut tx, &project, &run, &key, None);
            tx.execute_batch(HIDE)?;
            let ordinary_hidden = resolve_scope_dependency(&mut tx, &project, &run, &key, None);
            tx.execute_batch(UNHIDE)?;
            let mut loop_reads = CandidateFreshnessReads::default();
            let (shared, reads) = project_read_probe::recording(|| {
                tx.execute_batch(HIDE).expect("hide");
                let hidden =
                    resolve_scope_dependency(&mut tx, &project, &run, &key, Some(&mut loop_reads));
                tx.execute_batch(UNHIDE).expect("unhide");
                let again =
                    resolve_scope_dependency(&mut tx, &project, &run, &key, Some(&mut loop_reads));
                [hidden, again]
            });
            tx.rollback()?;
            Ok((ordinary, ordinary_hidden, shared, reads))
        })
        .expect("resolutions");
    assert!(ordinary.is_ok(), "{ordinary:?}");
    let hidden = ordinary_hidden.as_ref().expect_err("the table is gone");
    assert!(hidden.contains("no such table"), "{hidden}");
    assert_eq!(
        shared[0], ordinary_hidden,
        "the shared path reports the ordinary path's storage error"
    );
    assert_eq!(
        shared[1], ordinary,
        "a failed read is not kept: the next resolution reads again"
    );
    assert_eq!(
        reads.get(&Read::SealedDocuments).copied(),
        Some(2),
        "read (and failed), then read again"
    );
    assert_eq!(
        reads.get(&Read::AuthorityTree).copied(),
        Some(1),
        "the Scope read succeeded before the error and is kept"
    );
}

/// A storage error met by the first candidate's Freshness ends the finalize
/// loop at the same place with the same error, however the reads are shared.
#[test]
fn a_storage_error_ends_the_loop_the_same_way_however_the_reads_are_shared() {
    each_fixture(|name, db, project, _| {
        let plan = Plan {
            tamper_ddl: "ALTER TABLE narrative_extraction_artifacts \
                         RENAME TO hidden_extraction_artifacts",
            ..Plan::default()
        };
        let runs = runs(db, project, plan);
        assert_same_decisions(&runs, &format!("{name}, sealed documents unreadable"));
        assert_eq!(runs[0].admitted(), 0, "{name}: {:?}", runs[0].lines);
        assert_eq!(
            runs[0].lines.len(),
            1,
            "{name}: the error ends the loop at the first candidate: {:?}",
            runs[0].lines
        );
        let last = &runs[0].lines[0];
        assert!(
            last.starts_with("error: ") && last.contains("no such table"),
            "{name}: {last}"
        );
    });
}
