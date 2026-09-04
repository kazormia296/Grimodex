//! NIR-0 live project Scope/Order authority behavioral RED.
//!
//! The authority is a computed, project-scoped Source over the live, non-archived
//! `tree_nodes` graph. These journeys deliberately use the real tree writers,
//! canonical Narrative Change Feed, incremental Freshness facade, and restore
//! rebuild facade. No test-only authority table or mutable head is introduced.

use std::path::Path;

use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_db::domain_writes::{
    tree_node_create, tree_node_delete, tree_node_patch, TreeNodeCreatePayload,
    TreeNodeDeletePayload, TreeNodePatchPayload,
};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    ensure_restore_epochs_for_workspace, ensure_test_schema,
    rebuild_narrative_derived_state_for_project, run_incremental_freshness_cycle,
    write_dependency_declaration_set, DependencyDeclaration, DependencyDeclarationSetRequest,
    IncrementalFreshnessCycleOutcome, RebuildDerivedStateOutcome,
};
use grimodex_db::Database;
use rusqlite::{params, OptionalExtension};
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

#[test]
fn body_and_display_metadata_do_not_touch_the_project_aggregate_edge() {
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
        assert_eq!(
            summary.affected_edge_count, 0,
            "{field} is outside the project Scope/Order authority"
        );
        assert_eq!(summary.affected_consumer_count, 0, "{field}");
        assert_eq!(edge_state(&db), None, "{field} must not publish Freshness");
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
fn archive_then_unarchive_populated_folder_routes_feed_and_restores_the_baseline_token() {
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
        Some(("fresh".to_owned(), None, "none".to_owned())),
        "unarchiving restores the subtree and independently held baseline token"
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
