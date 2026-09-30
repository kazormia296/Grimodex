#[path = "../test-support/adapter.rs"]
mod test_support;

use grimodex_db::domain_writes::{
    project_create, tree_node_create, ProjectCreatePayload, TreeNodeCreatePayload,
};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{temporal_scene_patch, TemporalScenePatchPayload};
use grimodex_db::scene_body::{save_scene_body_bundle, SaveSceneBodyBundlePayload};
use grimodex_db::Database;

fn fixture() -> Database {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
    for (project_id, title) in [("p1", "One"), ("p2", "Two")] {
        project_create(
            &db,
            ProjectCreatePayload {
                project_id: project_id.to_string(),
                request_id: format!("fixture-project-{project_id}"),
                session_id: "fixture-session".to_string(),
                event_uid: format!("fixture-project-{project_id}-event"),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                title: title.to_string(),
                genre: None,
                pov: None,
                tense: None,
                language: None,
                style_guide: None,
                ai_instructions: None,
                outline: None,
                target_readers: None,
                created_at: "2026-08-13T00:00:00.000Z".to_string(),
                updated_at: "2026-08-13T00:00:00.000Z".to_string(),
            },
        )
        .expect("seed project through production writer");
        tree_node_create(
            &db,
            TreeNodeCreatePayload {
                id: format!("scene-{project_id}"),
                project_id: project_id.to_string(),
                request_id: format!("fixture-scene-{project_id}"),
                session_id: "fixture-session".to_string(),
                event_uid: format!("fixture-scene-{project_id}-event"),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                parent_id: None,
                node_type: "scene".to_string(),
                title: title.to_string(),
                sort_order: "a0".to_string(),
                synopsis: None,
                status: None,
                source_uri: None,
                source_mtime: None,
                content: None,
                canonical_payload: None,
            },
        )
        .expect("seed scene through production writer");
    }
    db
}

fn payload() -> TemporalScenePatchPayload {
    TemporalScenePatchPayload {
        request_id: "temporal-request-1".to_string(),
        session_id: "renderer-temporal".to_string(),
        event_uid: "temporal-event-1".to_string(),
        origin: NarrativeChangeOrigin::Human,
        original_transaction_id: None,
        undo_journal_id: None,
        project_id: "p1".to_string(),
        target_id: "scene-p1".to_string(),
        base_version: 0,
        story_time_order: Some("a0V".to_string()),
        story_time_label: Some("First".to_string()),
        start_time: Some(1),
        start_minute: None,
        start_granularity: "day".to_string(),
        end_time: Some(2),
        end_minute: None,
        end_granularity: "day".to_string(),
        precision: "exact".to_string(),
    }
}

#[test]
fn temporal_scene_patch_is_atomic_idempotent_and_project_scoped() {
    let db = fixture();
    let first = temporal_scene_patch(&db, payload()).expect("apply temporal patch");
    let mut replay_payload = payload();
    replay_payload.session_id = "renderer-temporal-after-restart".to_string();
    replay_payload.event_uid = "temporal-event-after-restart".to_string();
    let replay =
        temporal_scene_patch(&db, replay_payload).expect("cross-session replay temporal patch");
    assert_eq!(first, replay);
    assert_eq!(first["version"], 1);

    db.with_conn(|conn| {
        let transaction_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_transactions
              WHERE project_id = 'p1' AND request_id = 'temporal-request-1'",
            [],
            |row| row.get(0),
        )?;
        let (event_count, scene_event_count, scene_scope_event_count): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*),
                    SUM(CASE WHEN json_extract(event.object_key_json, '$.kind') = 'scene'
                             THEN 1 ELSE 0 END),
                    SUM(CASE WHEN json_extract(event.object_key_json, '$.kind') = 'scene-scope'
                             THEN 1 ELSE 0 END)
               FROM narrative_change_events event
               JOIN narrative_change_transactions feed_tx
                 ON feed_tx.id = event.transaction_id
              WHERE feed_tx.project_id = 'p1'
                AND feed_tx.request_id = 'temporal-request-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        let origin: String = conn.query_row(
            "SELECT origin FROM narrative_change_transactions
              WHERE project_id = 'p1' AND request_id = 'temporal-request-1'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(
            (
                transaction_count,
                event_count,
                scene_event_count,
                scene_scope_event_count
            ),
            (1, 2, 1, 1)
        );
        assert_eq!(origin, "human");
        Ok(())
    })
    .expect("read feed");

    let mut cross_project = payload();
    cross_project.request_id = "temporal-request-xproj".to_string();
    cross_project.event_uid = "temporal-event-xproj".to_string();
    cross_project.target_id = "scene-p2".to_string();
    assert!(temporal_scene_patch(&db, cross_project).is_err());
}

#[test]
fn temporal_feed_failure_rolls_back_scene_patch() {
    let db = fixture();
    let before_binding: (i64, String) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT version, source_token
                   FROM narrative_scene_scope_bindings
                  WHERE project_id = 'p1' AND scene_id = 'scene-p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(Into::into)
        })
        .expect("read pre-failure scope binding");
    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER fail_temporal_feed
               BEFORE INSERT ON narrative_change_transactions
               BEGIN SELECT RAISE(ABORT, 'forced temporal feed failure'); END;",
        )?;
        Ok(())
    })
    .expect("install failure trigger");

    let error = temporal_scene_patch(&db, payload()).expect_err("temporal feed must fail");
    assert!(
        error.to_string().contains("forced temporal feed failure"),
        "unexpected temporal feed failure: {error}"
    );
    db.with_conn(|conn| {
        let state: (i64, Option<String>, Option<i64>) = conn.query_row(
            "SELECT version, story_time_order, chronicle_start_time
               FROM tree_nodes WHERE id = 'scene-p1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let canonical_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM change_events WHERE event_uid = 'temporal-event-1'",
            [],
            |row| row.get(0),
        )?;
        let after_binding: (i64, String) = conn.query_row(
            "SELECT version, source_token
               FROM narrative_scene_scope_bindings
              WHERE project_id = 'p1' AND scene_id = 'scene-p1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(state, (0, None, None));
        assert_eq!(canonical_count, 0);
        assert_eq!(after_binding, before_binding);
        Ok(())
    })
    .expect("verify rollback");
}

#[test]
fn scene_feed_digest_is_continuous_across_temporal_and_body_writers() {
    let db = fixture();
    temporal_scene_patch(&db, payload()).expect("apply temporal patch");
    save_scene_body_bundle(
        &db,
        SaveSceneBodyBundlePayload {
            scene_id: "scene-p1".to_string(),
            project_id: "p1".to_string(),
            request_id: "scene-body-request-after-temporal".to_string(),
            session_id: "renderer-scene-body".to_string(),
            event_uid: "scene-body-event-after-temporal".to_string(),
            origin: NarrativeChangeOrigin::Human,
            timelapse_steps: None,
            timelapse_doc_step_coverage: None,
            include_sidecars: false,
            base_version: Some(1),
            updated_at: "2026-08-13T00:00:01.000Z".to_string(),
            content_json: "{\"type\":\"doc\",\"content\":[]}".to_string(),
            char_count: 0,
            placed_beat_preview: None,
            unplaced_beats_doc: "[]".to_string(),
            unplaced_beat_preview: None,
            authorship_spans: vec![],
            foreshadow_setups: vec![],
            foreshadow_payoffs: vec![],
            foreshadow_base_versions: std::collections::HashMap::new(),
            annotation_anchors: vec![],
            beat_mentions: vec![],
            beat_pov_overrides: vec![],
            doc_content_size: 2,
        },
    )
    .expect("save scene body");

    db.with_conn(|conn| {
        let temporal_after: String = conn.query_row(
            "SELECT event.after_digest
              FROM narrative_change_events event
               JOIN narrative_change_transactions feed_tx
                 ON feed_tx.id = event.transaction_id
              WHERE feed_tx.project_id = 'p1'
                AND feed_tx.request_id = 'temporal-request-1'
                AND json_extract(event.object_key_json, '$.kind') = 'scene'",
            [],
            |row| row.get(0),
        )?;
        let body_before: String = conn.query_row(
            "SELECT event.before_digest
               FROM narrative_change_events event
               JOIN narrative_change_transactions feed_tx
                 ON feed_tx.id = event.transaction_id
              WHERE feed_tx.project_id = 'p1'
                AND feed_tx.request_id = 'scene-body-request-after-temporal'
                AND json_extract(event.object_key_json, '$.kind') = 'scene'
                AND json_extract(event.object_key_json, '$.sceneId') = 'scene-p1'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(temporal_after, body_before);
        Ok(())
    })
    .expect("assert digest continuity");
}
