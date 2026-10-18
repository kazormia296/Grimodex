//! Tests for the gated NIR-1 Graph Index build route (B-ROUTE).
//!
//! Every test that opens the gate takes `serial()`: the judgement records are
//! process-local and a newer authority retires older authorities' records.

use super::*;
use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
use crate::narrative_extraction::maintenance_lifecycle::create_maintenance_run_in_tx;
use crate::narrative_extraction::maintenance_route_registry::{
    dispatch_enabled_work, route_descriptor_by_id, route_descriptor_for_run_kind,
    route_descriptors, route_id_for_run_kind,
};
use crate::narrative_extraction::maintenance_runtime::{
    decide_execution, preflight_maintenance_cycle_request,
    run_system_work_cycle_with_nir1_graph_runtime, MaintenanceCycleRequest, MaintenanceCycleResult,
    MaintenanceCycleStatus, MaintenanceExecutionDecision, MaintenanceExecutionMode,
    MaintenanceWorkRequest, RecoveryMode, NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN,
};
use crate::narrative_extraction::nir1_capacity::{
    set_used_steps_for_test, with_attempt_budget_for_test, CapacityBudget, SQL_PROGRESS_LIMIT,
};
use crate::narrative_extraction::nir1_chronicle_index::invalidate::suspend_project_in_tx;
use crate::narrative_extraction::nir1_entity_relation::{
    create_nir1_entity_relation_revision,
    tests::{
        append_typed_decision, approve_typed_revision, bounded_writer_bundle,
        prepare_a3_scope_fixture, rebind_scope_tokens, request, request_for_run,
        seed_run_and_catalog,
        writer_input_bytes,
    },
};
use crate::narrative_extraction::nir1_entity_relation_index::{
    cancel_next_native_prepare_after_first_roster_row_for_test, is_complete_registered,
    GraphProgressCallback,
};
use crate::narrative_extraction::nir1_graph::{
    Nir1GraphReader, Nir1GraphRequest, Nir1GraphResponse,
};
use crate::narrative_extraction::repository::SystemRunWorkKeyReuse;
use crate::narrative_extraction::restore_rebuild::ensure_restore_epochs_for_workspace;
use crate::state::WorkspaceAuthority;
use crate::workspace_lifecycle::WorkspaceLifecycleCore;
use grimodex_core::narrative_nir1::{ScopeValue, MAX_GRAPH_INPUT_BYTES};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::MutexGuard;
use std::time::Instant;

use super::test_hooks::{install as install_hook, TestStage};

const PROJECT: &str = "default-project";
const CAPACITY_CODE: &str = "NIR1_GRAPH_CAPACITY_EXCEEDED";

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|error| error.into_inner())
}

struct TestDirectory(PathBuf);

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// Field order matters: the authority (and its connection) drops before the
// directory that holds the database file.
struct Fixture {
    authority: Arc<WorkspaceAuthority>,
    lifecycle: WorkspaceLifecycleCore,
    directory: TestDirectory,
}

fn qualified_scope(
    db: &Database,
    typed: &mut super::super::nir1_entity_relation::Nir1EntityRelationRevisionRequest,
) {
    for entity in &mut typed.bundle.entities {
        entity.scope.reading = ScopeValue::Exact {
            value: "scene:a3-source".into(),
        };
        entity.scope.phase = "draft".into();
    }
    // The Scope token is the anchor Scene's projection, not the project's.
    rebind_scope_tokens(db, typed).expect("bind the anchor Scene Scope projection");
}

impl Fixture {
    /// One approved, qualified Entity/Relation Revision and no Graph binding.
    fn new() -> Result<Self> {
        let directory = TestDirectory(
            std::env::temp_dir().join(format!("nir1-b-route-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&directory.0)?;
        let db = Database::new(&directory.0.join("grimodex.db"))?;
        db.migrate()?;
        seed_run_and_catalog(&db)?;
        prepare_a3_scope_fixture(&db)?;
        run_incremental_freshness_cycle(&db)?;
        let mut typed = request(&db);
        qualified_scope(&db, &mut typed);
        let created = create_nir1_entity_relation_revision(&db, typed)?;
        approve_typed_revision(&db, "nir1-run", &created)?;
        let authority = WorkspaceAuthority::from_database_for_test(db, directory.0.clone())?;
        Ok(Self {
            authority,
            lifecycle: WorkspaceLifecycleCore::new(),
            directory,
        })
    }

    /// A fixture whose first gate-open cycle has published generation 1.
    fn published() -> Result<Self> {
        let fixture = Self::new()?;
        let recorder = Recorder::default();
        let result = run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
        assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
        assert_eq!(generation(fixture.db())?, Some(1));
        Ok(fixture)
    }

    fn db(&self) -> &Database {
        self.authority.db()
    }

    fn runtime(&self) -> &NirChronicleIndexRuntime {
        self.authority.nir_chronicle_index_runtime()
    }

    /// Replace the authority with a fresh one on the same file (cold reopen):
    /// a new runtime owner, a new connection, no process-local record.
    fn reopen(&mut self) -> Result<()> {
        let db = Database::new(&self.directory.0.join("grimodex.db"))?;
        db.migrate()?;
        self.authority = WorkspaceAuthority::from_database_for_test(db, self.directory.0.clone())?;
        Ok(())
    }

    fn current_epoch(&self) -> Result<String> {
        self.db().with_conn(|conn| {
            get_current_epoch(conn, PROJECT)?
                .map(|epoch| epoch.id)
                .ok_or_else(|| anyhow!("fixture has no Semantic Epoch"))
        })
    }

    fn graph_item(&self) -> Result<DesiredWork> {
        DesiredWork::new_with_epoch(
            PROJECT,
            AutomaticRunKind::Nir1GraphIndexBuild,
            NIR1_GRAPH_INDEX_BUILD_WORK_KEY,
            Some(self.current_epoch()?),
            "durable-wake",
        )
    }

    fn record(&self) -> Option<RecordedOutcome> {
        recorded_outcome_for_test(self.db(), self.runtime(), PROJECT)
    }

    fn mark_dirty(&self) -> Result<()> {
        self.db().with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            suspend_project_in_tx(&tx, PROJECT)?;
            tx.commit()?;
            Ok(())
        })
    }

    /// Judge the project exactly as the gate-open cycle would.
    fn judge(&self) -> Result<Nir1GraphIndexBuildDecision> {
        let recorder = Recorder::default();
        let context = Nir1GraphCycleContext::new(
            Nir1GraphIndexBuildGate::open_for_test(),
            Some(self.runtime()),
        );
        with_control(&recorder, |control| {
            judge_graph_index_build(self.db(), PROJECT, "durable-wake", Some(control), &context)
                .map(|(decision, _)| decision)
        })
    }

    /// The cycle planner's view of the project.
    fn plan(&self) -> Result<GraphBuildPlan> {
        let recorder = Recorder::default();
        let context = Nir1GraphCycleContext::new(
            Nir1GraphIndexBuildGate::open_for_test(),
            Some(self.runtime()),
        );
        with_control(&recorder, |control| {
            plan_graph_index_build(self.db(), PROJECT, "durable-wake", Some(control), &context)
        })
    }

    /// Dispatch one Graph build work item directly (no surrounding cycle).
    fn dispatch(&self, recorder: &Recorder) -> Result<MaintenanceDispatchOutcome> {
        let item = self.graph_item()?;
        let context = Nir1GraphCycleContext::new(
            Nir1GraphIndexBuildGate::open_for_test(),
            Some(self.runtime()),
        );
        with_control(recorder, |control| {
            dispatch_graph_index_build(self.db(), &item, Some(control), &context)
        })
    }
}

/// Test maintenance owner for the reader's own full registration.
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

/// Process-local cycle owner that records every queue transition. Grant
/// faults apply only to the Graph build key, so the durable chain that runs
/// before it in the same cycle is unaffected.
#[derive(Default)]
struct Recorder {
    stop: Arc<AtomicBool>,
    granted: Arc<AtomicBool>,
    lifecycle_stop: Arc<AtomicBool>,
    cancel_graph_before_grant: AtomicBool,
    cancel_after_graph_grant: AtomicBool,
    registered: Mutex<Vec<String>>,
    started: Mutex<Vec<String>>,
    completed: Mutex<Vec<String>>,
    noop: Mutex<Vec<String>>,
    deferred: Mutex<Vec<String>>,
    grants: Mutex<Vec<String>>,
}

fn is_graph_key(key: &str) -> bool {
    key.contains("/nir1-graph-index-build/")
}

impl Recorder {
    fn graph(list: &Mutex<Vec<String>>) -> Vec<String> {
        list.lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|key| is_graph_key(key))
            .cloned()
            .collect()
    }
}

fn push(list: &Mutex<Vec<String>>, key: String) {
    list.lock()
        .unwrap_or_else(|error| error.into_inner())
        .push(key);
}

fn with_control<T>(
    recorder: &Recorder,
    operation: impl FnOnce(&MaintenanceCycleControl<'_>) -> T,
) -> T {
    let should_stop = || -> Result<()> {
        if recorder.lifecycle_stop.load(Ordering::SeqCst) {
            bail!(
                "NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED: transition is draining this execution"
            );
        }
        if recorder.stop.load(Ordering::SeqCst) {
            bail!(
                "NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation requested at a Rust work boundary"
            );
        }
        Ok(())
    };
    let grant_finalize = |work_key: &str| -> Result<()> {
        let graph = is_graph_key(work_key);
        if graph && recorder.cancel_graph_before_grant.load(Ordering::SeqCst) {
            bail!("NEX_MAINTENANCE_ATTEMPT_CANCELLED: cancellation won before work finalization");
        }
        recorder.granted.store(true, Ordering::SeqCst);
        push(&recorder.grants, work_key.to_string());
        if graph && recorder.cancel_after_graph_grant.load(Ordering::SeqCst) {
            recorder.stop.store(true, Ordering::SeqCst);
        }
        Ok(())
    };
    let register_work = |item: &DesiredWork| -> Result<()> {
        push(&recorder.registered, item.canonical_key());
        Ok(())
    };
    let work_started = |item: &DesiredWork| -> Result<()> {
        push(&recorder.started, item.canonical_key());
        Ok(())
    };
    let work_completed = |item: &DesiredWork| -> Result<()> {
        push(&recorder.completed, item.canonical_key());
        Ok(())
    };
    let work_noop_completed = |item: &DesiredWork| -> Result<()> {
        push(&recorder.noop, item.canonical_key());
        Ok(())
    };
    let work_deferred = |item: &DesiredWork| -> Result<()> {
        push(&recorder.deferred, item.canonical_key());
        Ok(())
    };
    let defer_preempted_run = |_run_id: &str| -> Result<()> { Ok(()) };
    let control = MaintenanceCycleControl {
        should_stop: &should_stop,
        stop_signal: Some(Arc::clone(&recorder.stop)),
        finalization_granted_signal: Some(Arc::clone(&recorder.granted)),
        defer_preempted_run: &defer_preempted_run,
        grant_finalize: &grant_finalize,
        register_work: &register_work,
        work_started: &work_started,
        work_completed: &work_completed,
        work_noop_completed: &work_noop_completed,
        work_deferred: &work_deferred,
        attach_run: None,
        reserve_run: None,
        mark_run_creation_started: None,
        mark_run_reuse_selection_unknown: None,
        mark_run_creation_outcome: None,
        reset_run_creation_tracking: None,
        mark_run_terminalized: None,
    };
    operation(&control)
}

fn graph_seam() -> NarrativeMaintenanceCiConfig {
    NarrativeMaintenanceCiConfig {
        is_packaged: false,
        ci: "true".to_string(),
        owner_token: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_OWNER_TOKEN.to_string(),
        fault: None,
        trigger: Some(NarrativeMaintenanceCiTrigger::Nir1GraphIndexBuild),
        setup: None,
        freshness_hold_project_id: None,
        product_journey_barrier_id: None,
        correlation: None,
    }
}

fn wake_request() -> MaintenanceCycleRequest {
    MaintenanceCycleRequest {
        work: Vec::new(),
        wake_project_ids: vec![PROJECT.to_string()],
        delivery_sequence: None,
        delivery_fingerprint: None,
        workspace_binding: None,
    }
}

fn run_cycle_on(
    db: &Database,
    runtime: Option<&NirChronicleIndexRuntime>,
    request: &MaintenanceCycleRequest,
    seam: Option<&NarrativeMaintenanceCiConfig>,
    recorder: &Recorder,
) -> Result<MaintenanceCycleResult> {
    with_control(recorder, |control| {
        run_system_work_cycle_with_nir1_graph_runtime(
            db,
            request,
            |_| RecoveryMode::SameProcessLive,
            seam,
            None,
            Some(control),
            runtime,
        )
    })
}

fn run_cycle(
    fixture: &Fixture,
    seam: Option<&NarrativeMaintenanceCiConfig>,
    recorder: &Recorder,
) -> Result<MaintenanceCycleResult> {
    run_cycle_on(
        fixture.db(),
        Some(fixture.runtime()),
        &wake_request(),
        seam,
        recorder,
    )
}

/// Graph surface counts: metadata, D1 heads, V1 edges, consumer Freshness.
fn graph_surface(db: &Database) -> Result<(i64, i64, i64, i64)> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM narrative_semantic_index_metadata
                  WHERE project_id = ?1 AND index_key = ?2),
                (SELECT COUNT(*) FROM narrative_dependency_declaration_heads
                  WHERE project_id = ?1 AND consumer_kind = 'semantic-index' AND consumer_key = ?2),
                (SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE project_id = ?1 AND consumer_kind = 'semantic-index' AND consumer_key = ?2),
                (SELECT COUNT(*) FROM narrative_consumer_freshness
                  WHERE project_id = ?1 AND consumer_kind = 'semantic-index' AND consumer_key = ?2)",
            params![PROJECT, INDEX_KEY],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?)
    })
}

/// The sealed binding's identity: (generation, dirty, source digest, D1 head
/// version, built_at, Freshness updated_at).
type SealedIdentity = (i64, i64, String, i64, String, String);

fn sealed(db: &Database) -> Result<Option<SealedIdentity>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT m.generation, m.dirty_cache_flag, m.source_digest, h.version,
                        m.built_at, f.updated_at
                   FROM narrative_semantic_index_metadata m
                   JOIN narrative_dependency_declaration_heads h
                     ON h.project_id = m.project_id AND h.consumer_kind = 'semantic-index'
                    AND h.consumer_key = m.index_key
                   JOIN narrative_consumer_freshness f
                     ON f.project_id = m.project_id AND f.consumer_kind = 'semantic-index'
                    AND f.consumer_key = m.index_key
                  WHERE m.project_id = ?1 AND m.index_key = ?2",
                params![PROJECT, INDEX_KEY],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?)
    })
}

fn generation(db: &Database) -> Result<Option<i64>> {
    Ok(sealed(db)?.map(|identity| identity.0))
}

fn complete_registered(db: &Database) -> Result<bool> {
    db.with_conn(|conn| is_complete_registered(conn, PROJECT, INDEX_KEY))
}

fn graph_edge_states(db: &Database) -> Result<Vec<(String, String, String)>> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT e.id, s.evidence_freshness, s.evaluated_at
               FROM narrative_dependency_edges e
               LEFT JOIN narrative_dependency_edge_states s ON s.edge_id = e.id
              WHERE e.project_id = ?1 AND e.consumer_kind = 'semantic-index'
                AND e.consumer_key = ?2
              ORDER BY e.id",
        )?;
        let rows = statement
            .query_map(params![PROJECT, INDEX_KEY], |row| {
                Ok((
                    row.get(0)?,
                    row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// Register a fresh C-query reader and run the seed query. The query keeps
/// the production reader deadline; a deadline collapse under machine load
/// re-registers and retries a bounded number of times.
fn reader_query(fixture: &Fixture) -> Result<Option<Nir1GraphResponse>> {
    let mut reader = Nir1GraphReader::open(
        Arc::clone(&fixture.authority),
        fixture.lifecycle.begin_workspace_participant()?,
    )?;
    let mut last = None;
    for _ in 0..5 {
        if !reader.register_with_control(PROJECT, &mut RegistrationOwner)? {
            return Ok(None);
        }
        let response = reader.query(&Nir1GraphRequest {
            project_id: PROJECT.into(),
            query_scene_id: "nir1".into(),
            seed_entity_id: "nir1-alice".into(),
        })?;
        let retry = response.status != "available"
            && matches!(
                response.reason.as_deref(),
                Some("query-invalidated" | "query-budget-or-validation-failed")
            );
        last = Some(response);
        if !retry {
            break;
        }
    }
    Ok(last)
}

fn assert_available(fixture: &Fixture, generation: i64) -> Result<Nir1GraphResponse> {
    let response = reader_query(fixture)?.expect("the reader must register the sealed binding");
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let graph = response.graph.as_ref().expect("available Graph");
    assert_eq!(graph.generation, generation);
    assert!(graph
        .edges
        .iter()
        .any(|edge| edge.relation.edge_id == "nir1-edge"));
    Ok(response)
}

/// Add and approve a second Entity/Relation proposal carrying one more live
/// relation (`nir1-edge-b`), through the ordinary A2 writers.
fn add_second_reviewed_revision(db: &Database, proposal_key: &str) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO codex_relations
                (id, project_id, from_codex_id, to_codex_id, relation_type, directionality,
                 version, updated_at)
             VALUES ('nir1-edge-b', 'default-project', 'nir1-alice', 'nir1-bob', 'related',
                     'directed', 1, '2026-09-12T00:00:00Z')",
            [],
        )?;
        Ok(())
    })?;
    let mut typed = request_for_run(db, "nir1-run", proposal_key);
    qualified_scope(db, &mut typed);
    let mut relation = typed.bundle.relations[0].clone();
    relation.edge_id = "nir1-edge-b".into();
    relation.relation_type = "related".into();
    relation.source_token = "v1@2026-09-12T00:00:00Z:relation:nir1-edge-b".into();
    typed.bundle.relations.push(relation);
    let created = create_nir1_entity_relation_revision(db, typed)?;
    approve_typed_revision(db, "nir1-run", &created)?;
    Ok(())
}

fn revision_id_of(created: &serde_json::Value) -> Result<String> {
    Ok(created["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow!("typed revision id missing"))?
        .to_owned())
}

/// Extend a stored payload with JSON whitespace until it is over B's 6 MiB
/// per-component limit. The padding changes nothing the payload says. (The
/// stored envelope is immutable, so only the payload can be padded.)
fn pad_payload(db: &Database, revision_id: &str) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_proposal_revisions
                SET payload_json = payload_json || printf('%.*c', ?1, ' ')
              WHERE id = ?2",
            params![i64::try_from(MAX_GRAPH_INPUT_BYTES)? + 1, revision_id],
        )?;
        Ok(())
    })
}

/// A new typed Revision through the ordinary A2 writer, left a draft, whose
/// stored payload is then padded over B's 6 MiB per-component limit.
fn add_revision_with_oversized_payload(
    db: &Database,
    proposal_key: &str,
) -> Result<serde_json::Value> {
    let mut typed = request_for_run(db, "nir1-run", proposal_key);
    qualified_scope(db, &mut typed);
    let created = create_nir1_entity_relation_revision(db, typed)?;
    pad_payload(db, &revision_id_of(&created)?)?;
    Ok(created)
}

/// A new typed Revision, left a draft, that the A2 writer accepts as it is (3 MiB
/// of counted bytes, half the 6 MiB writer limit) but whose stored
/// reconciliation envelope is over B's 6 MiB per-component limit: the
/// envelope carries about twice the counted bytes for this shape.
fn add_revision_with_oversized_envelope(
    db: &Database,
    proposal_key: &str,
) -> Result<serde_json::Value> {
    let mut typed = request_for_run(db, "nir1-run", proposal_key);
    qualified_scope(db, &mut typed);
    let template = typed.bundle.clone();
    let base = writer_input_bytes(&bounded_writer_bundle(&template, 507, 0));
    typed.bundle = bounded_writer_bundle(&template, 507, 3 * 1024 * 1024 - base);
    let created = create_nir1_entity_relation_revision(db, typed)?;
    let revision_id = revision_id_of(&created)?;
    let (payload_bytes, envelope_bytes): (i64, i64) = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT octet_length(payload_json), octet_length(reconciliation_envelope_json)
               FROM narrative_proposal_revisions WHERE id = ?1",
            [revision_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    })?;
    let limit = i64::try_from(MAX_GRAPH_INPUT_BYTES)?;
    ensure!(
        payload_bytes <= limit && envelope_bytes > limit,
        "fixture premise: payload {payload_bytes} B within, envelope {envelope_bytes} B over {limit} B"
    );
    Ok(created)
}

/// The reader's own complete registration of the sealed binding, without a
/// query. `Err` is a registration that could not resolve the full roster.
fn reader_registers(fixture: &Fixture) -> Result<bool> {
    let mut reader = Nir1GraphReader::open(
        Arc::clone(&fixture.authority),
        fixture.lifecycle.begin_workspace_participant()?,
    )?;
    reader.register_with_control(PROJECT, &mut RegistrationOwner)
}

fn er_proposal_set_id(db: &Database) -> Result<String> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT proposal_set.id
               FROM narrative_proposal_sets proposal_set
              WHERE proposal_set.project_id = ?1 AND proposal_set.set_kind = ?2
              LIMIT 1",
            params![PROJECT, NIR1_ENTITY_RELATION_SET_KIND],
            |row| row.get(0),
        )?)
    })
}

fn error_text(error: &anyhow::Error) -> String {
    format!("{error:#}")
}

fn no_finalization(rediscover: bool) -> MaintenanceDispatchOutcome {
    MaintenanceDispatchOutcome::CompletedWithoutFinalization { rediscover }
}

fn refused(code: &str) -> Option<RecordedOutcome> {
    Some(RecordedOutcome::Refused {
        code: code.to_string(),
        limit: None,
    })
}

fn refused_capacity(limit: &str) -> Option<RecordedOutcome> {
    Some(RecordedOutcome::Refused {
        code: CAPACITY_CODE.to_string(),
        limit: Some(limit.to_string()),
    })
}

fn skip(reason: Nir1GraphIndexSkipReason) -> Nir1GraphIndexBuildDecision {
    Nir1GraphIndexBuildDecision::Skip { reason }
}

fn build(
    mode: Nir1GraphIndexBuildMode,
    reason: Nir1GraphIndexBuildReason,
) -> Nir1GraphIndexBuildDecision {
    Nir1GraphIndexBuildDecision::Build { mode, reason }
}

// ---------------------------------------------------------------------------
// A. Gate, ledgerless kind and the product default (A-1)
// ---------------------------------------------------------------------------

#[test]
fn gate_opens_only_for_the_validated_graph_seam() {
    assert!(!Nir1GraphIndexBuildGate::closed().is_open());
    assert!(!Nir1GraphIndexBuildGate::from_journey_seam(None).is_open());
    assert!(Nir1GraphIndexBuildGate::from_journey_seam(Some(&graph_seam())).is_open());

    let packaged = NarrativeMaintenanceCiConfig {
        is_packaged: true,
        ..graph_seam()
    };
    let not_ci = NarrativeMaintenanceCiConfig {
        ci: "false".to_string(),
        ..graph_seam()
    };
    let forged_owner = NarrativeMaintenanceCiConfig {
        owner_token: "renderer-supplied-owner".to_string(),
        ..graph_seam()
    };
    let no_trigger = NarrativeMaintenanceCiConfig {
        trigger: None,
        ..graph_seam()
    };
    let other_trigger = NarrativeMaintenanceCiConfig {
        trigger: Some(NarrativeMaintenanceCiTrigger::DependencyGap),
        ..graph_seam()
    };
    let incomplete_marker = NarrativeMaintenanceCiConfig {
        product_journey_barrier_id: Some("barrier".to_string()),
        ..graph_seam()
    };
    for config in [
        packaged,
        not_ci,
        forged_owner,
        no_trigger,
        other_trigger,
        incomplete_marker,
    ] {
        assert!(
            !Nir1GraphIndexBuildGate::from_journey_seam(Some(&config)).is_open(),
            "{config:?}"
        );
    }
    // The trigger perturbs no coordinate: it only selects the gated route.
    assert_eq!(
        crate::narrative_extraction::maintenance_runtime::effective_maintenance_coordinates(Some(
            &graph_seam()
        ))
        .expect("validated seam"),
        crate::narrative_extraction::maintenance_contracts::current_maintenance_coordinates()
            .expect("baseline coordinates"),
    );
}

#[test]
fn product_default_cycle_never_registers_or_dispatches_graph_build() -> Result<()> {
    let _serial = serial();
    // Same seeded project twice: once through the runtime-less entry (the
    // pre-B-ROUTE behavior), once through the Native form with the runtime
    // but without a seam, as every product launch runs.
    let baseline = Fixture::new()?;
    let baseline_recorder = Recorder::default();
    let baseline_result = run_cycle_on(
        baseline.db(),
        None,
        &wake_request(),
        None,
        &baseline_recorder,
    )?;
    let product = Fixture::new()?;
    let product_recorder = Recorder::default();
    let product_result = run_cycle(&product, None, &product_recorder)?;

    assert_eq!(product_result, baseline_result);
    for list in [
        &product_recorder.registered,
        &product_recorder.started,
        &product_recorder.completed,
        &product_recorder.noop,
        &product_recorder.deferred,
        &product_recorder.grants,
    ] {
        assert!(Recorder::graph(list).is_empty());
    }
    assert_eq!(graph_surface(product.db())?, (0, 0, 0, 0));
    assert!(product.record().is_none());
    assert!(!complete_registered(product.db())?);
    let ledger = |db: &Database| -> Result<Vec<(String, String)>> {
        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT run_kind, status FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind IN
                        ('backfill', 'dependency-verify', 'semantic-index-rebuild')
                  ORDER BY created_at, run_kind",
            )?;
            let rows = statement
                .query_map([PROJECT], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    };
    assert_eq!(ledger(product.db())?, ledger(baseline.db())?);
    let normalized = |recorder: &Recorder, epoch: &str| -> Vec<String> {
        recorder
            .registered
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|key| key.replace(epoch, "EPOCH"))
            .collect()
    };
    assert_eq!(
        normalized(&product_recorder, &product.current_epoch()?),
        normalized(&baseline_recorder, &baseline.current_epoch()?),
    );
    Ok(())
}

#[test]
fn closed_gate_reads_no_sql_and_refuses_forged_work_before_a_connection() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::new()?;
    let item = fixture.graph_item()?;
    let statements = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&statements);
    fixture.db().with_conn(|conn| {
        conn.authorizer(Some(move |_: rusqlite::hooks::AuthContext<'_>| {
            counted.fetch_add(1, Ordering::SeqCst);
            rusqlite::hooks::Authorization::Allow
        }))?;
        Ok(())
    })?;
    let recorder = Recorder::default();
    let closed =
        Nir1GraphCycleContext::new(Nir1GraphIndexBuildGate::closed(), Some(fixture.runtime()));
    let before = statements.load(Ordering::SeqCst);
    let (decision, epoch) = with_control(&recorder, |control| {
        judge_graph_index_build(
            fixture.db(),
            PROJECT,
            "durable-wake",
            Some(control),
            &closed,
        )
    })?;
    assert_eq!(decision, skip(Nir1GraphIndexSkipReason::GateClosed));
    assert!(epoch.is_none());
    let plan = plan_graph_index_build(fixture.db(), PROJECT, "durable-wake", None, &closed)?;
    assert!(!plan.preempts_durable_chain());
    assert!(plan.into_work().is_none());
    // A forged item through the gated route table, and the adapter itself.
    let outcome = with_control(&recorder, |control| {
        dispatch_enabled_work(fixture.db(), &item, None, Some(control), &closed)
    })?;
    assert_eq!(outcome, no_finalization(false));
    let outcome = with_control(&recorder, |control| {
        dispatch_graph_index_build(fixture.db(), &item, Some(control), &closed)
    })?;
    assert_eq!(outcome, no_finalization(false));
    assert_eq!(
        statements.load(Ordering::SeqCst),
        before,
        "closed gate executed SQL"
    );
    fixture.db().with_conn(|conn| {
        conn.authorizer(
            None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>,
        )?;
        Ok(())
    })?;

    // While another owner holds the shared connection, a closed gate still
    // answers without trying to acquire it (no preemption error).
    let held = fixture.db().lock()?;
    let (decision, _) = with_control(&recorder, |control| {
        judge_graph_index_build(
            fixture.db(),
            PROJECT,
            "durable-wake",
            Some(control),
            &closed,
        )
    })?;
    assert_eq!(decision, skip(Nir1GraphIndexSkipReason::GateClosed));
    // An open gate without a cycle owner or runtime also never connects.
    let open_without_runtime =
        Nir1GraphCycleContext::new(Nir1GraphIndexBuildGate::open_for_test(), None);
    let (decision, _) = with_control(&recorder, |control| {
        judge_graph_index_build(
            fixture.db(),
            PROJECT,
            "durable-wake",
            Some(control),
            &open_without_runtime,
        )
    })?;
    assert_eq!(decision, skip(Nir1GraphIndexSkipReason::RuntimeUnavailable));
    let open = Nir1GraphCycleContext::new(
        Nir1GraphIndexBuildGate::open_for_test(),
        Some(fixture.runtime()),
    );
    let (decision, _) =
        judge_graph_index_build(fixture.db(), PROJECT, "durable-wake", None, &open)?;
    assert_eq!(decision, skip(Nir1GraphIndexSkipReason::NoCycleOwner));
    for reason in ["before-cutover", "before-cutover-follow-up"] {
        let (decision, _) = with_control(&recorder, |control| {
            judge_graph_index_build(fixture.db(), PROJECT, reason, Some(control), &open)
        })?;
        assert_eq!(decision, skip(Nir1GraphIndexSkipReason::BeforeCutoverFlow));
    }
    assert_eq!(
        dispatch_graph_index_build(fixture.db(), &item, None, &open)?,
        no_finalization(false)
    );
    drop(held);
    Ok(())
}

#[test]
fn wire_request_cannot_carry_graph_build_work() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::new()?;
    let request = MaintenanceCycleRequest {
        work: vec![MaintenanceWorkRequest {
            project_id: PROJECT.to_string(),
            run_kind: AutomaticRunKind::Nir1GraphIndexBuild,
            work_key: NIR1_GRAPH_INDEX_BUILD_WORK_KEY.to_string(),
            semantic_epoch_id: Some(fixture.current_epoch()?),
            reasons: vec!["main-forged".to_string()],
        }],
        wake_project_ids: Vec::new(),
        delivery_sequence: None,
        delivery_fingerprint: None,
        workspace_binding: None,
    };
    let error = preflight_maintenance_cycle_request(&request).expect_err("wire Graph work");
    assert!(error_text(&error).contains("NEX_MAINTENANCE_INVALID_REQUEST"));
    // The serialized form is the same canonical kind; the wire still refuses it.
    let parsed: MaintenanceCycleRequest = serde_json::from_value(json!({
        "work": [{
            "projectId": PROJECT,
            "runKind": "nir1-graph-index-build",
            "workKey": NIR1_GRAPH_INDEX_BUILD_WORK_KEY,
            "semanticEpochId": fixture.current_epoch()?,
            "reasons": ["main-forged"]
        }],
        "wakeProjectIds": []
    }))?;
    assert!(parsed.normalized_work().is_err());
    for seam in [None, Some(graph_seam())] {
        let recorder = Recorder::default();
        let error = run_cycle_on(
            fixture.db(),
            Some(fixture.runtime()),
            &request,
            seam.as_ref(),
            &recorder,
        )
        .expect_err("a cycle must reject wire Graph work before any registration");
        assert!(error_text(&error).contains("NEX_MAINTENANCE_INVALID_REQUEST"));
        assert!(recorder
            .registered
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .is_empty());
    }
    assert_eq!(graph_surface(fixture.db())?, (0, 0, 0, 0));
    Ok(())
}

#[test]
fn graph_build_kind_is_ledgerless_and_outside_the_production_registry() -> Result<()> {
    let kind = AutomaticRunKind::Nir1GraphIndexBuild;
    assert_eq!(AutomaticRunKind::all().len(), 3);
    assert!(!AutomaticRunKind::all().contains(&kind));
    assert_eq!(route_descriptors().len(), 3);
    assert!(route_descriptors()
        .iter()
        .all(|descriptor| descriptor.run_kind != kind));
    assert!(route_descriptor_for_run_kind(kind).is_none());
    assert!(route_id_for_run_kind(kind).is_none());
    assert!(route_descriptor_by_id("nir1-graph-index-build").is_none());
    assert_eq!(kind.route_id(), "nir1-graph-index-build");
    assert_eq!(kind.as_str(), "nir1-graph-index-build");
    assert_eq!(serde_json::to_value(kind)?, json!("nir1-graph-index-build"));
    let item = DesiredWork::new_with_epoch(
        "project-1",
        kind,
        NIR1_GRAPH_INDEX_BUILD_WORK_KEY,
        Some("epoch-1".to_string()),
        "durable-wake",
    )?;
    assert_eq!(
        decide_execution(&item, MaintenanceExecutionMode::ExecuteSafe),
        MaintenanceExecutionDecision::Deferred {
            reason: "nir1-graph-index-build-cycle-internal".to_string()
        }
    );
    assert_eq!(
        item.canonical_key(),
        "narrative-maintenance:v1/nir1-graph-index-build/project-1/nir1-graph-index-build/epoch/epoch-1"
    );

    let db = Database::new(std::path::Path::new(":memory:"))?;
    db.migrate()?;
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('project-1', 'Project');
             INSERT INTO narrative_semantic_epochs (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-1', 'project-1', 0, 'initial', '2026-01-01T00:00:00.000Z');",
        )?;
        // The schema itself refuses a Run of this kind.
        let insert = conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest, status,
                 coverage_json, created_at, run_kind, semantic_epoch_id, work_key)
             VALUES ('graph-run', 'project-1', 'maintenance', '{}', '{}', 'sha256:graph',
                     'pending', '{}', '2026-01-01T00:00:00.000Z', 'nir1-graph-index-build',
                     'epoch-1', 'nir1-graph-index-build')",
            [],
        );
        assert!(insert.is_err(), "run_kind CHECK must reject the gated kind");
        // So does the maintenance lifecycle, before any Run DML.
        let tx = conn.unchecked_transaction()?;
        let error = create_maintenance_run_in_tx(
            &tx,
            "project-1",
            "nir1-graph-index-build",
            "epoch-1",
            NIR1_GRAPH_INDEX_BUILD_WORK_KEY,
            &json!({}),
            "sha256:graph",
            SystemRunWorkKeyReuse::RunningOnly,
        )
        .expect_err("ledgerless kind");
        assert!(error_text(&error).contains("NEX_MAINTENANCE_RUN_KIND_INVALID"));
        drop(tx);
        Ok(())
    })
}

#[test]
fn graph_build_decision_evidence_is_kebab_case_and_fail_closed() -> Result<()> {
    let decision = build(
        Nir1GraphIndexBuildMode::ValidateThenRebuild,
        Nir1GraphIndexBuildReason::ColdReopenValidation,
    );
    let value = serde_json::to_value(decision)?;
    assert_eq!(
        value,
        json!({
            "decision": "build",
            "mode": "validate-then-rebuild",
            "reason": "cold-reopen-validation"
        })
    );
    assert_eq!(
        serde_json::from_value::<Nir1GraphIndexBuildDecision>(value)?,
        decision
    );
    assert_eq!(
        serde_json::to_value(skip(Nir1GraphIndexSkipReason::RefusedUnchanged))?,
        json!({"decision": "skip", "reason": "refused-unchanged"})
    );
    assert!(serde_json::from_value::<Nir1GraphIndexBuildDecision>(
        json!({"decision": "skip", "reason": "activated"})
    )
    .is_err());
    assert_eq!(
        skip(Nir1GraphIndexSkipReason::GateClosed).code(),
        "skip:gate-closed"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// B. Positive path
// ---------------------------------------------------------------------------

#[test]
fn open_gate_cycle_builds_publishes_and_reader_is_available() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::new()?;
    assert!(reader_query(&fixture)?.is_none(), "no binding before B");
    assert_eq!(
        fixture.judge()?,
        build(
            Nir1GraphIndexBuildMode::Rebuild,
            Nir1GraphIndexBuildReason::BindingMissing
        )
    );
    let recorder = Recorder::default();
    let result = run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(result, MaintenanceCycleResult::accepted(false));

    // One B work: registered before it was queued, started, finalized once
    // through its grant, never settled as a no-op.
    let epoch = fixture.current_epoch()?;
    let key = format!(
        "narrative-maintenance:v1/nir1-graph-index-build/{PROJECT}/nir1-graph-index-build/epoch/{epoch}"
    );
    assert_eq!(Recorder::graph(&recorder.registered), vec![key.clone()]);
    assert_eq!(Recorder::graph(&recorder.started), vec![key.clone()]);
    assert_eq!(Recorder::graph(&recorder.grants), vec![key.clone()]);
    assert_eq!(Recorder::graph(&recorder.completed), vec![key.clone()]);
    assert!(Recorder::graph(&recorder.noop).is_empty());
    assert!(Recorder::graph(&recorder.deferred).is_empty());

    let (generation, dirty, _, head_version, _, _) =
        sealed(fixture.db())?.expect("published binding");
    assert_eq!((generation, dirty, head_version), (1, 0, 1));
    let (metadata, heads, edges, freshness) = graph_surface(fixture.db())?;
    assert_eq!((metadata, heads, freshness), (1, 1, 1));
    assert!(edges >= 2, "project source plus qualified material edges");
    assert!(complete_registered(fixture.db())?);
    assert_eq!(fixture.record(), Some(RecordedOutcome::Published));
    let response = assert_available(&fixture, 1)?;
    assert!(response
        .graph
        .as_ref()
        .is_some_and(|graph| !graph.nodes.is_empty()));

    // The publish changed the durable graph state, so the confirmation Verify
    // re-ran after B and counts the declared Graph footprint as clean.
    let registered = recorder
        .registered
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let b_index = registered.iter().position(|key| is_graph_key(key)).unwrap();
    // A missing binding is built only after the durable chain had nothing to
    // do (Backfill and Verify ran first).
    assert!(registered[..b_index]
        .iter()
        .any(|key| key.contains("/dependency-verify/")));
    assert!(registered[b_index + 1..]
        .iter()
        .any(|key| key.contains("/dependency-verify/")));
    let outcome: String = fixture.db().with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT outcome_summary_json FROM narrative_extraction_runs
              WHERE project_id = ?1 AND run_kind = 'dependency-verify' AND status = 'completed'
              ORDER BY completed_at DESC, rowid DESC LIMIT 1",
            [PROJECT],
            |row| row.get(0),
        )?)
    })?;
    let report: super::super::restore_rebuild::DependencyGraphVerifyReport =
        serde_json::from_value(
            serde_json::from_str::<serde_json::Value>(&outcome)?["report"].clone(),
        )?;
    assert!(report.is_clean(), "{report:?}");
    Ok(())
}

#[test]
fn second_cycle_skips_current_binding() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    let before = sealed(fixture.db())?;
    assert_eq!(
        fixture.judge()?,
        skip(Nir1GraphIndexSkipReason::BindingCurrent)
    );
    let recorder = Recorder::default();
    let result = run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(result, MaintenanceCycleResult::accepted(false));
    assert!(Recorder::graph(&recorder.registered).is_empty());
    assert_eq!(sealed(fixture.db())?, before);
    Ok(())
}

#[test]
fn a2_change_rebuilds_the_next_generation_without_mixing() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    let first = sealed(fixture.db())?.expect("generation 1");
    add_second_reviewed_revision(fixture.db(), "nir1:review:2")?;
    assert_eq!(sealed(fixture.db())?.map(|identity| identity.1), Some(1));
    assert!(!complete_registered(fixture.db())?);
    assert_eq!(
        fixture.judge()?,
        build(
            Nir1GraphIndexBuildMode::Rebuild,
            Nir1GraphIndexBuildReason::BindingDirty
        )
    );
    let recorder = Recorder::default();
    let result = run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(result, MaintenanceCycleResult::accepted(false));
    // The stale binding is rebuilt by its producer before the durable chain
    // re-verifies the changed graph; the confirmation Verify then counts the
    // new generation as declared.
    let registered = recorder
        .registered
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    assert!(is_graph_key(&registered[0]), "{registered:?}");
    assert!(registered[1..]
        .iter()
        .any(|key| key.contains("/dependency-verify/")));
    let second = sealed(fixture.db())?.expect("generation 2");
    assert_eq!((second.0, second.1, second.3), (2, 0, 2));
    assert_ne!(second.2, first.2, "the new roster has a new source digest");
    assert!(complete_registered(fixture.db())?);
    let response = assert_available(&fixture, 2)?;
    let graph = response.graph.expect("available Graph");
    assert!(graph
        .edges
        .iter()
        .any(|edge| edge.relation.edge_id == "nir1-edge-b"));
    Ok(())
}

#[test]
fn cold_reopen_validates_once_without_rebuild() -> Result<()> {
    let _serial = serial();
    let mut fixture = Fixture::published()?;
    let before = sealed(fixture.db())?;
    fixture.reopen()?;
    assert!(fixture.record().is_none());
    assert_eq!(
        fixture.judge()?,
        build(
            Nir1GraphIndexBuildMode::ValidateThenRebuild,
            Nir1GraphIndexBuildReason::ColdReopenValidation
        )
    );
    let recorder = Recorder::default();
    let result = run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(result, MaintenanceCycleResult::accepted(false));
    // The owned validation ran once and published nothing.
    assert_eq!(Recorder::graph(&recorder.registered).len(), 1);
    assert_eq!(Recorder::graph(&recorder.noop).len(), 1);
    assert!(Recorder::graph(&recorder.grants).is_empty());
    assert!(Recorder::graph(&recorder.completed).is_empty());
    assert_eq!(sealed(fixture.db())?, before);
    assert_eq!(fixture.record(), Some(RecordedOutcome::Validated));
    assert_eq!(
        fixture.judge()?,
        skip(Nir1GraphIndexSkipReason::BindingCurrent)
    );
    let recorder = Recorder::default();
    run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert!(Recorder::graph(&recorder.registered).is_empty());
    assert_available(&fixture, 1)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// C. Failure paths
// ---------------------------------------------------------------------------

#[test]
fn prepare_cancellation_publishes_nothing_and_restarts_from_scratch() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::new()?;
    let recorder = Recorder::default();
    let stop = Arc::clone(&recorder.stop);
    let _hook = install_hook(move |stage, _| {
        if stage == TestStage::BeforePrepare {
            stop.store(true, Ordering::SeqCst);
        }
        Ok(())
    });
    let error = run_cycle(&fixture, Some(&graph_seam()), &recorder)
        .expect_err("cancellation during prepare is a typed stop");
    assert!(
        error_text(&error).contains("NEX_MAINTENANCE_ATTEMPT_CANCELLED")
            || error_text(&error).contains("NEX_VALIDATION_TERMINATED:cancelled"),
        "{error:#}"
    );
    assert_eq!(Recorder::graph(&recorder.started).len(), 1);
    assert!(Recorder::graph(&recorder.completed).is_empty());
    assert!(Recorder::graph(&recorder.noop).is_empty());
    assert_eq!(graph_surface(fixture.db())?, (0, 0, 0, 0));
    assert!(fixture.record().is_none());
    assert!(fixture.db().connection_reusable());
    drop(_hook);

    // The runtime epoch rotates after the first roster row: the snapshot is
    // cancelled and nothing is published.
    cancel_next_native_prepare_after_first_roster_row_for_test();
    let recorder = Recorder::default();
    run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(Recorder::graph(&recorder.started).len(), 1);
    assert_eq!(Recorder::graph(&recorder.noop).len(), 1);
    assert!(Recorder::graph(&recorder.grants).is_empty());
    assert_eq!(graph_surface(fixture.db())?, (0, 0, 0, 0));
    assert_eq!(
        fixture.judge()?,
        skip(Nir1GraphIndexSkipReason::RuntimeUnavailable)
    );
    fixture.runtime().resume()?;

    // A later attempt starts over from the sealed state (none) and publishes.
    let recorder = Recorder::default();
    run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(generation(fixture.db())?, Some(1));
    assert!(complete_registered(fixture.db())?);
    Ok(())
}

#[test]
fn publish_cancellation_before_the_grant_keeps_the_sealed_generation() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let before = sealed(fixture.db())?;
    let edges_before = graph_edge_states(fixture.db())?;
    let recorder = Recorder::default();
    let stop = Arc::clone(&recorder.stop);
    let observed_partial = Arc::new(AtomicBool::new(false));
    let observed = Arc::clone(&observed_partial);
    let _hook = install_hook(move |stage, conn| {
        if stage == TestStage::AfterPublish {
            // Inside the publish transaction the new generation exists...
            let generation: i64 = conn.expect("publish connection").query_row(
                "SELECT generation FROM narrative_semantic_index_metadata
                      WHERE project_id = ?1 AND index_key = ?2",
                params![PROJECT, INDEX_KEY],
                |row| row.get(0),
            )?;
            observed.store(generation == 2, Ordering::SeqCst);
            // ...and a cancel arrives before the finalization grant.
            stop.store(true, Ordering::SeqCst);
        }
        Ok(())
    });
    let error = run_cycle(&fixture, Some(&graph_seam()), &recorder)
        .expect_err("cancellation before the grant stops the work");
    assert!(
        error_text(&error).contains("NEX_MAINTENANCE_ATTEMPT_CANCELLED"),
        "{error:#}"
    );
    assert!(observed_partial.load(Ordering::SeqCst));
    assert!(Recorder::graph(&recorder.grants).is_empty());
    assert!(Recorder::graph(&recorder.completed).is_empty());
    // Nothing of generation 2 is visible: the sealed generation 1 remains.
    assert_eq!(sealed(fixture.db())?, before);
    assert_eq!(graph_edge_states(fixture.db())?, edges_before);
    assert!(!matches!(
        fixture.record(),
        Some(RecordedOutcome::Refused { .. })
    ));
    assert!(fixture.db().connection_reusable());
    drop(_hook);

    let recorder = Recorder::default();
    run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(generation(fixture.db())?, Some(2));
    assert!(complete_registered(fixture.db())?);
    Ok(())
}

#[test]
fn the_grant_linearizes_cancellation_and_a_late_cancel_keeps_success() -> Result<()> {
    let _serial = serial();
    // (i) Cancellation won before the grant: the transaction rolls back.
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let before = sealed(fixture.db())?;
    let recorder = Recorder::default();
    recorder
        .cancel_graph_before_grant
        .store(true, Ordering::SeqCst);
    let error =
        run_cycle(&fixture, Some(&graph_seam()), &recorder).expect_err("cancel before grant");
    assert!(error_text(&error).contains("NEX_MAINTENANCE_ATTEMPT_CANCELLED"));
    assert_eq!(sealed(fixture.db())?, before);
    assert!(Recorder::graph(&recorder.completed).is_empty());
    assert!(!matches!(
        fixture.record(),
        Some(RecordedOutcome::Refused { .. })
    ));

    // (ii) The grant won: a cancel that arrives right after it cannot
    // interrupt the COMMIT or rewrite the success; it stops later work.
    let recorder = Recorder::default();
    recorder
        .cancel_after_graph_grant
        .store(true, Ordering::SeqCst);
    let error = run_cycle(&fixture, Some(&graph_seam()), &recorder)
        .expect_err("the late cancel stops the next boundary");
    assert!(error_text(&error).contains("NEX_MAINTENANCE_ATTEMPT_CANCELLED"));
    assert_eq!(Recorder::graph(&recorder.grants).len(), 1);
    assert_eq!(Recorder::graph(&recorder.completed).len(), 1);
    assert_eq!(generation(fixture.db())?, Some(2));
    assert!(complete_registered(fixture.db())?);
    assert_eq!(fixture.record(), Some(RecordedOutcome::Published));
    Ok(())
}

#[test]
fn foreground_preemption_defers_without_publishing() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let before = sealed(fixture.db())?;
    for stage in [
        TestStage::BeforePrepare,
        TestStage::BetweenPhases,
        TestStage::BeforeFinalizationReservation,
    ] {
        let authority = Arc::clone(&fixture.authority);
        let armed = Arc::new(AtomicBool::new(true));
        let arm = Arc::clone(&armed);
        let _hook = install_hook(move |current, _| {
            if current == stage && arm.swap(false, Ordering::SeqCst) {
                authority
                    .db()
                    .foreground_connection_waiters
                    .fetch_add(1, Ordering::SeqCst);
            }
            Ok(())
        });
        let recorder = Recorder::default();
        let result = run_cycle(&fixture, Some(&graph_seam()), &recorder);
        fixture
            .db()
            .foreground_connection_waiters
            .fetch_sub(1, Ordering::SeqCst);
        let result = result?;
        assert!(!armed.load(Ordering::SeqCst), "{stage:?} hook did not fire");
        assert_eq!(result, MaintenanceCycleResult::accepted(true), "{stage:?}");
        assert_eq!(Recorder::graph(&recorder.deferred).len(), 1, "{stage:?}");
        assert!(Recorder::graph(&recorder.grants).is_empty(), "{stage:?}");
        assert_eq!(sealed(fixture.db())?, before, "{stage:?}");
        assert!(!matches!(
            fixture.record(),
            Some(RecordedOutcome::Refused { .. })
        ));
        assert!(fixture.db().connection_reusable());
    }
    let recorder = Recorder::default();
    run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(generation(fixture.db())?, Some(2));
    Ok(())
}

#[test]
fn elapsed_deadline_is_a_typed_refusal_that_keeps_the_sealed_generation() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let before = sealed(fixture.db())?;
    let deadline = Duration::from_secs(2);
    let budget = CapacityBudget::new(SQL_PROGRESS_LIMIT, Instant::now() + deadline);
    let _hook = install_hook(move |stage, _| {
        if stage == TestStage::BeforePrepare {
            std::thread::sleep(deadline + Duration::from_millis(200));
        }
        Ok(())
    });
    let recorder = Recorder::default();
    let outcome = with_attempt_budget_for_test(budget, || fixture.dispatch(&recorder))?;
    assert_eq!(outcome, no_finalization(false));
    assert_eq!(fixture.record(), refused_capacity("deadline"));
    assert_eq!(sealed(fixture.db())?, before);
    assert!(fixture.db().connection_reusable());
    assert_eq!(
        fixture.judge()?,
        skip(Nir1GraphIndexSkipReason::RefusedUnchanged)
    );
    Ok(())
}

#[test]
fn capacity_n_plus_one_is_refused_without_partial_and_retried_on_change() -> Result<()> {
    let _serial = serial();

    // SQL: the attempt has already used the ratified 600,000,000 counts when
    // prepare starts; its next count is N+1.
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let before = sealed(fixture.db())?;
    let budget = CapacityBudget::supported();
    let spent = Arc::clone(&budget);
    let _hook = install_hook(move |stage, _| {
        if stage == TestStage::BeforePrepare {
            set_used_steps_for_test(&spent, SQL_PROGRESS_LIMIT);
        }
        Ok(())
    });
    let recorder = Recorder::default();
    let outcome = with_attempt_budget_for_test(budget, || fixture.dispatch(&recorder))?;
    drop(_hook);
    assert_eq!(outcome, no_finalization(false));
    assert_eq!(fixture.record(), refused_capacity("sql-progress"));
    assert_eq!(sealed(fixture.db())?, before);

    // Stored Graph collection: 8,193 edge rows is the limit; 8,194 refuses
    // before any stored string is loaded.
    let fixture = Fixture::published()?;
    let (_, _, edges, _) = graph_surface(fixture.db())?;
    fixture.db().with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for index in 0..(8_194 - edges) {
            tx.execute(
                "INSERT INTO narrative_dependency_edges
                    (id, project_id, consumer_kind, consumer_key, source_object_identity,
                     read_set_json, created_at)
                 VALUES (?1, ?2, 'semantic-index', ?3, ?4, '[\"t\"]', '2026-09-22T00:00:00.000Z')",
                params![
                    format!("graph-overflow-{index}"),
                    PROJECT,
                    INDEX_KEY,
                    format!("codex:overflow-{index}")
                ],
            )?;
        }
        suspend_project_in_tx(&tx, PROJECT)?;
        tx.commit()?;
        Ok(())
    })?;
    let before = sealed(fixture.db())?;
    let recorder = Recorder::default();
    assert_eq!(fixture.dispatch(&recorder)?, no_finalization(false));
    assert_eq!(fixture.record(), refused_capacity("stored-edge-rows"));
    assert_eq!(sealed(fixture.db())?, before);
    assert_eq!(graph_surface(fixture.db())?.2, 8_194);

    // Source input: one candidate whose stored payload alone is 16 MiB + 1.
    let fixture = Fixture::published()?;
    let set_id = er_proposal_set_id(fixture.db())?;
    fixture.db().with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO narrative_proposals
                (id, proposal_set_id, proposal_key, kind, status, payload_json,
                 current_revision_id, created_at, updated_at)
             VALUES ('oversized-proposal', ?1, 'oversized', 'nir1.entity-relation@1',
                     'unreviewed', '{}', 'oversized-revision',
                     '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z')",
            [&set_id],
        )?;
        tx.execute(
            "INSERT INTO narrative_proposal_revisions
                (id, proposal_id, revision_number, payload_json, created_at, created_by)
             VALUES ('oversized-revision', 'oversized-proposal', 1, printf('%.*c', ?1, 'x'),
                     '2026-09-22T00:00:00.000Z', 'test')",
            [16 * 1024 * 1024 + 1],
        )?;
        suspend_project_in_tx(&tx, PROJECT)?;
        tx.commit()?;
        Ok(())
    })?;
    let before = sealed(fixture.db())?;
    let recorder = Recorder::default();
    assert_eq!(fixture.dispatch(&recorder)?, no_finalization(false));
    assert_eq!(fixture.record(), refused_capacity("input-bytes"));
    assert_eq!(sealed(fixture.db())?, before);

    // Scanned candidates: 2,064 is the limit; the 2,065th row refuses. The
    // unchanged input is not planned again, and an A2 change lifts that
    // suppression. (Verify shares the same full-set limits by the B-close
    // contract, so this project's durable chain fails on its own; the route is
    // exercised through its adapter and the cycle planner.)
    let fixture = Fixture::published()?;
    let set_id = er_proposal_set_id(fixture.db())?;
    fixture.db().with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for index in 0..2_065 {
            tx.execute(
                "INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, status, payload_json,
                     current_revision_id, created_at, updated_at)
                 VALUES (?1, ?2, ?1, 'nir1.entity-relation@1', 'unreviewed', '{}', ?3,
                         '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z')",
                params![
                    format!("candidate-overflow-{index:04}"),
                    set_id,
                    format!("missing-revision-{index:04}")
                ],
            )?;
        }
        suspend_project_in_tx(&tx, PROJECT)?;
        tx.commit()?;
        Ok(())
    })?;
    let before = sealed(fixture.db())?;
    assert!(fixture.plan()?.preempts_durable_chain());
    let recorder = Recorder::default();
    assert_eq!(fixture.dispatch(&recorder)?, no_finalization(false));
    assert!(Recorder::graph(&recorder.grants).is_empty());
    assert_eq!(fixture.record(), refused_capacity("candidate-rows"));
    assert_eq!(sealed(fixture.db())?, before);
    // Unchanged input: the cycle planner returns no Graph work.
    let plan = fixture.plan()?;
    assert!(!plan.preempts_durable_chain());
    assert!(plan.into_work().is_none());
    assert_eq!(
        fixture.judge()?,
        skip(Nir1GraphIndexSkipReason::RefusedUnchanged)
    );
    // A changed A2 input lifts the suppression: the build is attempted again
    // (and, with the oversized candidate set still present, refused again).
    add_second_reviewed_revision(fixture.db(), "nir1:review:2")?;
    assert_eq!(
        fixture.judge()?,
        build(
            Nir1GraphIndexBuildMode::Rebuild,
            Nir1GraphIndexBuildReason::BindingDirty
        )
    );
    let recorder = Recorder::default();
    assert_eq!(fixture.dispatch(&recorder)?, no_finalization(false));
    assert_eq!(fixture.record(), refused_capacity("candidate-rows"));
    assert_eq!(generation(fixture.db())?, Some(1));
    Ok(())
}

// B-GUARD: the roster never holds a Revision that is not approved, so a draft
// or a rejection whose stored payload or envelope is over the 6 MiB component
// limit must not stop the build, however large it is. The roster, and so the
// source digest, is exactly the approved Revision's, and the reader registers
// the new generation with both oversized candidates still in the project.
//
// The reader's query is deliberately not asserted here: it has its own 2 MiB
// per-Revision preflight, and refuses a query whose candidates include an
// oversized Revision whatever its approval (the candidate pager reads every
// proposal-revision edge of the seed's Entities).
#[test]
fn oversized_drafts_and_rejections_do_not_stop_the_build() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    let first = sealed(fixture.db())?.expect("generation 1");
    add_revision_with_oversized_payload(fixture.db(), "nir1:review:oversized-draft")?;
    let rejected =
        add_revision_with_oversized_envelope(fixture.db(), "nir1:review:oversized-rejected")?;
    append_typed_decision(fixture.db(), "nir1-run", &rejected, "rejected")?;
    fixture.mark_dirty()?;
    assert_eq!(
        fixture.judge()?,
        build(
            Nir1GraphIndexBuildMode::Rebuild,
            Nir1GraphIndexBuildReason::BindingDirty
        )
    );

    let recorder = Recorder::default();
    assert_eq!(
        fixture.dispatch(&recorder)?,
        MaintenanceDispatchOutcome::Completed
    );
    assert_eq!(fixture.record(), Some(RecordedOutcome::Published));
    assert_eq!(Recorder::graph(&recorder.grants).len(), 1);
    let second = sealed(fixture.db())?.expect("generation 2");
    assert_eq!((second.0, second.1), (2, 0));
    assert_eq!(
        second.2, first.2,
        "neither oversized candidate is in the roster, so the digest is unchanged"
    );
    assert!(complete_registered(fixture.db())?);
    assert!(reader_registers(&fixture)?);
    assert_eq!(
        fixture.judge()?,
        skip(Nir1GraphIndexSkipReason::BindingCurrent)
    );
    Ok(())
}

// B-GUARD: an approved Revision is one the roster has to hold, and B cannot
// read it within the limit, so no complete roster exists. The whole build is a
// typed capacity refusal (code NIR1_GRAPH_CAPACITY_EXCEEDED with the exceeded
// bound as its limit), the sealed generation is untouched, and the unchanged
// input is not rebuilt on every wake. Cancelling the approval is an ordinary
// product action, and it makes the next owned build publish again.
#[test]
fn oversized_approved_revision_is_a_typed_refusal_until_its_approval_is_cancelled() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    let created =
        add_revision_with_oversized_payload(fixture.db(), "nir1:review:oversized-approved")?;
    approve_typed_revision(fixture.db(), "nir1-run", &created)?;
    fixture.mark_dirty()?;
    let before = sealed(fixture.db())?;

    let recorder = Recorder::default();
    assert_eq!(fixture.dispatch(&recorder)?, no_finalization(false));
    assert_eq!(
        fixture.record(),
        refused_capacity("persisted-revision-component-bytes")
    );
    assert_eq!(sealed(fixture.db())?, before);
    assert_eq!(generation(fixture.db())?, Some(1));
    assert!(Recorder::graph(&recorder.grants).is_empty());
    assert!(fixture.db().connection_reusable());
    assert_eq!(
        fixture.judge()?,
        skip(Nir1GraphIndexSkipReason::RefusedUnchanged)
    );
    let plan = fixture.plan()?;
    assert!(!plan.preempts_durable_chain());
    assert!(plan.into_work().is_none());

    // The approval is cancelled through the ordinary human Decision writer; the
    // Revision is then rejected, so the roster no longer has to hold it.
    append_typed_decision(fixture.db(), "nir1-run", &created, "rejected")?;
    assert_eq!(
        fixture.judge()?,
        build(
            Nir1GraphIndexBuildMode::Rebuild,
            Nir1GraphIndexBuildReason::BindingDirty
        )
    );
    let recorder = Recorder::default();
    assert_eq!(
        fixture.dispatch(&recorder)?,
        MaintenanceDispatchOutcome::Completed
    );
    assert_eq!(fixture.record(), Some(RecordedOutcome::Published));
    assert_eq!(generation(fixture.db())?, Some(2));
    assert!(complete_registered(fixture.db())?);
    assert!(reader_registers(&fixture)?);
    Ok(())
}

// B-GUARD: the reader's complete registration re-resolves the same roster, so
// the stored payload of an approved Revision that grows past the limit after
// sealing (an import, a restore, an edit outside the app) fails the
// registration with the same typed capacity refusal, and never reports the
// binding complete. A candidate that is not approved does not (the first test).
#[test]
fn oversized_approved_revision_refuses_the_readers_registration() -> Result<()> {
    use crate::narrative_extraction::source_revision::is_validation_capacity_exceeded;

    let _serial = serial();
    let fixture = Fixture::published()?;
    assert!(complete_registered(fixture.db())?);
    let revision_id: String = fixture.db().with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT proposal.current_revision_id
               FROM narrative_proposals proposal
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
              WHERE proposal_set.project_id = ?1 AND proposal_set.set_kind = ?2
                AND proposal.current_revision_id IS NOT NULL",
            params![PROJECT, NIR1_ENTITY_RELATION_SET_KIND],
            |row| row.get(0),
        )?)
    })?;
    pad_payload(fixture.db(), &revision_id)?;

    let error = complete_registered(fixture.db())
        .expect_err("an oversized approved Revision must fail the complete registration");
    assert!(is_validation_capacity_exceeded(&error), "{error:#}");
    assert!(
        error_text(&error).contains("persisted-revision-component-bytes"),
        "{error:#}"
    );
    let error = reader_registers(&fixture)
        .expect_err("the reader must not register a binding it cannot resolve completely");
    assert!(is_validation_capacity_exceeded(&error), "{error:#}");
    // The sealed generation itself is untouched.
    assert_eq!(generation(fixture.db())?, Some(1));
    Ok(())
}

#[test]
fn cleanup_failure_quarantines_the_connection_and_it_is_not_reused() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let before = sealed(fixture.db())?;
    // The capacity scope reports a failed hook restoration with this exact
    // prefix; the outer maintenance scope must refuse to reuse the connection.
    let _hook = install_hook(move |stage, _| {
        if stage == TestStage::BeforePrepare {
            bail!("NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED: capacity hook restore: injected");
        }
        Ok(())
    });
    let recorder = Recorder::default();
    let error = run_cycle(&fixture, Some(&graph_seam()), &recorder)
        .expect_err("cleanup failure is terminal for the connection");
    assert!(error_text(&error).contains("NIR1_MAINTENANCE_CONNECTION_CLEANUP_FAILED"));
    assert!(!fixture.db().connection_reusable());
    assert!(!matches!(
        fixture.record(),
        Some(RecordedOutcome::Refused { .. })
    ));
    drop(_hook);
    // No later maintenance, including B, runs on the quarantined connection.
    let recorder = Recorder::default();
    let error =
        run_cycle(&fixture, Some(&graph_seam()), &recorder).expect_err("quarantined connection");
    assert!(
        error_text(&error).contains("CONNECTION_UNUSABLE"),
        "{error:#}"
    );
    assert!(Recorder::graph(&recorder.started).is_empty());
    // The previous sealed generation is untouched on disk.
    let reader = Database::new(&fixture.directory.0.join("grimodex.db"))?;
    assert_eq!(sealed(&reader)?, before);
    Ok(())
}

#[test]
fn workspace_switch_stops_and_runtime_rotation_refuses_without_partial() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let before = sealed(fixture.db())?;
    // A lifecycle stop between prepare and publish, and one inside the
    // publish transaction before the grant, both end the attempt.
    for stage in [TestStage::BetweenPhases, TestStage::AfterPublish] {
        let recorder = Recorder::default();
        let lifecycle_stop = Arc::clone(&recorder.lifecycle_stop);
        let _hook = install_hook(move |current, _| {
            if current == stage {
                lifecycle_stop.store(true, Ordering::SeqCst);
            }
            Ok(())
        });
        let error =
            run_cycle(&fixture, Some(&graph_seam()), &recorder).expect_err("lifecycle stop");
        assert!(
            error_text(&error).contains("NEX_MAINTENANCE_LIFECYCLE_STOP_REQUESTED"),
            "{stage:?}: {error:#}"
        );
        assert!(Recorder::graph(&recorder.grants).is_empty());
        assert_eq!(sealed(fixture.db())?, before, "{stage:?}");
        assert!(!matches!(
            fixture.record(),
            Some(RecordedOutcome::Refused { .. })
        ));
    }

    // The shared runtime epoch rotates (embedding generation bound) between
    // prepare and publish: the snapshot is stale and is refused.
    let authority = Arc::clone(&fixture.authority);
    let _hook = install_hook(move |stage, _| {
        if stage == TestStage::BetweenPhases {
            authority
                .nir_chronicle_index_runtime()
                .bind_embedding_generation(1)?;
        }
        Ok(())
    });
    let recorder = Recorder::default();
    run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    drop(_hook);
    assert_eq!(sealed(fixture.db())?, before);
    assert_eq!(Recorder::graph(&recorder.noop).len(), 1);
    assert!(Recorder::graph(&recorder.grants).is_empty());
    // The refusal belongs to the old runtime epoch; the next wake rebuilds.
    assert_eq!(
        fixture.judge()?,
        build(
            Nir1GraphIndexBuildMode::Rebuild,
            Nir1GraphIndexBuildReason::BindingDirty
        )
    );
    let recorder = Recorder::default();
    run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(generation(fixture.db())?, Some(2));
    assert!(complete_registered(fixture.db())?);
    Ok(())
}

#[test]
fn drift_at_the_publish_barrier_is_refused_and_the_next_cycle_rebuilds() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let before = sealed(fixture.db())?;
    // An A2 Revision and Decision commit between the prepare snapshot and the
    // publish transaction.
    let authority = Arc::clone(&fixture.authority);
    let _hook = install_hook(move |stage, _| {
        if stage == TestStage::BetweenPhases {
            add_second_reviewed_revision(authority.db(), "nir1:review:drift")?;
        }
        Ok(())
    });
    let recorder = Recorder::default();
    let result = run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    drop(_hook);
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
    assert_eq!(fixture.record(), refused("NIR1_GRAPH_SNAPSHOT_STALE"));
    assert!(Recorder::graph(&recorder.grants).is_empty());
    let (generation_after, ..) = sealed(fixture.db())?.expect("sealed");
    assert_eq!(
        generation_after,
        before.as_ref().map(|identity| identity.0).unwrap()
    );
    // The refusal was keyed by the pre-drift inputs; the drifted inputs are
    // new, so the next cycle rebuilds with the new Revision.
    let recorder = Recorder::default();
    run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(generation(fixture.db())?, Some(2));
    let response = assert_available(&fixture, 2)?;
    assert!(response
        .graph
        .expect("available Graph")
        .edges
        .iter()
        .any(|edge| edge.relation.edge_id == "nir1-edge-b"));
    Ok(())
}

// ---------------------------------------------------------------------------
// D. Restore and cold reopen
// ---------------------------------------------------------------------------

#[test]
fn restore_epoch_makes_the_graph_unavailable_until_an_owned_rebuild() -> Result<()> {
    let _serial = serial();
    let fixture = Fixture::published()?;
    let before = sealed(fixture.db())?;
    ensure_restore_epochs_for_workspace(
        fixture.db(),
        "restore-image-sha256:b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
    )?;
    // The restore Epoch does not set dirty, but the binding is no longer
    // current: registration and the C-query reader fail closed.
    assert_eq!(sealed(fixture.db())?, before);
    assert!(!complete_registered(fixture.db())?);
    assert!(reader_query(&fixture)?.is_none());

    // Gate closed (the product default): the planner yields no Graph work and
    // reads nothing, so the binding stays unavailable. (Nothing in the product
    // creates a Graph binding; a stale one exists here only because this
    // test opened the gate earlier.)
    let recorder = Recorder::default();
    let closed =
        Nir1GraphCycleContext::new(Nir1GraphIndexBuildGate::closed(), Some(fixture.runtime()));
    let plan = with_control(&recorder, |control| {
        plan_graph_index_build(
            fixture.db(),
            PROJECT,
            "durable-wake",
            Some(control),
            &closed,
        )
    })?;
    assert!(!plan.preempts_durable_chain());
    assert!(plan.into_work().is_none());
    assert_eq!(sealed(fixture.db())?, before);
    assert!(!complete_registered(fixture.db())?);

    // Gate open: the stale binding is rebuilt under the restore Epoch before
    // the durable chain re-verifies it; once the chain settles, the binding is
    // complete again and the reader is available.
    assert_eq!(
        fixture.judge()?,
        build(
            Nir1GraphIndexBuildMode::Rebuild,
            Nir1GraphIndexBuildReason::NotCurrent
        )
    );
    let recorder = Recorder::default();
    let result = run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(result, MaintenanceCycleResult::accepted(false));
    let rebuilt = generation(fixture.db())?.expect("rebuilt binding");
    assert!(rebuilt >= 2);
    assert!(complete_registered(fixture.db())?);
    let restore_epoch = fixture.current_epoch()?;
    let freshness_epoch: String = fixture.db().with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT semantic_epoch_id FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'semantic-index' AND consumer_key = ?2",
            params![PROJECT, INDEX_KEY],
            |row| row.get(0),
        )?)
    })?;
    assert_eq!(freshness_epoch, restore_epoch);
    // Restore never auto-qualifies a Revision (it needs a new Revision and
    // Human Decision under the restore Epoch), so the rebuilt generation is
    // complete with no qualified material: the reader serves it, and never
    // the pre-restore roster.
    assert_eq!(graph_surface(fixture.db())?, (1, 1, 1, 1));
    let response = reader_query(&fixture)?.expect("the rebuilt binding registers");
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let graph = response.graph.expect("available Graph");
    assert_eq!(graph.generation, rebuilt);
    assert!(graph.edges.is_empty() && graph.nodes.is_empty());
    Ok(())
}

#[test]
fn cold_reopen_detects_an_external_edit_and_rebuilds() -> Result<()> {
    let _serial = serial();
    let mut fixture = Fixture::published()?;
    fixture.reopen()?;
    // An edit that bypasses every invalidation writer: the Graph's Freshness
    // inputs say stale while the binding still looks current.
    fixture.db().with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_dependency_edge_states
                SET evidence_freshness = 'stale', reason_code = 'source-revision-changed',
                    build_action = 'rebuild-required'
              WHERE edge_id IN (SELECT id FROM narrative_dependency_edges
                                 WHERE project_id = ?1 AND consumer_kind = 'semantic-index'
                                   AND consumer_key = ?2)",
            params![PROJECT, INDEX_KEY],
        )?;
        Ok(())
    })?;
    assert_eq!(sealed(fixture.db())?.map(|identity| identity.1), Some(0));
    assert!(!complete_registered(fixture.db())?);
    assert!(reader_query(&fixture)?.is_none());

    let recorder = Recorder::default();
    let result = run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
    // Validation (no grant) then a fresh rebuild attempt (one grant).
    assert_eq!(Recorder::graph(&recorder.registered).len(), 2);
    assert_eq!(Recorder::graph(&recorder.noop).len(), 1);
    assert_eq!(Recorder::graph(&recorder.grants).len(), 1);
    assert_eq!(Recorder::graph(&recorder.completed).len(), 1);
    assert_eq!(generation(fixture.db())?, Some(2));
    assert!(complete_registered(fixture.db())?);
    assert_eq!(fixture.record(), Some(RecordedOutcome::Published));
    assert_available(&fixture, 2)?;
    Ok(())
}

#[test]
fn injected_publish_failure_rolls_back_and_a_reopen_rebuilds() -> Result<()> {
    let _serial = serial();
    let mut fixture = Fixture::published()?;
    fixture.mark_dirty()?;
    let before = sealed(fixture.db())?;
    let _hook = install_hook(move |stage, _| {
        if stage == TestStage::AfterPublish {
            bail!("NIR1_GRAPH_TEST_INJECTED_PUBLISH_FAILURE: after D1/V1/metadata writes");
        }
        Ok(())
    });
    let recorder = Recorder::default();
    let result = run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    drop(_hook);
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
    assert_eq!(
        fixture.record(),
        refused("NIR1_GRAPH_TEST_INJECTED_PUBLISH_FAILURE")
    );
    assert_eq!(sealed(fixture.db())?, before);
    assert_eq!(
        fixture.judge()?,
        skip(Nir1GraphIndexSkipReason::RefusedUnchanged)
    );
    // A crash/restart keeps only the old sealed generation; the reopened
    // authority has no record and rebuilds from it.
    fixture.reopen()?;
    assert_eq!(sealed(fixture.db())?, before);
    let recorder = Recorder::default();
    run_cycle(&fixture, Some(&graph_seam()), &recorder)?;
    assert_eq!(generation(fixture.db())?, Some(2));
    assert!(complete_registered(fixture.db())?);
    Ok(())
}
