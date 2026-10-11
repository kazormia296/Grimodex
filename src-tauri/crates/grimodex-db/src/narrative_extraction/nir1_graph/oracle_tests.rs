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
use grimodex_core::canonical_json::canonical_json_digest;
use grimodex_core::narrative_nir1::{EntityRelationBundle, ScopeValue};
use rusqlite::params;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const PROJECT: &str = "default-project";
const UNRELATED_ENTITY: &str = "oracle-unrelated";
const TWO_HOP_ENTITY: &str = "oracle-third";
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
    expected_bundle: EntityRelationBundle,
    generation: i64,
    two_hop: bool,
    _directory: TestDirectory,
}

#[derive(Clone, Copy, Debug)]
enum DeniedBridge {
    Unapproved,
    FutureScope,
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
        Self::with_denied_bridge(None)
    }

    fn two_hop() -> Result<Self> {
        Self::build(None, true)
    }

    fn with_denied_bridge(bridge: Option<DeniedBridge>) -> Result<Self> {
        Self::build(bridge, false)
    }

    fn build(bridge: Option<DeniedBridge>, two_hop: bool) -> Result<Self> {
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
            if two_hop {
                conn.execute(
                    "INSERT INTO codex_entries
                        (id, project_id, type, name, summary, updated_at)
                     VALUES (?1, ?2, 'character', 'Third', 'Third',
                             '2026-09-12T00:00:00Z')",
                    params![TWO_HOP_ENTITY, PROJECT],
                )?;
                conn.execute(
                    "INSERT INTO codex_relations
                        (id, project_id, from_codex_id, to_codex_id, relation_type,
                         directionality, version, updated_at)
                     VALUES ('oracle-edge-bc', ?1, 'nir1-bob', ?2, 'related',
                             'directed', 1, '2026-09-12T00:00:00Z')",
                    params![PROJECT, TWO_HOP_ENTITY],
                )?;
            } else {
                conn.execute(
                    "INSERT INTO codex_relations
                        (id, project_id, from_codex_id, to_codex_id, relation_type,
                         directionality, version, updated_at)
                     VALUES ('nir1-edge-b', ?1, 'nir1-alice', 'nir1-bob', 'related',
                             'directed', 1, '2026-09-12T00:00:00Z')",
                    [PROJECT],
                )?;
            }
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
        let mut second_relation = target.bundle.relations[0].clone();
        if two_hop {
            let mut third_entity = target.bundle.entities[1].clone();
            third_entity.entity_id = TWO_HOP_ENTITY.into();
            third_entity.label = "Third".into();
            third_entity.source_token = "codex:oracle-third@2026-09-12T00:00:00Z".into();
            third_entity.evidence[0].evidence_id = "oracle-third-evidence".into();
            third_entity.evidence[0].source_ref = "codex:oracle-third".into();
            third_entity.evidence[0].quote = "Third".into();
            third_entity.evidence[0].end_utf16 = "Third".encode_utf16().count();
            target.bundle.entities.push(third_entity);

            second_relation.edge_id = "oracle-edge-bc".into();
            second_relation.from_entity_id = "nir1-bob".into();
            second_relation.to_entity_id = TWO_HOP_ENTITY.into();
            second_relation.evidence_ids =
                vec!["nir1-evidence-bob".into(), "oracle-third-evidence".into()];
        } else {
            second_relation.edge_id = "nir1-edge-b".into();
        }
        second_relation.relation_type = "related".into();
        second_relation.source_token = format!(
            "v1@2026-09-12T00:00:00Z:relation:{}",
            second_relation.edge_id
        );
        target.bundle.relations.push(second_relation);
        let expected_bundle = target.bundle.clone();
        // Storage order differs from the declared output order: sorting the
        // actual result in the assertion would hide an ordering regression.
        target.bundle.relations.reverse();
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
        let unrelated_entity = unrelated.bundle.entities[0].clone();
        let _unrelated_created = create_nir1_entity_relation_revision(&db, unrelated)?;
        approve_typed_revision(&db, "nir1-run", &_unrelated_created)?;

        if let Some(bridge) = bridge {
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO codex_relations
                        (id, project_id, from_codex_id, to_codex_id, relation_type,
                         directionality, version, updated_at)
                     VALUES ('oracle-denied-bridge', ?1, 'nir1-bob', ?2, 'knows',
                             'directed', 1, '2026-09-12T00:00:00Z')",
                    params![PROJECT, UNRELATED_ENTITY],
                )?;
                Ok(())
            })?;
            let mut denied = request(&db);
            denied.proposal_key = "nir1:oracle-denied:1".into();
            denied.bundle.entities = vec![expected_bundle.entities[1].clone(), unrelated_entity];
            if matches!(bridge, DeniedBridge::FutureScope) {
                denied.bundle.entities[1].scope.reading = ScopeValue::Exact {
                    value: "scene:a3-future".into(),
                };
            }
            let relation = &mut denied.bundle.relations[0];
            relation.edge_id = "oracle-denied-bridge".into();
            relation.from_entity_id = "nir1-bob".into();
            relation.to_entity_id = UNRELATED_ENTITY.into();
            relation.source_token = "v1@2026-09-12T00:00:00Z:relation:oracle-denied-bridge".into();
            relation.evidence_ids = vec![
                "nir1-evidence-bob".into(),
                "oracle-unrelated-evidence".into(),
            ];
            let created = create_nir1_entity_relation_revision(&db, denied)?;
            if matches!(bridge, DeniedBridge::FutureScope) {
                approve_typed_revision(&db, "nir1-run", &created)?;
            }
            let revision = created["revisionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("denied bridge revision missing"))?;
            db.with_conn(|conn| {
                let count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM narrative_dependency_edges
                     WHERE project_id=?1 AND consumer_kind='proposal-revision'
                       AND consumer_key=?2 AND source_object_identity='codex:nir1-bob'",
                    params![PROJECT, revision],
                    |row| row.get(0),
                )?;
                ensure!(
                    count == 1,
                    "denied bridge must be a real indexed intermediate candidate"
                );
                Ok(())
            })?;
        }

        let authority = WorkspaceAuthority::from_database_for_test(db, directory.0.clone())?;
        let runtime = authority.nir_chronicle_index_runtime();
        let snapshot = authority
            .with_read_transaction(|conn| prepare_graph_index_build(conn, runtime, PROJECT))?;
        let generation = authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let published = publish_nir1_entity_relation_index_in_tx(&tx, runtime, snapshot)?;
            tx.commit()?;
            Ok(published.generation)
        })?;

        Ok(Self {
            authority,
            lifecycle: WorkspaceLifecycleCore::new(),
            target_revision: target_created["revisionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("oracle target revision has no revisionId"))?
                .to_owned(),
            expected_bundle,
            generation,
            two_hop,
            _directory: directory,
        })
    }

    // The roster/material comes from inputs saved before the canonical writer,
    // not from candidate rows or A2/A3. Read only canonical binding metadata
    // for the exact fixture Revision; no qualification/traversal is duplicated.
    fn expected_response(&self) -> Result<Value> {
        self.authority.with_read_transaction(|conn| {
            let (proposal_id, decision_json): (String, String) = conn.query_row(
                "SELECT proposal_id, json_object(
                    'id', id, 'decision', decision, 'decisionJson', decision_json,
                    'createdAt', created_at, 'createdBy', created_by,
                    'actorKind', actor_kind, 'actorId', actor_id,
                    'authorityScope', authority_scope,
                    'overrideFieldPathsJson', override_field_paths_json)
                 FROM narrative_proposal_decisions WHERE revision_id=?1",
                [&self.target_revision],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let decision: Value = serde_json::from_str(&decision_json)?;
            assert_eq!(decision["decision"], "approved");
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
                         FROM narrative_change_transactions WHERE project_id=?1)))
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
                params![
                    PROJECT,
                    self.target_revision,
                    crate::narrative_extraction::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID,
                    // One source per Entity/Relation plus Scope authority.
                    (self.expected_bundle.entities.len() + self.expected_bundle.relations.len() + 1)
                        as i64,
                ],
                |row| row.get(0),
            )?;
            let freshness: Value = serde_json::from_str(&freshness_json)?;
            let (scene_source, scene_scope, incarnation): (String, String, String) = conn
                .query_row(
                    "SELECT 'v' || t.version || '@' || t.updated_at,
                        s.source_token, s.scene_incarnation_id
                 FROM tree_nodes t JOIN narrative_scene_scope_bindings s
                   ON s.project_id=t.project_id AND s.scene_id=t.id
                 WHERE t.project_id=?1 AND t.id='nir1'",
                    [PROJECT],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            let entities = &self.expected_bundle.entities;
            let expected_hops: &[u8] = if self.two_hop { &[0, 1, 2] } else { &[0, 1] };
            ensure!(
                entities.len() == expected_hops.len(),
                "oracle fixture entities do not match its declared path"
            );
            let entity_ids = entities
                .iter()
                .map(|entity| entity.entity_id.as_str())
                .collect::<Vec<_>>();
            let authority_revision = &entities[0].scope.authority_revision;
            // This fixture has no POV, phases or foreshadows; auto falls back
            // to reading order. These expectations do not consult A3 output.
            let reveal = json!({
                "projectId": PROJECT, "querySceneId": "nir1",
                "phaseResolutionMode": "auto", "effectiveAxis": "reading",
                "scopeAuthorityRevision": authority_revision, "queryViewpoint": null,
                "phaseState": entity_ids.iter().map(|id| json!({
                    "entityId": id, "baseContextMode": "mentioned", "phases": [],
                    "applicablePhaseIds": [], "effectiveContextMode": "mentioned",
                })).collect::<Vec<_>>(),
                "entities": entity_ids.iter().map(|id| json!({
                    "entityId": id, "foreshadows": [],
                })).collect::<Vec<_>>(),
            });
            let binding = json!({
                "revisionId": self.target_revision, "decisionId": decision["id"],
                "decisionToken": canonical_json_digest(&json!({
                    "proposalId": proposal_id, "revisionId": self.target_revision,
                    "decisions": [decision],
                }))?,
                "freshnessToken": canonical_json_digest(&freshness)?,
                "scopeAuthorityRevision": authority_revision,
                "querySceneSourceToken": scene_source, "querySceneScopeToken": scene_scope,
                "querySceneIncarnationId": incarnation,
                "revealStateToken": canonical_json_digest(&reveal)?,
            });
            let mut expected_edges = Vec::with_capacity(self.expected_bundle.relations.len());
            for relation in &self.expected_bundle.relations {
                let from = entities
                    .iter()
                    .find(|entity| entity.entity_id == relation.from_entity_id)
                    .ok_or_else(|| anyhow::anyhow!("oracle edge source is absent"))?;
                let to = entities
                    .iter()
                    .find(|entity| entity.entity_id == relation.to_entity_id)
                    .ok_or_else(|| anyhow::anyhow!("oracle edge target is absent"))?;
                expected_edges.push(json!({
                    "relation": relation, "from": from, "to": to, "binding": binding,
                }));
            }
            let expected_nodes = entities
                .iter()
                .zip(expected_hops)
                .map(|(entity, hop)| {
                    json!({
                        "entity": entity, "hop": hop, "bindings": [binding],
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "status": "available", "projectId": PROJECT, "querySceneId": "nir1",
                "scopeRevision": authority_revision, "reason": null,
                "graph": {
                    "seedEntityId": "nir1-alice", "generation": self.generation,
                    "nodes": expected_nodes,
                    "edges": expected_edges,
                },
            }))
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

// Freeze the full canonical projection before querying. This includes output
// order, both complete endpoint/Evidence values and every binding field, not
// just a set of IDs that could hide duplicates or partial material.
#[test]
fn seed_local_query_matches_explicit_roster_with_keyset_decoys() -> Result<()> {
    let fixture = OracleFixture::new()?;
    fixture.add_keyset_and_unrelated_decoys()?;
    let expected = fixture.expected_response()?;
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
    assert_eq!(serde_json::to_value(&response)?, expected);
    Ok(())
}

#[test]
fn seed_local_two_hop_query_matches_independent_canonical_projection() -> Result<()> {
    let fixture = OracleFixture::two_hop()?;
    let expected = fixture.expected_response()?;
    let mut reader = fixture.registered_reader()?;
    let response = reader.query_with_deadline(
        &graph_request("nir1-alice"),
        Duration::from_secs(2),
        100_000,
    )?;
    ensure!(
        response.status == "available",
        "two-hop oracle query unavailable: {:?}",
        response.reason
    );
    let actual = serde_json::to_value(&response)?;
    assert_eq!(actual, expected);
    assert_eq!(
        actual["graph"]["nodes"][2]["entity"]["entityId"],
        TWO_HOP_ENTITY
    );
    assert_eq!(actual["graph"]["nodes"][2]["hop"], 2);
    assert_eq!(
        actual["graph"]["edges"][0]["from"]["entityId"],
        "nir1-alice"
    );
    assert_eq!(actual["graph"]["edges"][0]["to"]["entityId"], "nir1-bob");
    assert_eq!(actual["graph"]["edges"][1]["from"]["entityId"], "nir1-bob");
    assert_eq!(
        actual["graph"]["edges"][1]["to"]["entityId"],
        TWO_HOP_ENTITY
    );
    Ok(())
}

#[test]
fn ineligible_intermediate_bridges_do_not_reach_an_otherwise_qualified_entity() -> Result<()> {
    for bridge in [DeniedBridge::Unapproved, DeniedBridge::FutureScope] {
        let fixture = OracleFixture::with_denied_bridge(Some(bridge))?;
        // Unrelated has its own approved, disclosable Revision. Even omitting
        // a denied edge is insufficient if traversal leaks its endpoint node.
        let expected = fixture.expected_response()?;
        let mut reader = fixture.registered_reader()?;
        let response = reader.query_with_deadline(
            &graph_request("nir1-alice"),
            Duration::from_secs(2),
            100_000,
        )?;
        assert_eq!(serde_json::to_value(&response)?, expected, "{bridge:?}");
    }
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
