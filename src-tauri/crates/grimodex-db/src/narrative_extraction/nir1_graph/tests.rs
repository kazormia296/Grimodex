use super::*;
use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
use crate::narrative_extraction::nir1_entity_relation::{
    create_nir1_entity_relation_revision,
    tests::{approve_typed_revision, prepare_a3_scope_fixture, request, seed_run_and_catalog},
};
use crate::narrative_extraction::nir1_entity_relation_index::{
    prepare_graph_index_build, publish_nir1_entity_relation_index_in_tx,
};
use crate::workspace_lifecycle::WorkspaceLifecycleCore;
use grimodex_core::narrative_nir1::ScopeValue;
use std::{path::PathBuf, time::Instant};

const PROJECT: &str = "default-project";

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
        let runtime = authority.nir_chronicle_index_runtime();
        let snapshot = authority
            .with_read_transaction(|conn| prepare_graph_index_build(conn, runtime, PROJECT))?;
        authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            publish_nir1_entity_relation_index_in_tx(&tx, runtime, snapshot)?;
            tx.commit()?;
            Ok(())
        })?;
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
}

fn graph_request(seed: &str) -> Nir1GraphRequest {
    Nir1GraphRequest {
        project_id: PROJECT.into(),
        query_scene_id: "nir1".into(),
        seed_entity_id: seed.into(),
    }
}

// Functional contracts have their own generous deadline; the production 8ms
// limit remains unchanged and deterministic exhaustion is tested separately.
fn query(reader: &mut Nir1GraphReader, seed: &str) -> Result<Nir1GraphResponse> {
    reader.query_with_deadline(&graph_request(seed), Duration::from_secs(2), 100_000)
}

/// Measurement-only probe for the production deadline. Functional fixtures
/// use a generous deadline so their correctness assertions are not coupled to
/// HDD scheduling; this ignored test exercises the actual public reader path.
#[test]
#[ignore = "run explicitly as the production 8ms availability measurement"]
fn production_query_has_an_available_8ms_success_path() -> Result<()> {
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
        // Diagnostic only: distinguish the 8 ms deadline from a fixture or
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
        elapsed < Duration::from_millis(8),
        "production query exceeded its 8ms wall budget: {elapsed:?}"
    );
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
    assert_unavailable(
        &reader.query(&graph_request("nir1-alice"))?,
        "reader-unavailable",
    );
    Ok(())
}
