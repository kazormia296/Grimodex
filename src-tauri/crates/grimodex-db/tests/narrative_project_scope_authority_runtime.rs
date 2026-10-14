//! NIR-0 live project Scope/Order authority behavioral RED.
//!
//! The authority is a computed, project-scoped Source over the live, non-archived
//! `tree_nodes` graph. These journeys deliberately use the real tree writers,
//! canonical Narrative Change Feed, incremental Freshness facade, and restore
//! rebuild facade. No test-only authority table or mutable head is introduced.

use std::path::Path;

use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_scene_scope::{
    self, NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeSceneScopeBindingV1, NarrativeSceneScopeRegistryV1,
    NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1, NarrativeScopePrincipalV1,
    NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
};
use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_db::domain_writes::{
    apply_ai_tree_plan, tree_node_create, tree_node_delete, tree_node_patch, undo_ai_tree_plan,
    AiTreeNodeVersionInput, AiTreePlanCreateInput, AiTreePlanPlacementInput, AiTreePlanUpdateInput,
    ApplyAiTreePlanPayload, TreeNodeCreatePayload, TreeNodeDeletePayload, TreeNodePatchPayload,
    UndoAiTreePlanPayload,
};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    ensure_restore_epochs_for_workspace, ensure_test_schema, read_narrative_scene_scope,
    rebuild_narrative_derived_state_for_project, run_incremental_freshness_cycle,
    write_dependency_declaration_set, DependencyDeclaration, DependencyDeclarationSetRequest,
    IncrementalFreshnessCycleOutcome, RebuildDerivedStateOutcome,
};
use grimodex_db::Database;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};

const PROJECT_ID: &str = "nir0-live-scope-project";
const EPOCH_ID: &str = "nir0-live-scope-epoch";
const RUN_ID: &str = "nir0-live-scope-consumer-run";
const EDGE_ID: &str = "nir0-live-scope-edge";
const SOURCE_IDENTITY: &str = "project:scope-authority:nir0-live-scope-project";
const CREATED_AT: &str = "2026-08-24T00:00:00.000Z";
const UPDATED_AT: &str = "2026-08-24T00:00:01.000Z";

fn digest(value: Value) -> String {
    canonical_json_digest(&value).expect("test oracle projection canonicalizes")
}

fn fixture_scope_registry() -> Value {
    json!({
        "registryVersion": NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
        "timelineRefs": [],
        "worldlineRefs": [],
        "narrativeLayerRefs": [],
    })
}

fn fixture_scope_binding(scene_id: &str) -> Value {
    fixture_scope_binding_at(scene_id, 1, CREATED_AT)
}

/// Independent oracle for a Scene's Scope binding row after `version - 1`
/// refreshes, the last of which happened at `updated_at`.
fn fixture_scope_binding_at(scene_id: &str, version: i64, updated_at: &str) -> Value {
    let query_identity = json!({
        "timeline": {"kind": "unresolved", "reason": "legacy-axis-unknown"},
        "worldline": {"kind": "unresolved", "reason": "legacy-axis-unknown"},
        "narrativeLayer": {"kind": "unresolved", "reason": "legacy-axis-unknown"},
    });
    let material_constraint = json!({
        "timeline": {"kind": "any"},
        "worldline": {"kind": "any"},
        "narrativeLayer": {"kind": "any"},
    });
    let source_token = digest(json!({
        "contractId": "narrative-scene-scope/1",
        "registry": fixture_scope_registry(),
        "projectId": PROJECT_ID,
        "sceneId": scene_id,
        "sceneIncarnationId": format!("legacy:{scene_id}"),
        "compatibilityMarker": "legacy-absent",
        "queryIdentity": query_identity.clone(),
        "materialConstraint": material_constraint.clone(),
        "knowledgeHolder": {"kind": "reader"},
        "audience": {"kind": "reader"},
        "version": version,
        "updatedAt": updated_at,
    }));
    json!({
        "schemaVersion": 1,
        "projectId": PROJECT_ID,
        "sceneId": scene_id,
        "sceneIncarnationId": format!("legacy:{scene_id}"),
        "compatibilityMarker": "legacy-absent",
        "queryIdentity": query_identity,
        "materialConstraint": material_constraint,
        "knowledgeHolder": {"kind": "reader"},
        "audience": {"kind": "reader"},
        "version": version,
        "sourceToken": source_token,
        "updatedAt": updated_at,
    })
}

/// Independent oracle for the Scope extension of the project authority.
///
/// The extension observes the Scope registry and every Scene binding (version,
/// source token, updatedAt included). It deliberately does not observe
/// `tree_nodes.version` or `tree_nodes.updated_at`: ADR009 keeps titles,
/// bodies and display labels, and empty folders and notes, out of the project
/// Scope authority.
fn scope_extended_authority_token(base_revision_token: String, bindings: Value) -> String {
    let registry = fixture_scope_registry();
    let registry_source_token = digest(json!({
        "contractId": NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
        "registry": registry.clone(),
        "version": 1,
    }));
    let extension_digest = digest(json!({
        "contractId": "narrative-scene-scope/1",
        "registry": registry,
        "registryRevision": 1,
        "registrySourceToken": registry_source_token,
        "bindings": bindings,
    }));
    digest(json!({
        "baseRevisionToken": base_revision_token,
        "sceneScopeExtensionDigest": extension_digest,
    }))
}

/// Independent oracle for the fixture's computed project authority.
///
/// This intentionally does not call the production builder/resolver. The
/// membership axis is scene-identity sorted and excludes Reading-position
/// aliases, so reordering the same scenes cannot perturb it. Reading DFS and
/// Story order are sealed in their own projections before the typed aggregate
/// revision domain composes the three digests.
fn baseline_token() -> String {
    let scope_registry_revision = digest(json!({
        "contractId": "narrative-scope-registry-revision/1",
        "projectId": PROJECT_ID,
        "scopeRegistry": {
            "registryVersion": "narrative-scope/2",
            "reservedAudienceRefs": ["reader"]
        },
        "mappings": [
            {
                "sourceKey": "project:scene:scene-a",
                "sceneRef": "scene:scene-a"
            },
            {
                "sourceKey": "project:scene:scene-b",
                "sceneRef": "scene:scene-b"
            }
        ]
    }));
    let reading_order_revision = digest(json!({
        "contractId": "narrative-reading-order-revision/1",
        "projectId": PROJECT_ID,
        "registryVersion": "narrative-scope/2",
        "mappings": [
            {
                "readingOrderRef": "reading:scene-a",
                "sceneRef": "scene:scene-a",
                "readingRank": 0
            },
            {
                "readingOrderRef": "reading:scene-b",
                "sceneRef": "scene:scene-b",
                "readingRank": 1
            }
        ]
    }));
    let story_time_order_revision = digest(json!({
        "contractId": "narrative-story-time-order-revision/1",
        "projectId": PROJECT_ID,
        "registryVersion": "narrative-scope/2",
        "mappings": [
            {
                "storyTimeRef": "story:scene-a",
                "sceneRef": "scene:scene-a",
                "storyTimeOrder": {
                    "status": "resolved",
                    "rawStoryKey": "b0",
                    "storyRank": 1
                }
            },
            {
                "storyTimeRef": "story:scene-b",
                "sceneRef": "scene:scene-b",
                "storyTimeOrder": {
                    "status": "resolved",
                    "rawStoryKey": "a0",
                    "storyRank": 0
                }
            }
        ]
    }));
    let base_revision_token = digest(json!({
        "contractId": "narrative-project-scope-authority-revision/1",
        "projectId": PROJECT_ID,
        "source": {
            "sourceKind": "project-scope-authority",
            "sourceKey": SOURCE_IDENTITY
        },
        "scopeRegistryRevision": scope_registry_revision,
        "readingOrderRevision": reading_order_revision,
        "storyTimeOrderRevision": story_time_order_revision
    }));
    scope_extended_authority_token(
        base_revision_token,
        json!([
            fixture_scope_binding("scene-a"),
            fixture_scope_binding("scene-b")
        ]),
    )
}

fn empty_project_token() -> String {
    let scope_registry_revision = digest(json!({
        "contractId": "narrative-scope-registry-revision/1",
        "projectId": PROJECT_ID,
        "scopeRegistry": {
            "registryVersion": "narrative-scope/2",
            "reservedAudienceRefs": ["reader"]
        },
        "mappings": []
    }));
    let reading_order_revision = digest(json!({
        "contractId": "narrative-reading-order-revision/1",
        "projectId": PROJECT_ID,
        "registryVersion": "narrative-scope/2",
        "mappings": []
    }));
    let story_time_order_revision = digest(json!({
        "contractId": "narrative-story-time-order-revision/1",
        "projectId": PROJECT_ID,
        "registryVersion": "narrative-scope/2",
        "mappings": []
    }));
    let base_revision_token = digest(json!({
        "contractId": "narrative-project-scope-authority-revision/1",
        "projectId": PROJECT_ID,
        "source": {
            "sourceKind": "project-scope-authority",
            "sourceKey": SOURCE_IDENTITY
        },
        "scopeRegistryRevision": scope_registry_revision,
        "readingOrderRevision": reading_order_revision,
        "storyTimeOrderRevision": story_time_order_revision
    }));
    scope_extended_authority_token(base_revision_token, json!([]))
}

fn seed_scope_bindings(conn: &Connection) -> anyhow::Result<()> {
    let registry = NarrativeSceneScopeRegistryV1 {
        registry_version: NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID.to_owned(),
        timeline_refs: Vec::new(),
        worldline_refs: Vec::new(),
        narrative_layer_refs: Vec::new(),
    };
    for scene_id in ["scene-a", "scene-b"] {
        let mut binding = NarrativeSceneScopeBindingV1 {
            schema_version: 1,
            project_id: PROJECT_ID.to_owned(),
            scene_id: scene_id.to_owned(),
            scene_incarnation_id: format!("legacy:{scene_id}"),
            compatibility_marker: NarrativeScopeCompatibilityMarkerV1::LegacyAbsent,
            query_identity: NarrativeSceneQueryIdentityV1 {
                timeline: NarrativeScopeConstraintV1::Unresolved {
                    reason: "legacy-axis-unknown".to_owned(),
                },
                worldline: NarrativeScopeConstraintV1::Unresolved {
                    reason: "legacy-axis-unknown".to_owned(),
                },
                narrative_layer: NarrativeScopeConstraintV1::Unresolved {
                    reason: "legacy-axis-unknown".to_owned(),
                },
            },
            material_constraint: NarrativeSceneMaterialConstraintV1 {
                timeline: NarrativeScopeConstraintV1::Any,
                worldline: NarrativeScopeConstraintV1::Any,
                narrative_layer: NarrativeScopeConstraintV1::Any,
            },
            knowledge_holder: NarrativeScopePrincipalV1::Reader {},
            audience: NarrativeScopePrincipalV1::Reader {},
            version: 1,
            source_token: "pending".to_owned(),
            updated_at: CREATED_AT.to_owned(),
        };
        binding.source_token = narrative_scene_scope::source_token(&registry, &binding)?;
        conn.execute(
            "INSERT INTO narrative_scene_scope_bindings
                (project_id, scene_id, scene_incarnation_id, compatibility_marker,
                 query_identity_json, material_constraint_json, knowledge_holder_json,
                 audience_json, version, source_token, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                binding.project_id,
                binding.scene_id,
                binding.scene_incarnation_id,
                serde_json::to_value(binding.compatibility_marker)?
                    .as_str()
                    .unwrap_or_default(),
                serde_json::to_string(&binding.query_identity)?,
                serde_json::to_string(&binding.material_constraint)?,
                serde_json::to_string(&binding.knowledge_holder)?,
                serde_json::to_string(&binding.audience)?,
                binding.version,
                binding.source_token,
                binding.updated_at,
            ],
        )?;
    }
    Ok(())
}

fn fixture_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'NIR-0 live Scope authority')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', ?3)",
            params![EPOCH_ID, PROJECT_ID, CREATED_AT],
        )?;
        conn.execute_batch(
            r#"INSERT INTO tree_nodes
                (id, project_id, parent_id, node_type, title, sort_order,
                 story_time_order, content, version, created_at, updated_at)
             VALUES
                ('folder-a', 'nir0-live-scope-project', NULL, 'folder', 'A', 'a0',
                 NULL, '{}', 0, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'),
                ('folder-b', 'nir0-live-scope-project', NULL, 'folder', 'B', 'b0',
                 NULL, '{}', 0, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'),
                ('scene-a', 'nir0-live-scope-project', 'folder-a', 'scene', 'Scene A', 'a0',
                 'b0', '{"type":"doc","content":[]}', 0,
                 '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'),
                ('scene-b', 'nir0-live-scope-project', 'folder-a', 'scene', 'Scene B', 'b0',
                 'a0', '{"type":"doc","content":[]}', 0,
                 '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z');"#,
        )?;
        let registry = json!({
            "registryVersion": NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
            "timelineRefs": [],
            "worldlineRefs": [],
            "narrativeLayerRefs": [],
        });
        conn.execute(
            "INSERT INTO narrative_scope_registries
                (project_id, registry_version, timeline_refs_json, worldline_refs_json,
                 narrative_layer_refs_json, version, source_token, updated_at)
             VALUES (?1, ?2, '[]', '[]', '[]', 1, ?3, ?4)",
            params![
                PROJECT_ID,
                NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
                digest(json!({
                    "contractId": NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
                    "registry": registry,
                    "version": 1,
                })),
                CREATED_AT,
            ],
        )?;
        seed_scope_bindings(conn)?;
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, run_kind, semantic_epoch_id)
             VALUES (?1, ?2, 'chronicle.extract', '{}', '{}', 'sha256:scope-consumer',
                     'completed', '{}', ?3, ?3, 'interpretation', ?4)",
            params![RUN_ID, PROJECT_ID, CREATED_AT, EPOCH_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, generated_by_transaction_id, created_at, owning_run_id)
             VALUES (?1, ?2, 'narrative-extraction-run', ?3, ?4, ?5, NULL, ?6, ?3)",
            params![
                EDGE_ID,
                PROJECT_ID,
                RUN_ID,
                SOURCE_IDENTITY,
                json!([baseline_token()]).to_string(),
                CREATED_AT,
            ],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed live Scope authority fixture");
    db
}

fn patch_payload(case: &str, node_id: &str, field: &str, value: Value) -> TreeNodePatchPayload {
    let mut patch = Map::new();
    patch.insert(field.to_owned(), value);
    TreeNodePatchPayload {
        project_id: PROJECT_ID.to_owned(),
        request_id: format!("scope-{case}-request"),
        session_id: "scope-authority-session".to_owned(),
        event_uid: format!("scope-{case}-event"),
        node_id: node_id.to_owned(),
        patch,
        base_version: None,
        bump_version: false,
        updated_at: UPDATED_AT.to_owned(),
        change_event: None,
        timelapse_doc_step_coverage: None,
        origin: NarrativeChangeOrigin::Human,
        original_transaction_id: None,
        undo_journal_id: None,
        source_domain: None,
        op_type: None,
        canonical_payload: None,
    }
}

fn create_scene(db: &Database, case: &str) {
    tree_node_create(
        db,
        TreeNodeCreatePayload {
            id: "scene-created".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            request_id: format!("scope-{case}-request"),
            session_id: "scope-authority-session".to_owned(),
            event_uid: format!("scope-{case}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: Some("folder-b".to_owned()),
            node_type: "scene".to_owned(),
            title: "Created".to_owned(),
            sort_order: "a0".to_owned(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: Some("{}".to_owned()),
            canonical_payload: None,
        },
    )
    .expect("create scene through the real tree writer");
}

fn delete_scene(db: &Database, case: &str) {
    tree_node_delete(
        db,
        TreeNodeDeletePayload {
            project_id: PROJECT_ID.to_owned(),
            request_id: format!("scope-{case}-request"),
            session_id: "scope-authority-session".to_owned(),
            event_uid: format!("scope-{case}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            node_id: "scene-b".to_owned(),
            canonical_payload: None,
        },
    )
    .expect("delete scene through the real tree writer");
}

fn run_cycle(db: &Database) -> grimodex_db::narrative_extraction::IncrementalFreshnessBatchSummary {
    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(db).expect("process the real tree Feed event")
    else {
        panic!("a real tree writer must leave a pending Feed range");
    };
    summary
}

fn edge_state(db: &Database) -> Option<(String, Option<String>, String)> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT evidence_freshness, reason_code, build_action
               FROM narrative_dependency_edge_states WHERE edge_id = ?1",
            [EDGE_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(Into::into)
    })
    .expect("read aggregate Edge state")
}

#[derive(Clone, Copy, Debug)]
enum AuthorityMutation {
    SortOrder,
    Parent,
    StoryTimeOrder,
    Create,
    Delete,
}

impl AuthorityMutation {
    fn name(self) -> &'static str {
        match self {
            Self::SortOrder => "sort-order",
            Self::Parent => "parent",
            Self::StoryTimeOrder => "story-time-order",
            Self::Create => "create",
            Self::Delete => "delete",
        }
    }

    fn apply(self, db: &Database) {
        match self {
            Self::SortOrder => {
                tree_node_patch(
                    db,
                    patch_payload(self.name(), "scene-a", "sortOrder", json!("z0")),
                )
                .expect("patch persisted Reading order");
            }
            Self::Parent => {
                tree_node_patch(
                    db,
                    patch_payload(self.name(), "scene-a", "parentId", json!("folder-b")),
                )
                .expect("patch persisted Reading parent");
            }
            Self::StoryTimeOrder => {
                tree_node_patch(
                    db,
                    patch_payload(self.name(), "scene-a", "storyTimeOrder", json!("z0")),
                )
                .expect("patch persisted Story order");
            }
            Self::Create => create_scene(db, self.name()),
            Self::Delete => delete_scene(db, self.name()),
        }
    }
}

#[test]
fn real_tree_scope_and_order_mutations_reach_the_project_aggregate_edge() {
    for mutation in [
        AuthorityMutation::SortOrder,
        AuthorityMutation::Parent,
        AuthorityMutation::StoryTimeOrder,
        AuthorityMutation::Create,
        AuthorityMutation::Delete,
    ] {
        let db = fixture_db();
        mutation.apply(&db);

        let summary = run_cycle(&db);
        assert_eq!(
            summary.affected_edge_count,
            1,
            "{} must project to the project Scope/Order Source",
            mutation.name()
        );
        assert_eq!(summary.affected_consumer_count, 1, "{}", mutation.name());
        assert_eq!(
            edge_state(&db),
            Some((
                "stale".to_owned(),
                Some("source-revision-changed".to_owned()),
                "rebuild-required".to_owned(),
            )),
            "{} must re-resolve the computed aggregate token",
            mutation.name()
        );
    }
}

#[test]
fn real_folder_reorder_reaches_the_project_aggregate_edge_through_typed_feed_metadata() {
    let db = fixture_db();
    db.with_conn(|conn| {
        // Establish two populated root folders without creating a Feed event.
        // The baseline Scene order remains A then B, so the independently
        // sealed Edge token is still current before the real writer runs.
        conn.execute(
            "UPDATE tree_nodes SET parent_id = 'folder-b' WHERE id = 'scene-b'",
            [],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("split the baseline scenes across root folders");

    tree_node_patch(
        &db,
        patch_payload("folder-reorder", "folder-b", "sortOrder", json!("Z0")),
    )
    .expect("reorder a populated folder through the real tree writer");

    let summary = run_cycle(&db);
    assert_eq!(summary.affected_edge_count, 1);
    assert_eq!(summary.affected_consumer_count, 1);
    assert_eq!(
        edge_state(&db),
        Some((
            "stale".to_owned(),
            Some("source-revision-changed".to_owned()),
            "rebuild-required".to_owned(),
        ))
    );
}

#[test]
fn empty_folder_structural_changes_do_not_false_stale_the_project_aggregate_edge() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, parent_id, node_type, title, sort_order,
                 content, version, created_at, updated_at)
             VALUES ('folder-empty', ?1, NULL, 'folder', 'Empty', 'c0',
                     '{}', 0, ?2, ?2)",
            params![PROJECT_ID, CREATED_AT],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed an empty Folder without changing the baseline authority");

    tree_node_patch(
        &db,
        patch_payload(
            "reorder-empty-folder",
            "folder-empty",
            "sortOrder",
            json!("z0"),
        ),
    )
    .expect("reorder an empty Folder through the real tree writer");
    let reordered = run_cycle(&db);
    assert_eq!(reordered.affected_edge_count, 0);
    assert_eq!(reordered.affected_consumer_count, 0);
    assert_eq!(edge_state(&db), None);

    tree_node_patch(
        &db,
        patch_payload(
            "archive-empty-folder",
            "folder-empty",
            "archivedAt",
            json!(UPDATED_AT),
        ),
    )
    .expect("archive an empty Folder through the real tree writer");
    let archived = run_cycle(&db);
    assert_eq!(archived.affected_edge_count, 0);
    assert_eq!(archived.affected_consumer_count, 0);
    assert_eq!(edge_state(&db), None);
}

/// X1-1 boundary. A Scene patch still refreshes that Scene's own Scope binding
/// for any field, so these patches still move the project token through the
/// binding generation (no longer through the tree's version/updatedAt). Narrowing
/// that refresh to the Scope-relevant fields is X1-2 and waits for confirmation;
/// the negative cases below show what X1-1 already stopped doing.
#[test]
fn body_and_display_metadata_invalidate_the_project_aggregate_edge_generation() {
    for (case, field, value) in [
        ("title", "title", json!("Renamed only")),
        (
            "content",
            "content",
            json!(r#"{"type":"doc","content":[{"type":"paragraph"}]}"#),
        ),
        (
            "story-time-label",
            "storyTimeLabel",
            json!("Display label only"),
        ),
    ] {
        let db = fixture_db();
        tree_node_patch(&db, patch_payload(case, "scene-a", field, value))
            .expect("patch a non-authority field through the real tree writer");

        let summary = run_cycle(&db);
        assert_eq!(summary.affected_edge_count, 1, "{field}");
        assert_eq!(summary.affected_consumer_count, 1, "{field}");
        assert_eq!(
            edge_state(&db),
            Some((
                "stale".to_owned(),
                Some("source-revision-changed".to_owned()),
                "rebuild-required".to_owned(),
            )),
            "{field} still refreshes the Scene's Scope binding generation"
        );
    }
}

fn seed_v2_scope_head(db: &Database) {
    write_dependency_declaration_set(
        db,
        DependencyDeclarationSetRequest {
            project_id: PROJECT_ID.to_owned(),
            consumer_kind: "proposal-revision".to_owned(),
            consumer_key: "nir0-live-scope-proposal-revision".to_owned(),
            producer_id: "proposal-revision-source-basis".to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![DependencyDeclaration {
                source_object_identity: SOURCE_IDENTITY.to_owned(),
                role: DependencyRole::ScopeResolution,
                selector: DependencySelector::WholeSource,
            }],
            created_at: CREATED_AT.to_owned(),
        },
    )
    .expect("seal a whole-Source declaration for the project aggregate");
}

#[test]
fn aggregate_create_and_delete_are_content_changes_not_scene_incarnation_or_missing() {
    for mutation in [AuthorityMutation::Create, AuthorityMutation::Delete] {
        let db = fixture_db();
        seed_v2_scope_head(&db);
        mutation.apply(&db);

        let summary = run_cycle(&db);
        assert_eq!(
            summary.v2_shadow.active_head_count,
            1,
            "{}",
            mutation.name()
        );
        assert_eq!(
            summary.v2_shadow.evaluated_declaration_count,
            1,
            "{}",
            mutation.name()
        );
        let consumer = &summary.v2_shadow.consumers[0];
        assert_eq!(
            consumer.freshness,
            "stale",
            "{} must be source-content-changed, never source-missing",
            mutation.name()
        );
        assert_eq!(
            consumer.required_actions,
            vec!["resolve-only"],
            "ScopeResolution + source-content-changed must keep its typed effect"
        );
        assert_eq!(
            edge_state(&db),
            Some((
                "stale".to_owned(),
                Some("source-revision-changed".to_owned()),
                "rebuild-required".to_owned(),
            )),
            "the project aggregate keeps one incarnation across {}",
            mutation.name()
        );
    }
}

#[test]
fn empty_project_rebuild_resolves_the_exact_empty_authority() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute("DELETE FROM tree_nodes WHERE project_id = ?1", [PROJECT_ID])?;
        conn.execute(
            "UPDATE narrative_dependency_edges SET read_set_json = ?1 WHERE id = ?2",
            params![json!([empty_project_token()]).to_string(), EDGE_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("install an empty live project with its independent held token");

    let RebuildDerivedStateOutcome::Ran { summary, .. } =
        rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
            .expect("resolve the empty live project authority")
    else {
        panic!("the empty-project rebuild must run");
    };
    assert_eq!(summary.consumers_evaluated, 1);
    assert_eq!(summary.edges_evaluated, 1);
    assert_eq!(
        edge_state(&db),
        Some(("fresh".to_owned(), None, "none".to_owned())),
        "zero live Scenes still form a stable typed authority"
    );
}

#[test]
fn corrupt_live_tree_cycle_fails_closed_with_stable_error() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET parent_id = 'folder-b' WHERE id = 'folder-a'",
            [],
        )?;
        conn.execute(
            "UPDATE tree_nodes SET parent_id = 'folder-a' WHERE id = 'folder-b'",
            [],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("install a durable parent cycle");

    let error = rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
        .expect_err("a cyclic live tree must not mint an authority token");
    assert_eq!(
        error.to_string(),
        "NEX_PROJECT_SCOPE_AUTHORITY_TREE_INVALID: active tree contains a parent cycle"
    );
    assert_eq!(edge_state(&db), None, "failed resolution must not publish");
}

#[test]
fn project_scope_source_key_must_match_edge_project_exactly() {
    for (source_identity, expected_error) in [
        (
            "project:scope-authority:foreign-project",
            "NEX_SOURCE_PROJECT_MISMATCH: project Scope authority does not belong to project",
        ),
        (
            "project:scope-authority:",
            "NEX_SOURCE_KEY_INVALID: project-scope-authority sourceKey must be project:scope-authority:<projectId>",
        ),
    ] {
        let db = fixture_db();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('foreign-project', 'Foreign')",
                [],
            )?;
            conn.execute(
                "UPDATE narrative_dependency_edges
                    SET source_object_identity = ?1 WHERE id = ?2",
                params![source_identity, EDGE_ID],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("install the mismatched aggregate Source identity");

        let error = rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
            .expect_err("the aggregate Source identity must fail closed");
        assert_eq!(error.to_string(), expected_error, "{source_identity}");
        assert_eq!(edge_state(&db), None, "{source_identity}");
    }
}

#[test]
fn archive_then_unarchive_populated_folder_does_not_restore_the_old_generation() {
    let db = fixture_db();

    tree_node_patch(
        &db,
        patch_payload(
            "archive-folder",
            "folder-a",
            "archivedAt",
            json!(UPDATED_AT),
        ),
    )
    .expect("archive a populated Folder through the real tree writer");
    let archived = run_cycle(&db);
    assert_eq!(archived.affected_edge_count, 1);
    assert_eq!(archived.affected_consumer_count, 1);
    assert_eq!(
        edge_state(&db),
        Some((
            "stale".to_owned(),
            Some("source-revision-changed".to_owned()),
            "rebuild-required".to_owned(),
        )),
        "archiving cuts the populated Folder subtree from the live aggregate token"
    );

    tree_node_patch(
        &db,
        patch_payload("unarchive-folder", "folder-a", "archivedAt", Value::Null),
    )
    .expect("unarchive the populated Folder through the real tree writer");
    let unarchived = run_cycle(&db);
    assert_eq!(unarchived.affected_edge_count, 1);
    assert_eq!(unarchived.affected_consumer_count, 1);
    assert_eq!(
        edge_state(&db),
        Some((
            "stale".to_owned(),
            Some("source-revision-changed".to_owned()),
            "rebuild-required".to_owned(),
        )),
        "unarchiving restores the subtree but not the old Native generation"
    );
}

#[test]
fn unchanged_tree_rebuild_resolves_the_independent_baseline_as_fresh() {
    let db = fixture_db();

    let RebuildDerivedStateOutcome::Ran { summary, .. } =
        rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
            .expect("rebuild the unchanged live authority")
    else {
        panic!("the first baseline rebuild must run");
    };
    assert_eq!(summary.consumers_evaluated, 1);
    assert_eq!(summary.edges_evaluated, 1);
    assert_eq!(
        edge_state(&db),
        Some(("fresh".to_owned(), None, "none".to_owned())),
        "the resolver must equal the independently computed axis-composite token",
    );
}

#[test]
fn restore_rebuild_rederives_the_live_project_aggregate_token() {
    let db = fixture_db();

    // Model the tree image installed by restore without manufacturing a
    // mutation-local Feed event. The restore marker/epoch rotation and the
    // derived rebuild are the production seams under test.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET sort_order = 'restored-z0'
              WHERE id = 'scene-a' AND project_id = ?1",
            [PROJECT_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("install restored tree ordering");
    ensure_restore_epochs_for_workspace(&db, "restore-image-sha256:nir0-live-scope")
        .expect("rotate the restore Semantic Epoch");

    // The fixture Consumer stands for a declaration produced in the restored
    // current Epoch. Its held token is deliberately the pre-restore basis.
    db.with_conn(|conn| {
        let current_epoch: String = conn.query_row(
            "SELECT id FROM narrative_semantic_epochs
              WHERE project_id = ?1 ORDER BY epoch_number DESC LIMIT 1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        conn.execute(
            "UPDATE narrative_extraction_runs SET semantic_epoch_id = ?1 WHERE id = ?2",
            params![current_epoch, RUN_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("bind the restored Consumer fixture to the current Epoch");

    let RebuildDerivedStateOutcome::Ran { summary, .. } =
        rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
            .expect("rebuild from the restored live authority")
    else {
        panic!("the first restored rebuild must run");
    };
    assert_eq!(summary.consumers_evaluated, 1);
    assert_eq!(summary.edges_evaluated, 1);
    assert_eq!(
        edge_state(&db),
        Some((
            "stale".to_owned(),
            Some("source-revision-changed".to_owned()),
            "rebuild-required".to_owned(),
        )),
        "rebuild must resolve the token from restored tree_nodes, not retain the old basis",
    );
}

// ---------------------------------------------------------------------------
// X1-1: the project token no longer observes `tree_nodes.version`/`updated_at`.
// A change to a folder's placement advances the Scope generation of the live
// Scenes below it instead, and empty folders and notes never move the token.
// ---------------------------------------------------------------------------

const INITIAL_READING_ORDER: [(&str, &str); 2] = [("scene-a", "b0"), ("scene-b", "a0")];

/// Independent oracle for any arrangement of the fixture's Scenes.
///
/// `reading_order` lists the live Scenes as `(sceneId, rawStoryKey)` in
/// persisted Reading DFS order. `bindings` are the Scope binding rows of every
/// Scene, live or not, ordered by Scene id.
fn live_authority_token(reading_order: &[(&str, &str)], bindings: Value) -> String {
    scope_extended_authority_token(live_base_revision_token(reading_order), bindings)
}

/// The base projection (Scene membership, Reading DFS order, Story keys) that
/// X1-1 leaves untouched. Every key is unique in these journeys, so each Scene
/// is `resolved` with its rank among the sorted keys.
fn live_base_revision_token(reading_order: &[(&str, &str)]) -> String {
    let mut by_scene = reading_order.to_vec();
    by_scene.sort_by(|left, right| left.0.cmp(right.0));
    let mut story_keys = reading_order
        .iter()
        .map(|(_, key)| *key)
        .collect::<Vec<_>>();
    story_keys.sort_unstable();
    let scope_registry_revision = digest(json!({
        "contractId": "narrative-scope-registry-revision/1",
        "projectId": PROJECT_ID,
        "scopeRegistry": {
            "registryVersion": "narrative-scope/2",
            "reservedAudienceRefs": ["reader"]
        },
        "mappings": by_scene
            .iter()
            .map(|(scene_id, _)| json!({
                "sourceKey": format!("project:scene:{scene_id}"),
                "sceneRef": format!("scene:{scene_id}"),
            }))
            .collect::<Vec<_>>(),
    }));
    let reading_order_revision = digest(json!({
        "contractId": "narrative-reading-order-revision/1",
        "projectId": PROJECT_ID,
        "registryVersion": "narrative-scope/2",
        "mappings": reading_order
            .iter()
            .enumerate()
            .map(|(rank, (scene_id, _))| json!({
                "readingOrderRef": format!("reading:{scene_id}"),
                "sceneRef": format!("scene:{scene_id}"),
                "readingRank": rank,
            }))
            .collect::<Vec<_>>(),
    }));
    let story_time_order_revision = digest(json!({
        "contractId": "narrative-story-time-order-revision/1",
        "projectId": PROJECT_ID,
        "registryVersion": "narrative-scope/2",
        "mappings": by_scene
            .iter()
            .map(|(scene_id, key)| json!({
                "storyTimeRef": format!("story:{scene_id}"),
                "sceneRef": format!("scene:{scene_id}"),
                "storyTimeOrder": {
                    "status": "resolved",
                    "rawStoryKey": key,
                    "storyRank": story_keys.iter().position(|candidate| candidate == key),
                },
            }))
            .collect::<Vec<_>>(),
    }));
    digest(json!({
        "contractId": "narrative-project-scope-authority-revision/1",
        "projectId": PROJECT_ID,
        "source": {
            "sourceKind": "project-scope-authority",
            "sourceKey": SOURCE_IDENTITY
        },
        "scopeRegistryRevision": scope_registry_revision,
        "readingOrderRevision": reading_order_revision,
        "storyTimeOrderRevision": story_time_order_revision
    }))
}

/// Scope binding rows of the two fixture Scenes at the given
/// `(version, updatedAt)`, ordered by Scene id.
fn both_scene_bindings(scene_a: (i64, &str), scene_b: (i64, &str)) -> Value {
    json!([
        fixture_scope_binding_at("scene-a", scene_a.0, scene_a.1),
        fixture_scope_binding_at("scene-b", scene_b.0, scene_b.1),
    ])
}

fn scene_scope_version(db: &Database, scene_id: &str) -> i64 {
    db.with_conn(|conn| {
        Ok::<_, anyhow::Error>(
            read_narrative_scene_scope(conn, PROJECT_ID, scene_id)?
                .binding
                .version,
        )
    })
    .expect("read the Scene Scope binding through the public reader")
}

fn stale_edge_state() -> Option<(String, Option<String>, String)> {
    Some((
        "stale".to_owned(),
        Some("source-revision-changed".to_owned()),
        "rebuild-required".to_owned(),
    ))
}

/// Install `expected` as the held token and let the production rebuild resolve
/// the live project authority against it. A `fresh` Edge means the live token
/// is exactly `expected`.
fn assert_live_token_is(db: &Database, expected: String, context: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_dependency_edges SET read_set_json = ?1 WHERE id = ?2",
            params![json!([expected]).to_string(), EDGE_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("install the independently computed token as the held token");
    let RebuildDerivedStateOutcome::Ran { summary, .. } =
        rebuild_narrative_derived_state_for_project(db, PROJECT_ID)
            .expect("resolve the live project authority")
    else {
        panic!("{context}: the rebuild must run");
    };
    assert_eq!(summary.edges_evaluated, 1, "{context}");
    assert_eq!(
        edge_state(db),
        Some(("fresh".to_owned(), None, "none".to_owned())),
        "{context}: the live token must equal the independent oracle"
    );
}

#[test]
fn the_generalized_oracle_reproduces_the_hardcoded_baselines() {
    assert_eq!(
        live_authority_token(
            &INITIAL_READING_ORDER,
            both_scene_bindings((1, CREATED_AT), (1, CREATED_AT)),
        ),
        baseline_token()
    );
    assert_eq!(live_authority_token(&[], json!([])), empty_project_token());
}

/// The project token exactly as the pre-X1-1 resolver minted it: the extension
/// digest also folded in the version and updatedAt of every tree node.
fn pre_x1_1_baseline_token() -> String {
    let tree_node = |id: &str, parent: Value, node_type: &str, sort: &str, story: Value| {
        json!({
            "id": id,
            "parentId": parent,
            "nodeType": node_type,
            "sortOrder": sort,
            "storyTimeOrder": story,
            "archivedAt": null,
            "version": 0,
            "updatedAt": CREATED_AT,
        })
    };
    let tree_source_generation = digest(json!({
        "contractId": "narrative-tree-source-generation/1",
        "projectId": PROJECT_ID,
        "nodes": [
            tree_node("folder-a", Value::Null, "folder", "a0", Value::Null),
            tree_node("folder-b", Value::Null, "folder", "b0", Value::Null),
            tree_node("scene-a", json!("folder-a"), "scene", "a0", json!("b0")),
            tree_node("scene-b", json!("folder-a"), "scene", "b0", json!("a0")),
        ],
    }));
    let registry = fixture_scope_registry();
    let registry_source_token = digest(json!({
        "contractId": NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
        "registry": registry.clone(),
        "version": 1,
    }));
    let extension_digest = digest(json!({
        "contractId": "narrative-scene-scope/1",
        "registry": registry,
        "registryRevision": 1,
        "registrySourceToken": registry_source_token,
        "treeSourceGeneration": tree_source_generation,
        "bindings": both_scene_bindings((1, CREATED_AT), (1, CREATED_AT)),
    }));
    digest(json!({
        "baseRevisionToken": live_base_revision_token(&INITIAL_READING_ORDER),
        "sceneScopeExtensionDigest": extension_digest,
    }))
}

/// X1-1 changes the token expression on purpose, so everything sealed against a
/// pre-X1-1 token is stale exactly once. It must resolve as an ordinary stale
/// Source (the existing rebuild and re-approval path): neither a resolver error
/// nor a silent match, and no stored row is rewritten.
#[test]
fn a_token_sealed_before_x1_1_resolves_as_stale_through_the_existing_rebuild_path() {
    let db = fixture_db();
    let sealed = pre_x1_1_baseline_token();
    assert_ne!(
        sealed,
        baseline_token(),
        "the token expression really changed"
    );
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_dependency_edges SET read_set_json = ?1 WHERE id = ?2",
            params![json!([sealed]).to_string(), EDGE_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("hold a token sealed before X1-1");

    let RebuildDerivedStateOutcome::Ran { summary, .. } =
        rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
            .expect("re-resolve the live project authority")
    else {
        panic!("the rebuild must run");
    };
    assert_eq!(summary.edges_evaluated, 1);
    assert_eq!(edge_state(&db), stale_edge_state());
    let held: String = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT read_set_json FROM narrative_dependency_edges WHERE id = ?1",
                [EDGE_ID],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })
        .expect("read the held token");
    assert_eq!(
        held,
        json!([pre_x1_1_baseline_token()]).to_string(),
        "the sealed row is read, never rewritten"
    );
}

#[derive(Clone, Copy, Debug)]
enum FolderPlacementChange {
    Reorder,
    Reparent,
    Archive,
}

impl FolderPlacementChange {
    fn name(self) -> &'static str {
        match self {
            Self::Reorder => "reorder",
            Self::Reparent => "reparent",
            Self::Archive => "archive",
        }
    }

    /// Reading order of the live Scenes once the change is applied. Folder B
    /// holds no Scene, so moving Folder A past it or nesting it inside it never
    /// reorders a Scene; archiving cuts both Scenes out of the live tree.
    fn live_reading_after_change(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Reorder | Self::Reparent => &INITIAL_READING_ORDER,
            Self::Archive => &[],
        }
    }

    fn apply(self, db: &Database) {
        let (field, value) = match self {
            Self::Reorder => ("sortOrder", json!("c0")),
            Self::Reparent => ("parentId", json!("folder-b")),
            Self::Archive => ("archivedAt", json!(UPDATED_AT)),
        };
        tree_node_patch(
            db,
            patch_payload(
                &format!("{}-forward", self.name()),
                "folder-a",
                field,
                value,
            ),
        )
        .expect("change the populated Folder through the real tree writer");
    }

    fn revert(self, db: &Database) {
        let (field, value) = match self {
            Self::Reorder => ("sortOrder", json!("a0")),
            Self::Reparent => ("parentId", Value::Null),
            Self::Archive => ("archivedAt", Value::Null),
        };
        tree_node_patch(
            db,
            patch_payload(&format!("{}-revert", self.name()), "folder-a", field, value),
        )
        .expect("restore the populated Folder through the real tree writer");
    }
}

#[test]
fn folder_placement_changes_advance_the_scope_generation_of_the_live_scenes_below() {
    for change in [
        FolderPlacementChange::Reorder,
        FolderPlacementChange::Reparent,
        FolderPlacementChange::Archive,
    ] {
        let db = fixture_db();
        let name = change.name();

        change.apply(&db);
        assert_eq!(scene_scope_version(&db, "scene-a"), 2, "{name}");
        assert_eq!(scene_scope_version(&db, "scene-b"), 2, "{name}");
        let applied = run_cycle(&db);
        assert_eq!(applied.affected_edge_count, 1, "{name}");
        assert_eq!(applied.affected_consumer_count, 1, "{name}");
        assert_eq!(edge_state(&db), stale_edge_state(), "{name}");

        // Putting the Folder back restores the Scene order and the persisted
        // placement, but the Scenes keep their advanced generations, so the
        // project token must not return to the value the Edge still holds.
        change.revert(&db);
        assert_eq!(scene_scope_version(&db, "scene-a"), 3, "{name} revert");
        assert_eq!(scene_scope_version(&db, "scene-b"), 3, "{name} revert");
        let reverted = run_cycle(&db);
        assert_eq!(reverted.affected_edge_count, 1, "{name} revert");
        assert_eq!(edge_state(&db), stale_edge_state(), "{name} revert");

        let after_round_trip = live_authority_token(
            &INITIAL_READING_ORDER,
            both_scene_bindings((3, UPDATED_AT), (3, UPDATED_AT)),
        );
        assert_live_token_is(&db, after_round_trip, &format!("{name} round trip"));
    }
}

#[test]
fn folder_placement_change_moves_the_token_by_the_advanced_generations_alone() {
    // The persisted Reading order of the Scenes is unchanged by Reorder and
    // Reparent (and empty after Archive), so the expected token pins exactly
    // the base projection plus the two advanced Scope bindings.
    for change in [
        FolderPlacementChange::Reorder,
        FolderPlacementChange::Reparent,
        FolderPlacementChange::Archive,
    ] {
        let db = fixture_db();
        change.apply(&db);
        run_cycle(&db);
        assert_live_token_is(
            &db,
            live_authority_token(
                change.live_reading_after_change(),
                both_scene_bindings((2, UPDATED_AT), (2, UPDATED_AT)),
            ),
            change.name(),
        );
    }
}

#[test]
fn folder_reorder_refreshes_only_the_scenes_below_the_moved_folder() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET parent_id = 'folder-b' WHERE id = 'scene-b'",
            [],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("split the baseline scenes across root folders");

    tree_node_patch(
        &db,
        patch_payload("folder-b-first", "folder-b", "sortOrder", json!("Z0")),
    )
    .expect("reorder only the Folder that holds Scene B");

    assert_eq!(
        scene_scope_version(&db, "scene-a"),
        1,
        "Scene A sits in the untouched Folder"
    );
    assert_eq!(
        scene_scope_version(&db, "scene-b"),
        2,
        "Scene B sits below the moved Folder"
    );
    run_cycle(&db);
    assert_live_token_is(
        &db,
        live_authority_token(
            &[("scene-b", "a0"), ("scene-a", "b0")],
            both_scene_bindings((1, CREATED_AT), (2, UPDATED_AT)),
        ),
        "only the moved Folder's Scene advances",
    );
}

#[test]
fn a_folder_patch_that_leaves_its_placement_unchanged_advances_no_generation() {
    let db = fixture_db();
    tree_node_patch(
        &db,
        patch_payload(
            "folder-same-sort-order",
            "folder-a",
            "sortOrder",
            json!("a0"),
        ),
    )
    .expect("patch a Folder with the placement it already has");

    assert_eq!(scene_scope_version(&db, "scene-a"), 1);
    assert_eq!(scene_scope_version(&db, "scene-b"), 1);
    run_cycle(&db);
    assert_live_token_is(
        &db,
        baseline_token(),
        "a no-op placement patch must not move the project token",
    );
}

#[test]
fn renaming_a_populated_folder_or_editing_its_synopsis_advances_no_generation() {
    let db = fixture_db();
    for (case, field, value) in [
        (
            "rename-populated-folder",
            "title",
            json!("Renamed populated folder"),
        ),
        (
            "populated-folder-synopsis",
            "synopsis",
            json!("A new synopsis"),
        ),
    ] {
        tree_node_patch(&db, patch_payload(case, "folder-a", field, value))
            .expect("patch a non-placement field of the populated Folder");
        assert_eq!(scene_scope_version(&db, "scene-a"), 1, "{case}");
        assert_eq!(scene_scope_version(&db, "scene-b"), 1, "{case}");
        assert_feed_leaves_the_project_scope_untouched(&db, case);
    }
    assert_live_token_is(
        &db,
        baseline_token(),
        "renaming a populated Folder must not move the project token",
    );
}

fn create_node(
    db: &Database,
    case: &str,
    id: &str,
    parent_id: Option<&str>,
    node_type: &str,
    sort_order: &str,
) {
    tree_node_create(
        db,
        TreeNodeCreatePayload {
            id: id.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            request_id: format!("scope-{case}-request"),
            session_id: "scope-authority-session".to_owned(),
            event_uid: format!("scope-{case}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: parent_id.map(str::to_owned),
            node_type: node_type.to_owned(),
            title: id.to_owned(),
            sort_order: sort_order.to_owned(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: Some("{}".to_owned()),
            canonical_payload: None,
        },
    )
    .expect("create a node through the real tree writer");
}

fn assert_feed_leaves_the_project_scope_untouched(db: &Database, step: &str) {
    let summary = run_cycle(db);
    assert_eq!(
        summary.affected_edge_count, 0,
        "{step}: no Edge may become pending"
    );
    assert_eq!(summary.affected_consumer_count, 0, "{step}");
    assert_eq!(edge_state(db), None, "{step}");
}

#[test]
fn empty_folders_and_notes_never_move_the_project_token_or_leave_pending_feed_work() {
    let db = fixture_db();

    create_node(
        &db,
        "create-empty-folder",
        "folder-empty",
        None,
        "folder",
        "c0",
    );
    assert_feed_leaves_the_project_scope_untouched(&db, "create an empty Folder");
    create_node(
        &db,
        "create-note",
        "note-a",
        Some("folder-empty"),
        "note",
        "a0",
    );
    assert_feed_leaves_the_project_scope_untouched(&db, "create a Note");

    for (case, node_id, field, value) in [
        (
            "move-empty-folder",
            "folder-empty",
            "parentId",
            json!("folder-b"),
        ),
        ("reorder-note", "note-a", "sortOrder", json!("z0")),
        (
            "archive-empty-folder",
            "folder-empty",
            "archivedAt",
            json!(UPDATED_AT),
        ),
        (
            "unarchive-empty-folder",
            "folder-empty",
            "archivedAt",
            Value::Null,
        ),
        ("archive-note", "note-a", "archivedAt", json!(UPDATED_AT)),
        ("unarchive-note", "note-a", "archivedAt", Value::Null),
        (
            "rename-folder",
            "folder-empty",
            "title",
            json!("Renamed folder"),
        ),
        ("rename-note", "note-a", "title", json!("Renamed note")),
        (
            "note-body",
            "note-a",
            "content",
            json!(r#"{"type":"doc","content":[{"type":"paragraph"}]}"#),
        ),
    ] {
        tree_node_patch(&db, patch_payload(case, node_id, field, value))
            .expect("patch an empty Folder or a Note through the real tree writer");
        assert_feed_leaves_the_project_scope_untouched(&db, case);
    }

    assert_eq!(scene_scope_version(&db, "scene-a"), 1);
    assert_eq!(scene_scope_version(&db, "scene-b"), 1);
    assert_live_token_is(
        &db,
        baseline_token(),
        "no empty-folder or Note operation may move the project token",
    );
}

const AI_PLAN_CONTROLS: [&str; 7] = [
    "proposal-revision",
    "decision",
    "prepared-commit",
    "application-id",
    "source-basis-occ",
    "field-authority",
    "typed-writer",
];
const AI_HISTORY_CONTROLS: [&str; 6] = [
    "original-transaction",
    "journal-lineage",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
];

fn ai_plan(
    request_id: &str,
    updated_at: &str,
    creates: Vec<AiTreePlanCreateInput>,
    updates: Vec<AiTreePlanUpdateInput>,
) -> ApplyAiTreePlanPayload {
    ApplyAiTreePlanPayload {
        request_id: request_id.to_owned(),
        project_id: PROJECT_ID.to_owned(),
        session_id: "scope-authority-session".to_owned(),
        surface: "in-app-agent".to_owned(),
        kind: "reorganize".to_owned(),
        updated_at: updated_at.to_owned(),
        model: None,
        trace_id: None,
        authority_route: "interpreter-projection".to_owned(),
        caller: "interpreter".to_owned(),
        controls: AI_PLAN_CONTROLS.iter().map(|c| (*c).to_owned()).collect(),
        provenance: None,
        writes_authority_protected_field: false,
        creates,
        updates,
        ops: None,
        redo: false,
        original_transaction_id: None,
        undo_journal_id: None,
    }
}

fn scene_scope_events_in(db: &Database, request_id: &str, scene_id: &str) -> i64 {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT COUNT(*)
               FROM narrative_change_events event
               JOIN narrative_change_transactions tx ON tx.id = event.transaction_id
              WHERE tx.request_id = ?1
                AND json_extract(event.object_key_json, '$.kind') = 'scene-scope'
                AND json_extract(event.object_key_json, '$.sceneId') = ?2",
            params![request_id, scene_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
    })
    .expect("count the Scene Scope Feed events of a transaction")
}

#[test]
fn ai_tree_plan_folder_placement_advances_the_live_scenes_scope_generation_on_apply_undo_and_redo()
{
    let db = fixture_db();
    let forward_plan = ai_plan(
        "scope-ai-forward",
        "2026-08-24T01:00:00.000Z",
        vec![AiTreePlanCreateInput {
            temp_id: None,
            id: "scene-created".to_owned(),
            parent_id: Some("folder-a".to_owned()),
            node_type: "scene".to_owned(),
            title: "Created by the plan".to_owned(),
            sort_order: "c0".to_owned(),
            synopsis: None,
        }],
        vec![
            AiTreePlanUpdateInput {
                id: "folder-a".to_owned(),
                base_version: 0,
                placement: Some(AiTreePlanPlacementInput {
                    parent_id: Some("folder-b".to_owned()),
                    sort_order: "a0".to_owned(),
                }),
                title: None,
            },
            // Scene A is updated directly *and* sits below the moved Folder.
            AiTreePlanUpdateInput {
                id: "scene-a".to_owned(),
                base_version: 0,
                placement: None,
                title: Some("Retitled by the plan".to_owned()),
            },
        ],
    );

    let forward = apply_ai_tree_plan(&db, forward_plan.clone()).expect("apply the plan");
    assert_eq!(
        scene_scope_version(&db, "scene-a"),
        2,
        "direct update, once"
    );
    assert_eq!(
        scene_scope_version(&db, "scene-b"),
        2,
        "below the moved Folder"
    );
    assert_eq!(
        scene_scope_version(&db, "scene-created"),
        1,
        "a Scene the plan creates keeps its brand-new binding"
    );
    for (scene_id, events) in [("scene-a", 1), ("scene-b", 1), ("scene-created", 0)] {
        assert_eq!(
            scene_scope_events_in(&db, "scope-ai-forward", scene_id),
            events,
            "apply: Scope events of {scene_id}"
        );
    }
    let applied = run_cycle(&db);
    assert_eq!(applied.affected_edge_count, 1);
    assert_eq!(edge_state(&db), stale_edge_state());

    let original_transaction_id = forward["maintenanceTransactionId"]
        .as_str()
        .expect("forward transaction")
        .to_owned();
    let undo_journal_id = forward["undoJournalId"]
        .as_str()
        .expect("forward undo journal")
        .to_owned();
    undo_ai_tree_plan(
        &db,
        UndoAiTreePlanPayload {
            request_id: "scope-ai-undo".to_owned(),
            project_id: PROJECT_ID.to_owned(),
            session_id: "scope-authority-session".to_owned(),
            updated_at: "2026-08-24T01:01:00.000Z".to_owned(),
            original_transaction_id: original_transaction_id.clone(),
            undo_journal_id: undo_journal_id.clone(),
            authority_route: "history-replay".to_owned(),
            caller: "history-controller".to_owned(),
            controls: AI_HISTORY_CONTROLS
                .iter()
                .map(|c| (*c).to_owned())
                .collect(),
            provenance: None,
            writes_authority_protected_field: false,
            expected_versions: forward["versions"]
                .as_array()
                .expect("forward versions")
                .iter()
                .map(|row| AiTreeNodeVersionInput {
                    id: row["id"].as_str().expect("version id").to_owned(),
                    version: row["version"].as_i64().expect("version"),
                })
                .collect(),
        },
    )
    .expect("undo the plan");
    assert_eq!(
        scene_scope_version(&db, "scene-a"),
        3,
        "undo: direct restore, once"
    );
    assert_eq!(
        scene_scope_version(&db, "scene-b"),
        3,
        "undo: folder restore"
    );
    assert!(
        db.with_conn(|conn| read_narrative_scene_scope(conn, PROJECT_ID, "scene-created"))
            .is_err(),
        "the Scene the plan created is gone, and so is its binding"
    );
    for (scene_id, events) in [("scene-a", 1), ("scene-b", 1), ("scene-created", 0)] {
        assert_eq!(
            scene_scope_events_in(&db, "scope-ai-undo", scene_id),
            events,
            "undo: Scope events of {scene_id}"
        );
    }
    let undone = run_cycle(&db);
    assert_eq!(undone.affected_edge_count, 1);
    assert_eq!(
        edge_state(&db),
        stale_edge_state(),
        "undoing the plan must not restore the old token"
    );

    let mut redo_plan = forward_plan;
    redo_plan.request_id = "scope-ai-redo".to_owned();
    redo_plan.updated_at = "2026-08-24T01:02:00.000Z".to_owned();
    for update in &mut redo_plan.updates {
        update.base_version = 2;
    }
    redo_plan.redo = true;
    redo_plan.original_transaction_id = Some(original_transaction_id);
    redo_plan.undo_journal_id = Some(undo_journal_id);
    redo_plan.authority_route = "history-replay".to_owned();
    redo_plan.caller = "history-controller".to_owned();
    redo_plan.controls = AI_HISTORY_CONTROLS
        .iter()
        .map(|c| (*c).to_owned())
        .collect();
    apply_ai_tree_plan(&db, redo_plan).expect("redo the plan");
    assert_eq!(
        scene_scope_version(&db, "scene-a"),
        4,
        "redo: direct update, once"
    );
    assert_eq!(
        scene_scope_version(&db, "scene-b"),
        4,
        "redo: below the moved Folder"
    );
    assert_eq!(scene_scope_version(&db, "scene-created"), 1);
    for (scene_id, events) in [("scene-a", 1), ("scene-b", 1), ("scene-created", 0)] {
        assert_eq!(
            scene_scope_events_in(&db, "scope-ai-redo", scene_id),
            events,
            "redo: Scope events of {scene_id}"
        );
    }
    let redone = run_cycle(&db);
    assert_eq!(redone.affected_edge_count, 1);
    assert_eq!(edge_state(&db), stale_edge_state());
}

#[test]
fn ai_tree_plan_retitling_a_populated_folder_advances_no_generation() {
    let db = fixture_db();
    apply_ai_tree_plan(
        &db,
        ai_plan(
            "scope-ai-folder-title",
            "2026-08-24T01:00:00.000Z",
            Vec::new(),
            vec![AiTreePlanUpdateInput {
                id: "folder-a".to_owned(),
                base_version: 0,
                placement: None,
                title: Some("Retitled by the plan".to_owned()),
            }],
        ),
    )
    .expect("retitle the populated Folder through the AI tree plan");
    for scene_id in ["scene-a", "scene-b"] {
        assert_eq!(scene_scope_version(&db, scene_id), 1, "{scene_id}");
        assert_eq!(
            scene_scope_events_in(&db, "scope-ai-folder-title", scene_id),
            0,
            "{scene_id}"
        );
    }
    assert_feed_leaves_the_project_scope_untouched(&db, "retitle the populated Folder");
    assert_live_token_is(
        &db,
        baseline_token(),
        "an AI retitle of a populated Folder must not move the project token",
    );
}
