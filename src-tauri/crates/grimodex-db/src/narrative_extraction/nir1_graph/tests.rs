use super::*;
use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
use crate::narrative_extraction::nir1_entity_relation::{
    create_nir1_entity_relation_revision, read_nir1_entity_relation_revision,
    tests::{
        approve_typed_revision, bounded_writer_bundle, prepare_a3_scope_fixture, request,
        seed_run_and_catalog, writer_input_bytes,
    },
    Nir1EntityRelationRevisionRead,
};
use crate::narrative_extraction::nir1_entity_relation_index::{
    prepare_graph_index_build, publish_nir1_entity_relation_index_in_tx, read_eligibility_source,
};
use crate::narrative_extraction::{
    narrative_extraction_append_human_decision, AppendDecisionPayload,
};
use crate::state::{active_workspace_snapshot, ActiveWorkspace, WorkspaceState};
use crate::workspace_lifecycle::{
    AdmissionKind, AdmissionOutcome, AdmissionTicket, LiveBinding,
    WorkspaceLifecycleCompatibilityView, WorkspaceLifecycleCore,
};
use grimodex_core::narrative_nir1::{EntityRelationBundle, EvidenceInput, ScopeValue};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const PROJECT: &str = "default-project";
const STARTUP_REFUSAL_PROJECT_ID: &str = "nir1-project-that-does-not-exist";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Q2WorkerScenario {
    ReaderOnly,
    NativeOwner,
    #[cfg(target_os = "linux")]
    ChildEnvironment,
    ProjectedLease,
    CallerCancellation,
    #[cfg(target_os = "linux")]
    RequestWriteCancellation,
    #[cfg(target_os = "linux")]
    RequestWriteDeadline,
    #[cfg(target_os = "linux")]
    RequestWriteChildExit,
    RequestWriteQuarantine,
    StartupRegistrationRefused,
    PostAdmissionCrash,
    PostCommitNonzero,
    #[cfg(target_os = "linux")]
    ResultHeldChildLive,
    #[cfg(target_os = "linux")]
    ResultHeldExitProofUnobserved,
    #[cfg(target_os = "linux")]
    ResultHeldReaderJoinFailure,
    #[cfg(target_os = "linux")]
    ResultHeldReaderCompletionPending,
    #[cfg(target_os = "linux")]
    CommittedFrameWithoutEof,
    PartialTerminalMarker,
    PartialFrame,
    TrailingData,
    #[cfg(target_os = "linux")]
    RustOom,
    SqlStepsOverCap,
    FrameLengthOverLimit,
    SqliteNoMem,
    CleanupUnproved,
    CleanupUnprovedRestore,
    #[cfg(target_os = "linux")]
    CleanupUnprovedDuringTransition,
    #[cfg(target_os = "linux")]
    OwnerDeathHelper,
}

struct TestDirectory(PathBuf);
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Fixture {
    authority: Arc<WorkspaceAuthority>,
    lifecycle: WorkspaceLifecycleCore,
    revision: String,
    _directory: TestDirectory,
}

// Test maintenance admission only: production readers cannot mint this owner.
struct RegistrationOwner;
impl GraphWorkControl for RegistrationOwner {
    fn check(&mut self, _: GraphWorkStage) -> Result<()> {
        Ok(())
    }
    fn progress_callback(&self) -> Option<GraphProgressCallback> {
        Some(Arc::new(|| false))
    }
    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

impl Fixture {
    fn new() -> Result<Self> {
        Self::with_direction("directed")
    }

    fn with_direction(direction: &str) -> Result<Self> {
        Self::with_extra_relation(direction, false)
    }

    fn with_extra_relation(direction: &str, extra_relation: bool) -> Result<Self> {
        Self::build(direction, extra_relation, &[])
    }

    /// Root Scenes ordered after the fixture's own reading order. Scenes are
    /// part of the live Scope authority, so they precede the typed Revision
    /// that records it; pins may be added until registration.
    fn with_scenes(scenes: &[String]) -> Result<Self> {
        Self::build("directed", false, scenes)
    }

    fn build(direction: &str, extra_relation: bool, scenes: &[String]) -> Result<Self> {
        let directory = TestDirectory(
            std::env::temp_dir().join(format!("nir1-c-graph-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&directory.0)?;
        let db = crate::Database::new(&directory.0.join("grimodex.db"))?;
        db.migrate()?;
        seed_run_and_catalog(&db)?;
        prepare_a3_scope_fixture(&db)?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE codex_relations SET directionality=?1 WHERE id='nir1-edge'",
                [direction],
            )?;
            if extra_relation {
                conn.execute(
                    "INSERT INTO codex_relations
                     (id,project_id,from_codex_id,to_codex_id,relation_type,directionality,version,updated_at)
                     VALUES ('nir1-edge-b','default-project','nir1-alice','nir1-bob','related',?1,1,'2026-09-12T00:00:00Z')",
                    [direction],
                )?;
            }
            for (index, scene) in scenes.iter().enumerate() {
                conn.execute(
                    "INSERT INTO tree_nodes
                        (id, project_id, node_type, title, content, sort_order, updated_at)
                     VALUES (?1, ?2, 'scene', 'Pinned', '{}', ?3, '2026-10-13T00:00:00.000Z')",
                    params![scene, PROJECT, format!("z{index:04}")],
                )?;
            }
            Ok(())
        })?;
        run_incremental_freshness_cycle(&db)?;
        let mut typed = request(&db);
        for entity in &mut typed.bundle.entities {
            entity.scope.reading = ScopeValue::Exact {
                value: "scene:a3-source".into(),
            };
            entity.scope.phase = "draft".into();
        }
        typed.bundle.relations[0].directionality = direction.into();
        if extra_relation {
            let mut relation = typed.bundle.relations[0].clone();
            relation.edge_id = "nir1-edge-b".into();
            relation.relation_type = "related".into();
            relation.source_token = "v1@2026-09-12T00:00:00Z:relation:nir1-edge-b".into();
            typed.bundle.relations.push(relation);
        }
        let created = create_nir1_entity_relation_revision(&db, typed)?;
        approve_typed_revision(&db, "nir1-run", &created)?;
        let authority = WorkspaceAuthority::from_database_for_test(db, directory.0.clone())?;
        publish_graph_index(&authority)?;
        Ok(Self {
            authority,
            lifecycle: WorkspaceLifecycleCore::new(),
            revision: created["revisionId"].as_str().unwrap().to_owned(),
            _directory: directory,
        })
    }

    fn reader(&self) -> Result<Nir1GraphReader> {
        Nir1GraphReader::open(
            Arc::clone(&self.authority),
            self.lifecycle.begin_workspace_participant()?,
        )
    }

    fn registered_reader(&self) -> Result<Nir1GraphReader> {
        let mut reader = self.reader()?;
        assert!(reader.register_with_control(PROJECT, &mut RegistrationOwner)?);
        Ok(reader)
    }

    fn add_pins(&self, pins: &[(&str, &str)]) -> Result<()> {
        self.authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for (scene, entry) in pins {
                tx.execute(
                    "INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
                     VALUES (?1, ?2, '2026-10-13T00:00:01.000Z')",
                    params![scene, entry],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// The isolated worker's reader state over the authority connection,
    /// prepared as the worker binary prepares it. The connection is then
    /// query-only, so fixture writes must precede this call.
    fn worker_reader(&self) -> Result<Nir1GraphReader> {
        self.authority.db().with_conn(|conn| {
            conn.busy_timeout(Duration::ZERO)?;
            conn.execute_batch(
                "PRAGMA temp_store=MEMORY; PRAGMA cache_size=-128; PRAGMA mmap_size=0;
                 CREATE TEMP TABLE IF NOT EXISTS grimodex_connection_meta(
                     singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL
                 );",
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO temp.grimodex_connection_meta VALUES(1,?1)",
                [uuid::Uuid::new_v4().to_string()],
            )?;
            conn.execute_batch("PRAGMA query_only=ON")?;
            Ok(())
        })?;
        let mut reader = Nir1GraphReader::open_for_worker(
            Arc::clone(&self.authority),
            self.lifecycle.begin_workspace_participant()?,
        )?;
        ensure!(
            reader.register_with_worker_maintenance(PROJECT, || true)?,
            "worker registration was refused"
        );
        Ok(reader)
    }

    fn add_decoys(&self, count: usize, source: &str) -> Result<()> {
        self.authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for index in 0..count {
                tx.execute("INSERT INTO narrative_dependency_edges
                    (id,project_id,consumer_kind,consumer_key,source_object_identity,read_set_json,created_at)
                    VALUES (?1,?2,'graph-test-unrelated',?1,?3,'[]','2026-09-22T00:00:00Z')",
                    params![format!("graph-decoy-{index}"), PROJECT, source])?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Unrelated typed-family Revisions with their own payload and
    /// reverse-index edge, optionally decided. None names a seed-local entity.
    fn add_unrelated_payload_revisions(
        &self,
        start: usize,
        count: usize,
        decided: bool,
    ) -> Result<()> {
        self.authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let proposal_set: String = tx.query_row(
                "SELECT proposal.proposal_set_id FROM narrative_proposal_revisions revision
                   JOIN narrative_proposals proposal ON proposal.id=revision.proposal_id
                  WHERE revision.id=?1",
                [&self.revision],
                |row| row.get(0),
            )?;
            for index in start..start + count {
                let entity = format!("nir1-unrelated-payload-{index}");
                let proposal = format!("graph-unrelated-proposal-{index}");
                let revision = format!("graph-unrelated-revision-{index}");
                let payload = serde_json::json!({
                    "bundle": {
                        "entities": [{
                            "entityId": entity,
                            "evidence": [{ "quote": "unrelated payload ".repeat(8) }],
                        }],
                        "relations": [],
                    }
                })
                .to_string();
                tx.execute(
                    "INSERT INTO narrative_proposals
                        (id, proposal_set_id, proposal_key, kind, status, payload_json,
                         current_revision_id, created_at, updated_at)
                     VALUES (?1, ?2, ?1, 'graph-test-unrelated', 'accepted', '{}', ?3,
                             '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z')",
                    params![proposal, proposal_set, revision],
                )?;
                tx.execute(
                    "INSERT INTO narrative_proposal_revisions
                        (id, proposal_id, revision_number, payload_json, created_at, created_by)
                     VALUES (?1, ?2, 1, ?3, '2026-09-22T00:00:00Z', 'graph-test')",
                    params![revision, proposal, payload],
                )?;
                if decided {
                    tx.execute(
                        "INSERT INTO narrative_proposal_decisions
                            (id, proposal_id, revision_id, decision, decision_json, created_at,
                             created_by)
                         VALUES (?1, ?2, ?3, 'approve', '{}', '2026-09-22T00:00:00Z',
                                 'graph-test')",
                        params![
                            format!("graph-unrelated-decision-{index}"),
                            proposal,
                            revision
                        ],
                    )?;
                }
                tx.execute(
                    "INSERT INTO narrative_dependency_edges
                        (id, project_id, consumer_kind, consumer_key, source_object_identity,
                         read_set_json, created_at)
                     VALUES (?1, ?2, 'proposal-revision', ?3, ?4, '[]', '2026-09-22T00:00:00Z')",
                    params![
                        format!("graph-unrelated-edge-{index}"),
                        PROJECT,
                        revision,
                        format!("codex:{entity}")
                    ],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    /// Deterministic A2/A3 usage for the seed Revision: one progress callback
    /// per SQLite VM instruction, the same unit charged against QUERY_SQL_STEPS.
    fn seed_a2_a3_usage(&self) -> Result<SeedAdmissionUsage> {
        let conn = rusqlite::Connection::open_with_flags(
            self._directory.0.join("grimodex.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let steps = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counter = Arc::clone(&steps);
        crate::set_sqlite_progress_handler(
            &conn,
            1,
            Some(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )?;
        let a2 = super::input::preflight_revision(
            &conn,
            PROJECT,
            &self.revision,
            MAX_GRAPH_RECORDS,
            MAX_GRAPH_INPUT_BYTES,
        )?
        .ok_or_else(|| anyhow::anyhow!("seed Revision did not pass A2"))?;
        let a2_steps = steps.load(Ordering::Relaxed);
        let a3 = super::input::preflight_disclosure_with_payload_bytes(
            &conn,
            PROJECT,
            &self.revision,
            "nir1",
            a2.payload_bytes,
            MAX_GRAPH_RECORDS - a2.rows,
            MAX_GRAPH_INPUT_BYTES - a2.bytes,
        )?;
        let total_steps = steps.load(Ordering::Relaxed);
        crate::set_sqlite_progress_handler(&conn, 0, None::<fn() -> bool>)?;
        Ok(SeedAdmissionUsage {
            a2_steps,
            a3_steps: total_steps - a2_steps,
            a2_rows: a2.rows,
            a2_bytes: a2.bytes,
            a3_rows: a3.rows,
            a3_bytes: a3.bytes,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SeedAdmissionUsage {
    a2_steps: u64,
    a3_steps: u64,
    a2_rows: usize,
    a2_bytes: usize,
    a3_rows: usize,
    a3_bytes: usize,
}

const UNRELATED_REVISION_STEPS: [usize; 3] = [0, 600, 6_000];

fn seed_usage_with_unrelated_revisions(decided: bool) -> Result<Vec<SeedAdmissionUsage>> {
    let fixture = Fixture::new()?;
    let mut added = 0;
    let mut usage = Vec::new();
    for target in UNRELATED_REVISION_STEPS {
        fixture.add_unrelated_payload_revisions(added, target - added, decided)?;
        added = target;
        usage.push(fixture.seed_a2_a3_usage()?);
    }
    Ok(usage)
}

// CQ-2: seed-local A2/A3 cost must not follow unrelated workspace growth.
#[test]
fn unrelated_payload_revisions_do_not_change_seed_a2_a3_steps_or_admission() -> Result<()> {
    let undecided = seed_usage_with_unrelated_revisions(false)?;
    assert!(undecided[0].a2_steps > 0 && undecided[0].a3_steps > 0);
    assert_eq!(
        undecided,
        vec![undecided[0]; UNRELATED_REVISION_STEPS.len()]
    );

    let decided = seed_usage_with_unrelated_revisions(true)?;
    let admission =
        |usage: &SeedAdmissionUsage| (usage.a2_rows, usage.a2_bytes, usage.a3_rows, usage.a3_bytes);
    assert_eq!(admission(&decided[0]), admission(&undecided[0]));
    assert!(decided
        .iter()
        .all(|usage| admission(usage) == admission(&decided[0])));
    Ok(())
}

// CQ-2 acceptance: SCHEMA 42's Decision Revision index keeps the three
// Decision charges (A2 length, A3 global rows/bytes 7) on the seed Revision, so
// decided unrelated Revisions never change admission and steps do not grow with
// them. The one bounded difference is the B-tree end: a seek that stops at a
// following unrelated key takes one more loop check than a seek that stops at
// the end of the index, so the first unrelated Decision may add at most one
// step per Decision seek, and 600 -> 6,000 adds none.
#[test]
fn unrelated_decided_revisions_do_not_change_seed_a2_a3_steps() -> Result<()> {
    const A2_DECISION_SEEKS: u64 = 1;
    const A3_DECISION_SEEKS: u64 = 2;
    let decided = seed_usage_with_unrelated_revisions(true)?;
    let [none, some, many] = decided.as_slice() else {
        panic!("three measurements: {decided:?}");
    };
    assert!(none.a2_steps > 0 && none.a3_steps > 0);
    let admission =
        |usage: &SeedAdmissionUsage| (usage.a2_rows, usage.a2_bytes, usage.a3_rows, usage.a3_bytes);
    assert!(
        decided
            .iter()
            .all(|usage| admission(usage) == admission(none)),
        "{decided:?}"
    );
    assert_eq!(
        some, many,
        "Decision growth must not reach the seed's steps"
    );
    assert!(
        (none.a2_steps..=none.a2_steps + A2_DECISION_SEEKS).contains(&some.a2_steps)
            && (none.a3_steps..=none.a3_steps + A3_DECISION_SEEKS).contains(&some.a3_steps),
        "only the index-end boundary may differ: {decided:?}"
    );
    Ok(())
}

#[test]
#[ignore = "CQ-2 wall measurement only; wall time is not asserted"]
fn measure_seed_a2_a3_wall_with_unrelated_revisions() -> Result<()> {
    for decided in [false, true] {
        let fixture = Fixture::new()?;
        let mut added = 0;
        for target in UNRELATED_REVISION_STEPS {
            fixture.add_unrelated_payload_revisions(added, target - added, decided)?;
            added = target;
            let started = Instant::now();
            let usage = fixture.seed_a2_a3_usage()?;
            eprintln!(
                "CQ-2 seed A2/A3: unrelated={target}; decided={decided}; wall={:?}; {usage:?}",
                started.elapsed()
            );
        }
    }
    Ok(())
}

fn graph_request(seed: &str) -> Nir1GraphRequest {
    Nir1GraphRequest {
        project_id: PROJECT.into(),
        query_scene_id: "nir1".into(),
        seed_entity_id: seed.into(),
    }
}

// Functional contracts have their own generous deadline; production's 100ms
// limit is independently tested and deterministic exhaustion stays separate.
fn query(reader: &mut Nir1GraphReader, seed: &str) -> Result<Nir1GraphResponse> {
    reader.query_with_deadline(&graph_request(seed), Duration::from_secs(2), 100_000)
}

/// Measurement-only probe for the production deadline. Functional fixtures
/// use a generous deadline so their correctness assertions are not coupled to
/// HDD scheduling; this ignored test exercises the actual public reader path.
#[test]
fn worker_reader_uses_one_authority_connection_for_registration_and_query() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut owned_reader = fixture.reader()?;
    let registration_error = owned_reader
        .register_with_worker_maintenance(PROJECT, || true)
        .expect_err("worker registration must reject an independently-owned connection");
    assert!(registration_error
        .to_string()
        .contains("NIR1_GRAPH_WORKER_REQUIRES_BORROWED_CONNECTION"));
    let query_error = owned_reader
        .query_for_worker_with_maintenance(&graph_request("nir1-alice"))
        .expect_err("worker query must reject an independently-owned connection");
    assert!(query_error
        .to_string()
        .contains("NIR1_GRAPH_WORKER_REQUIRES_BORROWED_CONNECTION"));
    drop(owned_reader);

    fixture.authority.db().with_conn(|conn| {
        conn.busy_timeout(Duration::ZERO)?;
        conn.execute_batch(
            "PRAGMA temp_store=MEMORY; PRAGMA cache_size=-128; PRAGMA mmap_size=0;
             CREATE TEMP TABLE IF NOT EXISTS grimodex_connection_meta(
                 singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL
             );",
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO temp.grimodex_connection_meta VALUES(1,?1)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        conn.execute_batch("PRAGMA query_only=ON")?;
        Ok(())
    })?;

    let mut reader = Nir1GraphReader::open_for_worker(
        Arc::clone(&fixture.authority),
        fixture.lifecycle.begin_workspace_participant()?,
    )?;
    let scratch_scopes = std::cell::Cell::new(0);
    let mut registration_stage = Nir1GraphRegistrationStage::Maintenance;
    assert!(reader.register_with_worker_maintenance_diagnostic(
        PROJECT,
        &mut registration_stage,
        |operation: &mut dyn FnMut()| {
            scratch_scopes.set(scratch_scopes.get() + 1);
            operation();
            true
        },
        || true,
    )?);
    assert!(scratch_scopes.get() > 0);
    let response = reader.query_for_worker_with_maintenance_deadline(
        &graph_request("nir1-alice"),
        Duration::from_secs(2),
    )?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    assert!(response
        .graph
        .as_ref()
        .is_some_and(|graph| !graph.nodes.is_empty()));
    fixture.authority.db().with_conn(|conn| {
        assert!(conn.is_autocommit());
        conn.query_row(
            "SELECT 1 FROM temp.grimodex_connection_meta WHERE singleton=1",
            [],
            |_| Ok(()),
        )?;
        Ok(())
    })?;
    Ok(())
}

#[test]
fn worker_reader_restore_admitted_during_query_read_refuses_result() -> Result<()> {
    use rusqlite::hooks::{AuthAction, Authorization};
    use std::sync::atomic::{AtomicBool, Ordering};

    let fixture = Fixture::new()?;
    let original_binding = LiveBinding::new(
        fixture.authority.path().to_string_lossy(),
        format!("test-workspace:{}", fixture.authority.identity()),
        fixture.authority.identity(),
        0,
    )
    .with_main_database_file_identity(fixture.authority.main_database_file_identity()?);
    fixture.lifecycle.set_ready(original_binding.clone())?;
    fixture.authority.db().with_conn(|conn| {
        conn.busy_timeout(Duration::ZERO)?;
        conn.execute_batch(
            "PRAGMA temp_store=MEMORY; PRAGMA cache_size=-128; PRAGMA mmap_size=0;
             CREATE TEMP TABLE IF NOT EXISTS grimodex_connection_meta(
                 singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL
             );",
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO temp.grimodex_connection_meta VALUES(1,?1)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        conn.execute_batch("PRAGMA query_only=ON")?;
        Ok(())
    })?;

    let mut reader = Nir1GraphReader::open_for_worker(
        Arc::clone(&fixture.authority),
        fixture.lifecycle.begin_workspace_participant()?,
    )?;
    assert!(reader.register_with_worker_maintenance(PROJECT, || true)?);
    assert!(reader.registration.is_some());

    let restore_triggered = Arc::new(AtomicBool::new(false));
    let restore_result = Arc::new(Mutex::new(
        None::<std::result::Result<AdmissionOutcome, String>>,
    ));
    let triggered_for_authorizer = Arc::clone(&restore_triggered);
    let result_for_authorizer = Arc::clone(&restore_result);
    let lifecycle_for_authorizer = fixture.lifecycle.clone();
    fixture.authority.db().with_conn(|conn| {
        conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
            if matches!(
                context.action,
                AuthAction::Read {
                    table_name,
                    column_name,
                } if table_name.eq_ignore_ascii_case("narrative_dependency_edges")
                    && column_name.eq_ignore_ascii_case("source_object_identity")
            ) && !triggered_for_authorizer.swap(true, Ordering::AcqRel)
            {
                let outcome = lifecycle_for_authorizer
                    .begin_transition(AdmissionKind::Restore)
                    .map_err(|error| error.to_string());
                *result_for_authorizer
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(outcome);
            }
            Authorization::Allow
        }))?;
        Ok(())
    })?;

    let query_result = reader.query_for_worker_with_maintenance_deadline(
        &graph_request("nir1-alice"),
        Duration::from_secs(2),
    );
    fixture.authority.db().with_conn(|conn| {
        conn.authorizer(None::<fn(rusqlite::hooks::AuthContext<'_>) -> Authorization>)?;
        ensure!(
            conn.is_autocommit(),
            "Restore-interrupted query did not roll back"
        );
        Ok(())
    })?;
    let response = query_result?;
    assert!(
        restore_triggered.load(Ordering::Acquire),
        "query SQL read did not trigger Restore"
    );
    assert_eq!(response.status, "unavailable", "{:?}", response.reason);
    assert!(
        response.graph.is_none(),
        "Restore-interrupted query returned a Graph"
    );

    let restore_result = restore_result
        .lock()
        .map_err(|_| anyhow::anyhow!("Restore authorizer result lock poisoned"))?
        .take()
        .ok_or_else(|| anyhow::anyhow!("Restore authorizer did not record an outcome"))?;
    let restore_outcome = restore_result.map_err(anyhow::Error::msg)?;
    let restore_ticket = match restore_outcome {
        AdmissionOutcome::Admitted(ticket) => ticket,
        AdmissionOutcome::NotAdmitted { reason, .. } => {
            anyhow::bail!("Restore was not admitted during query SQL read: {reason:?}")
        }
    };
    assert_eq!(fixture.lifecycle.workspace_participant_count()?, 1);
    let exclusion_error = match fixture
        .lifecycle
        .physical_exclusive_for_ticket(&restore_ticket)
    {
        Err(error) => error,
        Ok(exclusive) => {
            drop(exclusive);
            anyhow::bail!("Restore obtained exclusivity while the borrowed reader was live")
        }
    };
    assert!(matches!(
        exclusion_error,
        crate::workspace_lifecycle::LifecycleError::ActiveOperations
    ));

    reader.close()?;
    assert_eq!(fixture.lifecycle.workspace_participant_count()?, 0);
    fixture.lifecycle.mark_transition_joined(&restore_ticket)?;
    let exclusive = fixture
        .lifecycle
        .physical_exclusive_for_ticket(&restore_ticket)?;
    drop(exclusive);
    fixture
        .lifecycle
        .complete_unchanged(&restore_ticket, original_binding)?;
    Ok(())
}

#[test]
fn worker_registration_is_not_published_when_scratch_seal_fails() -> Result<()> {
    use crate::narrative_maintenance_connection::try_lock_narrative_maintenance;
    use std::sync::atomic::{AtomicBool, Ordering};

    let fixture = Fixture::new()?;
    fixture.authority.db().with_conn(|conn| {
        conn.busy_timeout(Duration::ZERO)?;
        conn.execute_batch(
            "PRAGMA temp_store=MEMORY; PRAGMA cache_size=-128; PRAGMA mmap_size=0;
             CREATE TEMP TABLE IF NOT EXISTS grimodex_connection_meta(
                 singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL
             );",
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO temp.grimodex_connection_meta VALUES(1,?1)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        conn.execute_batch("PRAGMA query_only=ON")?;
        Ok(())
    })?;

    let mut reader = Nir1GraphReader::open_for_worker(
        Arc::clone(&fixture.authority),
        fixture.lifecycle.begin_workspace_participant()?,
    )?;
    let seal_called = AtomicBool::new(false);
    let outer_cleanup_proved = AtomicBool::new(false);
    let database = fixture.authority.db();
    let error = reader
        .register_with_worker_maintenance(PROJECT, || {
            seal_called.store(true, Ordering::Release);
            let clean = try_lock_narrative_maintenance(database)
                .ok()
                .flatten()
                .is_some_and(|conn| conn.is_autocommit());
            outer_cleanup_proved.store(clean, Ordering::Release);
            false
        })
        .expect_err("failed scratch sealing must prevent Registration publication");
    assert!(error
        .to_string()
        .contains("NIR1_GRAPH_WORKER_SCRATCH_SEAL_FAILED"));
    assert!(seal_called.load(Ordering::Acquire));
    assert!(outer_cleanup_proved.load(Ordering::Acquire));
    assert!(reader.registration.is_none());
    assert!(reader.pending_registration.is_none());

    let response = reader.query_for_worker_with_maintenance(&graph_request("nir1-alice"))?;
    assert_eq!(response.reason.as_deref(), Some("registration-required"));
    Ok(())
}

#[test]
fn worker_registration_observes_cancellation_during_postflight_identity() -> Result<()> {
    use crate::narrative_extraction::is_validation_terminated;
    use crate::narrative_maintenance_connection::{
        with_narrative_maintenance_graph_control, NarrativeMaintenanceGraphControlConfig,
    };
    use rusqlite::hooks::{AuthAction, Authorization};
    use std::sync::atomic::{AtomicU64, AtomicUsize};

    let fixture = Fixture::new()?;
    fixture.authority.db().with_conn(|conn| {
        conn.busy_timeout(Duration::ZERO)?;
        conn.execute_batch(
            "PRAGMA temp_store=MEMORY; PRAGMA cache_size=-128; PRAGMA mmap_size=0;
             CREATE TEMP TABLE IF NOT EXISTS grimodex_connection_meta(
                 singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch TEXT NOT NULL
             );",
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO temp.grimodex_connection_meta VALUES(1,?1)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        conn.execute_batch("PRAGMA query_only=ON")?;
        Ok(())
    })?;

    let mut reader = Nir1GraphReader::open_for_worker(
        Arc::clone(&fixture.authority),
        fixture.lifecycle.begin_workspace_participant()?,
    )?;
    let stop = Arc::new(AtomicBool::new(false));
    let progress_callbacks = Arc::new(AtomicU64::new(0));
    let callbacks_at_postflight = Arc::new(AtomicU64::new(u64::MAX));
    let user_version_reads = Arc::new(AtomicUsize::new(0));
    let postflight_seen = Arc::new(AtomicBool::new(false));
    let config = NarrativeMaintenanceGraphControlConfig::with_progress_callbacks(Arc::clone(
        &progress_callbacks,
    ));
    let stop_in_authorizer = Arc::clone(&stop);
    let callbacks_for_authorizer = Arc::clone(&progress_callbacks);
    let callbacks_at_postflight_for_authorizer = Arc::clone(&callbacks_at_postflight);
    let reads_for_authorizer = Arc::clone(&user_version_reads);
    let postflight_for_authorizer = Arc::clone(&postflight_seen);

    let result = with_narrative_maintenance_graph_control(
        fixture.authority.db(),
        Duration::ZERO,
        1,
        Arc::clone(&stop),
        config,
        |conn, owner| {
            conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
                if let AuthAction::Pragma { pragma_name, .. } = context.action {
                    if pragma_name.eq_ignore_ascii_case("user_version")
                        && reads_for_authorizer.fetch_add(1, Ordering::AcqRel) == 2
                    {
                        callbacks_at_postflight_for_authorizer.store(
                            callbacks_for_authorizer.load(Ordering::Acquire),
                            Ordering::Release,
                        );
                        postflight_for_authorizer.store(true, Ordering::Release);
                        stop_in_authorizer.store(true, Ordering::Release);
                    }
                }
                Authorization::Allow
            }))?;
            let mut current_heap = |operation: &mut dyn FnMut()| {
                operation();
                true
            };
            let registration = reader.register_with_control_observed(
                conn,
                PROJECT,
                owner,
                None,
                &mut current_heap,
            );
            conn.authorizer(None::<fn(rusqlite::hooks::AuthContext<'_>) -> Authorization>)?;
            registration
        },
    )?
    .expect("maintenance connection acquired");

    assert!(result.receipt.connection_reusable);
    let error = result
        .into_result()
        .expect_err("cancellation during postflight must not publish Registration");
    assert!(is_validation_terminated(&error), "{error:#}");
    assert!(postflight_seen.load(Ordering::Acquire));
    assert!(
        progress_callbacks.load(Ordering::Acquire)
            > callbacks_at_postflight.load(Ordering::Acquire),
        "outer maintenance progress hook was not restored for postflight SQL"
    );
    assert!(reader.registration.is_none());
    Ok(())
}

#[test]
#[ignore = "run explicitly as the production 100ms availability measurement"]
fn production_query_has_an_available_100ms_success_path() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    let started = Instant::now();
    let response = reader.query(&graph_request("nir1-alice"))?;
    let elapsed = started.elapsed();
    eprintln!(
        "production graph query: status={} reason={:?} elapsed={elapsed:?}",
        response.status, response.reason
    );
    if response.status != "available" {
        // Diagnostic only: distinguish the 100 ms deadline from a fixture or
        // qualification failure without relaxing the production assertion.
        let diagnostic_started = Instant::now();
        let diagnostic = query(&mut reader, "nir1-alice")?;
        eprintln!(
            "generous-deadline diagnostic: status={} reason={:?} elapsed={:?}",
            diagnostic.status,
            diagnostic.reason,
            diagnostic_started.elapsed()
        );
    }
    assert_eq!(response.status, "available", "{:?}", response.reason);
    assert!(
        elapsed <= QUERY_DEADLINE,
        "production query exceeded its 100ms wall budget: {elapsed:?}"
    );
    Ok(())
}

// New Q2/R1/D0-local-explicit-scope variant: only a disposable copy receives
// canonical Scope/registry writes. The original diagnostic preseed stays Unknown
// (negative control). This tests the ordinary reader, NOT worker/Native lease.
#[test]
#[ignore = "requires a closed Q2/R1/D0-local preseed from the opt-in fixture builder"]
fn ordinary_reader_registers_and_queries_fixed_q2_fixture() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::ReaderOnly)
}

#[test]
#[ignore = "requires a closed Q2/R1/D0-local preseed and a built normal worker binary"]
fn native_worker_returns_fixed_q2_frame_from_real_workspace_owner() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::NativeOwner)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the official Q2 preseed and a normal worker binary"]
fn native_worker_child_environment_is_cleared_and_cwd_is_worker_dir() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::ChildEnvironment)
}

#[test]
#[ignore = "requires the official Q2 preseed and a normal worker binary"]
fn native_worker_projects_owned_dto_after_lease_drop() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::ProjectedLease)
}

#[test]
#[ignore = "requires the official Q2 preseed and a seam-enabled worker binary"]
fn native_worker_crashes_after_q2_ack_before_frame() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::PostAdmissionCrash)
}

#[test]
#[ignore = "requires the official Q2 preseed and a test-seam worker binary"]
fn native_worker_cancels_after_request_admission_and_retires_before_reloan() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::CallerCancellation)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the official Q2 preseed and a test-seam worker binary"]
fn native_worker_handles_backpressured_request_writes() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::RequestWriteCancellation)?;
    q2_reader_fixture(Q2WorkerScenario::RequestWriteDeadline)?;
    q2_reader_fixture(Q2WorkerScenario::RequestWriteChildExit)
}

#[test]
#[ignore = "isolated real-worker test; quarantines a live request writer until test-process exit"]
fn native_worker_quarantines_live_request_writer_after_cleanup_timeout() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::RequestWriteQuarantine)
}

#[test]
#[ignore = "requires the official Q2 preseed and a normal worker binary"]
fn native_worker_reports_canonical_registration_refusal_before_ready() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::StartupRegistrationRefused)
}

#[test]
#[ignore = "requires the official Q2 preseed and a seam-enabled worker binary"]
fn native_worker_accepts_committed_q2_frame_before_nonzero_exit() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::PostCommitNonzero)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the official Q2 preseed and a seam-enabled worker binary"]
fn native_worker_reaps_live_committed_child_after_result_lease() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::ResultHeldChildLive)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "isolated real-worker test; intentionally quarantines one ResultHeld owner until test-process exit"]
fn native_worker_quarantines_result_lease_when_exit_proof_transfer_is_unavailable() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::ResultHeldExitProofUnobserved)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "isolated real-worker test; intentionally quarantines one ResultHeld owner until test-process exit"]
fn native_worker_quarantines_result_lease_when_reader_join_fails() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::ResultHeldReaderJoinFailure)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "isolated real-worker test; intentionally quarantines one ResultHeld owner until test-process exit"]
fn native_worker_quarantines_result_lease_when_reader_completion_exceeds_cleanup_deadline(
) -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::ResultHeldReaderCompletionPending)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the official Q2 preseed and a seam-enabled worker binary"]
fn native_worker_refuses_committed_q2_frame_without_eof() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::CommittedFrameWithoutEof)
}

#[test]
#[ignore = "requires the official Q2 preseed and a partial-marker seam-enabled worker binary"]
fn native_worker_rejects_complete_q2_frame_with_partial_terminal_marker() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::PartialTerminalMarker)
}

#[test]
#[ignore = "requires the official Q2 preseed and a partial-frame seam-enabled worker binary"]
fn native_worker_rejects_declared_q2_frame_with_partial_body() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::PartialFrame)
}

#[test]
#[ignore = "requires the official Q2 preseed and a trailing-data seam-enabled worker binary"]
fn native_worker_rejects_committed_q2_frame_with_trailing_data() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::TrailingData)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the official Q2 preseed and a seam-enabled worker binary"]
fn native_worker_retires_after_real_child_rust_oom() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::RustOom)
}

#[test]
#[ignore = "requires the official Q2 preseed and a seam-enabled worker binary"]
fn native_worker_refuses_after_actual_sql_steps_over_cap() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::SqlStepsOverCap)
}

#[test]
#[ignore = "requires the official Q2 preseed and a seam-enabled worker binary"]
fn native_worker_rejects_request_and_frame_length_n_plus_one() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::FrameLengthOverLimit)
}

#[test]
#[ignore = "requires the official Q2 preseed and a seam-enabled worker binary"]
fn native_worker_refuses_after_real_child_sqlite_nomem() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::SqliteNoMem)
}

#[test]
#[ignore = "isolated real-worker test; intentionally quarantines one owner until test-process exit"]
fn native_worker_quarantines_when_cleanup_proof_is_unobserved() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::CleanupUnproved)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "isolated real Q2 worker test; intentionally quarantines W1 until test-process exit"]
fn native_worker_quarantine_blocks_w1_restore_and_retains_shared_lease() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::CleanupUnprovedRestore)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "isolated real-worker test; intentionally retains one fallback owner until test-process exit"]
fn native_worker_cleanup_unproved_without_file_identity_retains_participant_and_blocks_io(
) -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::CleanupUnprovedDuringTransition)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "subprocess helper for the owner-process-death test"]
fn real_worker_owner_death_subprocess_helper() -> Result<()> {
    q2_reader_fixture(Q2WorkerScenario::OwnerDeathHelper)
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the official Q2 preseed and a normal-build worker binary"]
fn native_worker_exits_after_owner_process_dies_after_request_admission() -> Result<()> {
    use std::{
        os::unix::process::{CommandExt, ExitStatusExt},
        process::{Command, Stdio},
    };

    let _subreaper = LinuxSubreaper::enable()?;
    let fixture_path =
        std::env::temp_dir().join(format!("nir1-c-owner-death-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&fixture_path)?;
    let _fixture = TestDirectory(fixture_path.clone());
    let ready_path = fixture_path.join("worker-ready");
    let request_admitted_path = fixture_path.join("request-admitted");
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("real_worker_owner_death_subprocess_helper")
        .arg("--ignored")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env("NIR1_OWNER_DEATH_FIXTURE_DIR", &fixture_path)
        .env("NIR1_OWNER_DEATH_READY_PATH", &ready_path)
        .env("NIR1_OWNER_DEATH_REQUEST_PATH", &request_admitted_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.process_group(0);
    let owner = command.spawn()?;
    let process_group = libc::pid_t::try_from(owner.id())?;
    let mut processes = OwnerDeathProcesses::new(owner, process_group);
    let worker_pid = processes.wait_for_worker_pid(&ready_path, Duration::from_secs(60))?;
    processes.wait_for_request_admitted(&request_admitted_path, Duration::from_secs(60))?;
    processes.ensure_worker_stopped(worker_pid)?;

    let owner_status = processes.kill_owner()?;
    ensure!(
        owner_status.signal() == Some(libc::SIGKILL),
        "owner process was not killed: {owner_status}"
    );
    processes.resume_worker(worker_pid)?;
    let worker_status = processes.wait_for_worker_exit(worker_pid, Duration::from_secs(5))?;
    ensure!(
        libc::WIFEXITED(worker_status) && libc::WEXITSTATUS(worker_status) != 0,
        "worker did not fail closed after resumed owner-death EOF: wait status={worker_status}"
    );
    processes.ensure_process_group_empty()?;
    eprintln!(
        "Linux real-worker owner-death phase: complete request admitted; worker stopped under live owner at boundary; owner SIGKILL reaped; worker PID {worker_pid} resumed and waitpid-reaped with nonzero exit"
    );
    Ok(())
}

#[cfg(target_os = "linux")]
struct LinuxSubreaper {
    previous: libc::c_int,
}

#[cfg(target_os = "linux")]
impl LinuxSubreaper {
    fn enable() -> Result<Self> {
        let mut previous = 0;
        let get_result = unsafe {
            libc::prctl(
                libc::PR_GET_CHILD_SUBREAPER,
                (&mut previous as *mut libc::c_int) as libc::c_ulong,
                0,
                0,
                0,
            )
        };
        ensure!(
            get_result == 0,
            "could not inspect Linux child-subreaper state: {}",
            std::io::Error::last_os_error()
        );
        let set_result = unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) };
        ensure!(
            set_result == 0,
            "could not enable Linux child-subreaper state: {}",
            std::io::Error::last_os_error()
        );
        Ok(Self { previous })
    }
}

#[cfg(target_os = "linux")]
impl Drop for LinuxSubreaper {
    fn drop(&mut self) {
        unsafe {
            libc::prctl(libc::PR_SET_CHILD_SUBREAPER, self.previous, 0, 0, 0);
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_process_state_and_parent(pid: libc::pid_t) -> Result<(String, libc::pid_t)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let command_end = stat
        .rfind(')')
        .ok_or_else(|| anyhow::anyhow!("invalid process stat"))?;
    let mut fields = stat[command_end + 1..].split_whitespace();
    let state = fields
        .next()
        .ok_or_else(|| anyhow::anyhow!("process state missing"))?
        .to_owned();
    let parent = fields
        .next()
        .ok_or_else(|| anyhow::anyhow!("process parent PID missing"))?
        .parse::<libc::pid_t>()?;
    Ok((state, parent))
}

#[cfg(target_os = "linux")]
struct OwnerDeathProcesses {
    owner: std::process::Child,
    process_group: libc::pid_t,
    owner_reaped: bool,
    worker_reaped: bool,
}

#[cfg(target_os = "linux")]
impl OwnerDeathProcesses {
    fn new(owner: std::process::Child, process_group: libc::pid_t) -> Self {
        Self {
            owner,
            process_group,
            owner_reaped: false,
            worker_reaped: false,
        }
    }

    fn wait_for_worker_pid(
        &mut self,
        path: &std::path::Path,
        timeout: Duration,
    ) -> Result<libc::pid_t> {
        let deadline = Instant::now() + timeout;
        loop {
            match std::fs::read_to_string(path) {
                Ok(value) => {
                    let pid = value.trim().parse::<libc::pid_t>()?;
                    ensure!(pid > 0, "invalid worker PID in helper readiness record");
                    ensure!(
                        !self.owner_exited()?,
                        "owner helper exited immediately after publishing READY"
                    );
                    return Ok(pid);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            if self.owner_exited()? {
                anyhow::bail!("owner helper exited before worker READY");
            }
            if Instant::now() >= deadline {
                anyhow::bail!("timed out waiting for READY worker PID");
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn owner_exited(&mut self) -> Result<bool> {
        if self.owner_reaped {
            return Ok(true);
        }
        if self.owner.try_wait()?.is_some() {
            self.owner_reaped = true;
            return Ok(true);
        }
        Ok(false)
    }

    fn wait_for_request_admitted(
        &mut self,
        path: &std::path::Path,
        timeout: Duration,
    ) -> Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            match std::fs::read_to_string(path) {
                Ok(value) => {
                    ensure!(value == "admitted", "invalid request-admission marker");
                    ensure!(
                        !self.owner_exited()?,
                        "owner helper exited after request admission"
                    );
                    return Ok(());
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            if self.owner_exited()? {
                anyhow::bail!("owner helper exited before request admission");
            }
            if Instant::now() >= deadline {
                anyhow::bail!("timed out waiting for complete request admission");
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn ensure_worker_stopped(&mut self, worker: libc::pid_t) -> Result<()> {
        ensure!(
            !self.owner_exited()?,
            "owner helper exited before worker liveness check"
        );
        let (state, parent) = linux_process_state_and_parent(worker)?;
        let owner_pid = libc::pid_t::try_from(self.owner.id())?;
        ensure!(
            state == "T" && parent == owner_pid,
            "worker PID {worker} is not stopped and live under owner PID {owner_pid}: state={state}, parent={parent}"
        );
        Ok(())
    }

    fn kill_owner(&mut self) -> Result<std::process::ExitStatus> {
        ensure!(
            !self.owner_reaped,
            "owner helper exited before explicit kill"
        );
        self.owner.kill()?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if Instant::now() >= deadline {
                anyhow::bail!("timed out waiting for killed owner process to exit");
            }
            if let Some(status) = self.owner.try_wait()? {
                self.owner_reaped = true;
                return Ok(status);
            }
            thread::sleep(
                Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }

    fn resume_worker(&self, worker: libc::pid_t) -> Result<()> {
        let result = unsafe { libc::kill(worker, libc::SIGCONT) };
        ensure!(
            result == 0,
            "could not resume stopped worker PID {worker}: {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    }

    fn wait_for_worker_exit(&mut self, worker: libc::pid_t, timeout: Duration) -> Result<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            let mut status = 0;
            let result = unsafe { libc::waitpid(worker, &mut status, libc::WNOHANG) };
            if result == worker {
                self.worker_reaped = true;
                return Ok(status);
            }
            if result == 0 {
                if Instant::now() >= deadline {
                    anyhow::bail!("timed out waiting for actual worker exit (pid {worker})");
                }
                thread::sleep(Duration::from_millis(5));
                continue;
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
    }

    fn ensure_process_group_empty(&self) -> Result<()> {
        ensure!(
            self.owner_reaped && self.worker_reaped,
            "owner/worker not reaped"
        );
        let result = unsafe { libc::kill(-self.process_group, 0) };
        ensure!(
            result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH),
            "test process group still exists after reaping owner and worker"
        );
        Ok(())
    }

    fn cleanup(&mut self) {
        if self.owner_reaped && self.worker_reaped {
            return;
        }
        unsafe {
            libc::kill(-self.process_group, libc::SIGKILL);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.owner_reaped && Instant::now() < deadline {
            match self.owner.try_wait() {
                Ok(Some(_)) => self.owner_reaped = true,
                Ok(None) => thread::sleep(Duration::from_millis(5)),
                Err(_) => break,
            }
        }
        if !self.owner_reaped {
            return;
        }
        while Instant::now() < deadline {
            let mut status = 0;
            let result = unsafe { libc::waitpid(-self.process_group, &mut status, libc::WNOHANG) };
            if result > 0 {
                continue;
            }
            if result == 0 {
                thread::sleep(Duration::from_millis(5));
                continue;
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ECHILD) {
                self.worker_reaped = true;
                return;
            }
            if error.kind() != std::io::ErrorKind::Interrupted {
                return;
            }
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for OwnerDeathProcesses {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[cfg(target_os = "linux")]
fn stop_worker_for_owner_death(worker: libc::pid_t) -> Result<()> {
    let helper_pid = libc::pid_t::try_from(std::process::id())?;
    let (state, parent) = linux_process_state_and_parent(worker)?;
    ensure!(
        matches!(state.as_str(), "R" | "S" | "D" | "I" | "P") && parent == helper_pid,
        "worker PID {worker} is not live under helper PID {helper_pid}: state={state}, parent={parent}"
    );
    let result = unsafe { libc::kill(worker, libc::SIGSTOP) };
    ensure!(
        result == 0,
        "could not stop worker PID {worker}: {}",
        std::io::Error::last_os_error()
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let (state, parent) = linux_process_state_and_parent(worker)?;
        ensure!(
            parent == helper_pid,
            "worker PID {worker} was reparented before admission: parent={parent}"
        );
        if state == "T" {
            return Ok(());
        }
        if Instant::now() >= deadline {
            anyhow::bail!("timed out waiting for worker PID {worker} to stop");
        }
        thread::sleep(
            Duration::from_millis(5).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

#[cfg(target_os = "linux")]
fn owner_death_helper(authority: &Arc<WorkspaceAuthority>) -> Result<()> {
    let worker_path = PathBuf::from(
        std::env::var_os("NIR1_C_QUERY_WORKER_BIN")
            .ok_or_else(|| anyhow::anyhow!("NIR1_C_QUERY_WORKER_BIN missing"))?,
    );
    let switching = WorkspaceLifecycleCompatibilityView::new(false);
    let native_state = WorkspaceState {
        inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(authority)))),
        safe_mode: crate::recovery::SafeModeState::default(),
        switching,
        open_lock: Mutex::new(Default::default()),
    };
    let binding = LiveBinding::new(
        authority.path().to_string_lossy(),
        format!("test-workspace:{}", authority.identity()),
        authority.identity(),
        0,
    )
    .with_main_database_file_identity(authority.main_database_file_identity()?);
    native_state.switching.core().set_ready(binding)?;
    let snapshot = active_workspace_snapshot(&native_state)?;
    let mut owner = super::c_query_worker::CQueryWorkerOwner::new(snapshot, worker_path);
    owner.prepare("nir1-capacity-fixture-project")?;
    let worker_pid = owner.child_pid_for_test()?;
    stop_worker_for_owner_death(libc::pid_t::try_from(worker_pid)?)?;

    let ready_path = PathBuf::from(
        std::env::var_os("NIR1_OWNER_DEATH_READY_PATH")
            .ok_or_else(|| anyhow::anyhow!("owner-death readiness path missing"))?,
    );
    let temporary_path = ready_path.with_extension("tmp");
    std::fs::write(&temporary_path, worker_pid.to_string())?;
    std::fs::rename(temporary_path, ready_path)?;

    let request_admitted_path = PathBuf::from(
        std::env::var_os("NIR1_OWNER_DEATH_REQUEST_PATH")
            .ok_or_else(|| anyhow::anyhow!("owner-death request marker path missing"))?,
    );
    owner.hold_after_request_for_test(request_admitted_path);
    owner.query_once(&Nir1GraphRequest {
        project_id: "nir1-capacity-fixture-project".into(),
        query_scene_id: "nir1-capacity-scope-drift-scene".into(),
        seed_entity_id: "nir1-capacity-q-r0-e0".into(),
    })?;
    anyhow::bail!("owner-death helper unexpectedly returned a query lease")
}

struct CanonicalGoldBinding {
    revision_id: String,
    decision_id: String,
    decision_token: String,
    freshness_token: String,
    scope_authority_revision: String,
    query_scene_source_token: String,
    query_scene_scope_token: String,
    query_scene_incarnation_id: String,
    reveal_state_token: String,
}

// These fixtures have one Codex source per Entity plus Scope authority, no
// Relations, POV, phases or foreshadows. Derive tokens from their saved inputs
// and canonical DB rows, never from the production A3 disclosure result.
fn fixture_canonical_gold_binding(
    authority: &crate::state::WorkspaceAuthority,
    project: &str,
    query_scene: &str,
    entities: &[grimodex_core::narrative_nir1::EntityInput],
    revision_id: &str,
    proposal_id: &str,
) -> Result<CanonicalGoldBinding> {
    let entity = entities
        .first()
        .ok_or_else(|| anyhow::anyhow!("canonical Gold fixture has no Entities"))?;
    authority.with_read_transaction(|conn| {
        let mut statement = conn.prepare(
            "SELECT id, decision, decision_json, created_at, created_by,
                    actor_kind, actor_id, authority_scope, override_field_paths_json
               FROM narrative_proposal_decisions
              WHERE proposal_id=?1 AND revision_id=?2
              ORDER BY created_at, id",
        )?;
        let decisions = statement
            .query_map(rusqlite::params![proposal_id, revision_id], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "decision": row.get::<_, String>(1)?,
                    "decisionJson": row.get::<_, String>(2)?,
                    "createdAt": row.get::<_, String>(3)?,
                    "createdBy": row.get::<_, String>(4)?,
                    "actorKind": row.get::<_, String>(5)?,
                    "actorId": row.get::<_, String>(6)?,
                    "authorityScope": row.get::<_, String>(7)?,
                    "overrideFieldPathsJson": row.get::<_, String>(8)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            decisions.len() == 1 && decisions[0]["decision"] == "approved",
            "canonical Gold requires its one approved Human Decision"
        );
        let decision_id = decisions[0]["id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("canonical Gold Decision ID missing"))?
            .to_owned();
        let decision_token =
            grimodex_core::canonical_json::canonical_json_digest(&serde_json::json!({
                "proposalId": proposal_id,
                "revisionId": revision_id,
                "decisions": decisions,
            }))?;

        let freshness_json: String = conn.query_row(
            "SELECT json_object(
                'semanticEpochId', f.semantic_epoch_id,
                'dependencySetDigest', f.dependency_set_digest,
                'declarationSetId', d.id,
                'declarationSetDigest', d.dependency_set_digest,
                'lastEvaluatedRunId', f.last_evaluated_run_id,
                'edgeCount', ?4,
                'feedAcknowledgedThroughSequence', c.acknowledged_through_sequence,
                'feedHeadSequence', MAX(
                    (SELECT COALESCE(MAX(canonical_sequence),0)
                       FROM narrative_change_events WHERE project_id=?1),
                    (SELECT COALESCE(MAX(source_change_event_sequence),0)
                       FROM narrative_change_transactions WHERE project_id=?1))
             )
             FROM narrative_consumer_freshness f
             JOIN narrative_dependency_declaration_heads h
               ON h.project_id=f.project_id AND h.consumer_kind=f.consumer_kind
              AND h.consumer_key=f.consumer_key
             JOIN narrative_dependency_declaration_sets d
               ON d.id=h.active_declaration_set_id
             JOIN narrative_change_cursors c ON c.project_id=f.project_id
              AND c.consumer_id=?3
             WHERE f.project_id=?1 AND f.consumer_kind='proposal-revision'
               AND f.consumer_key=?2",
            rusqlite::params![
                project,
                revision_id,
                crate::narrative_extraction::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID,
                i64::try_from(entities.len() + 1)?,
            ],
            |row| row.get(0),
        )?;
        let freshness: serde_json::Value = serde_json::from_str(&freshness_json)?;
        let freshness_token = grimodex_core::canonical_json::canonical_json_digest(&freshness)?;

        let (
            phase_resolution_mode,
            query_scene_source_token,
            query_scene_scope_token,
            query_scene_incarnation_id,
            query_viewpoint,
        ): (String, String, String, String, Option<String>) = conn.query_row(
            "SELECT p.phase_resolution_mode, 'v' || t.version || '@' || t.updated_at,
                    s.source_token, s.scene_incarnation_id, t.pov_character_id
               FROM projects p
               JOIN tree_nodes t ON t.project_id=p.id
               JOIN narrative_scene_scope_bindings s
                 ON s.project_id=t.project_id AND s.scene_id=t.id
              WHERE p.id=?1 AND t.id=?2 AND t.node_type='scene'",
            rusqlite::params![project, query_scene],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        ensure!(
            phase_resolution_mode == "auto" && query_viewpoint.is_none(),
            "canonical Gold fixture phase mode or viewpoint changed"
        );
        let mut phase_state = Vec::with_capacity(entities.len());
        let mut reveal_entities = Vec::with_capacity(entities.len());
        for fixture_entity in entities {
            ensure!(
                fixture_entity.scope.authority_revision == entity.scope.authority_revision,
                "canonical Gold fixture mixes Scope authority revisions"
            );
            let (base_context_mode, phase_count): (String, i64) = conn.query_row(
                "SELECT entry.context_mode, COUNT(phase.id)
                   FROM codex_entries entry
                   LEFT JOIN codex_entry_phases phase ON phase.entry_id=entry.id
                  WHERE entry.project_id=?1 AND entry.id=?2
                  GROUP BY entry.context_mode",
                rusqlite::params![project, fixture_entity.entity_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let foreshadow_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM foreshadow_codex_links link
                   JOIN foreshadows foreshadow ON foreshadow.id=link.foreshadow_id
                  WHERE link.codex_entry_id=?1 AND foreshadow.project_id=?2",
                rusqlite::params![fixture_entity.entity_id, project],
                |row| row.get(0),
            )?;
            ensure!(
                base_context_mode == "mentioned" && phase_count == 0 && foreshadow_count == 0,
                "canonical Gold fixture phase or reveal inputs changed"
            );
            phase_state.push(serde_json::json!({
                "entityId": fixture_entity.entity_id,
                "baseContextMode": base_context_mode,
                "phases": [],
                "applicablePhaseIds": [],
                "effectiveContextMode": "mentioned",
            }));
            reveal_entities.push(serde_json::json!({
                "entityId": fixture_entity.entity_id, "foreshadows": [],
            }));
        }
        let reveal_state = serde_json::json!({
            "projectId": project,
            "querySceneId": query_scene,
            "phaseResolutionMode": phase_resolution_mode,
            "effectiveAxis": "reading",
            "scopeAuthorityRevision": entity.scope.authority_revision,
            "queryViewpoint": query_viewpoint,
            "phaseState": phase_state,
            "entities": reveal_entities,
        });
        let reveal_state_token =
            grimodex_core::canonical_json::canonical_json_digest(&reveal_state)?;

        Ok(CanonicalGoldBinding {
            revision_id: revision_id.to_owned(),
            decision_id,
            decision_token,
            freshness_token,
            scope_authority_revision: entity.scope.authority_revision.clone(),
            query_scene_source_token,
            query_scene_scope_token,
            query_scene_incarnation_id,
            reveal_state_token,
        })
    })
}

fn q2_gold_text(frame: &mut Vec<u8>, value: &str) -> Result<()> {
    frame.extend_from_slice(&u32::try_from(value.len())?.to_le_bytes());
    frame.extend_from_slice(value.as_bytes());
    Ok(())
}

fn q2_gold_optional_text(frame: &mut Vec<u8>, value: Option<&str>) -> Result<()> {
    match value {
        Some(value) => {
            frame.push(1);
            q2_gold_text(frame, value)?;
        }
        None => frame.push(0),
    }
    Ok(())
}

fn q2_gold_scope_value(
    frame: &mut Vec<u8>,
    value: &grimodex_core::narrative_nir1::ScopeValue,
) -> Result<()> {
    use grimodex_core::narrative_nir1::ScopeValue;

    match value {
        ScopeValue::Any { purpose } => {
            frame.push(1);
            q2_gold_optional_text(frame, purpose.as_deref())?;
        }
        ScopeValue::Exact { value } => {
            frame.push(2);
            q2_gold_text(frame, value)?;
        }
        ScopeValue::NotApplicable { reason } => {
            frame.push(3);
            q2_gold_text(frame, reason)?;
        }
        ScopeValue::Unavailable { reason } => {
            frame.push(4);
            q2_gold_text(frame, reason)?;
        }
        ScopeValue::LegacyAbsent => frame.push(5),
        ScopeValue::Unresolved => frame.push(6),
    }
    Ok(())
}

/// The C-resource fixtures query seed-only Graphs: one node, no edges and,
/// without a reached Entity, no Scene association.
fn seed_only_frame_graph<'a>(
    frame: &super::worker_frame::FrameView<'a>,
    project: &str,
    query_scene: &str,
    seed: &str,
) -> Result<super::worker_frame::GraphView<'a>> {
    assert_eq!(frame.project(), project);
    assert_eq!(frame.query_scene(), query_scene);
    let graph = *frame
        .graph()
        .ok_or_else(|| anyhow::anyhow!("seed-only worker frame was unavailable"))?;
    assert_eq!(graph.seed(), seed);
    assert!(!graph.scope_revision().is_empty());
    assert!(graph.generation() > 0);
    assert_eq!((graph.node_count(), graph.edge_count()), (1, 0));
    assert_eq!(
        (graph.scene_count(), graph.diagnostic_scene_total()),
        (0, 0)
    );
    Ok(graph)
}

/// The only record of a one-record typed projection.
fn single_record<T>(mut records: impl Iterator<Item = Result<T>>) -> Result<T> {
    let record = records
        .next()
        .ok_or_else(|| anyhow::anyhow!("typed projection is empty"))??;
    ensure!(
        records.next().is_none(),
        "typed projection has more than one record"
    );
    Ok(record)
}

fn canonical_single_node_gold_frame(
    project: &str,
    query_scene: &str,
    entity: &grimodex_core::narrative_nir1::EntityInput,
    generation: i64,
    binding: &CanonicalGoldBinding,
) -> Result<Vec<u8>> {
    ensure!(
        entity.evidence.len() == 1,
        "official single-node Gold must have one Evidence"
    );
    let mut frame = b"NQG2".to_vec();
    frame.push(1);
    q2_gold_text(&mut frame, project)?;
    q2_gold_text(&mut frame, query_scene)?;
    q2_gold_text(&mut frame, &binding.scope_authority_revision)?;
    frame.extend_from_slice(&generation.to_le_bytes());
    q2_gold_text(&mut frame, &entity.entity_id)?;
    frame.extend_from_slice(&1_u16.to_le_bytes());
    frame.extend_from_slice(&0_u16.to_le_bytes());

    q2_gold_text(&mut frame, &entity.entity_id)?;
    q2_gold_text(&mut frame, &entity.entity_type)?;
    q2_gold_text(&mut frame, &entity.label)?;
    q2_gold_text(&mut frame, &entity.source_token)?;
    q2_gold_scope_value(&mut frame, &entity.scope.reading)?;
    q2_gold_scope_value(&mut frame, &entity.scope.story)?;
    q2_gold_scope_value(&mut frame, &entity.scope.auto)?;
    q2_gold_text(&mut frame, &entity.scope.phase)?;
    q2_gold_text(&mut frame, &entity.scope.reveal)?;
    q2_gold_optional_text(&mut frame, entity.scope.pov.as_deref())?;
    q2_gold_text(&mut frame, &entity.scope.authority_revision)?;
    frame.extend_from_slice(&u16::try_from(entity.evidence.len())?.to_le_bytes());
    for evidence in &entity.evidence {
        q2_gold_text(&mut frame, &evidence.evidence_id)?;
        q2_gold_text(&mut frame, &evidence.source_ref)?;
        q2_gold_text(&mut frame, &evidence.quote)?;
        frame.extend_from_slice(&u32::try_from(evidence.start_utf16)?.to_le_bytes());
        frame.extend_from_slice(&u32::try_from(evidence.end_utf16)?.to_le_bytes());
    }
    frame.push(0);
    frame.extend_from_slice(&1_u16.to_le_bytes());
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
        q2_gold_text(&mut frame, value)?;
    }
    // A seed-only Graph reaches no Entity: scene_total 0 and scene_count 0.
    frame.extend_from_slice(&0_u16.to_le_bytes());
    frame.extend_from_slice(&0_u16.to_le_bytes());
    Ok(frame)
}

fn q2_reader_fixture(scenario: Q2WorkerScenario) -> Result<()> {
    const PROJECT: &str = "nir1-capacity-fixture-project";
    const SOURCE_SCENE: &str = "nir1-capacity-scene"; // reading rank a0
    const QUERY_SCENE: &str = "nir1-capacity-scope-drift-scene"; // rank a1
    const ENTITY: &str = "nir1-capacity-q-r0-e0";
    use crate::narrative_extraction::incremental_freshness::IncrementalFreshnessCycleOutcome;
    use crate::narrative_extraction::nir1_entity_relation_index::{
        prepare_graph_index_build_with_control,
        publish_nir1_entity_relation_index_in_tx_with_control,
    };
    use crate::narrative_extraction::scene_scope::{
        read_narrative_scene_scope, update_narrative_scene_scope,
        update_narrative_scene_scope_registry, NarrativeSceneScopeRegistryUpdatePayload,
        NarrativeSceneScopeUpdatePayload, NarrativeSceneScopeUpdateV1,
    };
    use crate::narrative_extraction::{
        narrative_extraction_append_human_decision,
        project_scope_authority::load_live_project_scope_authority, AppendDecisionPayload,
        Nir1EntityRelationRevisionRequest,
    };
    use crate::narrative_maintenance_connection::{
        with_narrative_maintenance_graph_control, NarrativeMaintenanceGraphControlConfig,
    };
    use grimodex_core::narrative_nir1::EntityRelationBundle;
    use grimodex_core::narrative_scene_scope::{
        NarrativeSceneQueryIdentityV1, NarrativeScopeCompatibilityMarkerV1,
        NarrativeScopeConstraintV1,
    };

    fn maintenance<T>(
        db: &crate::Database,
        operation: impl FnOnce(&rusqlite::Connection, &mut dyn GraphWorkControl) -> Result<T>,
    ) -> Result<T> {
        with_narrative_maintenance_graph_control(
            db,
            Duration::ZERO,
            1_000,
            Arc::new(AtomicBool::new(false)),
            NarrativeMaintenanceGraphControlConfig::default(),
            operation,
        )?
        .ok_or_else(|| anyhow::anyhow!("fixture maintenance was deferred"))?
        .into_result()
    }

    #[cfg(target_os = "linux")]
    let directory_path = if scenario == Q2WorkerScenario::OwnerDeathHelper {
        PathBuf::from(
            std::env::var_os("NIR1_OWNER_DEATH_FIXTURE_DIR")
                .ok_or_else(|| anyhow::anyhow!("owner-death fixture directory missing"))?,
        )
    } else {
        std::env::temp_dir().join(format!("nir1-c-q2-{}", uuid::Uuid::new_v4()))
    };
    #[cfg(not(target_os = "linux"))]
    let directory_path = std::env::temp_dir().join(format!("nir1-c-q2-{}", uuid::Uuid::new_v4()));
    let directory = TestDirectory(directory_path);
    let workspace_path = directory.0.clone();
    std::fs::create_dir_all(&workspace_path)?;
    // Build the closed preseed separately with the opt-in fixture CLI, then
    // run this test WITHOUT its diagnostic feature on a disposable copy.
    let source = std::path::PathBuf::from(
        std::env::var_os("NIR1_Q2_FIXTURE_PATH")
            .ok_or_else(|| anyhow::anyhow!("NIR1_Q2_FIXTURE_PATH missing"))?,
    );
    ensure!(
        std::fs::symlink_metadata(&source)?.file_type().is_file(),
        "Q2 source not regular"
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        ensure!(
            !std::path::PathBuf::from(format!("{}{suffix}", source.display())).exists(),
            "Q2 source has a sidecar"
        );
    }
    let path = workspace_path.join("grimodex.db");
    std::fs::copy(&source, &path)?;
    let authority_path = workspace_path.clone();
    let authority =
        WorkspaceAuthority::from_database_for_test(crate::Database::new(&path)?, authority_path)?;
    let (original_revision, run_id, mut bundle): (String, String, EntityRelationBundle) = authority.with_read_transaction(|conn| {
        for scene in [SOURCE_SCENE, QUERY_SCENE] {
            let original = read_narrative_scene_scope(conn, PROJECT, scene)?;
            ensure!(
                original.binding.compatibility_marker == NarrativeScopeCompatibilityMarkerV1::Unknown,
                "original Q2 Scope must remain Unknown: {scene}"
            );
        }
        let revision = conn.query_row(
            "SELECT consumer_key FROM narrative_dependency_edges WHERE project_id=?1 AND source_object_identity=?2 AND consumer_kind='proposal-revision'",
            params![PROJECT, format!("codex:{ENTITY}")],
            |row| row.get::<_, String>(0),
        )?;
        ensure!(
            matches!(
                evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &revision, SOURCE_SCENE)?,
                Nir1EntityRelationDisclosureRead::Unavailable { reason } if reason == "a3-query-scope-unavailable"
            ),
            "original Q2 Unknown query Scope is an A3 negative control"
        );
        let (run_id, payload): (String, String) = conn.query_row(
            "SELECT proposal_set.run_id, revision.payload_json
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal ON proposal.id=revision.proposal_id
               JOIN narrative_proposal_sets proposal_set ON proposal_set.id=proposal.proposal_set_id
              WHERE revision.id=?1",
            [&revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let payload: serde_json::Value = serde_json::from_str(&payload)?;
        ensure!(payload["revisionId"] == revision && payload["projectId"] == PROJECT,
            "original Q2 typed Revision identity changed");
        let bundle = serde_json::from_value(payload["bundle"].clone())?;
        Ok((revision, run_id, bundle))
    })?;

    // Only this new variant gains a registry and resolved Explicit Source + S2.
    let current = authority
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, SOURCE_SCENE))?;
    let mut registry = current.registry;
    ensure!(
        registry.timeline_refs.is_empty()
            && registry.worldline_refs.is_empty()
            && registry.narrative_layer_refs.is_empty(),
        "Q2 preseed registry changed"
    );
    registry.timeline_refs.push("timeline:main".into());
    registry.worldline_refs.push("worldline:prime".into());
    registry
        .narrative_layer_refs
        .push("layer:manuscript".into());
    update_narrative_scene_scope_registry(
        &authority,
        NarrativeSceneScopeRegistryUpdatePayload {
            project_id: PROJECT.into(),
            request_id: "q2-explicit-registry".into(),
            session_id: "q2-explicit-variant".into(),
            event_uid: "q2-explicit-registry-event".into(),
            base_version: current.registry_revision,
            updated_at: "2026-09-20T00:00:00.000Z".into(),
            registry,
        },
    )?;
    let identity = NarrativeSceneQueryIdentityV1 {
        timeline: NarrativeScopeConstraintV1::Exact {
            reference: "timeline:main".into(),
        },
        worldline: NarrativeScopeConstraintV1::Exact {
            reference: "worldline:prime".into(),
        },
        narrative_layer: NarrativeScopeConstraintV1::Exact {
            reference: "layer:manuscript".into(),
        },
    };
    for (scene, ordinal) in [(SOURCE_SCENE, 0), (QUERY_SCENE, 1)] {
        let current = authority
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, scene))?;
        update_narrative_scene_scope(
            &authority,
            NarrativeSceneScopeUpdatePayload {
                project_id: PROJECT.into(),
                scene_id: scene.into(),
                request_id: format!("q2-explicit-scope-{ordinal}"),
                session_id: "q2-explicit-variant".into(),
                event_uid: format!("q2-explicit-scope-event-{ordinal}"),
                base_version: current.binding.version,
                updated_at: format!("2026-09-20T00:00:0{}.000Z", ordinal + 1),
                scope: NarrativeSceneScopeUpdateV1 {
                    schema_version: current.binding.schema_version,
                    compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
                    query_identity: identity.clone(),
                    material_constraint: current.binding.material_constraint,
                    knowledge_holder: current.binding.knowledge_holder,
                    audience: current.binding.audience,
                },
            },
        )?;
    }
    // The canonical writers emitted Feed changes; only the real Freshness
    // owner may bring the copied fixture current before registration.
    let mut drained = false;
    for _ in 0..8 {
        match run_incremental_freshness_cycle(&authority)? {
            IncrementalFreshnessCycleOutcome::Processed(_) => {}
            IncrementalFreshnessCycleOutcome::Idle => {
                drained = true;
                break;
            }
            IncrementalFreshnessCycleOutcome::Held(_) => anyhow::bail!("Q2 Freshness held"),
        }
    }
    ensure!(drained, "Q2 Freshness Feed did not drain");
    ensure!(
        matches!(
            authority.with_read_transaction(|conn| evaluate_nir1_entity_relation_disclosure(
                conn, PROJECT, &original_revision, QUERY_SCENE
            ))?,
            Nir1EntityRelationDisclosureRead::Unavailable { reason } if reason == "source-revision-changed"
        ),
        "old immutable Revision must not regain Source currentness after Scope change"
    );
    // Scope extension changes the project's source revision token. Re-issue
    // exactly the same Q2 material through the Native typed writer and a new
    // Human Decision; neither Freshness nor registration can revive the old
    // immutable Revision. The original preseed and its approval stay intact.
    let current_authority = authority.with_read_transaction(|conn| {
        load_live_project_scope_authority(
            conn,
            PROJECT,
            &format!("project:scope-authority:{PROJECT}"),
        )
    })?;
    ensure!(
        bundle.entities.len() == 1 && bundle.relations.is_empty(),
        "Q2 shape changed"
    );
    bundle.entities[0].scope.authority_revision = current_authority.source.revision_token;
    let canonical_gold_entity = bundle.entities[0].clone();
    let created = create_nir1_entity_relation_revision(
        &authority,
        Nir1EntityRelationRevisionRequest {
            run_id: run_id.clone(),
            project_id: PROJECT.into(),
            proposal_key: "nir1:capacity:q2-explicit-scope".into(),
            bundle,
        },
    )?;
    let revision = created["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Q2 typed writer omitted Revision ID"))?
        .to_owned();
    let proposal_id = created["proposalId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Q2 typed writer omitted Proposal ID"))?;
    ensure!(
        revision != original_revision,
        "Q2 variant must have a new immutable Revision"
    );
    narrative_extraction_append_human_decision(
        &authority,
        AppendDecisionPayload {
            run_id,
            project_id: PROJECT.into(),
            proposal_id: proposal_id.into(),
            revision_id: revision.clone(),
            decision: "approved".into(),
            decision_json: None,
            created_by: Some("q2-explicit-scope-fixture-variant".into()),
        },
    )?;

    let runtime = authority.nir_chronicle_index_runtime();
    let snapshot = maintenance(&authority, |conn, control| {
        let tx = conn.unchecked_transaction()?;
        let snapshot = prepare_graph_index_build_with_control(&tx, runtime, PROJECT, control)?;
        tx.commit()?;
        Ok(snapshot)
    })?;
    let published = maintenance(&authority, |conn, control| {
        let tx = conn.unchecked_transaction()?;
        let published =
            publish_nir1_entity_relation_index_in_tx_with_control(&tx, runtime, snapshot, control)?;
        tx.commit()?;
        Ok(published)
    })?;
    let canonical_gold_frame = if matches!(
        scenario,
        Q2WorkerScenario::NativeOwner | Q2WorkerScenario::ProjectedLease
    ) {
        let binding = fixture_canonical_gold_binding(
            &authority,
            PROJECT,
            QUERY_SCENE,
            std::slice::from_ref(&canonical_gold_entity),
            &revision,
            proposal_id,
        )?;
        Some(canonical_single_node_gold_frame(
            PROJECT,
            QUERY_SCENE,
            &canonical_gold_entity,
            published.generation,
            &binding,
        )?)
    } else {
        None
    };
    #[cfg(target_os = "linux")]
    if scenario == Q2WorkerScenario::OwnerDeathHelper {
        return owner_death_helper(&authority);
    }
    let lifecycle = WorkspaceLifecycleCore::new();
    let mut reader = Nir1GraphReader::open(
        Arc::clone(&authority),
        lifecycle.begin_workspace_participant()?,
    )?;
    let request = Nir1GraphRequest {
        project_id: PROJECT.into(),
        query_scene_id: QUERY_SCENE.into(),
        seed_entity_id: ENTITY.into(),
    };
    assert_unavailable(&reader.query(&request)?, "registration-required");
    ensure!(
        maintenance(&authority, |_, control| {
            reader.register_with_control(PROJECT, control)
        })?,
        "Q2 complete registration failed"
    );
    let started = Instant::now();
    let response = reader.query(&request)?;
    let elapsed = started.elapsed();
    eprintln!(
        "ordinary Q2/R1/D0-local-explicit-scope reader query: status={} reason={:?} elapsed={elapsed:?}",
        response.status, response.reason
    );
    ensure!(
        response.status == "available",
        "Q2 query: {:?}",
        response.reason
    );
    let graph = response
        .graph
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Q2 graph absent"))?;
    // Independent expectation: Q2's 2 materials are one Entity + Evidence;
    // Source and human Decision were written before this variant was copied.
    assert_eq!(graph.seed_entity_id, ENTITY);
    if graph.nodes.is_empty() {
        let disclosure = authority.with_read_transaction(|conn| {
            evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &revision, QUERY_SCENE)
        })?;
        match disclosure {
            Nir1EntityRelationDisclosureRead::Unavailable { reason } => {
                anyhow::bail!("Q2 explicit-scope A3 rejected exact revision: {reason}")
            }
            other => anyhow::bail!("Q2 explicit-scope graph empty with A3: {other:?}"),
        }
    }
    assert_eq!(graph.nodes.len(), 1);
    assert!(graph.edges.is_empty());
    assert_eq!(graph.nodes[0].hop, 0);
    let entity = &graph.nodes[0].entity;
    assert_eq!(entity.entity_id, ENTITY);
    assert_eq!(entity.entity_type, "character");
    assert_eq!(entity.label, ENTITY);
    assert_eq!(
        entity.source_token,
        format!("codex:{ENTITY}@2026-09-17T00:00:00Z")
    );
    assert_eq!(
        entity.scope.reading,
        ScopeValue::Exact {
            value: format!("scene:{SOURCE_SCENE}")
        }
    );
    assert_eq!(entity.evidence.len(), 1);
    let evidence = &entity.evidence[0];
    assert_eq!(
        evidence.evidence_id,
        format!("nir1:capacity:evidence:0:{ENTITY}")
    );
    assert_eq!(evidence.source_ref, format!("codex:{ENTITY}"));
    assert_eq!(evidence.start_utf16, 0);
    assert_eq!(evidence.quote, format!("fixture source {ENTITY} 日本語"));
    assert_eq!(evidence.end_utf16, evidence.quote.encode_utf16().count());
    assert_eq!(graph.nodes[0].bindings.len(), 1);
    assert_eq!(graph.nodes[0].bindings[0].revision_id, revision);
    ensure!(
        !graph.nodes[0].bindings[0].decision_id.is_empty(),
        "Q2 Human Decision missing"
    );
    reader.close()?;
    assert_eq!(lifecycle.workspace_participant_count()?, 0);
    drop(reader);

    if scenario != Q2WorkerScenario::ReaderOnly {
        let worker_path = PathBuf::from(
            std::env::var_os("NIR1_C_QUERY_WORKER_BIN")
                .ok_or_else(|| anyhow::anyhow!("NIR1_C_QUERY_WORKER_BIN missing"))?,
        );
        let switching = WorkspaceLifecycleCompatibilityView::new(false);
        let native_state = WorkspaceState {
            inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&authority)))),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching,
            open_lock: Mutex::new(Default::default()),
        };
        let binding = LiveBinding::new(
            authority.path().to_string_lossy(),
            format!("test-workspace:{}", authority.identity()),
            authority.identity(),
            0,
        );
        #[cfg(target_os = "linux")]
        let original_binding = if scenario == Q2WorkerScenario::CleanupUnprovedDuringTransition {
            binding
        } else {
            binding.with_main_database_file_identity(authority.main_database_file_identity()?)
        };
        #[cfg(not(target_os = "linux"))]
        let original_binding =
            binding.with_main_database_file_identity(authority.main_database_file_identity()?);
        native_state
            .switching
            .core()
            .set_ready(original_binding.clone())?;

        #[cfg(target_os = "linux")]
        if scenario == Q2WorkerScenario::CleanupUnprovedDuringTransition {
            let authority_weak = Arc::downgrade(&authority);
            let mut owner = super::c_query_worker::CQueryWorkerOwner::new(
                active_workspace_snapshot(&native_state)?,
                worker_path.clone(),
            );
            owner.prepare(&request.project_id)?;
            owner.suppress_eof_proof_for_test();
            let marker_dir = TestDirectory(std::env::temp_dir().join(format!(
                "nir1-c-query-transition-race-{}",
                uuid::Uuid::new_v4()
            )));
            std::fs::create_dir_all(&marker_dir.0)?;
            let marker_path = marker_dir.0.join("query-error-ready");
            let coordinator_release = Arc::new(AtomicBool::new(false));
            owner.hold_before_cleanup_for_transition_test(
                marker_path.clone(),
                Arc::clone(&coordinator_release),
            );
            let query_thread = thread::current();
            let core = native_state.switching.core();
            let transition_core = core.clone();
            let coordinator_release_for_thread = Arc::clone(&coordinator_release);
            let (ticket_tx, ticket_rx) =
                std::sync::mpsc::channel::<std::result::Result<AdmissionTicket, String>>();
            let coordinator = thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !marker_path.exists() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(1));
                }
                let admission = if marker_path.exists() {
                    transition_core
                        .begin_transition(AdmissionKind::Open)
                        .map_err(|error| error.to_string())
                        .and_then(|outcome| match outcome {
                            AdmissionOutcome::Admitted(ticket) => Ok(ticket),
                            AdmissionOutcome::NotAdmitted { reason, .. } => {
                                Err(format!("Open not admitted: {reason:?}"))
                            }
                        })
                } else {
                    Err("query request rendezvous timed out".to_owned())
                };
                let _ = ticket_tx.send(admission);
                coordinator_release_for_thread.store(true, Ordering::Release);
                query_thread.unpark();
            });
            let query_error = match owner.query_once(&request) {
                Ok(_) => None,
                Err(error) => Some(format!("{error:#}")),
            };
            let admitted = ticket_rx.recv_timeout(Duration::from_secs(10));
            let coordinator_joined = coordinator.join().is_ok();
            let ticket = admitted
                .as_ref()
                .ok()
                .and_then(|admission| admission.as_ref().ok())
                .cloned();
            let participant_retained = core.workspace_participant_count()? == 1;
            let physical_io_blocked = ticket.as_ref().is_some_and(|ticket| {
                matches!(
                    core.physical_exclusive_for_ticket(ticket),
                    Err(crate::workspace_lifecycle::LifecycleError::ActiveOperations)
                )
            });
            drop(authority);
            let owner_authority_pin_released = authority_weak
                .upgrade()
                .is_some_and(|authority| Arc::strong_count(&authority) == 2);
            ensure!(coordinator_joined, "transition coordinator was not joined");
            ensure!(
                ticket.is_some(),
                "Open transition admission failed: {admitted:?}"
            );
            ensure!(
                query_error.as_deref().is_some_and(|error| {
                    error.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED")
                        && error.contains("NIR1_GRAPH_TEST_EOF_PROOF_UNOBSERVED")
                        && !error.contains("NIR1_GRAPH_TEST_TRANSITION_SIGNAL_TIMEOUT")
                }),
                "query did not fail specifically on suppressed EOF proof after coordinator release: {query_error:?}"
            );
            ensure!(
                owner.normal_exit_and_eof_observed_for_test(),
                "test did not observe successful child exit + real reader EOF + complete frame"
            );
            ensure!(
                participant_retained && physical_io_blocked && owner_authority_pin_released,
                "fallback must release only this owner's authority pin while retaining the participant barrier"
            );
            eprintln!(
                "Native W1 cleanup-unproved after Open admission: owner authority pin released, participant count=1, protected I/O refused"
            );
            drop(owner);
            return Ok(());
        }

        if matches!(
            scenario,
            Q2WorkerScenario::CleanupUnproved | Q2WorkerScenario::CleanupUnprovedRestore
        ) {
            let authority_weak = Arc::downgrade(&authority);
            let workspace_path = authority.path().to_path_buf();
            let alias_path = workspace_path
                .with_file_name(format!("nir1-c-quarantine-alias-{}", uuid::Uuid::new_v4()));
            let _alias_directory = TestDirectory(alias_path.clone());
            std::fs::create_dir_all(alias_path.join(".grimodex"))?;
            std::fs::hard_link(
                workspace_path.join("grimodex.db"),
                alias_path.join("grimodex.db"),
            )?;
            std::fs::write(
                alias_path.join(".grimodex/workspace.json"),
                serde_json::json!({"id": "edited-workspace-metadata-id"}).to_string(),
            )?;
            let alias_database_identity =
                crate::narrative_extraction::sqlite_database_file_identity(
                    &alias_path.join("grimodex.db"),
                )?;
            ensure!(
                alias_database_identity == authority.main_database_file_identity()?,
                "hard-link alias must resolve to the held main DB file identity"
            );
            let alias_binding = LiveBinding::new(
                alias_path.to_string_lossy(),
                "edited-workspace-metadata-id",
                authority.identity().wrapping_add(1),
                1,
            )
            .with_main_database_file_identity(alias_database_identity);
            let mut owner = super::c_query_worker::CQueryWorkerOwner::new(
                active_workspace_snapshot(&native_state)?,
                worker_path.clone(),
            );
            owner.prepare(&request.project_id)?;
            owner.suppress_eof_proof_for_test();
            let started = Instant::now();
            let error = match owner.query_once(&request) {
                Ok(_) => anyhow::bail!("unproved cleanup returned a result lease"),
                Err(error) => error,
            };
            let returned_elapsed = started.elapsed();
            let error_text = format!("{error:#}");
            ensure!(
                error_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED")
                    && error_text.contains("NIR1_GRAPH_TEST_EOF_PROOF_UNOBSERVED"),
                "cleanup did not fail closed after proof suppression: {error_text}"
            );
            ensure!(
                owner.normal_exit_and_eof_observed_for_test(),
                "test did not observe successful child exit + real reader EOF + complete frame"
            );
            ensure!(
                owner.successful_request_bound_q2_frame_before_eof_suppression_for_test(),
                "EOF proof was suppressed without a successful request-bound Q2 frame"
            );
            ensure!(
                !owner.cleanup_proved_for_test(),
                "cleanup proof unexpectedly advanced despite withheld EOF transfer"
            );
            ensure!(
                owner.quarantined_resources_held_for_test(),
                "snapshot, claim, Native region, child status and reader handle were not quarantined"
            );
            ensure!(
                returned_elapsed > QUERY_DEADLINE,
                "cleanup timeout was conflated with the 100ms Graph deadline: {returned_elapsed:?}"
            );
            eprintln!(
                "Native Q2 cleanup-unproved: call-to-error={returned_elapsed:?}; query deadline={QUERY_DEADLINE:?}; cleanup deadline=500ms; child exit + real EOF + full frame observed, EOF proof transfer suppressed"
            );

            if scenario == Q2WorkerScenario::CleanupUnprovedRestore {
                let core = native_state.switching.core();
                let restore_ticket = match core.begin_transition(AdmissionKind::Restore)? {
                    AdmissionOutcome::Admitted(ticket) => ticket,
                    AdmissionOutcome::NotAdmitted { reason, .. } => {
                        anyhow::bail!("W1 Restore admission unexpectedly failed: {reason:?}")
                    }
                };
                ensure!(
                    restore_ticket.original_binding.as_ref() == Some(&original_binding),
                    "Restore did not capture the quarantined W1 binding"
                );
                let restore_error = match core.physical_exclusive_for_ticket(&restore_ticket) {
                    Err(error) => error,
                    Ok(exclusive) => {
                        drop(exclusive);
                        anyhow::bail!("W1 Restore acquired physical exclusion during quarantine")
                    }
                };
                ensure!(
                    matches!(
                        restore_error,
                        crate::workspace_lifecycle::LifecycleError::ActiveOperations
                    ),
                    "quarantined W1 Restore failed for an unexpected reason: {restore_error:?}"
                );

                // Isolate the retained C-query claim from the disposable DB authority.
                drop(owner);
                drop(authority);
                let active = native_state
                    .inner
                    .lock()
                    .expect("workspace lock")
                    .take();
                drop(active);
                ensure!(
                    authority_weak.upgrade().is_none(),
                    "test still retained the W1 DB authority"
                );
                let lease_error = crate::workspace_lease::acquire_exclusive(
                    &workspace_path,
                    Duration::ZERO,
                )
                .expect_err("cleanup-unproved W1 claim must retain its shared file lease");
                ensure!(
                    lease_error.code() == "WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT",
                    "exclusive lease failed for a reason other than shared-lock contention: {lease_error}"
                );
                eprintln!(
                    "Linux real Q2 quarantine: W1 Restore admission retained, core exclusion refused, DB authority dropped, shared file lease still blocked exclusive acquisition; no Restore DB I/O"
                );
                return Ok(());
            }

            let other_path = std::env::temp_dir().join(format!(
                "nir1-c-capacity-permit-other-{}",
                uuid::Uuid::new_v4()
            ));
            let _other_directory = TestDirectory(other_path.clone());
            let other_authority = crate::state::WorkspaceAuthority::from_database_for_test(
                crate::Database::new(std::path::Path::new(":memory:"))?,
                other_path,
            )?;
            let other_state = WorkspaceState {
                inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&other_authority)))),
                safe_mode: crate::recovery::SafeModeState::default(),
                switching: WorkspaceLifecycleCompatibilityView::new(false),
                open_lock: Mutex::new(Default::default()),
            };
            other_state.switching.core().set_ready(LiveBinding::new(
                other_authority.path().to_string_lossy(),
                format!("other-workspace:{}", other_authority.identity()),
                other_authority.identity(),
                0,
            ))?;
            let mut other_owner = super::c_query_worker::CQueryWorkerOwner::new(
                active_workspace_snapshot(&other_state)?,
                worker_path.clone(),
            );
            let capacity_error = other_owner
                .prepare(&request.project_id)
                .expect_err("detached old owner must retain process capacity");
            ensure!(
                capacity_error
                    .to_string()
                    .contains("NIR1_GRAPH_WORKER_CAPACITY_BUSY")
                    && other_owner.capacity_refusal_left_no_resources_for_test(),
                "distinct workspace reserved storage or spawned while old quarantine held capacity: {capacity_error:#}"
            );
            drop(other_owner);

            let late_error = match owner.query_once(&request) {
                Ok(_) => anyhow::bail!("quarantined owner adopted a late result"),
                Err(error) => error,
            };
            ensure!(
                late_error
                    .to_string()
                    .contains("NIR1_GRAPH_WORKER_ONE_QUERY_ONLY"),
                "quarantined owner accepted another query: {late_error:#}"
            );
            if let Some(claim) = authority.claim_c_query_child() {
                claim.release();
                anyhow::bail!("claim was reloaned before owner Drop");
            }
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0,
                "cleanup-unproved detached the snapshot participant immediately"
            );
            let immediate_reloan_error = match active_workspace_snapshot(&native_state) {
                Ok(_) => anyhow::bail!("same-workspace admission bypassed live quarantine"),
                Err(error) => error,
            };
            ensure!(
                immediate_reloan_error.to_string().contains("WORKSPACE_SWITCHING"),
                "live quarantine did not fence same-workspace admission: {immediate_reloan_error:#}"
            );

            drop(owner);
            let mut owner_after_drop = super::c_query_worker::CQueryWorkerOwner::new(
                active_workspace_snapshot(&other_state)?,
                worker_path.clone(),
            );
            let still_busy = owner_after_drop
                .prepare(&request.project_id)
                .expect_err("dropping the detached query owner must not release its permit");
            ensure!(
                still_busy
                    .to_string()
                    .contains("NIR1_GRAPH_WORKER_CAPACITY_BUSY")
                    && owner_after_drop.capacity_refusal_left_no_resources_for_test(),
                "owner Drop released process capacity before retirement: {still_busy:#}"
            );
            drop(owner_after_drop);
            if let Some(claim) = authority.claim_c_query_child() {
                claim.release();
                anyhow::bail!("claim was reloaned by owner Drop");
            }
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0,
                "detached quarantine must replace, not retain, the snapshot participant"
            );
            let reloan_error = match active_workspace_snapshot(&native_state) {
                Ok(_) => anyhow::bail!("same-workspace snapshot admission bypassed quarantine"),
                Err(error) => error,
            };
            ensure!(
                reloan_error.to_string().contains("WORKSPACE_SWITCHING"),
                "quarantine did not reject same-workspace admission: {reloan_error:#}"
            );
            assert!(
                native_state
                    .switching
                    .core()
                    .set_ready(LiveBinding::new(
                        workspace_path.to_string_lossy(),
                        "test-workspace-reopened",
                        authority.identity().wrapping_add(1),
                        1,
                    ))
                    .is_err(),
                "same-path new authority bypassed quarantine"
            );
            let replacement_path = std::env::temp_dir().join(format!(
                "nir1-c-quarantine-replacement-{}",
                uuid::Uuid::new_v4()
            ));
            let _replacement_directory = TestDirectory(replacement_path.clone());
            let replacement_authority = WorkspaceAuthority::from_database_for_test(
                crate::Database::new(std::path::Path::new(":memory:"))?,
                replacement_path.clone(),
            )?;
            let replacement_workspace_id = "different-test-workspace";
            let replacement_database_file_identity = "different-test-database";
            let replacement_binding = LiveBinding::new(
                replacement_path.to_string_lossy(),
                replacement_workspace_id,
                replacement_authority.identity(),
                1,
            )
            .with_main_database_file_identity(replacement_database_file_identity.to_owned());
            let replacement_locator = replacement_path.to_string_lossy().into_owned();
            let core = native_state.switching.core();
            let transition = match core.begin_open_transition_for_target(
                &replacement_locator,
                Some(replacement_workspace_id),
                Some(replacement_database_file_identity),
                None,
            )? {
                AdmissionOutcome::Admitted(ticket) => ticket,
                AdmissionOutcome::NotAdmitted { .. } => {
                    anyhow::bail!("unrelated workspace transition was blocked")
                }
            };
            let physical_exclusive = core.physical_exclusive_for_ticket(&transition)?;
            eprintln!("Native Q2 cleanup handoff preceded known-distinct W2 protected exclusivity");
            drop(physical_exclusive);
            core.mark_transition_joined(&transition)?;
            let old_active = native_state
                .inner
                .lock()
                .expect("workspace lock")
                .replace(ActiveWorkspace::new(replacement_authority));
            drop(old_active);
            core.activate(
                &transition,
                replacement_binding,
                crate::workspace_lifecycle::ContentEffect::Retained,
            )?;
            drop(authority);
            ensure!(
                authority_weak.upgrade().is_none(),
                "detached child claim still retained the DB/index authority after transition"
            );
            assert!(
                core.set_ready(alias_binding).is_err(),
                "same-file alias with changed metadata bypassed quarantine after old authority drop"
            );
            assert!(
                crate::workspace_lease::acquire_exclusive(&workspace_path, Duration::ZERO,)
                    .is_err(),
                "detached child claim released the original shared file lease"
            );
            return Ok(());
        }

        let authority_strong_count_before_snapshot =
            (scenario == Q2WorkerScenario::NativeOwner).then(|| Arc::strong_count(&authority));
        let snapshot = active_workspace_snapshot(&native_state)?;
        let mut owner =
            super::c_query_worker::CQueryWorkerOwner::new(snapshot, worker_path.clone());
        #[cfg(target_os = "linux")]
        let mut reader_completion_hold = None;
        match scenario {
            Q2WorkerScenario::CallerCancellation => {
                owner.hold_child_before_frame_for_test(
                    directory.0.join("caller-cancel-frame-ready"),
                );
            }
            Q2WorkerScenario::PostAdmissionCrash => {
                owner.crash_after_request_for_test(directory.0.join("post-admission-q2-ready"))
            }
            #[cfg(target_os = "linux")]
            Q2WorkerScenario::RequestWriteCancellation
            | Q2WorkerScenario::RequestWriteDeadline
            | Q2WorkerScenario::RequestWriteChildExit => {
                owner.use_threaded_request_writer_for_test();
                owner.hold_child_before_request_for_test(directory.0.join("request-write-pending"));
            }
            #[cfg(target_os = "linux")]
            Q2WorkerScenario::ResultHeldChildLive
            | Q2WorkerScenario::ResultHeldExitProofUnobserved
            | Q2WorkerScenario::ResultHeldReaderJoinFailure => {
                owner.hold_after_commit_for_test();
                if scenario == Q2WorkerScenario::ResultHeldReaderJoinFailure {
                    owner.panic_reader_after_pipe_for_test();
                }
            }
            #[cfg(target_os = "linux")]
            Q2WorkerScenario::ResultHeldReaderCompletionPending => {
                owner.hold_after_commit_for_test();
                reader_completion_hold = Some(owner.hold_reader_after_eof_for_test());
            }
            #[cfg(target_os = "linux")]
            Q2WorkerScenario::PostCommitNonzero => {
                owner.use_threaded_request_writer_for_test();
                owner.wait_for_child_exit_after_full_request_write_for_test();
            }
            #[cfg(target_os = "linux")]
            Q2WorkerScenario::CommittedFrameWithoutEof => {
                owner.hold_stdout_open_after_commit_for_test()
            }
            Q2WorkerScenario::PartialTerminalMarker => owner.partial_terminal_commit_for_test(),
            Q2WorkerScenario::PartialFrame => owner.partial_frame_for_test(),
            Q2WorkerScenario::TrailingData => owner.trailing_data_for_test(),
            #[cfg(target_os = "linux")]
            Q2WorkerScenario::RustOom => owner.rust_oom_for_test(),
            Q2WorkerScenario::SqlStepsOverCap => owner.sql_steps_over_cap_for_test(),
            Q2WorkerScenario::FrameLengthOverLimit => owner.oversized_frame_for_test(),
            Q2WorkerScenario::SqliteNoMem => owner.sqlite_nomem_for_test(),
            _ => {}
        }
        if scenario == Q2WorkerScenario::StartupRegistrationRefused {
            let error = owner
                .prepare(STARTUP_REFUSAL_PROJECT_ID)
                .expect_err("unregistered project must not report READY");
            let error_text = format!("{error:#}");
            ensure!(
                error_text.contains("NIR1_GRAPH_WORKER_EXIT_BEFORE_READY")
                    && error_text
                        .contains("NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_REFUSED"),
                "Native owner did not capture the fixed registration-refusal diagnostic: {error_text}"
            );
            ensure!(
                owner.cleanup_proved_for_test(),
                "startup refusal returned before child exit, stdout EOF and reader join"
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("proved registration-refusal cleanup did not release the claim")
            })?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0
            );
            eprintln!(
                "Native Q2 startup refusal: canonical registration refusal captured with no private details; child exit + stdout EOF + reader join proved before claim reloan"
            );
            return Ok(());
        }
        let prepare_started = Instant::now();
        owner
            .prepare(&request.project_id)
            .map_err(|error| anyhow::anyhow!("Native Q2 worker startup diagnostic: {error:#}"))?;
        let prepare_elapsed = prepare_started.elapsed();
        if let Some(expected_authority_count) = authority_strong_count_before_snapshot {
            ensure!(
                owner.child_pid_for_test()? > 0,
                "accepted READY did not retain a real child session"
            );
            ensure!(
                Arc::strong_count(&authority) == expected_authority_count,
                "Native Q2 READY owner retained its Authority Arc"
            );
        }
        #[cfg(target_os = "linux")]
        if scenario == Q2WorkerScenario::ChildEnvironment {
            let pid = owner.child_pid_for_test()?;
            ensure!(pid > 0, "accepted READY did not retain a real child session");
            let environ = std::fs::read(format!("/proc/{pid}/environ"))?;
            ensure!(
                environ.is_empty(),
                "worker child inherited {} environment bytes",
                environ.len()
            );
            let cwd = std::fs::read_link(format!("/proc/{pid}/cwd"))?;
            let worker_directory = worker_path
                .parent()
                .ok_or_else(|| anyhow::anyhow!("worker path has no parent directory"))?
                .canonicalize()?;
            ensure!(
                cwd.canonicalize()? == worker_directory,
                "worker child cwd is not the worker directory"
            );
            drop(owner);
            ensure!(
                native_state.switching.core().workspace_participant_count()? == 0,
                "worker child retained a workspace participant after owner drop"
            );
            return Ok(());
        }
        if scenario == Q2WorkerScenario::ProjectedLease {
            let query_started = Instant::now();
            let projection = owner.query_projected(&request, &AtomicBool::new(false))?;
            let query_elapsed = query_started.elapsed();
            ensure!(
                owner.retirement() == super::c_query_worker::CQueryRetirement::Retired,
                "projected query returned before its child was retired"
            );
            ensure!(
                !owner.retirement_pending_for_test(),
                "projected query returned with a pending retirement"
            );
            let claim = authority
                .claim_c_query_child()
                .ok_or_else(|| anyhow::anyhow!("retired query did not release its child claim"))?;
            claim.release();
            ensure!(
                projection.elapsed <= QUERY_DEADLINE,
                "projected query exceeded its deadline: {:?}",
                projection.elapsed
            );
            let expected = canonical_gold_frame
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("independent Q2 worker Gold frame missing"))?;
            ensure!(
                super::worker_frame::encode(&projection.into_response())? == expected,
                "projected Q2 DTO differs from canonical Gold"
            );
            eprintln!(
                "Native Q2 projected lease diagnostic (test instrumentation; diagnostic only): prepare={prepare_elapsed:?}; query_to_dto={query_elapsed:?}"
            );
            return Ok(());
        }
        if scenario == Q2WorkerScenario::PostAdmissionCrash {
            let mut busy_owner = super::c_query_worker::CQueryWorkerOwner::new(
                active_workspace_snapshot(&native_state)?,
                worker_path.clone(),
            );
            let busy_error = busy_owner
                .prepare(&request.project_id)
                .expect_err("post-admission child must retain its authority claim");
            ensure!(
                busy_error.to_string().contains("NIR1_GRAPH_WORKER_BUSY"),
                "post-admission child did not retain capacity: {busy_error:#}"
            );
            drop(busy_owner);

            let crash_error = match owner.query_once(&request) {
                Ok(_) => anyhow::bail!("post-admission child crash returned a result lease"),
                Err(error) => error,
            };
            let crash_text = format!("{crash_error:#}");
            ensure!(
                crash_text.contains("NIR1_GRAPH_TEST_CHILD_CRASH_AFTER_REQUEST")
                    && !crash_text.contains("NIR1_GRAPH_TEST_CHILD_ACK_")
                    && !crash_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
                "fault did not kill the acknowledged child with proved cleanup: {crash_text}"
            );
            ensure!(
                owner.abnormal_exit_observed_for_test(),
                "post-admission fault did not observe an abnormal child exit"
            );
            ensure!(
                owner.cleanup_proved_for_test(),
                "claim release preceded observed child exit, stdout EOF and reader join"
            );
            #[cfg(unix)]
            eprintln!(
                "Native acknowledged post-admission Q2 fault: observed abnormal exit code={:?}, signal={:?}; child exit + stdout EOF + reader join proved before claim reloan",
                owner.abnormal_exit_code_for_test(),
                owner.abnormal_exit_signal_for_test()
            );
            #[cfg(not(unix))]
            eprintln!(
                "Native acknowledged post-admission Q2 fault: observed abnormal exit code={:?}; child exit + stdout EOF + reader join proved before claim reloan",
                owner.abnormal_exit_code_for_test()
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("post-admission cleanup did not release the child claim")
            })?;
            claim.release();
            drop(owner);

            let mut reloan_owner = super::c_query_worker::CQueryWorkerOwner::new(
                active_workspace_snapshot(&native_state)?,
                worker_path.clone(),
            );
            reloan_owner.prepare(&request.project_id).map_err(|error| {
                anyhow::anyhow!("same-authority reloan after acknowledged crash failed: {error:#}")
            })?;
            drop(reloan_owner);
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("same-authority reloan cleanup did not release the child claim")
            })?;
            claim.release();
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0,
                "post-admission crash owner retained its workspace participant"
            );
            return Ok(());
        }
        if scenario == Q2WorkerScenario::RequestWriteQuarantine {
            const REQUEST_WIRE_BYTES: usize = super::c_query_worker::REQUEST_BYTES;
            let mut held_request = request.clone();
            let fixed_bytes = 8 + held_request.project_id.len() + held_request.seed_entity_id.len();
            held_request.query_scene_id = "x".repeat(
                REQUEST_WIRE_BYTES
                    .checked_sub(fixed_bytes)
                    .ok_or_else(|| anyhow::anyhow!("held request fixed fields exceed target"))?,
            );
            let wire_bytes = 8
                + held_request.project_id.len()
                + held_request.query_scene_id.len()
                + held_request.seed_entity_id.len();
            ensure!(
                wire_bytes == REQUEST_WIRE_BYTES,
                "held request wire size changed"
            );
            #[cfg(target_os = "linux")]
            owner.use_threaded_request_writer_for_test();
            let (hold_entered, hold_release, hold_finished) =
                owner.hold_request_writer_after_bytes_for_test(1);
            let cancellation = AtomicBool::new(false);
            let query_error = thread::scope(|scope| -> Result<Option<String>> {
                let entered_for_coordinator = Arc::clone(&hold_entered);
                let cancellation_for_coordinator = &cancellation;
                let authority_for_coordinator = &authority;
                let coordinator = scope.spawn(move || -> Result<()> {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while !entered_for_coordinator.load(Ordering::Acquire) {
                        ensure!(
                            Instant::now() < deadline,
                            "request writer did not enter its post-partial-write test hold"
                        );
                        thread::sleep(Duration::from_millis(1));
                    }
                    ensure!(
                        authority_for_coordinator.claim_c_query_child().is_none(),
                        "child claim was reloaned while the partial request writer was held"
                    );
                    cancellation_for_coordinator.store(true, Ordering::Release);
                    Ok(())
                });
                let query_error =
                    match owner.query_once_with_cancellation(&held_request, &cancellation) {
                        Ok(lease) => {
                            drop(lease);
                            None
                        }
                        Err(error) => Some(format!("{error:#}")),
                    };
                coordinator
                    .join()
                    .map_err(|_| anyhow::anyhow!("request-writer coordinator panicked"))??;
                Ok(query_error)
            })?;
            let error_text = query_error.ok_or_else(|| {
                anyhow::anyhow!("held partial request unexpectedly returned a result lease")
            })?;
            let (written, _) = owner.request_write_diagnostics_for_test();
            let live_writer_at_cleanup = hold_entered.load(Ordering::Acquire)
                && !hold_finished.load(Ordering::Acquire)
                && !owner.request_writer_joined_for_test()
                && owner.live_writer_at_cleanup_timeout_for_test()
                && !owner.cleanup_proved_for_test()
                && owner.quarantined_resources_held_for_test();
            let refused_without_handoff = error_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED")
                && error_text.contains("NIR1_GRAPH_WORKER_CALLER_CANCELLED")
                && error_text.contains("NIR1_GRAPH_WORKER_BOUNDED_JOIN_UNPROVED")
                && !owner.request_handoff_published_for_test()
                && written > 0
                && written < wire_bytes
                && cancellation.load(Ordering::Acquire);
            ensure!(
                refused_without_handoff && live_writer_at_cleanup,
                "cleanup did not quarantine a live unjoined writer after partial-write refusal: {error_text}"
            );
            ensure!(
                authority.claim_c_query_child().is_none(),
                "child claim was reloaned while request-writer quarantine was live"
            );
            drop(owner);
            ensure!(
                authority.claim_c_query_child().is_none(),
                "owner Drop reloaned the quarantined request-writer claim"
            );
            let workspace_reloan_error = match active_workspace_snapshot(&native_state) {
                Ok(_) => anyhow::bail!(
                    "owner Drop released workspace admission during request-writer quarantine"
                ),
                Err(error) => error,
            };
            ensure!(
                workspace_reloan_error.to_string().contains("WORKSPACE_SWITCHING"),
                "request-writer quarantine failed to retain workspace protection: {workspace_reloan_error:#}"
            );

            let other_path = std::env::temp_dir().join(format!(
                "nir1-c-live-writer-quarantine-other-{}",
                uuid::Uuid::new_v4()
            ));
            let _other_directory = TestDirectory(other_path.clone());
            let other_authority = crate::state::WorkspaceAuthority::from_database_for_test(
                crate::Database::new(std::path::Path::new(":memory:"))?,
                other_path,
            )?;
            let other_state = WorkspaceState {
                inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&other_authority)))),
                safe_mode: crate::recovery::SafeModeState::default(),
                switching: WorkspaceLifecycleCompatibilityView::new(false),
                open_lock: Mutex::new(Default::default()),
            };
            other_state.switching.core().set_ready(LiveBinding::new(
                other_authority.path().to_string_lossy(),
                format!("other-workspace:{}", other_authority.identity()),
                other_authority.identity(),
                0,
            ))?;
            let mut replacement_owner = super::c_query_worker::CQueryWorkerOwner::new(
                active_workspace_snapshot(&other_state)?,
                worker_path.clone(),
            );
            let replacement_error = replacement_owner
                .prepare(&request.project_id)
                .expect_err("request-writer quarantine must retain the process slot");
            ensure!(
                replacement_error
                    .to_string()
                    .contains("NIR1_GRAPH_WORKER_CAPACITY_BUSY")
                    && replacement_owner.capacity_refusal_left_no_resources_for_test(),
                "replacement admission bypassed request-writer quarantine: {replacement_error:#}"
            );
            drop(replacement_owner);
            hold_release.store(true, Ordering::Release);
            let writer_finish_deadline = Instant::now() + Duration::from_secs(2);
            while !hold_finished.load(Ordering::Acquire) && Instant::now() < writer_finish_deadline
            {
                thread::sleep(Duration::from_millis(1));
            }
            ensure!(
                hold_finished.load(Ordering::Acquire),
                "test-released detached request writer did not finish"
            );
            eprintln!(
                "Real-worker request-writer quarantine: partial write refused without OWNER_REQUEST/lease; bounded cleanup retained the live unjoined writer, claim, slot and workspace fence; owner Drop did not admit a replacement"
            );
            return Ok(());
        }

        #[cfg(target_os = "linux")]
        if matches!(
            scenario,
            Q2WorkerScenario::RequestWriteCancellation
                | Q2WorkerScenario::RequestWriteDeadline
                | Q2WorkerScenario::RequestWriteChildExit
        ) {
            const REQUEST_WIRE_BYTES: usize = super::c_query_worker::REQUEST_BYTES;
            let pipe_capacity = owner.shrink_stdin_pipe_for_test(4_096)?;
            let mut blocked_request = request.clone();
            let fixed_bytes =
                8 + blocked_request.project_id.len() + blocked_request.seed_entity_id.len();
            let scene_bytes = REQUEST_WIRE_BYTES
                .checked_sub(fixed_bytes)
                .ok_or_else(|| anyhow::anyhow!("blocked request fixed fields exceed target"))?;
            blocked_request.query_scene_id = "x".repeat(scene_bytes);
            let wire_bytes = 8
                + blocked_request.project_id.len()
                + blocked_request.query_scene_id.len()
                + blocked_request.seed_entity_id.len();
            let capacity_bytes = blocked_request
                .project_id
                .capacity()
                .checked_add(blocked_request.query_scene_id.capacity())
                .and_then(|bytes| bytes.checked_add(blocked_request.seed_entity_id.capacity()))
                .ok_or_else(|| anyhow::anyhow!("blocked request capacities overflow"))?;
            ensure!(
                wire_bytes == REQUEST_WIRE_BYTES,
                "blocked request wire size changed"
            );
            ensure!(
                capacity_bytes <= super::c_query_worker::REQUEST_BYTES
                    && pipe_capacity < wire_bytes,
                "request/pipe sizes do not force backpressure: request={wire_bytes}, capacities={capacity_bytes}, pipe={pipe_capacity}"
            );
            let blocked_signal = owner.observe_request_write_blocked_for_test(pipe_capacity);
            let child_pid = owner.child_pid_for_test()?;
            let marker = directory.0.join("request-write-pending");
            let cancellation = AtomicBool::new(false);
            let query_error = thread::scope(|scope| -> Result<Option<String>> {
                let cancellation_for_coordinator = &cancellation;
                let blocked_for_coordinator = Arc::clone(&blocked_signal);
                let authority_for_coordinator = &authority;
                let coordinator = scope.spawn(move || -> Result<()> {
                    let marker_deadline = Instant::now() + Duration::from_secs(5);
                    while !marker.is_file() {
                        if Instant::now() >= marker_deadline {
                            unsafe { libc::kill(child_pid as libc::pid_t, libc::SIGKILL) };
                            anyhow::bail!("worker did not reach its pre-request barrier");
                        }
                        thread::sleep(Duration::from_millis(1));
                    }
                    ensure!(
                        std::fs::read(&marker)?.as_slice() == b"request-pending",
                        "worker pre-request marker was incomplete"
                    );
                    ensure!(
                        authority_for_coordinator.claim_c_query_child().is_none(),
                        "child claim was reloaned while the request write was pending"
                    );
                    let blocked_deadline = Instant::now() + Duration::from_secs(2);
                    while !blocked_for_coordinator.load(Ordering::Acquire) {
                        if Instant::now() >= blocked_deadline {
                            unsafe { libc::kill(child_pid as libc::pid_t, libc::SIGKILL) };
                            anyhow::bail!(
                                "Native request writer did not stall after a partial write"
                            );
                        }
                        thread::sleep(Duration::from_millis(1));
                    }
                    match scenario {
                        Q2WorkerScenario::RequestWriteCancellation => {
                            cancellation_for_coordinator.store(true, Ordering::Release);
                        }
                        Q2WorkerScenario::RequestWriteDeadline => {}
                        Q2WorkerScenario::RequestWriteChildExit => {
                            ensure!(
                                unsafe { libc::kill(child_pid as libc::pid_t, libc::SIGKILL) } == 0,
                                "could not terminate stalled worker: {}",
                                std::io::Error::last_os_error()
                            );
                        }
                        _ => anyhow::bail!("unexpected request-write scenario"),
                    }
                    Ok(())
                });
                let query_error =
                    match owner.query_once_with_cancellation(&blocked_request, &cancellation) {
                        Ok(lease) => {
                            drop(lease);
                            None
                        }
                        Err(error) => Some(format!("{error:#}")),
                    };
                coordinator
                    .join()
                    .map_err(|_| anyhow::anyhow!("request-write coordinator panicked"))??;
                Ok(query_error)
            })?;
            let error_text = query_error.ok_or_else(|| {
                anyhow::anyhow!("stalled request write unexpectedly returned a result lease")
            })?;
            let expected_reason = match scenario {
                Q2WorkerScenario::RequestWriteCancellation => "NIR1_GRAPH_WORKER_CALLER_CANCELLED",
                Q2WorkerScenario::RequestWriteDeadline => {
                    "NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME"
                }
                Q2WorkerScenario::RequestWriteChildExit => "NIR1_GRAPH_WORKER_EXIT_DURING_REQUEST",
                _ => unreachable!(),
            };
            ensure!(
                error_text.contains(expected_reason)
                    && !error_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
                "backpressured request returned the wrong failure or unproved cleanup: {error_text}"
            );
            let (written, stalled) = owner.request_write_diagnostics_for_test();
            ensure!(
                stalled && written > 0 && written < wire_bytes,
                "test did not prove a partial stalled write: bytes={written}, total={wire_bytes}, stalled={stalled}"
            );
            ensure!(
                !owner.request_handoff_published_for_test(),
                "partial request was published to the pipe reader"
            );
            ensure!(
                (scenario == Q2WorkerScenario::RequestWriteCancellation)
                    == cancellation.load(Ordering::Acquire),
                "caller cancellation signal did not match the test case"
            );
            ensure!(
                owner.cleanup_proved_for_test()
                    && owner.abnormal_exit_observed_for_test()
                    && owner.request_writer_joined_for_test(),
                "backpressure refusal preceded writer join, child exit, stdout EOF and reader join"
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("proved request-write cleanup did not release the child claim")
            })?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0,
                "retired request-write owner retained its workspace participant"
            );
            eprintln!(
                "Linux analogue of non-Linux threaded request write: {expected_reason}; wrote {written}/{wire_bytes}, stalled without OWNER_REQUEST, and proved writer join + exit + EOF + reader join before reloan"
            );
            return Ok(());
        }
        if scenario == Q2WorkerScenario::CallerCancellation {
            let cancellation = AtomicBool::new(false);
            let marker = directory.0.join("caller-cancel-frame-ready");
            let query_error = thread::scope(|scope| -> Result<Option<String>> {
                let cancellation_for_coordinator = &cancellation;
                let authority_for_coordinator = &authority;
                let coordinator = scope.spawn(move || -> Result<()> {
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while !marker.is_file() {
                        ensure!(
                            Instant::now() < deadline,
                            "child did not reach its post-admission/pre-frame barrier"
                        );
                        thread::sleep(Duration::from_millis(1));
                    }
                    ensure!(
                        std::fs::read(&marker)?.as_slice() == b"q2-frame-pending",
                        "child barrier marker was incomplete"
                    );
                    ensure!(
                        authority_for_coordinator.claim_c_query_child().is_none(),
                        "child claim was reloaned while the admitted child remained blocked"
                    );
                    cancellation_for_coordinator.store(true, Ordering::Release);
                    Ok(())
                });
                let query_error = match owner.query_once_with_cancellation(&request, &cancellation)
                {
                    Ok(lease) => {
                        drop(lease);
                        None
                    }
                    Err(error) => Some(format!("{error:#}")),
                };
                coordinator
                    .join()
                    .map_err(|_| anyhow::anyhow!("caller-cancellation coordinator panicked"))??;
                Ok(query_error)
            })?;
            let error_text = query_error.ok_or_else(|| {
                anyhow::anyhow!("cancelled real Q2 query returned a result lease")
            })?;
            ensure!(
                error_text.contains("NIR1_GRAPH_WORKER_CALLER_CANCELLED")
                    && !error_text.contains("NIR1_GRAPH_QUERY_DEADLINE")
                    && !error_text.contains("NIR1_GRAPH_TEST_CHILD_CRASH_AFTER_REQUEST"),
                "in-flight caller cancellation was confused with deadline/fault: {error_text}"
            );
            ensure!(
                cancellation.load(Ordering::Acquire),
                "caller cancellation signal was not raised after child admission"
            );
            ensure!(
                owner.cleanup_proved_for_test() && owner.abnormal_exit_observed_for_test(),
                "caller cancellation returned before child exit, stdout EOF and reader join"
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("proved cancellation cleanup did not release the child claim")
            })?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0,
                "cancelled owner retained its workspace participant after retirement"
            );
            eprintln!(
                "Native real-Q2 caller cancellation: nonempty Q2 result reached post-admission/pre-frame barrier; distinct refusal; child exit + stdout EOF + reader join proved before child-claim reloan"
            );
            return Ok(());
        }
        if scenario == Q2WorkerScenario::FrameLengthOverLimit {
            const REQUEST_BYTES: usize = super::c_query_worker::REQUEST_BYTES;
            let mut oversized_request = request.clone();
            let fixed_bytes =
                8 + oversized_request.project_id.len() + oversized_request.seed_entity_id.len();
            let scene_bytes = REQUEST_BYTES
                .checked_add(1)
                .and_then(|target| target.checked_sub(fixed_bytes))
                .ok_or_else(|| anyhow::anyhow!("cannot construct exact N+1 request"))?;
            oversized_request.query_scene_id = "x".repeat(scene_bytes);
            let wire_bytes = 8
                + oversized_request.project_id.len()
                + oversized_request.query_scene_id.len()
                + oversized_request.seed_entity_id.len();
            let capacity_bytes = oversized_request
                .project_id
                .capacity()
                .checked_add(oversized_request.query_scene_id.capacity())
                .and_then(|bytes| bytes.checked_add(oversized_request.seed_entity_id.capacity()))
                .ok_or_else(|| anyhow::anyhow!("request capacity overflow"))?;
            ensure!(
                wire_bytes == REQUEST_BYTES + 1 && capacity_bytes <= REQUEST_BYTES,
                "request boundary fixture was not exactly N+1: wire={wire_bytes}, capacity={capacity_bytes}"
            );
            ensure!(owner.child_pid_for_test()? > 0, "Q2 child was not READY");
            let request_error = match owner.query_once(&oversized_request) {
                Ok(lease) => {
                    drop(lease);
                    anyhow::bail!("N+1 request unexpectedly produced a Native result lease")
                }
                Err(error) => format!("{error:#}"),
            };
            ensure!(
                request_error.contains("NIR1_GRAPH_WORKER_REQUEST_LIMIT")
                    && !request_error.contains("REQUEST_CAPACITY_LIMIT")
                    && !request_error.contains("QUERY_DEADLINE")
                    && !owner.request_handoff_published_for_test()
                    && !owner.retirement_pending_for_test(),
                "N+1 request was not rejected by pre-handoff length validation: {request_error}"
            );

            let frame_error = match owner.query_once(&request) {
                Ok(lease) => {
                    drop(lease);
                    anyhow::bail!("N+1 frame declaration unexpectedly produced a Native lease")
                }
                Err(error) => format!("{error:#}"),
            };
            ensure!(
                frame_error.contains("NIR1_GRAPH_FRAME_LIMIT")
                    && !frame_error.contains("QUERY_DEADLINE")
                    && !frame_error.contains("PIPE_TRUNCATED")
                    && !owner.retirement_pending_for_test(),
                "N+1 frame declaration did not produce a boundary-specific no-lease refusal: {frame_error}"
            );
            let frame_state = owner.oversized_frame_refusal_state_for_test();
            ensure!(
                owner.oversized_frame_refused_before_body_for_test(),
                "Native read or published a frame body after the N+1 length header: events={:#x}, mailbox frame_len={}, result_len={}",
                frame_state.0,
                frame_state.1,
                frame_state.2
            );
            ensure!(
                owner.cleanup_proved_for_test(),
                "frame-limit refusal preceded child exit, stdout EOF, and reader join"
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("proved frame-limit cleanup did not release the child claim")
            })?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0,
                "frame-limit refusal retained the workspace participant"
            );
            eprintln!(
                "Native Q2 boundaries: exact {}/{}-byte request refused before OWNER_REQUEST/no lease; canonical child then advertised frame length {} with header only, Native returned FRAME_LIMIT without body read/frame publication/lease, and exit + EOF + reader join preceded claim release",
                REQUEST_BYTES + 1,
                REQUEST_BYTES,
                super::c_query_worker::FRAME_BYTES + 1
            );
            return Ok(());
        }
        if scenario == Q2WorkerScenario::SqlStepsOverCap {
            let error = match owner.query_once(&request) {
                Ok(lease) => {
                    drop(lease);
                    anyhow::bail!("over-cap SQL unexpectedly returned a Native result lease")
                }
                Err(error) => error,
            };
            let error_text = format!("{error:#}");
            ensure!(
                error_text.contains("NIR1_GRAPH_WORKER_UNAVAILABLE")
                    && error_text.contains(
                        "query-worker-post-stamp-steps-pre-cleanup-work-failed-steps"
                    )
                    && !error_text.contains("deadline")
                    && !error_text.contains("record-limit")
                    && !error_text.contains("sqlite-nomem")
                    && !error_text.contains("NIR1_GRAPH_WORKER_PIPE")
                    && !error_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
                "Native did not report the actual over-cap SQL refusal without a confound: {error_text}"
            );
            ensure!(
                owner.cleanup_proved_for_test(),
                "SQL-step refusal preceded actual child exit, stdout EOF, and reader join"
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("proved SQL-step refusal cleanup did not release the child claim")
            })?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0,
                "SQL-step refusal retained the workspace participant after retirement"
            );
            eprintln!(
                "Native Q2 actual-SQL over-cap refusal: unavailable frame mapped to no lease; reason=query-worker-post-stamp-steps-pre-cleanup-work-failed-steps; child exit + stdout EOF + reader join proved before claim reloan"
            );
            return Ok(());
        }
        if scenario == Q2WorkerScenario::SqliteNoMem {
            let (error, returned_elapsed) = {
                let call_started = Instant::now();
                let error = match owner.query_once(&request) {
                    Ok(lease) => {
                        drop(lease);
                        anyhow::anyhow!("real child SQLite NOMEM returned a result lease")
                    }
                    Err(error) => error,
                };
                (error, call_started.elapsed())
            };
            let error_text = format!("{error:#}");
            ensure!(
                [
                    "NIR1_GRAPH_WORKER_PIPE_TRUNCATED",
                    "NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME",
                ]
                .iter()
                .any(|reason| error_text.contains(reason))
                    && !error_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
                "Native did not cleanly refuse the SQLite NOMEM child: {error_text}"
            );
            ensure!(
                owner.abnormal_exit_observed_for_test()
                    && owner.abnormal_exit_code_for_test() == Some(26),
                "child did not exit with the SQLite SQLITE_NOMEM proof code: abnormal={}, code={:?}",
                owner.abnormal_exit_observed_for_test(),
                owner.abnormal_exit_code_for_test()
            );
            ensure!(
                owner.cleanup_proved_for_test(),
                "claim release preceded actual child exit, stdout EOF, and reader join"
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("proved SQLite NOMEM cleanup did not release the worker claim")
            })?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0
            );
            eprintln!(
                "Native real-child SQLite NOMEM: no lease; SQLite SQLITE_NOMEM exit code 26 + stdout EOF + reader join proved before claim reloan; call-to-refusal={returned_elapsed:?} (diagnostic only)"
            );
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        if scenario == Q2WorkerScenario::RustOom {
            let (error, returned_elapsed) = {
                let call_started = Instant::now();
                let error = match owner.query_once(&request) {
                    Ok(lease) => {
                        drop(lease);
                        anyhow::anyhow!("real Rust allocator OOM returned a result lease")
                    }
                    Err(error) => error,
                };
                (error, call_started.elapsed())
            };
            let error_text = format!("{error:#}");
            ensure!(
                [
                    "NIR1_GRAPH_WORKER_PIPE_TRUNCATED",
                    "NIR1_GRAPH_QUERY_DEADLINE_NO_TIMELY_FRAME",
                ]
                .iter()
                .any(|reason| error_text.contains(reason))
                    && !error_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
                "real child OOM was not cleanly refused: {error_text}"
            );
            let abnormal_exit = owner.abnormal_exit_observed_for_test();
            let exit_code = owner.abnormal_exit_code_for_test();
            let exit_signal = owner.abnormal_exit_signal_for_test();
            ensure!(
                abnormal_exit
                    && exit_code.is_none()
                    && exit_signal == Some(libc::SIGABRT),
                "worker did not terminate by observed Linux SIGABRT after allocation failure: abnormal={abnormal_exit}, code={exit_code:?}, signal={exit_signal:?}"
            );
            ensure!(
                owner.cleanup_proved_for_test(),
                "OOM claim release preceded actual child exit, stdout EOF, and reader join"
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("proved Rust OOM cleanup did not release the worker claim")
            })?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0
            );
            eprintln!(
                "Native real child Rust OOM: no lease; observed SIGABRT + stdout EOF + reader join before claim reloan; call-to-refusal={returned_elapsed:?} (diagnostic only)"
            );
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        if scenario == Q2WorkerScenario::CommittedFrameWithoutEof {
            let (error, returned_elapsed) = {
                let call_started = Instant::now();
                let error = match owner.query_once(&request) {
                    Ok(lease) => {
                        drop(lease);
                        anyhow::anyhow!("committed frame without EOF produced a result lease")
                    }
                    Err(error) => error,
                };
                (error, call_started.elapsed())
            };
            ensure!(
                owner.frame_commit_observed_within_deadline_for_test(),
                "Native did not observe FRAME+COMMIT inside the 100ms query loop"
            );
            let error_text = format!("{error:#}");
            ensure!(
                error_text.contains("NIR1_GRAPH_QUERY_DEADLINE_AFTER_TIMELY_FRAME_RETURN")
                    && !error_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
                "missing EOF was not refused after timely frame validation: {error_text}"
            );
            ensure!(
                owner.missing_eof_boundary_observed_before_cleanup_for_test(),
                "before cleanup, Native did not observe a timely request-bound Q2 FRAME+COMMIT without EOF, a timely validation, no lease, and a live child"
            );
            ensure!(
                returned_elapsed > QUERY_DEADLINE,
                "deadline refusal omitted bounded cleanup time: {returned_elapsed:?}"
            );
            ensure!(
                owner.cleanup_proved_for_test()
                    && owner.abnormal_exit_observed_for_test()
                    && owner.abnormal_exit_code_for_test().is_none()
                    && owner.abnormal_exit_signal_for_test() == Some(libc::SIGKILL),
                "missing-EOF refusal returned before SIGKILL + EOF + reader join proof"
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("proved missing-EOF cleanup did not release the child claim")
            })?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0
            );
            eprintln!(
                "Native Q2 missing-EOF refusal: timely request-bound Q2 frame + NQGC1 observed without EOF and without a lease; SIGKILL + EOF + reader join proved before claim reloan; call-to-refusal={returned_elapsed:?}"
            );
            return Ok(());
        }
        if matches!(
            scenario,
            Q2WorkerScenario::PartialTerminalMarker
                | Q2WorkerScenario::PartialFrame
                | Q2WorkerScenario::TrailingData
        ) {
            let (error, returned_elapsed) = {
                let call_started = Instant::now();
                let error = match owner.query_once(&request) {
                    Ok(lease) => {
                        drop(lease);
                        anyhow::anyhow!("malformed Q2 response produced a result lease")
                    }
                    Err(error) => error,
                };
                (error, call_started.elapsed())
            };
            let error_text = format!("{error:#}");
            let (expected_error, observation, failure_label) = match scenario {
                Q2WorkerScenario::PartialTerminalMarker => (
                    "NIR1_GRAPH_WORKER_PIPE_TRUNCATED",
                    owner.available_request_bound_q2_frame_observed_for_test(),
                    "partial terminal marker",
                ),
                Q2WorkerScenario::PartialFrame => (
                    "NIR1_GRAPH_WORKER_PIPE_TRUNCATED",
                    owner.partial_frame_failure_kept_claim_for_test(),
                    "partial declared frame body",
                ),
                Q2WorkerScenario::TrailingData => (
                    "NIR1_GRAPH_WORKER_TRAILING_PIPE_DATA",
                    owner.committed_request_bound_q2_frame_with_trailing_observed_for_test(),
                    "trailing data after terminal commit",
                ),
                _ => unreachable!("handled only refusal scenarios"),
            };
            ensure!(
                error_text.contains(expected_error)
                    && !error_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
                "{failure_label} was not cleanly refused: {error_text}"
            );
            ensure!(
                observation,
                "Native did not observe the expected rejection while retaining the claim for {failure_label}"
            );
            ensure!(
                owner.cleanup_proved_for_test(),
                "trailing-data refusal returned before actual child exit, EOF, and reader join were proved"
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("proved malformed-frame cleanup did not release the child claim")
            })?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0
            );
            eprintln!(
                "Native Q2 {failure_label}: no lease; scenario-specific Native refusal observed; cleanup proof passed before child-claim reloan; call-to-refusal={returned_elapsed:?}"
            );
            return Ok(());
        }
        let call_started = Instant::now();
        let query_result = owner.query_once(&request);
        let returned_elapsed = call_started.elapsed();
        if query_result.is_err() {
            let error = query_result
                .err()
                .ok_or_else(|| anyhow::anyhow!("Q2 diagnostic result changed"))?;
            let phases = owner.query_phase_diagnostics_for_test();
            eprintln!(
                "Native Q2 worker phase diagnostic (test instrumentation; diagnostic only): call_entry_to_return={returned_elapsed:?}; admission_to_lease=None; outcome=refused; phases={phases:?}"
            );
            return Err(error);
        }
        let mut lease = query_result?;
        ensure!(
            lease.retirement_pending_for_test(),
            "successful result lease waited for child retirement"
        );
        let admission_elapsed = lease.elapsed();
        #[cfg(target_os = "linux")]
        if matches!(
            scenario,
            Q2WorkerScenario::ResultHeldChildLive
                | Q2WorkerScenario::ResultHeldExitProofUnobserved
                | Q2WorkerScenario::ResultHeldReaderJoinFailure
                | Q2WorkerScenario::ResultHeldReaderCompletionPending
        ) {
            ensure!(
                returned_elapsed <= QUERY_DEADLINE
                    && lease.elapsed() <= QUERY_DEADLINE,
                "committed live-child lease missed the fixed deadline: call={returned_elapsed:?}, admission={:?}",
                lease.elapsed()
            );
            ensure!(
                lease.retirement_pending_for_test()
                    && lease.committed_eof_with_reader_pending_for_test()
                    && lease.child_exit_unobserved_for_test()?,
                "ResultHeld did not retain a committed EOF lease while child exit was unobserved"
            );
            {
                let frame = lease.frame()?;
                seed_only_frame_graph(&frame, PROJECT, QUERY_SCENE, ENTITY)?;
            }
            ensure!(
                authority.claim_c_query_child().is_none(),
                "child claim was reloaned while ResultHeld child exit was unproved"
            );
            #[cfg(target_os = "linux")]
            if scenario == Q2WorkerScenario::ResultHeldReaderJoinFailure {
                drop(lease);
                ensure!(
                    !owner.cleanup_proved_for_test()
                        && owner.result_lease_reader_join_quarantined_for_test(),
                    "ResultHeld lease drop reloaned resources after reader join failure"
                );
                ensure!(
                    authority.claim_c_query_child().is_none(),
                    "claim was reloaned after failed reader join"
                );
                assert_eq!(
                    native_state
                        .switching
                        .core()
                        .workspace_participant_count()?,
                    0,
                    "reader-join quarantine did not detach the snapshot participant"
                );
                drop(owner);
                ensure!(
                    authority.claim_c_query_child().is_none(),
                    "owner Drop reloaned a claim after failed reader join"
                );
                assert_eq!(
                    native_state
                        .switching
                        .core()
                        .workspace_participant_count()?,
                    0,
                    "detached reader-join quarantine retained the snapshot participant"
                );
                let reloan_error = match active_workspace_snapshot(&native_state) {
                    Ok(_) => {
                        anyhow::bail!("reader-join quarantine permitted same-workspace reloan")
                    }
                    Err(error) => error,
                };
                ensure!(
                    reloan_error.to_string().contains("WORKSPACE_SWITCHING"),
                    "same-workspace reloan was not rejected: {reloan_error:#}"
                );
                eprintln!(
                    "Native ResultHeld reader-join failure: committed Q2 lease returned with real EOF/live child; cleanup observed child exit + EOF but the actual reader thread panicked on join; resources quarantined and no claim reloaned"
                );
                return Ok(());
            }
            #[cfg(target_os = "linux")]
            if scenario == Q2WorkerScenario::ResultHeldReaderCompletionPending {
                let (reader_entered, reader_release, reader_finished) = reader_completion_hold
                    .take()
                    .ok_or_else(|| anyhow::anyhow!("reader completion hold missing"))?;
                let entry_deadline = Instant::now() + Duration::from_secs(5);
                while !reader_entered.load(Ordering::Acquire) && Instant::now() < entry_deadline {
                    thread::park_timeout(Duration::from_millis(1));
                }
                let entered_before_cleanup = reader_entered.load(Ordering::Acquire);
                let cleanup_started = Instant::now();
                drop(lease);
                let cleanup_elapsed = cleanup_started.elapsed();
                let reader_was_pending = !reader_finished.load(Ordering::Acquire);
                let timeout_quarantine =
                    owner.result_lease_reader_completion_quarantined_for_test();
                let claim_retained = authority.claim_c_query_child().is_none();
                reader_release.store(true, Ordering::Release);
                let reader_finish_deadline = Instant::now() + Duration::from_secs(5);
                while !reader_finished.load(Ordering::Acquire)
                    && Instant::now() < reader_finish_deadline
                {
                    thread::park_timeout(Duration::from_millis(1));
                }
                ensure!(
                    entered_before_cleanup && reader_was_pending,
                    "reader did not remain unfinished after publishing EOF"
                );
                ensure!(
                    timeout_quarantine && !owner.cleanup_proved_for_test(),
                    "reader completion timeout did not retain owner resources in quarantine"
                );
                ensure!(
                    claim_retained,
                    "child claim was released before reader completion"
                );
                ensure!(
                    reader_finished.load(Ordering::Acquire),
                    "test-held reader did not finish after quarantine was asserted"
                );
                assert_eq!(
                    native_state
                        .switching
                        .core()
                        .workspace_participant_count()?,
                    0,
                    "reader-completion quarantine retained an active snapshot participant"
                );
                drop(owner);
                ensure!(
                    authority.claim_c_query_child().is_none(),
                    "owner Drop released a claim after reader-completion timeout"
                );
                let reloan_error = match active_workspace_snapshot(&native_state) {
                    Ok(_) => anyhow::bail!(
                        "reader-completion quarantine permitted same-workspace reloan"
                    ),
                    Err(error) => error,
                };
                ensure!(
                    reloan_error.to_string().contains("WORKSPACE_SWITCHING"),
                    "same-workspace reloan was not rejected: {reloan_error:#}"
                );
                eprintln!(
                    "Native ResultHeld EOF-before-reader-completion: cleanup returned after {cleanup_elapsed:?}; actual child exit + EOF observed but reader remained unfinished, so owner/claim/slot/workspace fence stayed quarantined"
                );
                return Ok(());
            }
            #[cfg(target_os = "linux")]
            if scenario == Q2WorkerScenario::ResultHeldExitProofUnobserved {
                lease.suppress_exit_proof_for_test();
                drop(lease);
                ensure!(
                    !owner.cleanup_proved_for_test()
                        && owner.result_lease_exit_proof_quarantined_for_test(),
                    "ResultHeld lease drop released resources without transferred child exit proof"
                );
                ensure!(
                    authority.claim_c_query_child().is_none(),
                    "claim was reloaned despite missing exit proof"
                );
                assert_eq!(
                    native_state
                        .switching
                        .core()
                        .workspace_participant_count()?,
                    0,
                    "quarantine did not detach the workspace snapshot"
                );
                drop(owner);
                ensure!(
                    authority.claim_c_query_child().is_none(),
                    "owner Drop reloaned a claim without exit proof"
                );
                assert_eq!(
                    native_state
                        .switching
                        .core()
                        .workspace_participant_count()?,
                    0,
                    "detached quarantine retained the snapshot participant"
                );
                let reloan_error = match active_workspace_snapshot(&native_state) {
                    Ok(_) => anyhow::bail!("quarantine permitted same-workspace reloan"),
                    Err(error) => error,
                };
                ensure!(
                    reloan_error.to_string().contains("WORKSPACE_SWITCHING"),
                    "same-workspace reloan was not rejected: {reloan_error:#}"
                );
                eprintln!(
                    "Native ResultHeld exit-proof failure: committed current-bound Q2 lease returned with real EOF/live child; exit-status transfer suppressed during lease drop; resources quarantined and no claim reloaned"
                );
                return Ok(());
            }
            drop(lease);
            ensure!(
                owner.cleanup_proved_for_test()
                    && owner.abnormal_exit_observed_for_test()
                    && owner.abnormal_exit_code_for_test().is_none()
                    && owner.abnormal_exit_signal_for_test() == Some(libc::SIGKILL),
                "lease drop released capacity without actual child exit + EOF + reader join"
            );
            let claim = authority.claim_c_query_child().ok_or_else(|| {
                anyhow::anyhow!("proved ResultHeld retirement did not release claim")
            })?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0
            );
            eprintln!(
                "Native ResultHeld live child: committed Q2 lease returned before exit proof; SIGKILL exit + EOF + reader join observed on lease drop before claim reloan; call_entry_to_lease={returned_elapsed:?}"
            );
            return Ok(());
        }
        if scenario == Q2WorkerScenario::PostCommitNonzero {
            ensure!(
                returned_elapsed <= QUERY_DEADLINE
                    && admission_elapsed <= QUERY_DEADLINE,
                "terminal-commit lease missed its 100ms deadline: call={returned_elapsed:?}, admission={admission_elapsed:?}"
            );
            ensure!(
                lease.committed_eof_with_reader_pending_for_test(),
                "lease lacked a complete committed frame, real EOF, or owned reader"
            );
            {
                let frame = lease.frame()?;
                seed_only_frame_graph(&frame, PROJECT, QUERY_SCENE, ENTITY)?;
            }
            lease.wait_for_child_exit_code_for_test(23)?;
            ensure!(
                lease.retirement_pending_for_test()
                    && lease.committed_eof_with_reader_pending_for_test(),
                "child retirement proofs released the held lease or reader early"
            );
            ensure!(
                authority.claim_c_query_child().is_none(),
                "child claim was reloaned while committed lease remained held"
            );
            drop(lease);
            #[cfg(target_os = "linux")]
            ensure!(
                owner.child_exit_observed_before_request_handoff_for_test(),
                "writer did not observe child exit after a full transfer and before OWNER_REQUEST"
            );
            ensure!(
                owner.cleanup_proved_for_test()
                    && owner.abnormal_exit_observed_for_test()
                    && owner.abnormal_exit_code_for_test() == Some(23)
                    && owner.request_writer_joined_for_test(),
                "lease drop released capacity before writer join, nonzero exit, EOF, and reader join proof"
            );
            let claim = authority
                .claim_c_query_child()
                .ok_or_else(|| anyhow::anyhow!("retired result lease did not release capacity"))?;
            claim.release();
            drop(owner);
            assert_eq!(
                native_state
                    .switching
                    .core()
                    .workspace_participant_count()?,
                0
            );
            eprintln!(
                "Native postcommit nonzero child: call_entry_to_lease={returned_elapsed:?}; admission_to_lease={admission_elapsed:?}; exit=23; EOF/reader join proved before claim reloan"
            );
            return Ok(());
        }
        let phases = lease.query_phase_diagnostics_for_test();
        eprintln!(
            "Native Q2 worker phase diagnostic (test instrumentation; diagnostic only): call_entry_to_return={returned_elapsed:?}; admission_to_lease={admission_elapsed:?}; outcome=lease; phases={phases:?}"
        );
        ensure!(
            returned_elapsed <= QUERY_DEADLINE,
            "Native Q2 worker returned after deadline: {returned_elapsed:?}"
        );
        ensure!(
            admission_elapsed <= QUERY_DEADLINE,
            "Native Q2 worker admission deadline: {admission_elapsed:?}"
        );
        if scenario == Q2WorkerScenario::NativeOwner {
            let expected = canonical_gold_frame
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("independent Q2 worker Gold frame missing"))?;
            assert_eq!(
                lease.validated_frame_bytes_for_test()?,
                expected,
                "complete Native Q2 worker frame differs from canonical Gold"
            );
        }
        {
            let frame = lease.frame()?;
            let graph = seed_only_frame_graph(&frame, PROJECT, QUERY_SCENE, ENTITY)?;
            let node = single_record(graph.nodes())?;
            assert_eq!(node.hop, 0);
            assert_eq!(node.entity.id, ENTITY);
            assert_eq!(node.entity.kind, "character");
            assert_eq!(node.entity.label, ENTITY);
            assert_eq!(
                node.entity.source,
                format!("codex:{ENTITY}@2026-09-17T00:00:00Z")
            );
            assert!(
                matches!(node.entity.scope.reading, super::worker_frame::ScopeView::Exact(value) if value == format!("scene:{SOURCE_SCENE}"))
            );
            assert_eq!(node.entity.evidence_count(), 1);
            let evidence = single_record(node.entity.evidence())?;
            assert_eq!(evidence.id, format!("nir1:capacity:evidence:0:{ENTITY}"));
            assert_eq!(evidence.source, format!("codex:{ENTITY}"));
            assert_eq!(evidence.quote, format!("fixture source {ENTITY} 日本語"));
            assert_eq!(evidence.start, 0);
            assert_eq!(evidence.end as usize, evidence.quote.encode_utf16().count());
            assert_eq!(node.binding_count(), 1);
            let binding = single_record(node.bindings())?;
            assert_eq!(binding.revision_id, revision);
            assert!(!binding.decision_id.is_empty());
        }
        assert!(
            authority.claim_c_query_child().is_none(),
            "result lease released Native capacity early"
        );
        let mut competing_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        let competing_error = competing_owner
            .prepare(&request.project_id)
            .expect_err("another worker must not start while a result lease is held");
        assert!(
            competing_error
                .to_string()
                .contains("NIR1_GRAPH_WORKER_BUSY"),
            "second actual owner was not rejected by the authority claim: {competing_error:#}"
        );
        drop(competing_owner);
        let restore_ticket = match native_state
            .switching
            .core()
            .begin_transition(AdmissionKind::Restore)?
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { reason, .. } => {
                anyhow::bail!(
                    "Restore was not admitted while the result lease was held: {reason:?}"
                )
            }
        };
        let exclusivity_error = match native_state
            .switching
            .core()
            .physical_exclusive_for_ticket(&restore_ticket)
        {
            Err(error) => error,
            Ok(exclusive) => {
                drop(exclusive);
                anyhow::bail!(
                    "Restore obtained physical exclusivity while the Native snapshot was leased"
                )
            }
        };
        ensure!(
            matches!(
                exclusivity_error,
                crate::workspace_lifecycle::LifecycleError::ActiveOperations
            ),
            "lease-held Restore failed for an unexpected reason: {exclusivity_error:?}"
        );
        assert!(
            authority.claim_c_query_child().is_none(),
            "Restore admission released the result lease's worker claim"
        );
        {
            let frame = lease.frame()?;
            seed_only_frame_graph(&frame, PROJECT, QUERY_SCENE, ENTITY)?;
        }
        drop(lease);
        ensure!(
            owner.cleanup_proved_for_test(),
            "lease drop released claim without exit + EOF + reader join proof"
        );
        let claim = authority
            .claim_c_query_child()
            .ok_or_else(|| anyhow::anyhow!("result lease drop did not release capacity"))?;
        claim.release();
        drop(owner);
        assert_eq!(
            native_state
                .switching
                .core()
                .workspace_participant_count()?,
            0
        );
        native_state
            .switching
            .core()
            .mark_transition_joined(&restore_ticket)?;
        let exclusive = native_state
            .switching
            .core()
            .physical_exclusive_for_ticket(&restore_ticket)?;
        drop(exclusive);
        native_state
            .switching
            .core()
            .complete_unchanged(&restore_ticket, original_binding.clone())?;

        let mut crashed_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        crashed_owner.prepare(&request.project_id)?;
        let mut busy_during_crash = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        let busy_error = busy_during_crash
            .prepare(&request.project_id)
            .expect_err("the READY child must retain its claim until cleanup");
        ensure!(
            busy_error.to_string().contains("NIR1_GRAPH_WORKER_BUSY"),
            "READY child did not retain capacity: {busy_error:#}"
        );
        drop(busy_during_crash);

        crashed_owner.crash_child_after_ready_for_test()?;
        let crash_error = match crashed_owner.query_once(&request) {
            Ok(_) => anyhow::bail!("a crashed worker returned a result lease"),
            Err(error) => error,
        };
        ensure!(
            format!("{crash_error:#}")
                .contains("NIR1_GRAPH_WORKER_EXIT_DURING_REQUEST"),
            "READY-child crash did not produce the expected exit-during-request refusal: {crash_error:#}"
        );
        ensure!(
            !format!("{crash_error:#}").contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
            "child exit + stdout EOF were not proven before returning: {crash_error:#}"
        );
        drop(crashed_owner);

        let mut fresh_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        fresh_owner.prepare(&request.project_id).map_err(|error| {
            anyhow::anyhow!("fresh owner after proved crash cleanup failed: {error:#}")
        })?;
        drop(fresh_owner);
        let claim = authority.claim_c_query_child().ok_or_else(|| {
            anyhow::anyhow!("fresh owner cleanup did not release the child claim")
        })?;
        claim.release();

        let mut failed_start_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        let failed_start = failed_start_owner
            .prepare("nir1-project-that-does-not-exist")
            .expect_err("worker must not report READY for an unregistered project");
        let failed_start_text = failed_start.to_string();
        assert!(
            failed_start_text.contains("NIR1_GRAPH_WORKER_EXIT_BEFORE_READY")
                && failed_start_text
                    .contains("NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_REFUSED"),
            "expected canonical-registration refusal before READY, got: {failed_start:#}"
        );
        assert!(
            !failed_start_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
            "failed startup did not prove child exit and stdout EOF: {failed_start:#}"
        );
        let claim = authority
            .claim_c_query_child()
            .ok_or_else(|| anyhow::anyhow!("proved startup cleanup did not release the claim"))?;
        claim.release();
        drop(failed_start_owner);

        let mut restore_owner = super::c_query_worker::CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path,
        );
        restore_owner.prepare(&request.project_id)?;
        let restore_ticket = match native_state
            .switching
            .core()
            .begin_transition(AdmissionKind::Restore)?
        {
            AdmissionOutcome::Admitted(ticket) => ticket,
            AdmissionOutcome::NotAdmitted { reason, .. } => {
                anyhow::bail!("Restore was not admitted for the pinned-worker test: {reason:?}")
            }
        };
        let stale_result = match restore_owner.query_once(&request) {
            Ok(_) => anyhow::bail!("a Restore transition returned a result from the old binding"),
            Err(error) => error,
        };
        let stale_result_text = stale_result.to_string();
        assert!(
            stale_result_text
                .contains("workspace lifecycle cannot publish Ready from its current state"),
            "result was not rejected by the active Restore binding: {stale_result:#}"
        );
        assert!(
            !stale_result_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
            "Restore rejection did not prove child exit and stdout EOF: {stale_result:#}"
        );
        let claim = authority
            .claim_c_query_child()
            .ok_or_else(|| anyhow::anyhow!("Restore cleanup did not release the child claim"))?;
        claim.release();
        drop(restore_owner);
        native_state
            .switching
            .core()
            .mark_transition_joined(&restore_ticket)?;
        native_state
            .switching
            .core()
            .complete_unchanged(&restore_ticket, original_binding)?;
        assert_eq!(
            native_state
                .switching
                .core()
                .workspace_participant_count()?,
            0
        );
    }
    Ok(())
}

#[test]
#[ignore = "requires official A3-eligible Q512/R2 shared-material preseed and normal worker binary"]
fn native_worker_returns_canonical_512_a3_eligible_seed_local_graph() -> Result<()> {
    run_native_worker_returns_canonical_512_a3_eligible_seed_local_graph(Canonical512FixtureCase {
        label: "Q512",
        entity_count: 70,
        registry_rows: 4,
        a3_rows: 370,
        add_unrelated_seed_edge: false,
        native_runs: 1,
    })
}

#[test]
#[ignore = "finite same-parent practical retention check; requires official Q512 preseed and normal worker"]
fn native_worker_practical_retention_q512_30x() -> Result<()> {
    run_native_worker_returns_canonical_512_a3_eligible_seed_local_graph(Canonical512FixtureCase {
        label: "Q512-retention-30x",
        entity_count: 70,
        registry_rows: 4,
        a3_rows: 370,
        add_unrelated_seed_edge: false,
        native_runs: 30,
    })
}

#[test]
#[ignore = "requires official Q512 preseed and normal worker binary"]
fn native_worker_refuses_exact_513_seed_local_unrelated_reverse_index_edge() -> Result<()> {
    run_native_worker_returns_canonical_512_a3_eligible_seed_local_graph(Canonical512FixtureCase {
        label: "Q513-unrelated-seed-edge",
        entity_count: 70,
        registry_rows: 4,
        a3_rows: 370,
        add_unrelated_seed_edge: true,
        native_runs: 1,
    })
}

#[test]
#[ignore = "requires official Q512/R1/E12/registry33 preseed and normal worker binary"]
fn native_worker_returns_canonical_512_a3_eligible_registry33_seed_local_graph() -> Result<()> {
    run_native_worker_returns_canonical_512_a3_eligible_seed_local_graph(Canonical512FixtureCase {
        label: "N512-registry33",
        entity_count: 12,
        registry_rows: 33,
        a3_rows: 486,
        add_unrelated_seed_edge: false,
        native_runs: 1,
    })
}

#[derive(Clone, Copy)]
struct Canonical512FixtureCase {
    label: &'static str,
    entity_count: usize,
    registry_rows: usize,
    a3_rows: usize,
    add_unrelated_seed_edge: bool,
    native_runs: usize,
}

// Descriptive Linux snapshots only: not a query peak or physical-memory bound.
// Call outside the admission-to-lease timing interval and never scan other PIDs.
#[cfg(target_os = "linux")]
fn practical_process_rss_kib(pid: u32) -> Result<(u64, u64)> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
    let field = |key: &str| -> Result<u64> {
        let value = status
            .lines()
            .find_map(|line| line.strip_prefix(key))
            .ok_or_else(|| anyhow::anyhow!("practical process usage field missing"))?;
        let mut fields = value.split_whitespace();
        let kib = fields
            .next()
            .ok_or_else(|| anyhow::anyhow!("practical process usage value missing"))?
            .parse::<u64>()?;
        ensure!(
            fields.next() == Some("kB") && fields.next().is_none(),
            "process usage unit changed"
        );
        Ok(kib)
    };
    Ok((field("VmRSS:")?, field("VmHWM:")?))
}

fn run_native_worker_returns_canonical_512_a3_eligible_seed_local_graph(
    case: Canonical512FixtureCase,
) -> Result<()> {
    use crate::narrative_extraction::incremental_freshness::IncrementalFreshnessCycleOutcome;
    use crate::narrative_extraction::nir1_entity_relation_index::{
        prepare_graph_index_build_with_control,
        publish_nir1_entity_relation_index_in_tx_with_control,
    };
    use crate::narrative_maintenance_connection::{
        with_narrative_maintenance_graph_control, NarrativeMaintenanceGraphControlConfig,
    };
    use rusqlite::OpenFlags;
    use std::sync::atomic::AtomicBool;

    const PROJECT: &str = "nir1-capacity-fixture-project";
    const QUERY_SCENE: &str = "nir1-capacity-scope-drift-scene";
    const SEED: &str = "nir1-capacity-shared-entity-2";

    let observe_practical = match std::env::var("NIR1_C_QUERY_PRACTICAL_OBSERVE") {
        Ok(value) if value == "1" => true,
        Err(std::env::VarError::NotPresent) => false,
        _ => anyhow::bail!("invalid practical observation selection"),
    };
    ensure!(
        !observe_practical
            || (cfg!(target_os = "linux")
                && matches!(case.label, "Q512" | "Q512-retention-30x")),
        "practical observation requires Linux and the original Q512 fixture"
    );

    let source = PathBuf::from(
        std::env::var_os("NIR1_Q2_FIXTURE_PATH")
            .ok_or_else(|| anyhow::anyhow!("NIR1_Q2_FIXTURE_PATH missing"))?,
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        ensure!(
            !PathBuf::from(format!("{}{suffix}", source.display())).exists(),
            "Q512 source has a sidecar"
        );
    }
    // Independently establish the exact official seed-local shape and charged
    // QueryUsage rows before handing the disposable copy to the worker.
    let source_db = rusqlite::Connection::open_with_flags(
        &source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let registry_rows: i64 = source_db.query_row(
        "SELECT 1 + COALESCE(json_array_length(timeline_refs_json), 0)
                    + COALESCE(json_array_length(worldline_refs_json), 0)
                    + COALESCE(json_array_length(narrative_layer_refs_json), 0)
           FROM narrative_scope_registries WHERE project_id=?1",
        [PROJECT],
        |row| row.get(0),
    )?;
    assert_eq!(usize::try_from(registry_rows)?, case.registry_rows);
    let candidate_ids = {
        let mut statement = source_db.prepare(
            "SELECT DISTINCT consumer_key FROM narrative_dependency_edges
              WHERE project_id=?1 AND consumer_kind='proposal-revision'
                AND source_object_identity=?2 ORDER BY consumer_key",
        )?;
        let ids = statement
            .query_map(rusqlite::params![PROJECT, format!("codex:{SEED}")], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ids
    };
    assert_eq!(candidate_ids.len(), 1);
    let mut material_rows = 0usize;
    let mut a2_rows = 0usize;
    let mut a3_rows = 0usize;
    let mut charged_rows = candidate_ids.len();
    for revision_id in &candidate_ids {
        let (entities, relations, evidence): (i64, i64, i64) = source_db.query_row(
            "SELECT json_array_length(payload_json,'$.bundle.entities'),
                    json_array_length(payload_json,'$.bundle.relations'),
                    (SELECT COALESCE(SUM(json_array_length(
                         json_extract(entity.value,'$.evidence'))),0)
                       FROM json_each(json_extract(payload_json,'$.bundle.entities')) entity)
               FROM narrative_proposal_revisions WHERE id=?1",
            [revision_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let entities = usize::try_from(entities)?;
        let relations = usize::try_from(relations)?;
        let evidence = usize::try_from(evidence)?;
        assert_eq!(
            (entities, relations, evidence),
            (case.entity_count, 0, case.entity_count)
        );
        material_rows += 2 * entities + relations;

        let a2 = super::input::preflight_revision(
            &source_db,
            PROJECT,
            revision_id,
            MAX_GRAPH_RECORDS - charged_rows,
            MAX_GRAPH_INPUT_BYTES,
        )?
        .ok_or_else(|| anyhow::anyhow!("official {} Revision did not pass A2", case.label))?;
        assert_eq!(a2.rows, entities + relations + evidence);
        a2_rows += a2.rows;
        charged_rows += a2.rows;
        let a3 = super::input::preflight_disclosure_with_payload_bytes(
            &source_db,
            PROJECT,
            revision_id,
            QUERY_SCENE,
            a2.payload_bytes,
            MAX_GRAPH_RECORDS - charged_rows,
            MAX_GRAPH_INPUT_BYTES - a2.bytes,
        )?;
        a3_rows += a3.rows;
        charged_rows += a3.rows;
    }
    assert_eq!(material_rows, 2 * case.entity_count);
    assert_eq!(a2_rows, 2 * case.entity_count);
    assert_eq!(a3_rows, case.a3_rows);
    assert_eq!(charged_rows, MAX_GRAPH_RECORDS - 1);
    assert_eq!(MAX_GRAPH_RECORDS, 512);
    assert_eq!(MAX_GRAPH_INPUT_BYTES, 6_291_456);
    assert_eq!(QUERY_SQL_STEPS, 100_000);
    assert_eq!(QUERY_DEADLINE, Duration::from_millis(100));
    drop(source_db);
    if observe_practical {
        eprintln!(
            "Native practical fixture: label={}; os={}; arch={}; source_bytes={}; materials={}; revisions=1; registry_rows={}; charged_rows=512; runs={}; usage_unit=KiB; snapshots_not_peak=true",
            case.label, std::env::consts::OS, std::env::consts::ARCH,
            std::fs::metadata(&source)?.len(), material_rows, registry_rows, case.native_runs
        );
    }

    let directory = TestDirectory(std::env::temp_dir().join(format!(
        "nir1-c-{}-{}",
        case.label,
        uuid::Uuid::new_v4()
    )));
    std::fs::create_dir_all(&directory.0)?;
    let path = directory.0.join("grimodex.db");
    std::fs::copy(&source, &path)?;
    let authority = WorkspaceAuthority::from_database_for_test(
        crate::Database::new(&path)?,
        directory.0.clone(),
    )?;

    let mut drained = false;
    for _ in 0..8 {
        match run_incremental_freshness_cycle(&authority)? {
            IncrementalFreshnessCycleOutcome::Processed(_) => {}
            IncrementalFreshnessCycleOutcome::Idle => {
                drained = true;
                break;
            }
            IncrementalFreshnessCycleOutcome::Held(_) => {
                anyhow::bail!("{} Freshness held", case.label)
            }
        }
    }
    ensure!(drained, "{} Freshness Feed did not drain", case.label);
    let revision_id = &candidate_ids[0];
    let disclosure = authority.with_read_transaction(|conn| {
        evaluate_nir1_entity_relation_disclosure(conn, PROJECT, revision_id, QUERY_SCENE)
    })?;
    ensure!(
        matches!(disclosure, Nir1EntityRelationDisclosureRead::Eligible(_)),
        "Q512 Revision {revision_id} is not A3 eligible: {disclosure:?}"
    );
    let (proposal_id, canonical_gold_bundle) = authority.with_read_transaction(|conn| {
        let (proposal_id, payload): (String, String) = conn.query_row(
            "SELECT proposal_id, payload_json FROM narrative_proposal_revisions WHERE id=?1",
            [revision_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let payload: serde_json::Value = serde_json::from_str(&payload)?;
        ensure!(
            payload["revisionId"] == revision_id.as_str() && payload["projectId"] == PROJECT,
            "Q512 canonical Gold immutable Revision identity changed"
        );
        let bundle: grimodex_core::narrative_nir1::EntityRelationBundle =
            serde_json::from_value(payload["bundle"].clone())?;
        ensure!(
            bundle.entities.len() == case.entity_count && bundle.relations.is_empty(),
            "Q512 canonical Gold source shape changed"
        );
        Ok((proposal_id, bundle))
    })?;
    let canonical_binding = fixture_canonical_gold_binding(
        &authority,
        PROJECT,
        QUERY_SCENE,
        &canonical_gold_bundle.entities,
        revision_id,
        &proposal_id,
    )?;
    let decision_id = canonical_binding.decision_id.as_str();

    let runtime = authority.nir_chronicle_index_runtime();
    let snapshot = with_narrative_maintenance_graph_control(
        &authority,
        Duration::ZERO,
        1_000,
        Arc::new(AtomicBool::new(false)),
        NarrativeMaintenanceGraphControlConfig::default(),
        |conn, control| {
            let tx = conn.unchecked_transaction()?;
            let snapshot = prepare_graph_index_build_with_control(&tx, runtime, PROJECT, control)?;
            tx.commit()?;
            Ok(snapshot)
        },
    )?
    .ok_or_else(|| anyhow::anyhow!("Q512 index prepare was deferred"))?
    .into_result()?;
    let published = with_narrative_maintenance_graph_control(
        &authority,
        Duration::ZERO,
        1_000,
        Arc::new(AtomicBool::new(false)),
        NarrativeMaintenanceGraphControlConfig::default(),
        |conn, control| {
            let tx = conn.unchecked_transaction()?;
            let published = publish_nir1_entity_relation_index_in_tx_with_control(
                &tx, runtime, snapshot, control,
            )?;
            tx.commit()?;
            Ok(published)
        },
    )?
    .ok_or_else(|| anyhow::anyhow!("Q512 index publish was deferred"))?
    .into_result()?;

    let canonical_gold_frame = if matches!(case.label, "Q512" | "Q512-retention-30x") {
        ensure!(
            case.native_runs > 0 && !case.add_unrelated_seed_edge,
            "Q512 Gold applies only to the official positive fixture"
        );
        let entity = canonical_gold_bundle
            .entities
            .iter()
            .find(|entity| entity.entity_id == SEED)
            .ok_or_else(|| anyhow::anyhow!("Q512 canonical Gold seed Entity missing"))?;
        Some(canonical_single_node_gold_frame(
            PROJECT,
            QUERY_SCENE,
            entity,
            published.generation,
            &canonical_binding,
        )?)
    } else {
        None
    };

    let worker_path = PathBuf::from(
        std::env::var_os("NIR1_C_QUERY_WORKER_BIN")
            .ok_or_else(|| anyhow::anyhow!("NIR1_C_QUERY_WORKER_BIN missing"))?,
    );
    let switching = WorkspaceLifecycleCompatibilityView::new(false);
    let native_state = WorkspaceState {
        inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&authority)))),
        safe_mode: crate::recovery::SafeModeState::default(),
        switching,
        open_lock: Mutex::new(Default::default()),
    };
    let original_binding = LiveBinding::new(
        authority.path().to_string_lossy(),
        format!("test-workspace:{}", authority.identity()),
        authority.identity(),
        0,
    )
    .with_main_database_file_identity(authority.main_database_file_identity()?);
    native_state.switching.core().set_ready(original_binding)?;
    let snapshot = active_workspace_snapshot(&native_state)?;
    let mut owner = Some(super::c_query_worker::CQueryWorkerOwner::new(
        snapshot,
        worker_path.clone(),
    ));
    if case.add_unrelated_seed_edge {
        let edge_id = format!("q513-seed-decoy-{}", uuid::Uuid::new_v4());
        let source_identity = format!("codex:{SEED}");
        authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let inserted = tx.execute(
                "INSERT INTO narrative_dependency_edges
                    (id,project_id,consumer_kind,consumer_key,source_object_identity,created_at)
                 VALUES (?1,?2,'graph-test-unrelated',?1,?3,'2026-10-01T00:00:00Z')",
                rusqlite::params![edge_id, PROJECT, source_identity],
            )?;
            ensure!(
                inserted == 1,
                "Q513 decoy edge was not inserted exactly once"
            );
            let count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE id=?1 AND project_id=?2 AND consumer_kind='graph-test-unrelated'
                    AND consumer_key=?1 AND source_object_identity=?3",
                rusqlite::params![edge_id, PROJECT, source_identity],
                |row| row.get(0),
            )?;
            ensure!(
                count == 1,
                "Q513 disposable DB must contain exactly one decoy edge"
            );
            tx.commit()?;
            Ok(())
        })?;
    }
    let post_maintenance = authority.with_read_transaction(|conn| {
        let mut usage = QueryUsage::default();
        usage.admit(0, PROJECT.len() + QUERY_SCENE.len() + SEED.len())?;
        let mut cursor = 0i64;
        let mut candidates = std::collections::BTreeSet::new();
        let mut candidate_rows = 0usize;
        loop {
            usage.admit(0, super::candidates::source_input_bytes(SEED)?)?;
            // Mirror the production loop: an exhausted record budget ends
            // paging before a zero-row page could repeat forever.
            if usage.rows == MAX_GRAPH_RECORDS {
                break;
            }
            let page_limit = (MAX_GRAPH_RECORDS - usage.rows).min(16);
            let page = super::candidates::read_candidate_page(
                conn,
                PROJECT,
                SEED,
                cursor,
                MAX_GRAPH_RECORDS - usage.rows,
                MAX_GRAPH_INPUT_BYTES - usage.bytes,
            )?;
            let count = page.len();
            let bytes = page
                .iter()
                .map(|row| row.consumer_kind.len() + row.revision_id.len())
                .sum();
            for row in page {
                cursor = row.cursor;
                if row.consumer_kind == "proposal-revision" {
                    candidates.insert(row.revision_id);
                }
            }
            usage.admit(count, bytes)?;
            usage.pages += 1;
            candidate_rows += count;
            if count < page_limit {
                break;
            }
        }
        let mut a2_rows = 0usize;
        let mut a3_rows = 0usize;
        let mut first_refusal = None;
        for revision_id in candidates.iter() {
            let a2 = match super::input::preflight_revision(
                conn,
                PROJECT,
                revision_id,
                MAX_GRAPH_RECORDS - usage.rows,
                MAX_GRAPH_INPUT_BYTES - usage.bytes,
            ) {
                Ok(Some(admission)) => admission,
                Ok(None) => {
                    first_refusal = Some(format!("A2 no admission for {revision_id}"));
                    break;
                }
                Err(error) => {
                    first_refusal = Some(format!("A2: {error}"));
                    break;
                }
            };
            if let Err(error) = usage.admit(a2.rows, a2.bytes) {
                first_refusal = Some(format!("A2 QueryUsage::admit: {error}"));
                break;
            }
            a2_rows += a2.rows;
            if case.add_unrelated_seed_edge {
                let shape = super::input::preflight_disclosure_with_payload_bytes(
                    conn,
                    PROJECT,
                    revision_id,
                    QUERY_SCENE,
                    a2.payload_bytes,
                    MAX_GRAPH_RECORDS,
                    MAX_GRAPH_INPUT_BYTES - usage.bytes,
                )?;
                a3_rows += shape.rows;
            }
            let a3 = match super::input::preflight_disclosure_with_payload_bytes(
                conn,
                PROJECT,
                revision_id,
                QUERY_SCENE,
                a2.payload_bytes,
                MAX_GRAPH_RECORDS - usage.rows,
                MAX_GRAPH_INPUT_BYTES - usage.bytes,
            ) {
                Ok(admission) => admission,
                Err(error) => {
                    first_refusal = Some(format!("A3: {error}"));
                    break;
                }
            };
            if let Err(error) = usage.admit(a3.rows, a3.bytes) {
                first_refusal = Some(format!("A3 QueryUsage::admit: {error}"));
                break;
            }
            a3_rows += a3.rows;
        }
        let attempted_rows = candidate_rows + a2_rows + a3_rows;
        Ok((
            candidate_rows,
            candidates.len(),
            a2_rows,
            a3_rows,
            usage.rows,
            attempted_rows,
            first_refusal,
        ))
    })?;
    eprintln!(
        "{} post-maintenance preflight: candidate_rows={} canonical_candidates={} A2_rows={} A3_rows={} admitted_rows={} attempted_rows={} first_refusal={:?}",
        case.label,
        post_maintenance.0,
        post_maintenance.1,
        post_maintenance.2,
        post_maintenance.3,
        post_maintenance.4,
        post_maintenance.5,
        post_maintenance.6
    );
    let extra = if case.add_unrelated_seed_edge { 1 } else { 0 };
    let expected_refusal = case
        .add_unrelated_seed_edge
        .then(|| "A3: NIR1_GRAPH_DISCLOSURE_RECORD_LIMIT".to_owned());
    assert_eq!(
        post_maintenance,
        (
            2 + extra,
            1,
            2 * case.entity_count,
            case.a3_rows,
            if extra == 0 { MAX_GRAPH_RECORDS } else { 143 },
            MAX_GRAPH_RECORDS + extra,
            expected_refusal,
        )
    );
    owner
        .as_mut()
        .expect("initial Q512 worker owner exists")
        .prepare(PROJECT)?;
    let request = Nir1GraphRequest {
        project_id: PROJECT.to_owned(),
        query_scene_id: QUERY_SCENE.to_owned(),
        seed_entity_id: SEED.to_owned(),
    };
    if case.add_unrelated_seed_edge {
        const REFUSAL: &str =
            "query-worker-work-disclosure-record-limit-pre-cleanup-work-failed-disclosure-record-limit";
        let mut owner = owner.take().expect("initial Q513 worker owner exists");
        let started = Instant::now();
        let error = match owner.query_once(&request) {
            Ok(lease) => {
                drop(lease);
                anyhow::bail!("Q513 worker unexpectedly returned a result lease")
            }
            Err(error) => error,
        };
        let returned_elapsed = started.elapsed();
        let error_text = format!("{error:#}");
        ensure!(
            error_text.contains("NIR1_GRAPH_WORKER_UNAVAILABLE")
                && error_text.contains(REFUSAL)
                && !error_text.contains("NIR1_GRAPH_WORKER_CLEANUP_UNPROVED"),
            "Native Q513 refusal cause or cleanup proof changed: {error_text}"
        );
        ensure!(
            owner.cleanup_proved_for_test(),
            "Q513 reloan preceded child exit + stdout EOF + reader join"
        );
        let claim = authority
            .claim_c_query_child()
            .ok_or_else(|| anyhow::anyhow!("Q513 retirement did not release the child claim"))?;
        claim.release();
        drop(owner);
        ensure!(
            native_state
                .switching
                .core()
                .workspace_participant_count()?
                == 0,
            "Q513 owner retained its workspace participant after retirement"
        );
        eprintln!(
            "Native Q513 unrelated reverse-index refusal: reason={REFUSAL}; call-including-cleanup={returned_elapsed:?}; retirement=exit+EOF+reader-join"
        );
        return Ok(());
    }
    ensure!(
        case.native_runs > 0,
        "Q512 native run count must be positive"
    );
    for iteration in 0..case.native_runs {
        let mut owner = match owner.take() {
            Some(owner) => owner,
            None => {
                let snapshot = active_workspace_snapshot(&native_state)?;
                let mut owner =
                    super::c_query_worker::CQueryWorkerOwner::new(snapshot, worker_path.clone());
                owner.prepare(PROJECT)?;
                owner
            }
        };
        #[cfg(target_os = "linux")]
        let usage_before = if observe_practical {
            let pid = owner.child_pid_for_test()?;
            Some((
                pid,
                practical_process_rss_kib(std::process::id())?,
                practical_process_rss_kib(pid)?,
            ))
        } else {
            None
        };
        let started = Instant::now();
        let lease = owner.query_once(&request)?;
        let returned_elapsed = started.elapsed();
        let admission_elapsed = lease.elapsed();
        eprintln!(
            "Native canonical charged-row {} run {}/{}: call={returned_elapsed:?}, admission={admission_elapsed:?}",
            case.label,
            iteration + 1,
            case.native_runs
        );
        ensure!(
            returned_elapsed <= QUERY_DEADLINE && admission_elapsed <= QUERY_DEADLINE,
            "Native Q512 worker exceeded the 100 ms deadline"
        );
        {
            if let Some(expected) = canonical_gold_frame.as_deref() {
                assert_eq!(
                    lease.validated_frame_bytes_for_test()?,
                    expected,
                    "complete Native Q512 worker frame differs from independent canonical Gold"
                );
            }
            let frame = lease.frame()?;
            let graph = seed_only_frame_graph(&frame, PROJECT, QUERY_SCENE, SEED)?;
            let node = single_record(graph.nodes())?;
            assert_eq!(node.hop, 0);
            assert_eq!(node.entity.id, SEED);
            assert_eq!(node.entity.kind, "character");
            assert_eq!(node.entity.label, SEED);
            assert_eq!(
                node.entity.source,
                format!("codex:{SEED}@2026-09-17T00:00:00Z")
            );
            assert!(matches!(
                node.entity.scope.reading,
                super::worker_frame::ScopeView::Exact(value)
                    if value == "scene:nir1-capacity-scene"
            ));
            assert_eq!(node.entity.evidence_count(), 1);
            let evidence = single_record(node.entity.evidence())?;
            assert_eq!(evidence.id, format!("nir1:capacity:evidence:shared:{SEED}"));
            assert_eq!(evidence.source, format!("codex:{SEED}"));
            assert_eq!(evidence.quote, format!("fixture source {SEED} 日本語"));
            assert_eq!(evidence.start, 0);
            assert_eq!(evidence.end as usize, evidence.quote.encode_utf16().count());
            assert_eq!(node.binding_count(), 1);
            let binding = single_record(node.bindings())?;
            assert_eq!(binding.revision_id, revision_id);
            assert_eq!(binding.decision_id, decision_id);
        }
        assert!(
            authority.claim_c_query_child().is_none(),
            "Native capacity must stay leased while the result is held"
        );
        #[cfg(target_os = "linux")]
        let parent_lease_usage = if observe_practical {
            Some(practical_process_rss_kib(std::process::id())?)
        } else {
            None
        };
        drop(lease);
        ensure!(
            owner.cleanup_proved_for_test(),
            "Q512 iteration {} reloan preceded child exit + stdout EOF + reader join",
            iteration + 1
        );
        let claim = authority
            .claim_c_query_child()
            .ok_or_else(|| anyhow::anyhow!("Q512 lease drop did not release the child claim"))?;
        claim.release();
        drop(owner);
        assert_eq!(
            native_state
                .switching
                .core()
                .workspace_participant_count()?,
            0,
            "Q512 iteration {} retained a workspace participant after retirement",
            iteration + 1
        );
        #[cfg(target_os = "linux")]
        if let Some((pid, parent_ready, worker_ready)) = usage_before {
            let parent_retired = practical_process_rss_kib(std::process::id())?;
            eprintln!(
                "Native practical retirement: label={}; run={}/{}; parent_pid={}; worker_pid={pid}; parent_ready_rss_hwm_kib={parent_ready:?}; worker_ready_rss_hwm_kib={worker_ready:?}; parent_lease_rss_hwm_kib={parent_lease_usage:?}; parent_retired_rss_hwm_kib={parent_retired:?}; lease_released=true; exit_eof_all_joins=true; claim_reloan=true; participants=0",
                case.label, iteration + 1, case.native_runs, std::process::id()
            );
        }
    }
    Ok(())
}

fn assert_unavailable(response: &Nir1GraphResponse, reason: &str) {
    assert_eq!(response.status, "unavailable");
    assert_eq!(response.reason.as_deref(), Some(reason));
    assert!(
        response.graph.is_none(),
        "failure must not expose a partial graph"
    );
    assert!(response.scope_revision.is_none());
}

#[test]
fn registered_graph_preserves_multi_edge_order_and_bindings() -> Result<()> {
    let fixture = Fixture::with_extra_relation("directed", true)?;
    let mut reader = fixture.registered_reader()?;
    let response = query(&mut reader, "nir1-alice")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let graph = response.graph.unwrap();
    assert_eq!(graph.edges.len(), 2);
    assert_eq!(
        graph
            .edges
            .iter()
            .map(|edge| edge.relation.edge_id.as_str())
            .collect::<Vec<_>>(),
        vec!["nir1-edge", "nir1-edge-b"]
    );
    for edge in &graph.edges {
        assert_eq!(edge.binding.revision_id, fixture.revision);
        assert_eq!(edge.from.entity_id, "nir1-alice");
        assert_eq!(edge.to.entity_id, "nir1-bob");
        assert!(!edge.binding.decision_token.is_empty());
        assert!(!edge.binding.freshness_token.is_empty());
    }
    Ok(())
}

#[test]
fn fixed_worker_arena_replaces_only_the_transient_reader_reserve() -> Result<()> {
    assert_eq!(MAX_GRAPH_INPUT_BYTES, 6_291_456);
    assert_eq!(MAX_GRAPH_RECORDS, 512);
    assert_eq!(QUERY_SQL_STEPS, 100_000);
    assert_eq!(QUERY_DEADLINE, Duration::from_millis(100));
    let estimate = transient_material_reserve(0, 1)?;
    let retained = MAX_GRAPH_INPUT_BYTES - estimate + 1;

    let mut ordinary = QueryUsage {
        retained_bytes: retained,
        ..QueryUsage::default()
    };
    let error = ordinary
        .admit_transient_material_reserve(0, 1, false)
        .expect_err("ordinary reader must retain its transient estimate");
    assert!(error.to_string().contains("NIR1_GRAPH_RETAINED_LIMIT"));

    let mut worker = QueryUsage {
        retained_bytes: retained,
        ..QueryUsage::default()
    };
    worker.admit_transient_material_reserve(0, 1, true)?;
    assert_eq!(worker.retained_bytes, retained);
    assert!(worker.admit_retained(estimate).is_err());
    Ok(())
}

#[test]
fn ordinary_and_unregistered_readers_cannot_authorize_graph() -> Result<()> {
    let fixture = Fixture::new()?;
    let response = fixture
        .authority
        .with_conn(|conn| read_nir1_graph(conn, &graph_request("nir1-alice")))?;
    assert_unavailable(&response, "registration-required");
    let mut reader = fixture.reader()?;
    assert_unavailable(
        &reader.query(&graph_request("nir1-alice"))?,
        "registration-required",
    );
    Ok(())
}

#[test]
fn registered_graph_preserves_exact_revision_decision_and_evidence() -> Result<()> {
    let fixture = Fixture::new()?;
    let proof = fixture.authority.with_read_transaction(|conn| {
        evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &fixture.revision, "nir1")
    })?;
    let Nir1EntityRelationDisclosureRead::Eligible(proof) = proof else {
        anyhow::bail!("canonical test material was not A3 eligible")
    };
    let mut reader = fixture.registered_reader()?;
    let response = query(&mut reader, "nir1-alice")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let graph = response.graph.unwrap();
    assert_eq!(graph.edges.len(), 1);
    assert_eq!(graph.nodes.len(), 2);
    assert_eq!(graph.nodes[0].entity.entity_id, "nir1-alice");
    assert_eq!(graph.nodes[0].hop, 0);
    assert_eq!(graph.nodes[1].hop, 1);
    let edge = &graph.edges[0];
    assert_eq!(edge.binding.revision_id, fixture.revision);
    assert_eq!(
        edge.binding.decision_id,
        proof.revision.decision.as_ref().unwrap().id()
    );
    assert_eq!(edge.binding.decision_token, proof.decision_token);
    assert_eq!(edge.binding.freshness_token, proof.freshness_token);
    assert_eq!(
        edge.binding.scope_authority_revision,
        proof.scope_authority_revision
    );
    assert_eq!(
        edge.binding.query_scene_source_token,
        proof.query_scene_source_token
    );
    assert_eq!(
        edge.binding.query_scene_scope_token,
        proof.query_scene_scope_token
    );
    assert_eq!(
        edge.binding.query_scene_incarnation_id,
        proof.query_scene_incarnation_id
    );
    assert_eq!(edge.binding.reveal_state_token, proof.reveal_state_token);
    assert_eq!(
        serde_json::to_value(&edge.relation)?,
        serde_json::to_value(&proof.revision.bundle.relations[0])?
    );
    assert_eq!(edge.from.evidence[0].evidence_id, "nir1-evidence-alice");
    assert_eq!(edge.from.evidence[0].quote, "Alice");
    assert_eq!(edge.to.evidence[0].evidence_id, "nir1-evidence-bob");
    assert_eq!(edge.to.evidence[0].quote, "Bob");
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    Ok(())
}

#[test]
fn reverse_traversal_obeys_directed_and_symmetric_relations() -> Result<()> {
    for (direction, expected_edges) in [("directed", 0), ("symmetric", 1)] {
        let fixture = Fixture::with_direction(direction)?;
        let mut reader = fixture.registered_reader()?;
        let response = query(&mut reader, "nir1-bob")?;
        assert_eq!(response.status, "available", "{:?}", response.reason);
        let graph = response.graph.unwrap();
        assert_eq!(graph.edges.len(), expected_edges, "{direction}");
        assert_eq!(graph.nodes[0].entity.entity_id, "nir1-bob");
        assert_eq!(graph.nodes[0].hop, 0);
    }
    Ok(())
}

#[test]
fn committed_external_write_invalidates_registration_without_partial_output() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    let external = Connection::open(fixture.authority.path().join("grimodex.db"))?;
    external.execute(
        "UPDATE codex_entries SET summary='changed' WHERE id='nir1-alice'",
        [],
    )?;
    assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-drift");
    assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-required");
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    Ok(())
}

#[test]
fn dirty_binding_invalidates_registration_and_cannot_be_registered_again() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    fixture.authority.with_conn(|conn| {
        conn.execute("UPDATE narrative_semantic_index_metadata SET dirty_cache_flag=1 WHERE project_id=?1 AND index_key=?2", params![PROJECT, INDEX_KEY])?;
        Ok(())
    })?;
    assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-drift");
    assert!(!reader.register_with_control(PROJECT, &mut RegistrationOwner)?);
    assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-required");
    Ok(())
}

#[test]
fn missing_source_or_decision_cannot_reuse_published_binding() -> Result<()> {
    for mutation in [
        "DELETE FROM codex_entries WHERE id='nir1-alice'",
        "DELETE FROM narrative_proposal_decisions",
    ] {
        let fixture = Fixture::new()?;
        let mut reader = fixture.registered_reader()?;
        fixture.authority.with_conn(|conn| {
            conn.execute(mutation, [])?;
            Ok(())
        })?;
        assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-drift");
        assert!(
            !reader.register_with_control(PROJECT, &mut RegistrationOwner)?,
            "{mutation}"
        );
        assert_unavailable(&query(&mut reader, "nir1-alice")?, "registration-required");
    }
    Ok(())
}

#[test]
fn unrelated_reverse_dependencies_do_not_consume_seed_local_budget() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.add_decoys(513, "codex:unrelated-entity")?;
    let mut reader = fixture.registered_reader()?;
    let response = query(&mut reader, "nir1-alice")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    assert_eq!(response.graph.unwrap().edges.len(), 1);
    Ok(())
}

#[test]
fn oversized_seed_candidate_set_is_refused_without_partial_graph() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.add_decoys(513, "codex:nir1-alice")?;
    let mut reader = fixture.registered_reader()?;
    assert_unavailable(
        &query(&mut reader, "nir1-alice")?,
        "query-budget-or-validation-failed",
    );
    assert_unavailable(
        &reader.query(&graph_request("nir1-alice"))?,
        "query-budget-or-validation-failed",
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    Ok(())
}

#[test]
fn oversized_hop1_candidate_set_is_refused_at_a_partial_page_boundary() -> Result<()> {
    // Seed paging plus its A2/A3 admission leaves a charged row count that is
    // not a multiple of the 16-row page, so the hop-1 frontier reaches the
    // 512-record limit inside a short page. Its remaining rows must still be
    // probed and refused instead of silently truncating the graph.
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    let baseline = query(&mut reader, "nir1-alice")?;
    assert_eq!(baseline.status, "available", "{:?}", baseline.reason);
    drop(reader);
    fixture.add_decoys(600, "codex:nir1-bob")?;
    let mut reader = fixture.registered_reader()?;
    assert_unavailable(
        &query(&mut reader, "nir1-alice")?,
        "query-budget-or-validation-failed",
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    Ok(())
}

#[test]
fn exhausted_deadline_or_sql_budget_rolls_back_actual_connection() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    for (duration, steps) in [(Duration::ZERO, 100_000), (Duration::from_secs(2), 0)] {
        let response = reader.query_with_deadline(&graph_request("nir1-alice"), duration, steps)?;
        assert_unavailable(&response, "query-budget-or-validation-failed");
        assert!(reader.connection.as_ref().unwrap().is_autocommit());
    }
    // Exhaustion must not strand an open read transaction or poison the owner.
    assert_eq!(query(&mut reader, "nir1-alice")?.status, "available");
    Ok(())
}

#[test]
fn worker_refusal_reason_is_allowlisted_by_site_cause_and_pre_cleanup_status() {
    let reason = |site, error: &anyhow::Error, deadline, steps, status| {
        let reason = worker_refusal_reason(site, error, deadline, steps, status);
        let text = reason.to_string();
        // Every composed reason round-trips through the frame allowlist.
        assert_eq!(UnavailableReason::parse(&text), Some(reason), "{text}");
        text
    };
    let deadline = validation_terminated(ValidationTerminationReason::TimedOut, "private detail");
    assert_eq!(
        reason(WorkerSite::Work, &deadline, false, false, None),
        "query-worker-work-deadline"
    );

    let capacity = validation_terminated(
        ValidationTerminationReason::CapacityExceeded,
        "private detail",
    );
    assert_eq!(
        reason(WorkerSite::PostStamp, &capacity, false, true, None),
        "query-worker-post-stamp-steps"
    );
    assert_eq!(
        reason(WorkerSite::Work, &capacity, true, true, None),
        "query-worker-work-deadline-or-steps"
    );

    let known = validation_terminated(
        ValidationTerminationReason::WorkspaceGenerationChanged,
        "private detail",
    );
    assert_eq!(
        reason(WorkerSite::PostStamp, &known, false, false, None),
        "query-worker-post-stamp-validation-workspace-generation-changed"
    );
    let sqlite_nomem: anyhow::Error = rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOMEM),
        None,
    )
    .into();
    assert_eq!(
        reason(WorkerSite::Work, &sqlite_nomem, false, false, None),
        "query-worker-work-sqlite-nomem"
    );
    let record_limit = anyhow::anyhow!("NIR1_GRAPH_DISCLOSURE_RECORD_LIMIT");
    assert_eq!(
        reason(WorkerSite::Work, &record_limit, false, false, None),
        "query-worker-work-disclosure-record-limit"
    );
    let record_status = worker_work_status(&Err::<(), _>(record_limit), false, false);
    assert_eq!(
        reason(
            WorkerSite::Work,
            &anyhow::anyhow!("NIR1_GRAPH_DISCLOSURE_RECORD_LIMIT"),
            false,
            false,
            Some(record_status),
        ),
        "query-worker-work-disclosure-record-limit-pre-cleanup-work-failed-disclosure-record-limit"
    );
    // A Scene-join resource refusal, even through a shared QueryUsage
    // marker, is `scene-limit`; steps keep their typed cause.
    let scene_limit = scene_join_failure(anyhow::anyhow!("NIR1_GRAPH_QUERY_RESOURCE_LIMIT"));
    let scene_status = worker_work_status(&Err::<(), _>(scene_limit), false, false);
    assert_eq!(
        scene_status,
        PreCleanup::WorkFailed(WorkerCause::SceneLimit)
    );
    assert_eq!(
        reason(
            WorkerSite::Work,
            &scene_join_failure(anyhow::anyhow!("NIR1_GRAPH_SCENE_PIN_LIMIT")),
            false,
            false,
            Some(scene_status),
        ),
        "query-worker-work-scene-limit-pre-cleanup-work-failed-scene-limit"
    );
    let scene_steps = scene_join_failure(validation_terminated(
        ValidationTerminationReason::CapacityExceeded,
        "private detail",
    ));
    assert_eq!(
        reason(WorkerSite::Work, &scene_steps, false, true, None),
        "query-worker-work-steps"
    );
    assert_eq!(
        UnavailableReason::parse(
            "query-worker-work-scene-limit-pre-cleanup-work-failed-scene-limit"
        )
        .map(UnavailableReason::category),
        Some(super::worker_frame::UnavailableCategory::Limit)
    );
    let other = anyhow::anyhow!("private detail");
    assert_eq!(
        reason(WorkerSite::Work, &other, false, false, None),
        "query-worker-work-other"
    );
    let generic_unavailable = unavailable_response(&graph_request("seed"), "reader-unavailable");
    assert_eq!(generic_unavailable.status, "unavailable");
    assert_eq!(
        generic_unavailable.reason.as_deref(),
        Some("reader-unavailable")
    );

    let success = Ok::<(), anyhow::Error>(());
    let work_ok = worker_work_status(&success, false, false);
    assert_eq!(
        reason(WorkerSite::PostStamp, &deadline, true, false, Some(work_ok),),
        "query-worker-post-stamp-deadline-pre-cleanup-work-ok"
    );

    let failure = Err::<(), _>(validation_terminated(
        ValidationTerminationReason::CapacityExceeded,
        "private detail",
    ));
    let work_failed = worker_work_status(&failure, false, true);
    assert_eq!(
        reason(
            WorkerSite::PostStamp,
            &deadline,
            true,
            false,
            Some(work_failed),
        ),
        "query-worker-post-stamp-deadline-pre-cleanup-work-failed-steps"
    );

    let late_work = worker_work_status(&success, true, false);
    assert_eq!(
        reason(
            WorkerSite::PostStamp,
            &deadline,
            true,
            false,
            Some(late_work),
        ),
        "query-worker-post-stamp-deadline-pre-cleanup-deadline-already-crossed"
    );
}

#[cfg(feature = "nir1-material-diagnostics")]
#[test]
fn diagnostic_stage_observation_reports_deadline_and_stamp_flags_only() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    let (result, observation) = reader.query_with_stage_observation_and_deadline(
        &graph_request("nir1-alice"),
        Duration::ZERO,
        100_000,
    );
    assert_unavailable(&result?, "query-budget-or-validation-failed");
    assert!(observation.work_result_error);
    assert!(observation.post_stamp_error);
    assert!(observation.deadline_observed_at_collapse);
    assert!(observation.unattributed);
    assert!(observation.cleanup_post_stamp_ns.is_some());
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    Ok(())
}

#[test]
fn runtime_pause_resume_never_revives_an_old_reader() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    fixture.authority.nir_chronicle_index_runtime().pause()?;
    fixture.authority.nir_chronicle_index_runtime().resume()?;
    assert_unavailable(
        &reader.query(&graph_request("nir1-alice"))?,
        "reader-unavailable",
    );
    assert!(reader
        .register_with_control(PROJECT, &mut RegistrationOwner)
        .is_err());
    Ok(())
}

#[test]
fn cancellation_is_sticky_and_close_releases_physical_connection_and_participant() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut reader = fixture.registered_reader()?;
    assert_eq!(fixture.lifecycle.workspace_participant_count()?, 1);
    reader.cancellation().cancel();
    assert_unavailable(
        &reader.query(&graph_request("nir1-alice"))?,
        "reader-unavailable",
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    assert_eq!(fixture.lifecycle.workspace_participant_count()?, 1);
    reader.close()?;
    assert!(reader.connection.is_none());
    assert_eq!(fixture.lifecycle.workspace_participant_count()?, 0);
    reader.close()?;
    let error = reader
        .query(&graph_request("nir1-alice"))
        .expect_err("a closed reader must refuse queries");
    assert!(error.to_string().contains("NIR1_GRAPH_READER_CLOSED"));
    Ok(())
}

// CP-1: the worker-side Scene pin join. Synthetic paths run against the real
// schema; the join reads only Codex entries, Scenes, pins and A1 bindings.

const SCENE_UPDATED_AT: &str = "2026-10-13T00:00:00.000Z";
const PIN_CREATED_AT: &str = "2026-10-13T00:00:01.000Z";

fn synthetic_entity(id: &str) -> Arc<EntityInput> {
    Arc::new(EntityInput {
        entity_id: id.into(),
        entity_type: "character".into(),
        label: id.into(),
        source_token: format!("codex:{id}@v1"),
        scope: grimodex_core::narrative_nir1::ScopeBinding {
            reading: ScopeValue::LegacyAbsent,
            story: ScopeValue::LegacyAbsent,
            auto: ScopeValue::LegacyAbsent,
            phase: "draft".into(),
            reveal: "visible".into(),
            pov: None,
            authority_revision: "scope-authority".into(),
        },
        evidence: Vec::new(),
    })
}

fn synthetic_binding() -> Arc<Nir1GraphMaterialBinding> {
    Arc::new(Nir1GraphMaterialBinding {
        revision_id: "revision".into(),
        decision_id: "decision".into(),
        decision_token: "decision-token".into(),
        freshness_token: "freshness-token".into(),
        scope_authority_revision: "scope-authority".into(),
        query_scene_source_token: "v0@query".into(),
        query_scene_scope_token: "query-scope".into(),
        query_scene_incarnation_id: "query-incarnation".into(),
        reveal_state_token: "reveal".into(),
    })
}

fn synthetic_node(id: &str, hop: u8) -> Nir1GraphNode {
    Nir1GraphNode {
        entity: synthetic_entity(id),
        hop,
        bindings: vec![synthetic_binding()],
    }
}

fn synthetic_edge(edge_id: &str, from: &str, to: &str, directionality: &str) -> Nir1GraphEdge {
    Nir1GraphEdge {
        relation: Arc::new(GraphEdgeInput {
            edge_id: edge_id.into(),
            from_entity_id: from.into(),
            to_entity_id: to.into(),
            relation_type: "knows".into(),
            directionality: directionality.into(),
            source_token: format!("v1@{edge_id}"),
            evidence_ids: Vec::new(),
        }),
        from: synthetic_entity(from),
        to: synthetic_entity(to),
        binding: synthetic_binding(),
    }
}

/// Seed s and one reached Entity x.
fn one_hop_graph() -> (Vec<Nir1GraphNode>, Vec<Nir1GraphEdge>) {
    (
        vec![synthetic_node("s", 0), synthetic_node("x", 1)],
        vec![synthetic_edge("e-sx", "s", "x", "directed")],
    )
}

/// b ranks before a (e-1 < e-2); c is at hop 2 through both, and its
/// minimum path starts with the smaller first edge, through b.
fn ranked_graph() -> (Vec<Nir1GraphNode>, Vec<Nir1GraphEdge>) {
    (
        vec![
            synthetic_node("s", 0),
            synthetic_node("a", 1),
            synthetic_node("b", 1),
            synthetic_node("c", 2),
        ],
        vec![
            synthetic_edge("e-2", "s", "a", "directed"),
            synthetic_edge("e-1", "s", "b", "directed"),
            synthetic_edge("e-3", "a", "c", "directed"),
            synthetic_edge("e-4", "b", "c", "directed"),
        ],
    )
}

fn pin_workspace(entities: &[&str]) -> Result<crate::Database> {
    let db = crate::Database::new(std::path::Path::new(":memory:"))?;
    db.migrate()?;
    db.with_conn(|conn| {
        for entity in entities {
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES (?1, ?2, 'character', ?1, ?1, '2026-10-13T00:00:00Z')",
                params![entity, PROJECT],
            )?;
        }
        Ok(())
    })?;
    Ok(db)
}

/// Pins in the given order; each new Scene is a live root Scene.
fn add_scene_pins(db: &crate::Database, pins: &[(&str, &str)]) -> Result<()> {
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for (scene, entry) in pins {
            tx.execute(
                "INSERT OR IGNORE INTO tree_nodes
                    (id, project_id, node_type, title, content, sort_order, updated_at)
                 VALUES (?1, ?2, 'scene', 'Pinned', '{}', 'z0', ?3)",
                params![scene, PROJECT, SCENE_UPDATED_AT],
            )?;
            tx.execute(
                "INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
                 VALUES (?1, ?2, ?3)",
                params![scene, entry, PIN_CREATED_AT],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

fn run_join(
    db: &crate::Database,
    nodes: &[Nir1GraphNode],
    edges: &[Nir1GraphEdge],
    usage: &mut QueryUsage,
    control: &mut dyn GraphWorkControl,
) -> Result<(usize, Vec<Nir1GraphSceneAssociation>)> {
    db.with_read_transaction(|conn| {
        join_scene_pins(conn, &graph_request("s"), nodes, edges, usage, control)
    })
}

fn join(
    db: &crate::Database,
    nodes: &[Nir1GraphNode],
    edges: &[Nir1GraphEdge],
) -> Result<(usize, Vec<Nir1GraphSceneAssociation>, QueryUsage)> {
    let mut usage = QueryUsage::default();
    let (total, scenes) = run_join(db, nodes, edges, &mut usage, &mut RegistrationOwner)?;
    Ok((total, scenes, usage))
}

type SceneTuple = (String, String, Vec<String>);

/// (Scene, representative Entity, traversal-order edge IDs).
fn scene_tuples(scenes: &[Nir1GraphSceneAssociation], edges: &[Nir1GraphEdge]) -> Vec<SceneTuple> {
    scenes
        .iter()
        .map(|scene| {
            (
                scene.scene_id.clone(),
                scene.pin_entry_id.clone(),
                scene
                    .path_edge_indices
                    .iter()
                    .map(|index| edges[usize::from(*index)].relation.edge_id.clone())
                    .collect(),
            )
        })
        .collect()
}

fn scene_tuple(scene: &str, entry: &str, path: &[&str]) -> SceneTuple {
    (
        scene.into(),
        entry.into(),
        path.iter().map(|edge| (*edge).to_owned()).collect(),
    )
}

fn scene_ids(count: usize) -> Vec<String> {
    (0..count)
        .map(|index| format!("scene-{index:03}"))
        .collect()
}

/// The worker's cause once query_in_snapshot marks a join failure.
fn join_failure_cause(error: anyhow::Error) -> WorkerCause {
    worker_refusal_cause(&scene_join_failure(error), false, false)
}

#[test]
fn reached_entity_rank_orders_hop_then_edge_ids_then_entity() -> Result<()> {
    // c and d share their only edge ID (one Relation in two Revisions), so
    // the Entity ID decides; the seed itself is never ranked.
    let nodes = vec![
        synthetic_node("s", 0),
        synthetic_node("a", 1),
        synthetic_node("b", 1),
        synthetic_node("c", 1),
        synthetic_node("d", 1),
        synthetic_node("z", 2),
    ];
    let edges = vec![
        synthetic_edge("e-2", "s", "a", "directed"),
        synthetic_edge("e-1", "s", "b", "directed"),
        synthetic_edge("e-3", "s", "d", "directed"),
        synthetic_edge("e-3", "s", "c", "directed"),
        synthetic_edge("e-0", "a", "z", "directed"),
    ];
    let ranked = rank_reached_entities("s", &nodes, &edges)?;
    assert_eq!(
        ranked
            .iter()
            .map(|entity| (entity.entity_id, entity.hop, entity.path().to_vec()))
            .collect::<Vec<_>>(),
        vec![
            ("b", 1, vec![1]),
            ("a", 1, vec![0]),
            ("c", 1, vec![3]),
            ("d", 1, vec![2]),
            ("z", 2, vec![0, 4]),
        ]
    );
    Ok(())
}

#[test]
fn representative_path_uses_byte_order_and_frame_index_tie_break() -> Result<()> {
    let nodes = vec![
        synthetic_node("s", 0),
        synthetic_node("x", 1),
        synthetic_node("y", 1),
        synthetic_node("w", 1),
        synthetic_node("z", 2),
    ];
    let edges = vec![
        synthetic_edge("e-b", "s", "x", "directed"),
        synthetic_edge("e-a", "s", "x", "directed"),
        // The same Relation ID in two Revisions: the lower frame index wins.
        synthetic_edge("e-y", "s", "y", "directed"),
        synthetic_edge("e-y", "s", "y", "directed"),
        // U+FF5E precedes U+1F600 in UTF-8 bytes, not in UTF-16 units.
        synthetic_edge("\u{1F600}", "s", "w", "directed"),
        synthetic_edge("\u{FF5E}", "s", "w", "directed"),
        synthetic_edge("e-z2", "y", "z", "directed"),
        synthetic_edge("e-z1", "x", "z", "directed"),
    ];
    let ranked = rank_reached_entities("s", &nodes, &edges)?;
    assert_eq!(
        ranked
            .iter()
            .map(|entity| (entity.entity_id, entity.path().to_vec()))
            .collect::<Vec<_>>(),
        vec![
            ("x", vec![1]),
            ("y", vec![2]),
            ("w", vec![5]),
            // (e-a, e-z1) through x precedes (e-y, e-z2) through y.
            ("z", vec![1, 7]),
        ]
    );
    Ok(())
}

#[test]
fn symmetric_edges_traverse_both_ways_for_paths() -> Result<()> {
    // y is reached through a symmetric edge stored as y->s; the smaller
    // directed y->s edge is not traversable from the seed.
    let nodes = vec![
        synthetic_node("s", 0),
        synthetic_node("y", 1),
        synthetic_node("z", 2),
    ];
    let edges = vec![
        synthetic_edge("e-1", "y", "s", "symmetric"),
        synthetic_edge("e-0", "y", "s", "directed"),
        synthetic_edge("e-2", "z", "y", "symmetric"),
    ];
    let ranked = rank_reached_entities("s", &nodes, &edges)?;
    assert_eq!(
        ranked
            .iter()
            .map(|entity| (entity.entity_id, entity.path().to_vec()))
            .collect::<Vec<_>>(),
        vec![("y", vec![0]), ("z", vec![0, 2])]
    );
    // A reached Entity without a traversable path fails closed.
    let error = rank_reached_entities("s", &nodes[..2], &edges[1..2])
        .expect_err("a hop-1 node needs an edge from the seed");
    assert!(error.to_string().contains("NIR1_GRAPH_SCENE_PATH_MISSING"));
    Ok(())
}

#[test]
fn scene_join_enumerates_zero_sixteen_and_seventeen_pins_across_keyset_pages() -> Result<()> {
    let (nodes, edges) = one_hop_graph();
    for (pins, pages) in [(0usize, 1usize), (16, 2), (17, 2)] {
        let db = pin_workspace(&["s", "x"])?;
        let scenes = scene_ids(pins);
        add_scene_pins(
            &db,
            &scenes
                .iter()
                .map(|scene| (scene.as_str(), "x"))
                .collect::<Vec<_>>(),
        )?;
        let (total, associations, usage) = join(&db, &nodes, &edges)?;
        let returned = pins.min(MAX_GRAPH_SCENES);
        assert_eq!((total, usage.pages), (pins, pages), "{pins} pins");
        // Every pin row and each returned Scene row is admitted.
        assert_eq!(usage.rows, pins + returned, "{pins} pins");
        assert_eq!(
            scene_tuples(&associations, &edges),
            scenes[..returned]
                .iter()
                .map(|scene| scene_tuple(scene, "x", &["e-sx"]))
                .collect::<Vec<_>>()
        );
        for association in &associations {
            assert!(association.pin_rowid > 0);
            assert_eq!(association.pin_created_at, PIN_CREATED_AT);
            assert_eq!(
                association.scene_source_token,
                format!("v0@{SCENE_UPDATED_AT}")
            );
            assert_eq!(
                (
                    &association.scene_incarnation_id,
                    &association.scene_scope_token
                ),
                (&None, &None)
            );
            assert_eq!(association.path_hop, 1);
        }
    }
    Ok(())
}

#[test]
fn scene_join_reads_a1_binding_tokens_for_bound_scenes() -> Result<()> {
    let (nodes, edges) = one_hop_graph();
    let db = pin_workspace(&["s", "x"])?;
    add_scene_pins(&db, &[("bound", "x"), ("unbound", "x")])?;
    db.with_conn(|conn| {
        crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
            conn,
            PROJECT,
            "bound",
            SCENE_UPDATED_AT,
        )
    })?;
    let (incarnation, scope): (String, String) = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT scene_incarnation_id, source_token FROM narrative_scene_scope_bindings
              WHERE project_id=?1 AND scene_id='bound'",
            [PROJECT],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    })?;
    let (total, associations, usage) = join(&db, &nodes, &edges)?;
    assert_eq!(total, 2);
    assert_eq!(associations[0].scene_id, "bound");
    assert_eq!(
        associations[0].scene_incarnation_id.as_deref(),
        Some(incarnation.as_str())
    );
    assert_eq!(
        associations[0].scene_scope_token.as_deref(),
        Some(scope.as_str())
    );
    assert_eq!(
        (
            &associations[1].scene_incarnation_id,
            &associations[1].scene_scope_token
        ),
        (&None, &None)
    );
    // Two pins, two Scene rows and one binding row.
    assert_eq!(usage.rows, 5);
    Ok(())
}

#[test]
fn scene_join_excludes_seed_pins() -> Result<()> {
    let (nodes, edges) = one_hop_graph();
    let db = pin_workspace(&["s", "x"])?;
    add_scene_pins(
        &db,
        &[
            ("seed-only", "s"),
            ("shared", "s"),
            ("shared", "x"),
            ("x-only", "x"),
        ],
    )?;
    let (total, associations, usage) = join(&db, &nodes, &edges)?;
    assert_eq!(total, 2);
    assert_eq!(
        scene_tuples(&associations, &edges),
        vec![
            scene_tuple("shared", "x", &["e-sx"]),
            scene_tuple("x-only", "x", &["e-sx"]),
        ]
    );
    // Only the reached Entity's page is read.
    assert_eq!(usage.pages, 1);

    // A seed-only Graph contributes nothing and reads no pin.
    let (total, associations, usage) = join(&db, &nodes[..1], &[])?;
    assert_eq!(
        (total, associations.len(), usage.rows, usage.pages),
        (0, 0, 0, 0)
    );
    Ok(())
}

#[test]
fn scene_join_dedups_each_scene_to_its_minimum_tuple() -> Result<()> {
    let (nodes, edges) = ranked_graph();
    let db = pin_workspace(&["s", "a", "b", "c"])?;
    // Inserted against the tuple order.
    add_scene_pins(
        &db,
        &[
            ("all", "c"),
            ("all", "a"),
            ("all", "b"),
            ("a-and-c", "c"),
            ("a-and-c", "a"),
            ("c-only", "c"),
        ],
    )?;
    let (total, associations, _) = join(&db, &nodes, &edges)?;
    assert_eq!(total, 3);
    assert_eq!(
        scene_tuples(&associations, &edges),
        vec![
            scene_tuple("all", "b", &["e-1"]),
            scene_tuple("a-and-c", "a", &["e-2"]),
            scene_tuple("c-only", "c", &["e-1", "e-4"]),
        ]
    );
    Ok(())
}

#[test]
fn scene_join_orders_scene_ids_by_utf8_bytes() -> Result<()> {
    let (nodes, edges) = one_hop_graph();
    let db = pin_workspace(&["s", "x"])?;
    add_scene_pins(
        &db,
        &[
            ("\u{1F600}", "x"),
            ("\u{FF5E}", "x"),
            ("a", "x"),
            ("Z", "x"),
        ],
    )?;
    let (_, associations, _) = join(&db, &nodes, &edges)?;
    assert_eq!(
        associations
            .iter()
            .map(|scene| scene.scene_id.as_str())
            .collect::<Vec<_>>(),
        vec!["Z", "a", "\u{FF5E}", "\u{1F600}"]
    );
    Ok(())
}

#[test]
fn scene_join_truncates_to_eight_and_reports_scene_total() -> Result<()> {
    let (nodes, edges) = one_hop_graph();
    let db = pin_workspace(&["s", "x"])?;
    let scenes = scene_ids(10);
    // Reverse insertion: rowid order differs from the byte order.
    add_scene_pins(
        &db,
        &scenes
            .iter()
            .rev()
            .map(|scene| (scene.as_str(), "x"))
            .collect::<Vec<_>>(),
    )?;
    let (total, associations, usage) = join(&db, &nodes, &edges)?;
    assert_eq!(total, 10);
    assert_eq!(
        associations
            .iter()
            .map(|scene| scene.scene_id.clone())
            .collect::<Vec<_>>(),
        scenes[..MAX_GRAPH_SCENES].to_vec()
    );
    // Tokens are read only for the returned eight.
    assert_eq!(usage.rows, 10 + MAX_GRAPH_SCENES);
    Ok(())
}

#[test]
fn scene_join_budget_is_graph_wide_not_per_entity() -> Result<()> {
    let nodes = vec![
        synthetic_node("s", 0),
        synthetic_node("x", 1),
        synthetic_node("y", 1),
    ];
    let edges = vec![
        synthetic_edge("e-x", "s", "x", "directed"),
        synthetic_edge("e-y", "s", "y", "directed"),
    ];
    let db = pin_workspace(&["s", "x", "y"])?;
    let pins = (0..9)
        .flat_map(|index| [(format!("x-{index}"), "x"), (format!("y-{index}"), "y")])
        .collect::<Vec<_>>();
    add_scene_pins(
        &db,
        &pins
            .iter()
            .map(|(scene, entry)| (scene.as_str(), *entry))
            .collect::<Vec<_>>(),
    )?;
    let (total, _, fresh) = join(&db, &nodes, &edges)?;
    assert_eq!((total, fresh.rows), (18, 18 + MAX_GRAPH_SCENES));
    // Each Entity's nine pins fit in 15 rows; together they do not.
    let mut usage = QueryUsage {
        rows: MAX_GRAPH_RECORDS - 15,
        ..QueryUsage::default()
    };
    let error = run_join(&db, &nodes, &edges, &mut usage, &mut RegistrationOwner)
        .expect_err("the shared remainder covers both Entities");
    assert_eq!(join_failure_cause(error), WorkerCause::SceneLimit);
    Ok(())
}

#[test]
fn scene_join_rows_n_available_n_plus_one_limit() -> Result<()> {
    let (nodes, edges) = one_hop_graph();
    let db = pin_workspace(&["s", "x"])?;
    let scenes = scene_ids(20);
    add_scene_pins(
        &db,
        &scenes
            .iter()
            .map(|scene| (scene.as_str(), "x"))
            .collect::<Vec<_>>(),
    )?;
    let (_, expected, fresh) = join(&db, &nodes, &edges)?;
    // Twenty pin rows and the eight returned Scene rows.
    let needed = fresh.rows;
    assert_eq!(needed, 20 + MAX_GRAPH_SCENES);
    let mut usage = QueryUsage {
        rows: MAX_GRAPH_RECORDS - needed,
        ..QueryUsage::default()
    };
    let (total, associations) = run_join(&db, &nodes, &edges, &mut usage, &mut RegistrationOwner)?;
    assert_eq!((total, associations), (20, expected));
    assert_eq!(usage.rows, MAX_GRAPH_RECORDS);
    let mut usage = QueryUsage {
        rows: MAX_GRAPH_RECORDS - needed + 1,
        ..QueryUsage::default()
    };
    let error = run_join(&db, &nodes, &edges, &mut usage, &mut RegistrationOwner)
        .expect_err("one row over the shared remainder");
    assert_eq!(join_failure_cause(error), WorkerCause::SceneLimit);
    Ok(())
}

#[test]
fn scene_join_pages_n_available_n_plus_one_limit() -> Result<()> {
    let (nodes, edges) = one_hop_graph();
    // Sixteen pins need one full page and the has-more probe; seventeen need
    // a second page.
    for (pins, pages_needed) in [(16usize, 1usize), (17, 2)] {
        let db = pin_workspace(&["s", "x"])?;
        let scenes = scene_ids(pins);
        add_scene_pins(
            &db,
            &scenes
                .iter()
                .map(|scene| (scene.as_str(), "x"))
                .collect::<Vec<_>>(),
        )?;
        let mut usage = QueryUsage {
            pages: QUERY_MAX_PAGES - pages_needed,
            ..QueryUsage::default()
        };
        let (total, _) = run_join(&db, &nodes, &edges, &mut usage, &mut RegistrationOwner)?;
        assert_eq!((total, usage.pages), (pins, QUERY_MAX_PAGES), "{pins} pins");
        let mut usage = QueryUsage {
            pages: QUERY_MAX_PAGES - pages_needed + 1,
            ..QueryUsage::default()
        };
        let error = run_join(&db, &nodes, &edges, &mut usage, &mut RegistrationOwner)
            .expect_err("one page over the shared 32");
        assert_eq!(
            join_failure_cause(error),
            WorkerCause::SceneLimit,
            "{pins} pins"
        );
    }
    Ok(())
}

#[test]
fn scene_join_bytes_exhaustion_is_limit() -> Result<()> {
    let (nodes, edges) = one_hop_graph();
    let db = pin_workspace(&["s", "x"])?;
    add_scene_pins(&db, &[("scene-a", "x"), ("scene-b", "x"), ("scene-c", "x")])?;
    let (_, expected, fresh) = join(&db, &nodes, &edges)?;
    let needed = fresh.bytes;
    assert!(needed > 0);
    let mut usage = QueryUsage {
        bytes: MAX_GRAPH_INPUT_BYTES - needed,
        ..QueryUsage::default()
    };
    let (_, associations) = run_join(&db, &nodes, &edges, &mut usage, &mut RegistrationOwner)?;
    assert_eq!(associations, expected);
    assert_eq!(usage.bytes, MAX_GRAPH_INPUT_BYTES);
    for mut usage in [
        QueryUsage {
            bytes: MAX_GRAPH_INPUT_BYTES - needed + 1,
            ..QueryUsage::default()
        },
        // The retained ledger is the same shared budget.
        QueryUsage {
            retained_bytes: MAX_GRAPH_INPUT_BYTES,
            ..QueryUsage::default()
        },
    ] {
        let error = run_join(&db, &nodes, &edges, &mut usage, &mut RegistrationOwner)
            .expect_err("bytes over the shared remainder");
        assert_eq!(join_failure_cause(error), WorkerCause::SceneLimit);
    }
    Ok(())
}

#[test]
fn scene_join_scene_section_n_available_n_plus_one_limit() -> Result<()> {
    let without_id = super::worker_frame::SceneAssociationLengths {
        scene_id: 0,
        scene_incarnation_id: None,
        scene_source_token: format!("v0@{SCENE_UPDATED_AT}").len(),
        scene_scope_token: None,
        pin_entry_id: "x".len(),
        pin_created_at: PIN_CREATED_AT.len(),
        path_edge_count: 1,
    }
    .encoded_bytes()
    .expect("small association");
    let exact = MAX_SCENE_SECTION_BYTES - SCENE_SECTION_HEADER_BYTES - without_id;
    for (id_bytes, admitted) in [(exact, true), (exact + 1, false)] {
        let (nodes, edges) = one_hop_graph();
        let db = pin_workspace(&["s", "x"])?;
        let scene = "s".repeat(id_bytes);
        add_scene_pins(&db, &[(scene.as_str(), "x")])?;
        let result = join(&db, &nodes, &edges);
        if !admitted {
            let Err(error) = result else {
                panic!("the Scene section is one byte over its cap");
            };
            assert!(format!("{error:#}").contains("NIR1_GRAPH_SCENE_FRAME_LIMIT"));
            assert_eq!(join_failure_cause(error), WorkerCause::SceneLimit);
            continue;
        }
        let (scene_total, scenes, _) = result?;
        // The worker's pre-check is the encoded size: the frame is exact.
        let response = Nir1GraphResponse {
            status: "available",
            project_id: PROJECT.into(),
            query_scene_id: "nir1".into(),
            scope_revision: Some("scope-authority".into()),
            graph: Some(Nir1QualifiedGraph {
                seed_entity_id: "s".into(),
                generation: 1,
                nodes,
                edges,
                scene_total,
                scenes,
            }),
            reason: None,
        };
        let frame = super::worker_frame::encode(&response)?;
        let view = super::worker_frame::validate(&frame)?;
        assert_eq!(view.graph().map(|graph| graph.scene_count()), Some(1));
    }
    Ok(())
}

/// Stops at the n-th owner check, as a cancellation or deadline would.
struct StopAtCheck {
    checks: usize,
    stop_at: usize,
}

impl GraphWorkControl for StopAtCheck {
    fn check(&mut self, _: GraphWorkStage) -> Result<()> {
        self.checks += 1;
        if self.checks == self.stop_at {
            return Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "test stop",
            ));
        }
        Ok(())
    }
}

#[test]
fn scene_join_cancellation_returns_no_partial_result() -> Result<()> {
    let (nodes, edges) = ranked_graph();
    let db = pin_workspace(&["s", "a", "b", "c"])?;
    let scenes = scene_ids(17);
    add_scene_pins(
        &db,
        &scenes
            .iter()
            .map(|scene| (scene.as_str(), "c"))
            .chain([("a-scene", "a"), ("b-scene", "b")])
            .collect::<Vec<_>>(),
    )?;
    let mut complete = StopAtCheck {
        checks: 0,
        stop_at: usize::MAX,
    };
    let (total, _) = run_join(
        &db,
        &nodes,
        &edges,
        &mut QueryUsage::default(),
        &mut complete,
    )?;
    assert_eq!(total, 19);
    assert!(complete.checks > 19, "{}", complete.checks);
    for stop_at in 1..=complete.checks {
        let mut control = StopAtCheck { checks: 0, stop_at };
        let error = run_join(
            &db,
            &nodes,
            &edges,
            &mut QueryUsage::default(),
            &mut control,
        )
        .expect_err("a stopped join returns no result");
        // A stop keeps its typed cause; it is never relabelled as a limit.
        assert_eq!(
            join_failure_cause(error),
            WorkerCause::ValidationCancelled,
            "check {stop_at}"
        );
    }
    Ok(())
}

#[test]
fn scene_join_never_reads_scene_body() -> Result<()> {
    use rusqlite::hooks::{AuthAction, Authorization};

    let (nodes, edges) = ranked_graph();
    let db = pin_workspace(&["s", "a", "b", "c"])?;
    add_scene_pins(&db, &[("scene-a", "a"), ("scene-c", "c")])?;
    db.with_conn(|conn| {
        crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
            conn,
            PROJECT,
            "scene-c",
            SCENE_UPDATED_AT,
        )
    })?;
    let reads = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let observed = Arc::clone(&reads);
    db.with_conn(|conn| {
        conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
            if let AuthAction::Read {
                table_name,
                column_name,
            } = context.action
            {
                observed
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push((table_name.to_owned(), column_name.to_owned()));
            }
            Authorization::Allow
        }))?;
        Ok(())
    })?;
    let joined = join(&db, &nodes, &edges);
    let control: Option<String> = db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT content FROM tree_nodes WHERE id='scene-a'",
                [],
                |row| row.get(0),
            )
            .ok())
    })?;
    db.with_conn(|conn| {
        conn.authorizer(None::<fn(rusqlite::hooks::AuthContext<'_>) -> Authorization>)?;
        Ok(())
    })?;
    let (total, associations, _) = joined?;
    assert_eq!(total, 2);
    assert!(associations[1].scene_scope_token.is_some());
    assert!(control.is_some());
    let reads = reads
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let content_reads = reads
        .iter()
        .filter(|(table, column)| table == "tree_nodes" && column == "content")
        .count();
    // Only the control statement after the join selected the body.
    assert_eq!(content_reads, 1, "{reads:?}");
    assert!(reads
        .iter()
        .any(|(table, column)| table == "scene_codex_pins" && column == "entry_id"));
    assert!(reads.iter().any(
        |(table, column)| table == "narrative_scene_scope_bindings" && column == "source_token"
    ));
    Ok(())
}

#[test]
fn scene_join_steps_do_not_follow_unrelated_pins() -> Result<()> {
    const UNRELATED_PINS: [usize; 3] = [0, 600, 6_000];
    const UNRELATED_SCENES: usize = 100;
    let (nodes, edges) = one_hop_graph();
    // Unrelated Entities sort after the reached one, so every index seek may
    // meet an unrelated key instead of the end of the index.
    let unrelated = (0..UNRELATED_PINS[2] / UNRELATED_SCENES)
        .map(|index| format!("zz-unrelated-{index:02}"))
        .collect::<Vec<_>>();
    let mut entities = vec!["s", "x"];
    entities.extend(unrelated.iter().map(String::as_str));
    let db = pin_workspace(&entities)?;
    add_scene_pins(&db, &[("scene-a", "x"), ("scene-b", "x"), ("scene-c", "x")])?;
    let mut measurements = Vec::new();
    let mut added = 0;
    for target in UNRELATED_PINS {
        let pins = (added..target)
            .map(|pin| {
                (
                    format!("unrelated-scene-{:03}", pin % UNRELATED_SCENES),
                    unrelated[pin / UNRELATED_SCENES].as_str(),
                )
            })
            .collect::<Vec<_>>();
        add_scene_pins(
            &db,
            &pins
                .iter()
                .map(|(scene, entry)| (scene.as_str(), *entry))
                .collect::<Vec<_>>(),
        )?;
        added = target;
        let steps = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counter = Arc::clone(&steps);
        let mut usage = QueryUsage::default();
        let result = db.with_read_transaction(|conn| {
            crate::set_sqlite_progress_handler(
                conn,
                1,
                Some(move || {
                    counter.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )?;
            let result = join_scene_pins(
                conn,
                &graph_request("s"),
                &nodes,
                &edges,
                &mut usage,
                &mut RegistrationOwner,
            );
            crate::set_sqlite_progress_handler(conn, 0, None::<fn() -> bool>)?;
            result
        })?;
        measurements.push((
            steps.load(Ordering::Relaxed),
            (usage.rows, usage.bytes, usage.pages),
            result,
        ));
    }
    let [(none, admission, result), (some, some_admission, some_result), (many, many_admission, many_result)] =
        measurements.as_slice()
    else {
        panic!("three measurements");
    };
    assert!(*none > 0);
    assert_eq!(some_admission, admission);
    assert_eq!(many_admission, admission);
    assert_eq!(some_result, result);
    assert_eq!(many_result, result);
    assert_eq!(some, many, "600 -> 6,000 unrelated pins must not add steps");
    // The nonpositive-rowid probe and the one page may each compare one
    // following unrelated key instead of reaching the end of the index.
    assert!((*none..=*none + 2).contains(some), "{none} -> {some}");
    Ok(())
}

#[test]
fn scene_join_output_is_deterministic() -> Result<()> {
    let (nodes, edges) = ranked_graph();
    let pins = [
        ("all", "c"),
        ("all", "a"),
        ("all", "b"),
        ("a-and-c", "c"),
        ("a-and-c", "a"),
        ("c-only", "c"),
        ("b-only", "b"),
    ];
    let forward = pin_workspace(&["s", "a", "b", "c"])?;
    add_scene_pins(&forward, &pins)?;
    let reversed = pin_workspace(&["s", "a", "b", "c"])?;
    add_scene_pins(&reversed, &pins.iter().rev().copied().collect::<Vec<_>>())?;

    let frame = |db: &crate::Database| -> Result<(Vec<u8>, Vec<SceneTuple>)> {
        let (nodes, edges) = ranked_graph();
        let (scene_total, scenes, _) = join(db, &nodes, &edges)?;
        let tuples = scene_tuples(&scenes, &edges);
        let response = Nir1GraphResponse {
            status: "available",
            project_id: PROJECT.into(),
            query_scene_id: "nir1".into(),
            scope_revision: Some("scope-authority".into()),
            graph: Some(Nir1QualifiedGraph {
                seed_entity_id: "s".into(),
                generation: 1,
                nodes,
                edges,
                scene_total,
                scenes,
            }),
            reason: None,
        };
        Ok((super::worker_frame::encode(&response)?, tuples))
    };
    let (first, tuples) = frame(&forward)?;
    let (second, _) = frame(&forward)?;
    assert_eq!(
        first, second,
        "the same snapshot yields the same frame bytes"
    );
    let (_, reversed_tuples) = frame(&reversed)?;
    // Pin rowids follow insertion; the tuple order does not.
    assert_eq!(reversed_tuples, tuples);
    assert_eq!(
        tuples,
        vec![
            scene_tuple("all", "b", &["e-1"]),
            scene_tuple("b-only", "b", &["e-1"]),
            scene_tuple("a-and-c", "a", &["e-2"]),
            scene_tuple("c-only", "c", &["e-1", "e-4"]),
        ]
    );
    let (direct_total, _, _) = join(&forward, &nodes, &edges)?;
    assert_eq!(direct_total, 4);
    Ok(())
}

fn graph_shape(response: &Nir1GraphResponse) -> (Vec<(String, u8)>, Vec<String>) {
    let graph = response.graph.as_ref().expect("available Graph");
    (
        graph
            .nodes
            .iter()
            .map(|node| (node.entity.entity_id.clone(), node.hop))
            .collect(),
        graph
            .edges
            .iter()
            .map(|edge| edge.relation.edge_id.clone())
            .collect(),
    )
}

#[test]
fn reader_and_worker_return_scene_associations_with_the_graph() -> Result<()> {
    let scenes = ["pinned-b", "pinned-a", "seed-pin"].map(String::from);
    let fixture = Fixture::with_scenes(&scenes)?;
    fixture.add_pins(&[
        ("pinned-b", "nir1-bob"),
        ("pinned-a", "nir1-bob"),
        ("seed-pin", "nir1-alice"),
    ])?;
    let response = query(&mut fixture.registered_reader()?, "nir1-alice")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    // Scenes after the reading order leave the Graph's own material as is.
    let baseline = Fixture::new()?;
    assert_eq!(
        graph_shape(&response),
        graph_shape(&query(&mut baseline.registered_reader()?, "nir1-alice")?)
    );
    let graph = response.graph.as_ref().expect("available Graph");
    assert_eq!(graph.scene_total, 2);
    assert_eq!(
        scene_tuples(&graph.scenes, &graph.edges),
        vec![
            scene_tuple("pinned-a", "nir1-bob", &["nir1-edge"]),
            scene_tuple("pinned-b", "nir1-bob", &["nir1-edge"]),
        ]
    );

    let mut worker = fixture.worker_reader()?;
    let worker_response = worker.query_for_worker_with_maintenance_deadline(
        &graph_request("nir1-alice"),
        Duration::from_secs(2),
    )?;
    assert_eq!(
        worker_response.status, "available",
        "{:?}",
        worker_response.reason
    );
    let frame = super::worker_frame::encode(&worker_response)?;
    let view = super::worker_frame::validate(&frame)?;
    let projected = view.graph().expect("available frame");
    assert_eq!(projected.diagnostic_scene_total(), 2);
    let mut projected_scenes = Vec::new();
    for scene in projected.scenes() {
        let scene = scene?;
        let path = projected.scene_path(&scene)?;
        let steps = path
            .steps()
            .map(|step| {
                (
                    step.edge.relation.edge_id.to_owned(),
                    step.from.to_owned(),
                    step.to.to_owned(),
                )
            })
            .collect::<Vec<_>>();
        projected_scenes.push((scene.scene_id.to_owned(), steps));
    }
    let step = || {
        vec![(
            "nir1-edge".to_owned(),
            "nir1-alice".to_owned(),
            "nir1-bob".to_owned(),
        )]
    };
    assert_eq!(
        projected_scenes,
        vec![
            ("pinned-a".to_owned(), step()),
            ("pinned-b".to_owned(), step())
        ]
    );
    Ok(())
}

#[test]
fn graph_with_pin_overflow_is_unavailable_without_partial_graph() -> Result<()> {
    // Seed reverse-index decoys take most of the shared 512 rows and 32
    // pages, so the reached Entity's pins cannot all be enumerated.
    let scenes = (0..64)
        .map(|index| format!("overflow-{index:02}"))
        .collect::<Vec<_>>();
    let fixture = Fixture::with_scenes(&scenes)?;
    // The Graph's own admission before the join: both reverse-index pages
    // and the one Revision's A2/A3 rows (Scenes add A3 rows too).
    let candidate_rows = fixture.authority.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id=?1
                AND source_object_identity IN ('codex:nir1-alice', 'codex:nir1-bob')",
            [PROJECT],
            |row| row.get::<_, i64>(0),
        )?)
    })?;
    let seed = fixture.seed_a2_a3_usage()?;
    let graph_rows = usize::try_from(candidate_rows)? + seed.a2_rows + seed.a3_rows;
    const REMAINING_ROWS: usize = 24;
    fixture.add_decoys(
        MAX_GRAPH_RECORDS - graph_rows - REMAINING_ROWS,
        "codex:nir1-alice",
    )?;
    let baseline = query(&mut fixture.registered_reader()?, "nir1-alice")?;
    assert_eq!(baseline.status, "available", "{:?}", baseline.reason);
    fixture.add_pins(
        &scenes
            .iter()
            .map(|scene| (scene.as_str(), "nir1-bob"))
            .collect::<Vec<_>>(),
    )?;
    let mut reader = fixture.registered_reader()?;
    assert_unavailable(
        &query(&mut reader, "nir1-alice")?,
        "query-budget-or-validation-failed",
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());

    let mut worker = fixture.worker_reader()?;
    let response = worker.query_for_worker_with_maintenance_deadline(
        &graph_request("nir1-alice"),
        Duration::from_secs(2),
    )?;
    let reason = response
        .reason
        .as_deref()
        .and_then(UnavailableReason::parse)
        .expect("an allowlisted worker reason");
    assert_unavailable(&response, &reason.to_string());
    assert_eq!(
        reason,
        UnavailableReason::Worker {
            site: WorkerSite::Work,
            cause: WorkerCause::SceneLimit,
            pre_cleanup: Some(PreCleanup::WorkFailed(WorkerCause::SceneLimit)),
        }
    );
    assert_eq!(
        reason.category(),
        super::worker_frame::UnavailableCategory::Limit
    );
    let frame = super::worker_frame::encode(&response)?;
    assert_eq!(
        super::worker_frame::validate(&frame)?.unavailable_reason(),
        Some(reason)
    );
    Ok(())
}

struct JoinMeasurement {
    steps: u64,
    wall: Duration,
    /// (rows, bytes, pages) charged to the QueryUsage.
    admission: (usize, usize, usize),
    scene_total: usize,
}

/// Join steps, admission and wall for one shared QueryUsage, measured on a
/// fresh read transaction. Steps use a cadence-one progress handler; wall is
/// a separate run without it.
fn measure_join(
    db: &crate::Database,
    nodes: &[Nir1GraphNode],
    edges: &[Nir1GraphEdge],
) -> Result<JoinMeasurement> {
    let steps = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let counter = Arc::clone(&steps);
    let mut usage = QueryUsage::default();
    let (total, _) = db.with_read_transaction(|conn| {
        crate::set_sqlite_progress_handler(
            conn,
            1,
            Some(move || {
                counter.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )?;
        let result = join_scene_pins(
            conn,
            &graph_request("s"),
            nodes,
            edges,
            &mut usage,
            &mut RegistrationOwner,
        );
        crate::set_sqlite_progress_handler(conn, 0, None::<fn() -> bool>)?;
        result
    })?;
    let mut wall = Duration::MAX;
    for _ in 0..5 {
        let started = Instant::now();
        run_join(
            db,
            nodes,
            edges,
            &mut QueryUsage::default(),
            &mut RegistrationOwner,
        )?;
        wall = wall.min(started.elapsed());
    }
    Ok(JoinMeasurement {
        steps: steps.load(Ordering::Relaxed),
        wall,
        admission: (usage.rows, usage.bytes, usage.pages),
        scene_total: total,
    })
}

#[test]
#[ignore = "CP-1 measurement only: Scene-join steps/wall and NQG2 Scene-section bytes"]
fn measure_scene_join_capacity_and_frame_bytes() -> Result<()> {
    // Scene section bytes for realistic identifiers: the sample project's
    // pins and G-01-shaped UUIDs, each bound to an A1 row, behind a 2-hop
    // path (the largest path encoding).
    let sample_pins = include_str!("../../../../../resources/sample_project/v2.sql")
        .lines()
        .filter_map(|line| {
            let values = line.strip_prefix(
                "INSERT OR IGNORE INTO scene_codex_pins (scene_id, entry_id, created_at) VALUES ('",
            )?;
            let (scene, rest) = values.split_once("', '")?;
            let (entry, _) = rest.split_once('\'')?;
            Some((scene.to_owned(), entry.to_owned()))
        })
        .collect::<Vec<_>>();
    assert!(!sample_pins.is_empty());
    let uuid_pins = (0..MAX_GRAPH_SCENES)
        .map(|_| {
            (
                uuid::Uuid::new_v4().to_string(),
                uuid::Uuid::new_v4().to_string(),
            )
        })
        .collect::<Vec<_>>();
    for (label, pins, updated_at) in [
        // The sample seeder stamps rows with chrono's RFC 3339 nanoseconds.
        (
            "sample",
            &sample_pins,
            "2026-10-13T00:00:00.123456789+00:00",
        ),
        ("uuid", &uuid_pins, "2026-10-13T00:00:00.000Z"),
    ] {
        let mut entities = pins
            .iter()
            .map(|(_, entry)| entry.as_str())
            .collect::<Vec<_>>();
        entities.sort_unstable();
        entities.dedup();
        let mut all = vec!["s", "m"];
        all.extend(entities.iter().copied());
        let db = pin_workspace(&all)?;
        db.with_conn(|conn| {
            for (scene, entry) in pins {
                conn.execute(
                    "INSERT OR IGNORE INTO tree_nodes
                        (id, project_id, node_type, title, content, sort_order, version, updated_at)
                     VALUES (?1, ?2, 'scene', 'Pinned', '{}', 'z0', 9999, ?3)",
                    params![scene, PROJECT, updated_at],
                )?;
                conn.execute(
                    "INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
                     VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
                    params![scene, entry],
                )?;
                crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                    conn, PROJECT, scene, updated_at,
                )?;
            }
            Ok(())
        })?;
        let mut nodes = vec![synthetic_node("s", 0), synthetic_node("m", 1)];
        let mut edges = vec![synthetic_edge(
            &uuid::Uuid::new_v4().to_string(),
            "s",
            "m",
            "directed",
        )];
        for entity in &entities {
            nodes.push(synthetic_node(entity, 2));
            edges.push(synthetic_edge(
                &uuid::Uuid::new_v4().to_string(),
                "m",
                entity,
                "directed",
            ));
        }
        let (total, scenes, _) = join(&db, &nodes, &edges)?;
        let lengths = scenes
            .iter()
            .map(|scene| {
                super::worker_frame::SceneAssociationLengths::of(scene)
                    .encoded_bytes()
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let max = lengths.iter().copied().max().unwrap_or(0);
        eprintln!(
            "CP-1 Scene section: shape={label}; pins={}; scene_total={total}; returned={}; association_bytes_max={max}; section_bytes={}; eight_at_max={}; cap={MAX_SCENE_SECTION_BYTES}",
            pins.len(),
            scenes.len(),
            SCENE_SECTION_HEADER_BYTES + lengths.iter().sum::<usize>(),
            SCENE_SECTION_HEADER_BYTES + MAX_GRAPH_SCENES * max,
        );
    }

    // Steps and wall: pins on one reached Entity, bodies of 200 B and 200 KB,
    // and the same budget spread over eleven reached Entities.
    let body = |bytes: usize| {
        serde_json::json!({
            "type": "doc",
            "content": [{"type": "paragraph", "content": [{"type": "text", "text": "x".repeat(bytes)}]}]
        })
        .to_string()
    };
    for body_bytes in [200usize, 200 * 1024] {
        for pins in [0usize, 16, 17, 256, 496] {
            let (nodes, edges) = one_hop_graph();
            let db = pin_workspace(&["s", "x"])?;
            let content = body(body_bytes);
            db.with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                for scene in scene_ids(pins) {
                    tx.execute(
                        "INSERT INTO tree_nodes
                            (id, project_id, node_type, title, content, sort_order, updated_at)
                         VALUES (?1, ?2, 'scene', 'Pinned', ?3, 'z0', ?4)",
                        params![scene, PROJECT, content, SCENE_UPDATED_AT],
                    )?;
                    tx.execute(
                        "INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
                         VALUES (?1, 'x', ?2)",
                        params![scene, PIN_CREATED_AT],
                    )?;
                }
                tx.commit()?;
                Ok(())
            })?;
            let measured = measure_join(&db, &nodes, &edges)?;
            eprintln!(
                "CP-1 Scene join: entities=1; pins={pins}; body_bytes={body_bytes}; scene_total={}; steps={}; wall_min_of_5={:?}; (rows, bytes, pages)={:?}",
                measured.scene_total, measured.steps, measured.wall, measured.admission
            );
        }
    }
    let mut nodes = vec![synthetic_node("s", 0)];
    let mut edges = Vec::new();
    let entities = (0..MAX_GRAPH_NODES - 1)
        .map(|index| format!("e{index:02}"))
        .collect::<Vec<_>>();
    for entity in &entities {
        nodes.push(synthetic_node(entity, 1));
        edges.push(synthetic_edge(
            &format!("edge-{entity}"),
            "s",
            entity,
            "directed",
        ));
    }
    let mut all = vec!["s"];
    all.extend(entities.iter().map(String::as_str));
    let db = pin_workspace(&all)?;
    let spread = entities
        .iter()
        // 31 pins are two pages per Entity: 22 of the shared 32 pages.
        .flat_map(|entity| {
            (0..31).map(move |index| (format!("{entity}-scene-{index:02}"), entity.clone()))
        })
        .collect::<Vec<_>>();
    add_scene_pins(
        &db,
        &spread
            .iter()
            .map(|(scene, entity)| (scene.as_str(), entity.as_str()))
            .collect::<Vec<_>>(),
    )?;
    let measured = measure_join(&db, &nodes, &edges)?;
    eprintln!(
        "CP-1 Scene join: entities=11; pins={}; scene_total={}; steps={}; wall_min_of_5={:?}; (rows, bytes, pages)={:?}",
        spread.len(),
        measured.scene_total,
        measured.steps,
        measured.wall,
        measured.admission
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// C-resource boundaries (CR-2, proposal/6): G-1 B publish, G-2 per-Revision
// preflight, G-3 wait 0, and G-4 proposal/5 negatives. They run in-process, on
// the ordinary reader and on the worker-shaped reader over the authority
// connection. `worker_query` is the production worker configuration: the
// maintenance owner and the production SQL step budget. It runs under the
// ordinary allocator, not the real worker binary's fixed arena, so none of these
// tests shows what the real worker can process.
// ---------------------------------------------------------------------------

/// Per-Revision preflight limit: `input::INPUT_BYTES` (proposal/6 RB-2).
const PER_REVISION_PREFLIGHT_BYTES: usize = 2 * 1024 * 1024;

/// Upper bound for a refused query to return. Against a held write lock a query
/// meets SQLITE_BUSY at its first read and again at its post-cleanup stamp, so a
/// busy timeout T costs about 2T. This bound therefore detects a timeout of
/// about 0.5 s or more, such as SQLite's 5 s default; a short non-zero timeout
/// still passes.
const BUSY_WAIT_BOUND: Duration = Duration::from_secs(1);

/// Extra Codex objects and directed Relations added to the seed Revision.
/// The seed's alice, bob, and nir1-edge are always present.
#[derive(Default)]
struct GraphPlan {
    entities: Vec<String>,
    relations: Vec<(String, String, String)>,
}

/// Same scope edits as the seed Revision, so every Entity is A3-eligible for
/// the `nir1` query scene.
fn seed_scope_edits(bundle: &mut EntityRelationBundle) {
    for entity in &mut bundle.entities {
        entity.scope.reading = ScopeValue::Exact {
            value: "scene:a3-source".into(),
        };
        entity.scope.phase = "draft".into();
    }
}

fn publish_graph_index(authority: &WorkspaceAuthority) -> Result<()> {
    let runtime = authority.nir_chronicle_index_runtime();
    let snapshot = authority
        .with_read_transaction(|conn| prepare_graph_index_build(conn, runtime, PROJECT))?;
    authority.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        publish_nir1_entity_relation_index_in_tx(&tx, runtime, snapshot)?;
        tx.commit()?;
        Ok(())
    })
}

/// The Evidence identifier used for an Entity, e.g. `nir1-alice` ->
/// `nir1-evidence-alice`, matching the seed Revision.
fn evidence_id_for(entity: &str) -> String {
    format!("nir1-evidence-{}", entity.trim_start_matches("nir1-"))
}

fn worker_query(reader: &mut Nir1GraphReader, seed: &str) -> Result<Nir1GraphResponse> {
    reader.query_for_worker_with_maintenance_deadline(&graph_request(seed), Duration::from_secs(2))
}

fn assert_refused_without_graph(response: &Nir1GraphResponse) {
    assert_eq!(response.status, "unavailable", "{:?}", response.reason);
    assert!(
        response.graph.is_none(),
        "a refused query must not expose a partial Graph"
    );
    assert!(response.scope_revision.is_none());
}

/// A refusal on the production worker configuration that is not a step or
/// deadline artifact. The fixtures behind it fit the production step budget, so
/// the refusal belongs to the limit under test.
fn assert_refused_within_budget(response: &Nir1GraphResponse) {
    assert_refused_without_graph(response);
    let reason = response.reason.as_deref().unwrap_or_default();
    assert!(
        !reason.contains("steps") && !reason.contains("deadline"),
        "the refusal is a budget artifact: {reason}"
    );
}

fn hop_map(graph: &Nir1QualifiedGraph) -> BTreeMap<String, u8> {
    graph
        .nodes
        .iter()
        .map(|node| (node.entity.entity_id.clone(), node.hop))
        .collect()
}

fn edge_ids(graph: &Nir1QualifiedGraph) -> Vec<String> {
    let mut ids: Vec<String> = graph
        .edges
        .iter()
        .map(|edge| edge.relation.edge_id.clone())
        .collect();
    ids.sort();
    ids
}

impl Fixture {
    /// The seed Revision plus the objects in `plan`, all in one approved typed
    /// Revision published once.
    fn with_graph(plan: &GraphPlan) -> Result<Self> {
        let directory = TestDirectory(
            std::env::temp_dir().join(format!("nir1-c-graph-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&directory.0)?;
        let db = crate::Database::new(&directory.0.join("grimodex.db"))?;
        db.migrate()?;
        seed_run_and_catalog(&db)?;
        prepare_a3_scope_fixture(&db)?;
        db.with_conn(|conn| {
            for entity in &plan.entities {
                conn.execute(
                    "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                     VALUES (?1, 'default-project', 'character', ?1, ?1, '2026-09-12T00:00:00Z')",
                    [entity],
                )?;
            }
            for (edge, from, to) in &plan.relations {
                conn.execute(
                    "INSERT INTO codex_relations
                        (id, project_id, from_codex_id, to_codex_id, relation_type,
                         directionality, version, updated_at)
                     VALUES (?1, 'default-project', ?2, ?3, 'knows', 'directed', 1,
                             '2026-09-12T00:00:00Z')",
                    params![edge, from, to],
                )?;
            }
            Ok(())
        })?;
        run_incremental_freshness_cycle(&db)?;
        let mut typed = request(&db);
        seed_scope_edits(&mut typed.bundle);
        let template = typed.bundle.entities[0].clone();
        for entity in &plan.entities {
            typed.bundle.entities.push(EntityInput {
                entity_id: entity.clone(),
                entity_type: template.entity_type.clone(),
                label: entity.clone(),
                source_token: format!("codex:{entity}@2026-09-12T00:00:00Z"),
                scope: template.scope.clone(),
                evidence: vec![EvidenceInput {
                    evidence_id: evidence_id_for(entity),
                    source_ref: format!("codex:{entity}"),
                    start_utf16: 0,
                    end_utf16: entity.encode_utf16().count(),
                    quote: entity.clone(),
                }],
            });
        }
        for (edge, from, to) in &plan.relations {
            typed.bundle.relations.push(GraphEdgeInput {
                edge_id: edge.clone(),
                from_entity_id: from.clone(),
                to_entity_id: to.clone(),
                relation_type: "knows".into(),
                directionality: "directed".into(),
                source_token: format!("v1@2026-09-12T00:00:00Z:relation:{edge}"),
                evidence_ids: vec![evidence_id_for(from), evidence_id_for(to)],
            });
        }
        let created = create_nir1_entity_relation_revision(&db, typed)?;
        approve_typed_revision(&db, "nir1-run", &created)?;
        let authority = WorkspaceAuthority::from_database_for_test(db, directory.0.clone())?;
        publish_graph_index(&authority)?;
        Ok(Self {
            authority,
            lifecycle: WorkspaceLifecycleCore::new(),
            revision: created["revisionId"].as_str().unwrap().to_owned(),
            _directory: directory,
        })
    }

    fn republish_graph_index(&self) -> Result<()> {
        publish_graph_index(&self.authority)
    }

    /// A2 admitted bytes for one typed Revision, from the reader's own preflight.
    /// `Err` is the per-Revision refusal.
    fn a2_admission(&self, revision: &str) -> Result<usize> {
        self.authority.with_conn(|conn| {
            let admission = super::input::preflight_revision(
                conn,
                PROJECT,
                revision,
                MAX_GRAPH_RECORDS,
                MAX_GRAPH_INPUT_BYTES,
            )?
            .ok_or_else(|| anyhow::anyhow!("candidate is not a typed Revision"))?;
            Ok(admission.bytes)
        })
    }

    /// One more approved typed Revision for the seed Entities. The serial has a
    /// fixed width, so every candidate shares the same base admission bytes.
    /// `decision_padding` grows the approval's `decision_json`, which A2 counts
    /// once in the Revision's preflight, so each padding byte is one admitted
    /// byte. The Graph response does not carry it.
    fn add_candidate_revision(&self, serial: usize, decision_padding: usize) -> Result<String> {
        let db = self.authority.db();
        let mut payload = request(db);
        payload.proposal_key = format!("nir1:review:candidate-{serial:04}");
        seed_scope_edits(&mut payload.bundle);
        let created = create_nir1_entity_relation_revision(db, payload)?;
        let revision = created["revisionId"].as_str().unwrap().to_owned();
        narrative_extraction_append_human_decision(
            db,
            AppendDecisionPayload {
                run_id: "nir1-run".into(),
                project_id: PROJECT.into(),
                proposal_id: created["proposalId"].as_str().unwrap().into(),
                revision_id: revision.clone(),
                decision: "approved".into(),
                decision_json: Some(serde_json::json!({
                    "pad": "p".repeat(decision_padding)
                })),
                created_by: Some("renderer-reviewer".into()),
            },
        )?;
        Ok(revision)
    }

    /// Decision padding that makes a candidate admit exactly `target` A2 bytes.
    /// Two probes on a throwaway fixture measure the base and the slope, so the
    /// fixture under test keeps one candidate beside the seed Revision: every
    /// further approved Revision costs about 33,400 SQL steps against the
    /// production budget of 100,000. The probes are approved like the candidate,
    /// because the approval's bytes are part of the admission.
    fn candidate_padding_for(target: usize) -> Result<usize> {
        let calibration = Self::new()?;
        let probe = calibration.add_candidate_revision(1, 0)?;
        let base = calibration.a2_admission(&probe)?;
        let grown = calibration.add_candidate_revision(2, 1000)?;
        ensure!(
            calibration.a2_admission(&grown)? - base == 1000,
            "one decision byte must add exactly one admitted byte"
        );
        target
            .checked_sub(base)
            .ok_or_else(|| anyhow::anyhow!("target is below the base admission"))
    }
}

/// A Relation fan of `count` Entities around alice (proposal/5 Entity 12).
fn star_plan(count: usize) -> GraphPlan {
    GraphPlan {
        entities: (0..count)
            .map(|index| format!("nir1-n{index:02}"))
            .collect(),
        relations: (0..count)
            .map(|index| {
                (
                    format!("nir1-edge-n{index:02}"),
                    "nir1-alice".to_owned(),
                    format!("nir1-n{index:02}"),
                )
            })
            .collect(),
    }
}

/// `count` parallel Relations from alice to bob, each a distinct edge
/// (proposal/5 edge expansion 144).
fn parallel_plan(count: usize) -> GraphPlan {
    GraphPlan {
        entities: Vec::new(),
        relations: (0..count)
            .map(|index| {
                (
                    format!("nir1-par-{index:03}"),
                    "nir1-alice".to_owned(),
                    "nir1-bob".to_owned(),
                )
            })
            .collect(),
    }
}

/// SQL step budget large enough that the cap never binds. A refusal under it
/// can only come from a semantic limit; the production budget is
/// `QUERY_SQL_STEPS`. Only the G-4 Entity and edge limits use it, on the
/// ordinary reader: it separates their semantic refusal from the step cap, and
/// the 144-edge fan exceeds the production budget before its edge limit. The
/// G-1 and G-2 tests stay within the production budget.
const UNCAPPED_SQL_STEPS: u64 = 10_000_000;

fn query_with_steps(
    reader: &mut Nir1GraphReader,
    seed: &str,
    sql_steps: u64,
) -> Result<Nir1GraphResponse> {
    reader.query_with_deadline(&graph_request(seed), Duration::from_secs(2), sql_steps)
}

// G-1 (RB-1): a Revision of 2.5 MiB counted bytes, above the C-query preflight
// (2 MiB) and below the writer limit, is saved, read by the A2 reader, and
// published by the B build. The C-query refuses any query that reaches it
// (proposal/6: 2-6 MiB Revisions are stored and read, but not used by the Graph).
//
// What decides B here is its per-component guard on the saved documents, not the
// counted bytes. B reads the stored payload and the stored reconciliation
// envelope and refuses the whole build when either is over 6,291,456 B
// (NIR1_GRAPH_PERSISTED_REVISION_INPUT_LIMIT). This padded shape stores an
// envelope of about 2.07x its counted bytes, so 2.5 MiB counted (envelope about
// 5.4 MB) is inside the guard. Near the writer limit it is not: 3,145,728
// counted bytes (payload + envelope about 9.7 MB, inside the 16 MiB whole set) is
// already refused by the component guard, and the exact writer limit by the
// whole set. RB-1's B positive for a Revision near the writer limit is therefore
// not covered by this test.
#[test]
fn b_publishes_a_revision_within_its_component_guard_that_the_c_query_refuses() -> Result<()> {
    let fixture = Fixture::new()?;
    let db = fixture.authority.db();
    let template = request(db).bundle;
    let base = writer_input_bytes(&bounded_writer_bundle(&template, 507, 0));
    let mut payload = request(db);
    payload.bundle =
        bounded_writer_bundle(&template, 507, B_COMPONENT_GUARD_CONTAINED_BYTES - base);
    assert_eq!(
        writer_input_bytes(&payload.bundle),
        B_COMPONENT_GUARD_CONTAINED_BYTES
    );
    let created = create_nir1_entity_relation_revision(db, payload)?;
    approve_typed_revision(db, "nir1-run", &created)?;
    let revision = created["revisionId"].as_str().unwrap().to_owned();
    let read = fixture.authority.with_read_transaction(|conn| {
        read_nir1_entity_relation_revision(conn, PROJECT, &revision)
    })?;
    assert!(
        matches!(read, Nir1EntityRelationRevisionRead::Available(_)),
        "the Revision must be readable by the A2 reader"
    );
    fixture.republish_graph_index()?;
    let source = fixture
        .authority
        .with_read_transaction(|conn| read_eligibility_source(conn, PROJECT))?;
    assert!(
        source
            .roster
            .iter()
            .any(|entry| entry.revision_id == revision),
        "B must publish the Revision's material"
    );
    // The refusal below is the per-Revision preflight's: A2's own admission of
    // this Revision is over the 2 MiB limit, rather than another guard, such as
    // the record limit, being the one that refuses the query.
    let refusal = fixture
        .a2_admission(&revision)
        .expect_err("a Revision above the per-Revision preflight is refused");
    assert!(
        refusal
            .to_string()
            .contains("NIR1_GRAPH_REVISION_INPUT_LIMIT"),
        "{refusal}"
    );
    let mut worker = fixture.worker_reader()?;
    assert_refused_within_budget(&worker_query(&mut worker, "nir1-alice")?);
    Ok(())
}

/// Counted bytes of one Revision that B publishes: above the C-query preflight
/// (2 MiB), and its stored envelope (about 2.07x the counted bytes for this
/// padded shape) stays inside B's 6,291,456 B per-component guard.
const B_COMPONENT_GUARD_CONTAINED_BYTES: usize = 2_621_440;

// G-2 (RB-2): a candidate of exactly the per-Revision preflight limit is an
// ordinary Graph contribution on the production worker configuration: the
// maintenance owner and the production SQL step budget (`worker_query`). The
// fixture is the seed Revision plus this one candidate. Each approved Revision
// costs about 33,400 SQL steps, so two use about 67,000 of the production
// budget of 100,000 and four would use about 134,000.
//
// This does not show that the real worker binary can process such a candidate.
// Its fixed query arena is 4,718,592 B, and the release worker leaves during its
// startup registration on a project that holds this exact candidate.
#[test]
fn worker_query_admits_a_candidate_at_exactly_the_per_revision_preflight_limit() -> Result<()> {
    let padding = Fixture::candidate_padding_for(PER_REVISION_PREFLIGHT_BYTES)?;
    let fixture = Fixture::new()?;
    let candidate = fixture.add_candidate_revision(1, padding)?;
    assert_eq!(
        fixture.a2_admission(&candidate)?,
        PER_REVISION_PREFLIGHT_BYTES
    );
    fixture.republish_graph_index()?;
    let mut reader = fixture.worker_reader()?;
    let response = worker_query(&mut reader, "nir1-alice")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let graph = response
        .graph
        .expect("an available response carries the Graph");
    for revision in [&fixture.revision, &candidate] {
        assert!(
            graph
                .edges
                .iter()
                .any(|edge| &edge.binding.revision_id == revision),
            "Revision {revision} must contribute its Relation"
        );
    }
    Ok(())
}

// G-2 (RB-2): one byte over the per-Revision preflight refuses the whole query
// on the same production worker configuration. The seed-only Graph is available
// first, and no partial Graph is returned. The same construction admits the
// exact limit (the test above), so only the one extra byte changes the outcome,
// and the refusal is the preflight's rather than a step or deadline artifact.
#[test]
fn query_refuses_the_whole_graph_when_a_candidate_is_one_byte_over() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut baseline = fixture.registered_reader()?;
    assert_eq!(query(&mut baseline, "nir1-alice")?.status, "available");

    let padding = Fixture::candidate_padding_for(PER_REVISION_PREFLIGHT_BYTES + 1)?;
    let candidate = fixture.add_candidate_revision(1, padding)?;
    let refusal = fixture
        .a2_admission(&candidate)
        .expect_err("one byte over the per-Revision preflight is refused");
    assert!(
        refusal
            .to_string()
            .contains("NIR1_GRAPH_REVISION_INPUT_LIMIT"),
        "{refusal}"
    );

    fixture.republish_graph_index()?;
    let mut worker = fixture.worker_reader()?;
    assert_refused_within_budget(&worker_query(&mut worker, "nir1-alice")?);
    Ok(())
}

// G-3 (RB-4): a busy database ends a query at once as an unavailable response
// on both reader paths: no partial Graph, a return in under a second, and a
// normal answer again once the lock is released.
//
// How SQLITE_BUSY is injected, and what that covers. A WAL reader never waits
// on another connection's write lock, and an EXCLUSIVE-locking-mode holder
// cannot be created while reader connections are open, so this fixture
// switches the database to the rollback journal (journal_mode=DELETE). There a
// second connection's BEGIN EXCLUSIVE makes readers return SQLITE_BUSY at once.
// Not covered: busy causes that exist only in WAL (recovery, SQLite's internal
// WAL retries). The ordinary reader is checked against its own busy timeout of
// 0. The worker path runs under the production maintenance scope, which sets
// the busy timeout to 0 itself, so it checks that production setting rather
// than the borrowed connection's own. The 1 s bound (BUSY_WAIT_BOUND) detects a
// timeout of about 0.5 s or more.
#[test]
fn busy_database_refuses_both_reader_paths_without_waiting() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.authority.db().with_conn(|conn| {
        let mode: String = conn.query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))?;
        anyhow::ensure!(mode == "delete", "journal mode is {mode}");
        Ok(())
    })?;
    let mut ordinary = fixture.registered_reader()?;
    let mut worker = fixture.worker_reader()?;
    assert_eq!(query(&mut ordinary, "nir1-alice")?.status, "available");
    assert_eq!(worker_query(&mut worker, "nir1-alice")?.status, "available");

    let path = fixture.authority.path().join("grimodex.db");
    let writer = Connection::open(&path)?;
    writer.busy_timeout(Duration::ZERO)?;
    writer.execute_batch("BEGIN EXCLUSIVE")?;
    let probe = Connection::open(&path)?;
    probe.busy_timeout(Duration::ZERO)?;
    let busy = probe
        .query_row("SELECT COUNT(*) FROM codex_entries", [], |row| {
            row.get::<_, i64>(0)
        })
        .expect_err("another connection's write lock must make readers busy");
    assert!(
        matches!(
            busy.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
        ),
        "{busy}"
    );
    drop(probe);

    let started = Instant::now();
    let response = query(&mut ordinary, "nir1-alice")?;
    let elapsed = started.elapsed();
    assert_refused_without_graph(&response);
    assert!(
        elapsed < BUSY_WAIT_BOUND,
        "the ordinary reader waited {elapsed:?} on a busy database"
    );

    let started = Instant::now();
    let response = worker_query(&mut worker, "nir1-alice")?;
    let elapsed = started.elapsed();
    assert_refused_without_graph(&response);
    assert!(
        elapsed < BUSY_WAIT_BOUND,
        "the worker reader waited {elapsed:?} on a busy database"
    );

    writer.execute_batch("ROLLBACK")?;
    drop(writer);
    assert_eq!(query(&mut ordinary, "nir1-alice")?.status, "available");
    assert_eq!(worker_query(&mut worker, "nir1-alice")?.status, "available");
    Ok(())
}

// G-4 (RB-8): an unknown seed, and a seed that exists only in another project,
// are refused as `seed-not-found` on both reader paths. A registered seed still
// answers afterwards.
#[test]
fn unknown_and_foreign_seeds_are_refused_as_seed_not_found_on_both_reader_paths() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.authority.db().with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id) VALUES ('nir1-foreign-project')",
            [],
        )?;
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
             VALUES ('nir1-foreign', 'nir1-foreign-project', 'character',
                     'nir1-foreign', 'nir1-foreign', '2026-09-12T00:00:00Z')",
            [],
        )?;
        Ok(())
    })?;
    let mut ordinary = fixture.registered_reader()?;
    assert_unavailable(&query(&mut ordinary, "nir1-missing")?, "seed-not-found");
    assert_unavailable(&query(&mut ordinary, "nir1-foreign")?, "seed-not-found");
    let mut worker = fixture.worker_reader()?;
    assert_unavailable(
        &worker_query(&mut worker, "nir1-missing")?,
        "seed-not-found",
    );
    assert_unavailable(
        &worker_query(&mut worker, "nir1-foreign")?,
        "seed-not-found",
    );
    assert_eq!(worker_query(&mut worker, "nir1-alice")?.status, "available");
    Ok(())
}

// G-4 (RB-8): proposal/5's two-hop limit. From alice, the third hop (dave) is
// never reached; from bob, dave is exactly two hops away and is admitted. The
// ordinary reader checks the traversal logic; the worker-shaped reader repeats it
// on the production worker configuration (`worker_query`: the maintenance owner
// and the production SQL step budget), so the multi-hop walk also runs under the
// worker's stop and progress control. The fixture is one approved Revision and
// fits the production step budget.
#[test]
fn two_hop_limit_stops_before_a_third_hop() -> Result<()> {
    let fixture = Fixture::with_graph(&GraphPlan {
        entities: vec!["nir1-carol".into(), "nir1-dave".into()],
        relations: vec![
            (
                "nir1-edge-bc".into(),
                "nir1-bob".into(),
                "nir1-carol".into(),
            ),
            (
                "nir1-edge-cd".into(),
                "nir1-carol".into(),
                "nir1-dave".into(),
            ),
        ],
    })?;
    let from_alice_hops = BTreeMap::from([
        ("nir1-alice".to_owned(), 0),
        ("nir1-bob".to_owned(), 1),
        ("nir1-carol".to_owned(), 2),
    ]);
    let mut reader = fixture.registered_reader()?;

    let from_alice = query(&mut reader, "nir1-alice")?;
    assert_eq!(from_alice.status, "available", "{:?}", from_alice.reason);
    let graph = from_alice.graph.unwrap();
    assert_eq!(hop_map(&graph), from_alice_hops);
    assert_eq!(edge_ids(&graph), vec!["nir1-edge", "nir1-edge-bc"]);

    let from_bob = query(&mut reader, "nir1-bob")?;
    assert_eq!(from_bob.status, "available", "{:?}", from_bob.reason);
    assert_eq!(hop_map(&from_bob.graph.unwrap()).get("nir1-dave"), Some(&2));

    let mut worker = fixture.worker_reader()?;
    let worker_from_alice = worker_query(&mut worker, "nir1-alice")?;
    assert_eq!(
        worker_from_alice.status, "available",
        "{:?}",
        worker_from_alice.reason
    );
    let worker_graph = worker_from_alice.graph.unwrap();
    assert_eq!(hop_map(&worker_graph), from_alice_hops);
    assert_eq!(edge_ids(&worker_graph), vec!["nir1-edge", "nir1-edge-bc"]);

    let worker_from_bob = worker_query(&mut worker, "nir1-bob")?;
    assert_eq!(
        worker_from_bob.status, "available",
        "{:?}",
        worker_from_bob.reason
    );
    assert_eq!(
        hop_map(&worker_from_bob.graph.unwrap()).get("nir1-dave"),
        Some(&2)
    );
    Ok(())
}

// G-4 (RB-8): the discovered-Entity limit is 12 including the seed. Twelve are
// admitted at the production budget. The thirteenth is refused with no partial
// Graph at the production budget, and the same refusal repeats with the step
// cap uncapped, so it does not depend on the step cap. The ordinary reader
// checks the limit's logic; the worker-shaped reader repeats both cases on the
// production worker configuration (`worker_query`), where the thirteenth is
// refused for a reason other than steps or the deadline. Both fixtures are one
// approved Revision and fit the production step budget.
#[test]
fn twelve_discovered_entities_are_admitted_and_the_thirteenth_is_refused() -> Result<()> {
    let twelve = Fixture::with_graph(&star_plan(10))?;
    let mut reader = twelve.registered_reader()?;
    let response = query(&mut reader, "nir1-alice")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    assert_eq!(response.graph.unwrap().nodes.len(), 12);
    let mut worker = twelve.worker_reader()?;
    let response = worker_query(&mut worker, "nir1-alice")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    assert_eq!(response.graph.unwrap().nodes.len(), 12);

    let thirteen = Fixture::with_graph(&star_plan(11))?;
    let mut reader = thirteen.registered_reader()?;
    assert_unavailable(
        &query_with_steps(&mut reader, "nir1-alice", UNCAPPED_SQL_STEPS)?,
        "query-budget-or-validation-failed",
    );
    assert_unavailable(
        &query(&mut reader, "nir1-alice")?,
        "query-budget-or-validation-failed",
    );
    let mut worker = thirteen.worker_reader()?;
    assert_refused_within_budget(&worker_query(&mut worker, "nir1-alice")?);
    Ok(())
}

// G-4 (RB-8): the distinct-edge limit is 144. With the step cap uncapped, the
// 144th distinct edge is admitted and the 145th is refused with no partial
// Graph. At the production 100,000-step budget this 144-edge fan exceeds the
// step cap before the edge limit is reached, so the edge limit itself is tested
// with the cap lifted. The 145-edge fan is refused at the production budget too.
#[test]
fn one_hundred_forty_four_distinct_edges_are_admitted_and_the_145th_is_refused() -> Result<()> {
    let at_limit = Fixture::with_graph(&parallel_plan(143))?;
    let mut reader = at_limit.registered_reader()?;
    let response = query_with_steps(&mut reader, "nir1-alice", UNCAPPED_SQL_STEPS)?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let graph = response.graph.unwrap();
    assert_eq!(graph.edges.len(), 144);
    assert_eq!(graph.nodes.len(), 2);

    let over_limit = Fixture::with_graph(&parallel_plan(144))?;
    let mut reader = over_limit.registered_reader()?;
    assert_unavailable(
        &query_with_steps(&mut reader, "nir1-alice", UNCAPPED_SQL_STEPS)?,
        "query-budget-or-validation-failed",
    );
    assert_unavailable(
        &query(&mut reader, "nir1-alice")?,
        "query-budget-or-validation-failed",
    );
    Ok(())
}
