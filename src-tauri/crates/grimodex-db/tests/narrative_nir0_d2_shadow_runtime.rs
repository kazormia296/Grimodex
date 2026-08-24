//! NIR-0 D2 RED journeys.
//!
//! These tests deliberately exercise the public incremental Freshness facade.
//! They describe the shadow-only V2 contract: V1 remains the durable
//! authority while a sealed D1 head is evaluated against the same Feed input.

use std::path::Path;

use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_db::narrative_extraction::{
    ensure_restore_epochs_for_workspace, ensure_test_schema,
    rebuild_narrative_derived_state_for_project, run_incremental_freshness_cycle,
    write_dependency_declaration_set, DependencyDeclaration, DependencyDeclarationSetRequest,
    IncrementalFreshnessCycleOutcome, RebuildDerivedStateOutcome,
};
use grimodex_db::Database;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;

const PROJECT_ID: &str = "nir0-d2-project";
const EPOCH_ID: &str = "nir0-d2-epoch";
const CONSUMER_KIND: &str = "proposal-revision";
const CONSUMER_KEY: &str = "nir0-d2-revision";
const RUN_ID: &str = "nir0-d2-run";
const SCENE_ID: &str = "nir0-d2-scene";
const CREATED_AT: &str = "2026-08-24T00:00:00.000Z";

fn fixture_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'NIR-0 D2')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', ?3)",
            params![EPOCH_ID, PROJECT_ID, CREATED_AT],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, version, updated_at)
             VALUES (?1, ?2, 'scene', ?1, '{}', 2, ?3)",
            params![SCENE_ID, PROJECT_ID, CREATED_AT],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, run_kind, semantic_epoch_id)
             VALUES (?1, ?2, 'chronicle.extract', '{}', '{}', 'sha256:run',
                     'completed', '{}', ?3, ?3, 'interpretation', ?4)",
            params![RUN_ID, PROJECT_ID, CREATED_AT, EPOCH_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, generated_by_transaction_id, created_at, owning_run_id)
             VALUES ('nir0-d2-v1-edge', ?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)",
            params![
                PROJECT_ID,
                CONSUMER_KIND,
                CONSUMER_KEY,
                format!("project:scene:{SCENE_ID}"),
                "[\"v1@2026-08-24T00:00:01.000Z\"]",
                CREATED_AT,
                RUN_ID,
            ],
        )?;
        seed_scene_change(conn, 1)?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed D2 fixture");
    db
}

fn seed_scene_change(conn: &Connection, sequence: i64) -> anyhow::Result<()> {
    let event_uid = format!("nir0-d2-event-{sequence}");
    let transaction_id = format!("nir0-d2-transaction-{sequence}");
    let event_id = format!("nir0-d2-change-{sequence}");
    conn.execute(
        "INSERT INTO change_events
            (event_uid, project_id, scene_id, domain, op_type, entity_type, entity_id,
             payload, session_id, sequence, timestamp, prev_hash, hash)
         VALUES (?1, ?2, ?3, 'scene', 'scene.update', 'scene', ?3,
                 '{}', 'nir0-d2-test', ?4, 1787078400000, 'prev', 'hash')",
        params![event_uid, PROJECT_ID, SCENE_ID, sequence],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_transactions
            (id, project_id, request_id, source_domain, source_change_event_uid,
             source_change_event_sequence, cause_kind, origin, application_ids_json,
             payload_digest, created_at)
         VALUES (?1, ?2, ?3, 'scene.update', ?4, ?5, 'forward', 'human', '[]', ?6, ?7)",
        params![
            transaction_id,
            PROJECT_ID,
            format!("nir0-d2-request-{sequence}"),
            event_uid,
            sequence,
            format!("sha256:payload-{sequence}"),
            CREATED_AT,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_change_events
            (id, project_id, transaction_id, canonical_change_event_uid,
             canonical_sequence, event_ordinal, object_key_json, change_kind,
             mutation_kind, before_version, before_digest, after_version,
             after_digest, changed_paths_json, text_impact_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 'content', 'update',
                 1, 'sha256:before', 2, 'sha256:after', '[\"/content\"]', ?7, ?8)",
        params![
            event_id,
            PROJECT_ID,
            transaction_id,
            event_uid,
            sequence,
            json!({
                "kind": "scene",
                "sceneId": SCENE_ID,
            })
            .to_string(),
            json!({ "normalizerVersion": "gdx-canonical-text/1" }).to_string(),
            CREATED_AT,
        ],
    )?;
    Ok(())
}

fn declaration(source: &str, role: DependencyRole) -> DependencyDeclaration {
    DependencyDeclaration {
        source_object_identity: source.to_owned(),
        role,
        selector: DependencySelector::WholeSource,
    }
}

fn seed_v2_head(db: &Database) {
    write_dependency_declaration_set(
        db,
        DependencyDeclarationSetRequest {
            project_id: PROJECT_ID.to_owned(),
            consumer_kind: CONSUMER_KIND.to_owned(),
            consumer_key: CONSUMER_KEY.to_owned(),
            producer_id: "nir0-d2-producer".to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![
                declaration(
                    &format!("project:scene:{SCENE_ID}"),
                    DependencyRole::DirectEvidence,
                ),
                declaration(
                    &format!("project:scene:{SCENE_ID}"),
                    DependencyRole::QualityContext,
                ),
            ],
            created_at: CREATED_AT.to_owned(),
        },
    )
    .expect("seed sealed V2 head");
}

fn seed_v2_text_range_head(db: &Database) {
    write_dependency_declaration_set(
        db,
        DependencyDeclarationSetRequest {
            project_id: PROJECT_ID.to_owned(),
            consumer_kind: CONSUMER_KIND.to_owned(),
            consumer_key: CONSUMER_KEY.to_owned(),
            producer_id: "nir0-d2-range-producer".to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![DependencyDeclaration {
                source_object_identity: format!("project:scene:{SCENE_ID}"),
                role: DependencyRole::DirectEvidence,
                selector: DependencySelector::TextRange {
                    unit: "utf16".to_owned(),
                    from: 0,
                    to: 5,
                    normalizer_version: "gdx-canonical-text/1".to_owned(),
                    anchor_digest: Some(
                        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                            .to_owned(),
                    ),
                },
            }],
            created_at: CREATED_AT.to_owned(),
        },
    )
    .expect("seed sealed V2 range head");
}

fn seed_v2_field_path_head(db: &Database) {
    write_dependency_declaration_set(
        db,
        DependencyDeclarationSetRequest {
            project_id: PROJECT_ID.to_owned(),
            consumer_kind: CONSUMER_KIND.to_owned(),
            consumer_key: CONSUMER_KEY.to_owned(),
            producer_id: "nir0-d2-field-producer".to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![DependencyDeclaration {
                source_object_identity: format!("project:scene:{SCENE_ID}"),
                role: DependencyRole::DirectEvidence,
                selector: DependencySelector::FieldPath {
                    object_identity: format!("project:scene:{SCENE_ID}"),
                    field_path: "/content".to_owned(),
                },
            }],
            created_at: CREATED_AT.to_owned(),
        },
    )
    .expect("seed V2 field-path head");
}

fn seed_v2_unrelated_source_same_consumer_head(db: &Database) {
    write_dependency_declaration_set(
        db,
        DependencyDeclarationSetRequest {
            project_id: PROJECT_ID.to_owned(),
            consumer_kind: CONSUMER_KIND.to_owned(),
            consumer_key: CONSUMER_KEY.to_owned(),
            producer_id: "nir0-d2-unrelated-same-consumer-producer".to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![declaration(
                "project:scene:nir0-d2-unrelated-same-consumer",
                DependencyRole::DirectEvidence,
            )],
            created_at: CREATED_AT.to_owned(),
        },
    )
    .expect("seed unrelated V2 head for the existing consumer");
}

fn seed_v2_snapshot_head(db: &Database) {
    write_dependency_declaration_set(
        db,
        DependencyDeclarationSetRequest {
            project_id: PROJECT_ID.to_owned(),
            consumer_kind: CONSUMER_KIND.to_owned(),
            consumer_key: CONSUMER_KEY.to_owned(),
            producer_id: "nir0-d2-snapshot-producer".to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![declaration(
                &format!("snapshot:{RUN_ID}"),
                DependencyRole::DirectEvidence,
            )],
            created_at: CREATED_AT.to_owned(),
        },
    )
    .expect("seed V2 snapshot head");
}

fn seed_unrelated_v2_head(db: &Database) {
    write_dependency_declaration_set(
        db,
        DependencyDeclarationSetRequest {
            project_id: PROJECT_ID.to_owned(),
            consumer_kind: CONSUMER_KIND.to_owned(),
            consumer_key: "nir0-d2-unrelated".to_owned(),
            producer_id: "nir0-d2-unrelated-producer".to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![declaration(
                "project:scene:nir0-d2-unrelated-scene",
                DependencyRole::DirectEvidence,
            )],
            created_at: CREATED_AT.to_owned(),
        },
    )
    .expect("seed unrelated V2 head");
}

fn v2_storage_snapshot(db: &Database) -> (i64, i64, i64, Option<String>) {
    db.with_conn(|conn| {
        let sets: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_declaration_sets
              WHERE project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        let entries: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM narrative_dependency_declaration_entries AS entry
               JOIN narrative_dependency_declaration_sets AS set_row
                 ON set_row.id = entry.declaration_set_id
              WHERE set_row.project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        let heads: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_declaration_heads
              WHERE project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        let digest: Option<String> = conn
            .query_row(
                "SELECT dependency_set_digest
                   FROM narrative_dependency_declaration_sets
                  WHERE project_id = ?1
                  ORDER BY id ASC LIMIT 1",
                [PROJECT_ID],
                |row| row.get(0),
            )
            .optional()?;
        Ok::<_, anyhow::Error>((sets, entries, heads, digest))
    })
    .expect("snapshot D1 declaration storage")
}

#[test]
fn active_v2_head_is_reached_through_public_incremental_cycle_and_keeps_v1_canonical() {
    let db = fixture_db();
    seed_v2_head(&db);
    let d1_before = v2_storage_snapshot(&db);

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("run D2 shadow cycle")
    else {
        panic!("the Feed range must be processed");
    };

    assert_eq!(summary.affected_edge_count, 1);
    assert_eq!(summary.v2_shadow.active_head_count, 1);
    assert_eq!(summary.v2_shadow.evaluated_declaration_count, 2);
    let consumer = &summary.v2_shadow.consumers[0];
    assert_eq!(consumer.consumer_kind, CONSUMER_KIND);
    assert_eq!(consumer.consumer_key, CONSUMER_KEY);
    assert_eq!(consumer.evaluated_declaration_count, 2);
    assert_eq!(consumer.required_actions, vec!["rebuild-required"]);
    assert_eq!(consumer.advisory_actions, vec!["refresh-available"]);

    let v1_state: (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT evidence_freshness, build_action
                   FROM narrative_dependency_edge_states
                  WHERE edge_id = 'nir0-d2-v1-edge'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read V1 authority");
    assert_eq!(
        v1_state,
        ("stale".to_owned(), "rebuild-required".to_owned())
    );
    assert_eq!(v2_storage_snapshot(&db), d1_before);
}

#[test]
fn v2_shadow_uses_feed_facts_when_v1_edges_have_conflicting_private_read_sets() {
    let db = fixture_db();
    seed_v2_head(&db);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key, source_object_identity,
                 read_set_json, generated_by_transaction_id, created_at, owning_run_id)
             VALUES ('nir0-d2-v1-conflicting-edge', ?1, 'proposal-revision',
                     'nir0-d2-v1-conflicting-consumer', ?2, ?3, NULL, ?4, ?5)",
            params![
                PROJECT_ID,
                format!("project:scene:{SCENE_ID}"),
                json!([
                    "v1@2026-08-24T00:00:01.000Z",
                    {
                        "kind": "text-range",
                        "from": 0,
                        "to": 5,
                        "normalizerVersion": "gdx-canonical-text/1"
                    }
                ])
                .to_string(),
                CREATED_AT,
                RUN_ID,
            ],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed a V1 edge with a conflicting private read-set");

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("run Feed-backed shadow cycle")
    else {
        panic!("the Feed range must be processed");
    };
    let consumer = &summary.v2_shadow.consumers[0];
    assert_eq!(consumer.freshness, "stale", "{:?}", summary.v2_shadow);
    assert_eq!(consumer.required_actions, vec!["rebuild-required"]);
    assert_eq!(consumer.advisory_actions, vec!["refresh-available"]);
}

#[test]
fn no_active_v2_head_is_exact_v1_fallback() {
    let db = fixture_db();
    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("run V1 fallback cycle")
    else {
        panic!("the Feed range must be processed");
    };
    assert_eq!(summary.v2_shadow.active_head_count, 0);
    assert!(summary.v2_shadow.consumers.is_empty());
    assert!(summary.v2_shadow.diagnostics.is_empty());
    assert_eq!(summary.affected_edge_count, 1);
}

#[test]
fn corrupt_v2_head_is_observable_but_does_not_block_v1_publication() {
    let db = fixture_db();
    seed_v2_head(&db);
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_dependency_declaration_heads
                SET producer_generation = producer_generation + 1",
            [],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("corrupt active V2 head");

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("V1 must survive V2 corruption")
    else {
        panic!("the Feed range must be processed");
    };
    assert_eq!(summary.affected_edge_count, 1);
    assert!(summary.v2_shadow.active_head_count == 0);
    assert!(
        summary
            .v2_shadow
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("CORRUPT")),
        "{:?}",
        summary.v2_shadow
    );
    let freshness: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT evidence_freshness FROM narrative_dependency_edge_states
                  WHERE edge_id = 'nir0-d2-v1-edge'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("read V1 publication after V2 corruption");
    assert_eq!(freshness, "stale");
}

#[test]
fn active_v2_head_is_reached_for_a_v2_only_source_without_a_v1_reverse_edge() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute("DELETE FROM narrative_dependency_edges", [])?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("remove the V1 compatibility edge from the shadow-only fixture");
    seed_v2_head(&db);

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("run V2-only shadow cycle")
    else {
        panic!("the Feed range must still be processed");
    };
    assert_eq!(summary.affected_edge_count, 0);
    assert_eq!(summary.v2_shadow.active_head_count, 1);
    assert_eq!(summary.v2_shadow.evaluated_declaration_count, 2);
}

#[test]
fn sealed_text_range_selector_changes_the_v2_effect_without_changing_v1() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_change_events
                SET text_impact_json = ?1
              WHERE id = 'nir0-d2-change-1'",
            [json!({
                "normalizerVersion": "gdx-canonical-text/1",
                "mapping": {
                    "kind": "position-map",
                    "segments": [{
                        "oldRange": { "from": 0, "to": 5 },
                        "newRange": { "from": 0, "to": 5 },
                        "behavior": "replaced"
                    }]
                }
            })
            .to_string()],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed V2 selector mapping");
    seed_v2_text_range_head(&db);

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("run selector-aware shadow cycle")
    else {
        panic!("the Feed range must be processed");
    };
    let consumer = &summary.v2_shadow.consumers[0];
    assert_eq!(
        consumer.freshness, "anchor-mismatch",
        "{:?}",
        summary.v2_shadow
    );
    assert_eq!(consumer.required_actions, vec!["reanchor-candidate"]);

    let v1_state: (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT evidence_freshness, build_action
                   FROM narrative_dependency_edge_states
                  WHERE edge_id = 'nir0-d2-v1-edge'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read V1 state after selector-aware shadow");
    assert_eq!(
        v1_state,
        ("stale".to_owned(), "rebuild-required".to_owned())
    );
}

#[test]
fn canonical_diff_does_not_claim_text_range_proof() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_change_events
                SET text_impact_json = ?1
              WHERE id = 'nir0-d2-change-1'",
            [json!({
                "normalizerVersion": "gdx-canonical-text/1",
                "mapping": {
                    "kind": "canonical-diff",
                    "changedOldRanges": [{ "from": 0, "to": 5 }],
                    "changedNewRanges": [{ "from": 0, "to": 5 }]
                }
            })
            .to_string()],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed unproven canonical-diff mapping");
    seed_v2_text_range_head(&db);

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("run canonical-diff shadow cycle")
    else {
        panic!("the Feed range must be processed");
    };
    let consumer = &summary.v2_shadow.consumers[0];
    assert_eq!(consumer.freshness, "unknown", "{:?}", summary.v2_shadow);
    assert_eq!(consumer.required_actions, vec!["manual"]);
    assert!(summary
        .v2_shadow
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.contains("SELECTOR_UNKNOWN")));
}

#[test]
fn unprovable_field_path_selector_is_unknown_without_source_scan() {
    let db = fixture_db();
    seed_v2_field_path_head(&db);

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("run field-path shadow cycle")
    else {
        panic!("the Feed range must be processed");
    };
    let consumer = &summary.v2_shadow.consumers[0];
    assert_eq!(consumer.freshness, "unknown", "{:?}", summary.v2_shadow);
    assert_eq!(consumer.required_actions, vec!["manual"]);
    assert!(summary
        .v2_shadow
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.contains("SELECTOR_UNKNOWN")));
}

#[test]
fn unrelated_v2_head_is_not_included_in_this_feed_shadow_or_guard() {
    let db = fixture_db();
    seed_v2_head(&db);
    seed_unrelated_v2_head(&db);

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("unrelated V2 head must not block V1")
    else {
        panic!("the Feed range must be processed");
    };
    assert_eq!(summary.v2_shadow.active_head_count, 1);
    assert_eq!(summary.v2_shadow.consumers.len(), 1);
    assert_eq!(summary.v2_shadow.consumers[0].consumer_key, CONSUMER_KEY);
    assert_eq!(summary.affected_edge_count, 1);
}

#[test]
fn same_consumer_head_for_an_unaffected_v2_source_is_not_shadowed_or_guarded() {
    let db = fixture_db();
    seed_v2_unrelated_source_same_consumer_head(&db);

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("unrelated same-consumer head must not block")
    else {
        panic!("the Feed range must be processed");
    };
    assert_eq!(summary.v2_shadow.active_head_count, 0);
    assert!(summary.v2_shadow.consumers.is_empty());
    assert!(summary.v2_shadow.diagnostics.is_empty());
    assert_eq!(summary.affected_edge_count, 1);
}

#[test]
fn restore_rebuild_verifies_v2_only_heads_after_epoch_rotation_without_persistence() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute("DELETE FROM narrative_dependency_edges", [])?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("remove the V1 edge for the rebuild-only V2 consumer");
    seed_v2_head(&db);
    let d1_before = v2_storage_snapshot(&db);

    ensure_restore_epochs_for_workspace(&db, "restore-image-sha256:nir0-d2")
        .expect("rotate the restore Semantic Epoch");
    let RebuildDerivedStateOutcome::Ran { summary, .. } =
        rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
            .expect("rebuild must retain V1 authority while shadow-verifying D1")
    else {
        panic!("rebuild must run after restore epoch rotation");
    };
    assert_eq!(summary.v2_shadow.active_head_count, 1);
    assert_eq!(summary.v2_shadow.declaration_count, 2);
    assert_eq!(summary.v2_shadow.evaluated_declaration_count, 2);
    assert_eq!(v2_storage_snapshot(&db), d1_before);
}

#[test]
fn restore_rebuild_reports_corrupt_v2_head_without_v2_persistence() {
    let db = fixture_db();
    seed_v2_head(&db);
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_dependency_declaration_heads
                SET producer_generation = producer_generation + 1",
            [],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("corrupt the active D1 head");
    let d1_before = v2_storage_snapshot(&db);

    let RebuildDerivedStateOutcome::Ran { summary, .. } =
        rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
            .expect("V1 rebuild must survive a corrupt D1 head")
    else {
        panic!("rebuild must run");
    };
    assert_eq!(summary.v2_shadow.active_head_count, 0);
    assert!(summary
        .v2_shadow
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.contains("CORRUPT")));
    assert_eq!(v2_storage_snapshot(&db), d1_before);
}

#[test]
fn restore_rebuild_resolves_v2_only_snapshot_with_embedded_producer_run() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute("DELETE FROM narrative_dependency_edges", [])?;
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET snapshot_digest = 'sha256:nir0-d2-snapshot'
              WHERE id = ?1 AND project_id = ?2",
            params![RUN_ID, PROJECT_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed a sealed snapshot for the V2-only declaration");
    seed_v2_snapshot_head(&db);

    let RebuildDerivedStateOutcome::Ran { summary, .. } =
        rebuild_narrative_derived_state_for_project(&db, PROJECT_ID)
            .expect("rebuild must resolve the snapshot through its producer Run")
    else {
        panic!("rebuild must run");
    };
    assert_eq!(summary.v2_shadow.active_head_count, 1);
    assert_eq!(summary.v2_shadow.evaluated_declaration_count, 1);
    assert!(
        summary.v2_shadow.diagnostics.is_empty(),
        "{:?}",
        summary.v2_shadow
    );
}
