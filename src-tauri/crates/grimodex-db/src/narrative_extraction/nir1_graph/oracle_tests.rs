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
use rusqlite::params;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const PROJECT: &str = "default-project";
const UNRELATED_ENTITY: &str = "oracle-unrelated";
const SEED_KEYSET_DECOYS: usize = 31;
const UNRELATED_REVERSE_INDEX_DECOYS: usize = 513;
const STALE_SEED_REVERSE_INDEX_DECOYS: usize = 512;

struct TestDirectory(PathBuf);

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct OracleFixture {
    authority: Arc<WorkspaceAuthority>,
    lifecycle: WorkspaceLifecycleCore,
    target_revision: String,
    _directory: TestDirectory,
}

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

impl OracleFixture {
    fn new() -> Result<Self> {
        let directory = TestDirectory(
            std::env::temp_dir().join(format!("nir1-c-graph-oracle-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&directory.0)?;
        let db = crate::Database::new(&directory.0.join("grimodex.db"))?;
        db.migrate()?;
        seed_run_and_catalog(&db)?;
        prepare_a3_scope_fixture(&db)?;
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO codex_entries
                    (id, project_id, type, name, summary, updated_at)
                 VALUES (?1, ?2, 'character', 'Unrelated', 'Unrelated',
                         '2026-09-12T00:00:00Z')",
                params![UNRELATED_ENTITY, PROJECT],
            )?;
            conn.execute(
                "UPDATE codex_relations SET directionality='directed'
                  WHERE id='nir1-edge'",
                [],
            )?;
            Ok(())
        })?;
        run_incremental_freshness_cycle(&db)?;

        let mut target = request(&db);
        for entity in &mut target.bundle.entities {
            entity.scope.reading = ScopeValue::Exact {
                value: "scene:a3-source".into(),
            };
            entity.scope.phase = "draft".into();
        }
        target.bundle.relations[0].directionality = "directed".into();
        let target_created = create_nir1_entity_relation_revision(&db, target)?;
        approve_typed_revision(&db, "nir1-run", &target_created)?;

        let mut unrelated = request(&db);
        unrelated.proposal_key = "nir1:oracle-unrelated:1".into();
        let entity = unrelated
            .bundle
            .entities
            .first_mut()
            .ok_or_else(|| anyhow::anyhow!("oracle fixture request has no entity"))?;
        entity.entity_id = UNRELATED_ENTITY.into();
        entity.label = "Unrelated".into();
        entity.source_token = "codex:oracle-unrelated@2026-09-12T00:00:00Z".into();
        entity.scope.reading = ScopeValue::Exact {
            value: "scene:a3-source".into(),
        };
        entity.scope.phase = "draft".into();
        let evidence = entity
            .evidence
            .first_mut()
            .ok_or_else(|| anyhow::anyhow!("oracle fixture entity has no evidence"))?;
        evidence.evidence_id = "oracle-unrelated-evidence".into();
        evidence.source_ref = "codex:oracle-unrelated".into();
        evidence.quote = "Unrelated".into();
        evidence.end_utf16 = "Unrelated".encode_utf16().count();
        unrelated.bundle.entities.truncate(1);
        unrelated.bundle.relations.clear();
        let _unrelated_created = create_nir1_entity_relation_revision(&db, unrelated)?;
        approve_typed_revision(&db, "nir1-run", &_unrelated_created)?;

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
            target_revision: target_created["revisionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("oracle target revision has no revisionId"))?
                .to_owned(),
            _directory: directory,
        })
    }

    fn add_keyset_and_unrelated_decoys(&self) -> Result<()> {
        self.authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for index in 0..SEED_KEYSET_DECOYS {
                let id = format!("oracle-seed-keyset-decoy-{index}");
                tx.execute(
                    "INSERT INTO narrative_dependency_edges
                        (id, project_id, consumer_kind, consumer_key,
                         source_object_identity, read_set_json, created_at)
                     VALUES (?1, ?2, 'graph-test-unrelated', ?1, ?3, '[]',
                             '2026-09-22T00:00:00Z')",
                    params![id, PROJECT, "codex:nir1-alice"],
                )?;
            }
            for index in 0..UNRELATED_REVERSE_INDEX_DECOYS {
                let id = format!("oracle-unrelated-revision-decoy-{index}");
                let revision_id = format!("oracle-unrelated-revision-{index}");
                tx.execute(
                    "INSERT INTO narrative_dependency_edges
                        (id, project_id, consumer_kind, consumer_key,
                         source_object_identity, read_set_json, created_at)
                     VALUES (?1, ?2, 'proposal-revision', ?3, ?4, '[]',
                             '2026-09-22T00:00:00Z')",
                    params![
                        id,
                        PROJECT,
                        revision_id,
                        format!("codex:{UNRELATED_ENTITY}")
                    ],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    fn add_same_source_stale_rows(&self) -> Result<()> {
        self.authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for index in 0..STALE_SEED_REVERSE_INDEX_DECOYS {
                let id = format!("oracle-stale-seed-{index}");
                tx.execute(
                    "INSERT INTO narrative_dependency_edges
                        (id, project_id, consumer_kind, consumer_key,
                         source_object_identity, read_set_json, created_at)
                     VALUES (?1, ?2, 'proposal-revision', ?3, ?4, '[]',
                             '2026-09-22T00:00:00Z')",
                    params![
                        id,
                        PROJECT,
                        format!("oracle-stale-revision-{index}"),
                        "codex:nir1-alice",
                    ],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }

    fn assert_semantic_index_sealed(&self) -> Result<()> {
        self.authority.with_conn(|conn| {
            let (dirty, freshness, action): (i64, String, String) = conn.query_row(
                "SELECT m.dirty_cache_flag, f.evidence_freshness, f.build_action
                   FROM narrative_semantic_index_metadata m
                   JOIN narrative_consumer_freshness f
                     ON f.project_id=m.project_id
                    AND f.consumer_kind='semantic-index'
                    AND f.consumer_key=m.index_key
                  WHERE m.project_id=?1 AND m.index_key=?2",
                params![PROJECT, INDEX_KEY],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            ensure!(dirty == 0, "semantic index is dirty");
            ensure!(freshness == "fresh", "semantic index is not fresh");
            ensure!(action == "none", "semantic index requires rebuild");
            Ok(())
        })
    }

    fn corrupt_seed_reverse_index(&self, wrong_family: bool) -> Result<()> {
        self.authority.with_conn(|conn| {
            let affected = if wrong_family {
                conn.execute(
                    "UPDATE narrative_dependency_edges
                        SET consumer_kind='oracle-wrong-family'
                      WHERE project_id=?1
                        AND consumer_kind='proposal-revision'
                        AND consumer_key=?2
                        AND source_object_identity='codex:nir1-alice'",
                    params![PROJECT, self.target_revision],
                )?
            } else {
                conn.execute(
                    "DELETE FROM narrative_dependency_edges
                      WHERE project_id=?1
                        AND consumer_kind='proposal-revision'
                        AND consumer_key=?2
                        AND source_object_identity='codex:nir1-alice'",
                    params![PROJECT, self.target_revision],
                )?
            };
            ensure!(
                affected == 1,
                "oracle fixture expected one target reverse-index row"
            );
            Ok(())
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
        ensure!(
            reader.register_with_control(PROJECT, &mut RegistrationOwner)?,
            "oracle fixture graph index did not register"
        );
        Ok(reader)
    }
}

fn graph_request(seed_entity_id: &str) -> Nir1GraphRequest {
    Nir1GraphRequest {
        project_id: PROJECT.into(),
        query_scene_id: "nir1".into(),
        seed_entity_id: seed_entity_id.into(),
    }
}

// The expected roster is deliberately written from the fixture contract. It
// does not inspect the published index or enumerate candidate rows, so a
// query can only pass by returning the target revision's exact material.
#[test]
fn seed_local_query_matches_explicit_roster_with_keyset_decoys() -> Result<()> {
    let fixture = OracleFixture::new()?;
    fixture.add_keyset_and_unrelated_decoys()?;
    let mut reader = fixture.registered_reader()?;
    let response = reader.query_with_deadline(
        &graph_request("nir1-alice"),
        Duration::from_secs(2),
        100_000,
    )?;
    ensure!(
        response.status == "available",
        "oracle query unavailable: {:?}",
        response.reason
    );
    let graph = response
        .graph
        .ok_or_else(|| anyhow::anyhow!("oracle query returned no graph"))?;
    assert_eq!(graph.seed_entity_id, "nir1-alice");
    assert!(graph.generation > 0);

    let actual_nodes = graph
        .nodes
        .iter()
        .map(|node| (node.entity.entity_id.clone(), node.hop))
        .collect::<Vec<_>>();
    let mut sorted_nodes = actual_nodes.clone();
    sorted_nodes.sort();
    assert_eq!(
        sorted_nodes,
        vec![("nir1-alice".into(), 0), ("nir1-bob".into(), 1)]
    );
    assert_eq!(
        actual_nodes.len(),
        BTreeMap::<String, u8>::from_iter(actual_nodes.iter().cloned()).len(),
        "query returned duplicate node identities"
    );

    let actual_edges = graph
        .edges
        .iter()
        .map(|edge| {
            (
                edge.binding.revision_id.clone(),
                edge.relation.edge_id.clone(),
                edge.from.entity_id.clone(),
                edge.to.entity_id.clone(),
            )
        })
        .collect::<BTreeSet<_>>();
    let expected_edges = BTreeSet::from([(
        fixture.target_revision.clone(),
        "nir1-edge".to_owned(),
        "nir1-alice".to_owned(),
        "nir1-bob".to_owned(),
    )]);
    assert_eq!(actual_edges, expected_edges);
    Ok(())
}

#[test]
fn same_source_stale_reverse_rows_are_budgeted_without_partial_graph() -> Result<()> {
    let fixture = OracleFixture::new()?;
    fixture.add_same_source_stale_rows()?;
    let mut reader = fixture.registered_reader()?;
    let response = reader.query_with_deadline(
        &graph_request("nir1-alice"),
        Duration::from_secs(2),
        100_000,
    )?;
    assert_eq!(response.status, "unavailable");
    assert_eq!(
        response.reason.as_deref(),
        Some("query-budget-or-validation-failed")
    );
    assert!(response.graph.is_none());
    Ok(())
}

#[test]
fn sealed_semantic_index_rejects_missing_or_wrong_family_seed_reverse_row() -> Result<()> {
    for wrong_family in [false, true] {
        let fixture = OracleFixture::new()?;
        fixture.assert_semantic_index_sealed()?;
        fixture.corrupt_seed_reverse_index(wrong_family)?;
        fixture.assert_semantic_index_sealed()?;

        let mut reader = fixture.reader()?;
        assert!(
            !reader.register_with_control(PROJECT, &mut RegistrationOwner)?,
            "malformed reverse-index family {wrong_family} must fail closed during registration"
        );
        let response = reader.query_with_deadline(
            &graph_request("nir1-alice"),
            Duration::from_secs(2),
            100_000,
        )?;
        assert_eq!(response.status, "unavailable");
        assert_eq!(response.reason.as_deref(), Some("registration-required"));
        assert!(response.graph.is_none());
    }
    Ok(())
}
