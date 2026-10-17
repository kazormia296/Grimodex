//! X1-2 acceptance for `scope-storage-authority` (Scene Scope generation).
//!
//! A Scene's Scope generation (the Scope binding's `version`, source token and
//! `updatedAt`) advances only when a value that affects the Scope really
//! changes. Body saves, titles, display metadata and Codex-rename propagation
//! advance the Scene's body Source token (`v{version}@{updated_at}`) alone.
//! These tests use the real writers and the typed-Revision fixtures; they sit
//! in the crate because the project Scope authority loader is crate-private.

use anyhow::Result;
use grimodex_core::narrative_nir1::ScopeValue;
use rusqlite::params;
use serde_json::{json, Value};

use crate::domain_writes::{
    apply_codex_rename, tree_node_patch, CodexRenameApplyPayload, CodexRenameUndoUpdate,
    TreeNodePatchPayload,
};
use crate::narrative_extraction::change_feed::NarrativeChangeOrigin;
use crate::narrative_extraction::incremental_freshness::{
    run_incremental_freshness_cycle, IncrementalFreshnessCycleOutcome,
};
use crate::narrative_extraction::nir1_entity_relation::tests::{
    approve_typed_revision, prepare_a3_scope_fixture, request, seed_run_and_catalog,
};
use crate::narrative_extraction::nir1_entity_relation::{
    create_nir1_entity_relation_revision, evaluate_nir1_entity_relation_disclosure,
    read_nir1_entity_relation_revision, Nir1EntityRelationDisclosureRead,
    Nir1EntityRelationRevisionRead,
};
use crate::narrative_extraction::nir1_entity_relation_index;
use crate::narrative_extraction::project_scope_authority::load_live_project_scope_authority;
use crate::narrative_extraction::scene_scope::read_narrative_scene_scope;
use crate::narrative_extraction::DependencyDeclarationSetRequest;
use crate::narrative_extraction::{write_dependency_declaration_set, DependencyDeclaration};
use crate::scene_body::{save_scene_body_bundle, SaveSceneBodyBundlePayload};
use crate::test_support::fresh_migrated_memory;
use crate::Database;
use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};

const PROJECT: &str = "default-project";
const SCENES: [&str; 3] = ["nir1", "a3-source", "a3-future"];

#[derive(Debug, Clone, PartialEq, Eq)]
struct Generation {
    version: i64,
    source_token: String,
    updated_at: String,
}

fn generation(db: &Database, scene: &str) -> Result<Generation> {
    db.with_read_transaction(|conn| {
        let binding = read_narrative_scene_scope(conn, PROJECT, scene)?.binding;
        Ok(Generation {
            version: binding.version,
            source_token: binding.source_token,
            updated_at: binding.updated_at,
        })
    })
}

fn generations(db: &Database) -> Result<Vec<Generation>> {
    SCENES.iter().map(|scene| generation(db, scene)).collect()
}

fn body_token(db: &Database, scene: &str) -> Result<String> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT 'v' || version || '@' || updated_at FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2",
            params![scene, PROJECT],
            |row| row.get(0),
        )?)
    })
}

fn project_token(db: &Database) -> Result<String> {
    db.with_read_transaction(|conn| {
        Ok(load_live_project_scope_authority(
            conn,
            PROJECT,
            "project:scope-authority:default-project",
        )?
        .source
        .revision_token)
    })
}

fn scope_event_count(db: &Database) -> Result<i64> {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_events event
               JOIN narrative_change_transactions tx ON tx.id = event.transaction_id
              WHERE tx.project_id = ?1
                AND json_extract(event.object_key_json, '$.kind') = 'scene-scope'",
            [PROJECT],
            |row| row.get(0),
        )?)
    })
}

fn roster(db: &Database) -> Result<nir1_entity_relation_index::GraphEligibilitySource> {
    db.with_read_transaction(|conn| {
        nir1_entity_relation_index::read_eligibility_source(conn, PROJECT)
    })
}

/// A typed Revision anchored at `a3-source`, approved, with every Scene bound.
fn approved_fixture() -> Result<(Database, String)> {
    let db = fresh_migrated_memory()?;
    seed_run_and_catalog(&db)?;
    prepare_a3_scope_fixture(&db)?;
    run_incremental_freshness_cycle(&db)?;
    let mut typed_request = request(&db);
    for entity in &mut typed_request.bundle.entities {
        entity.scope.reading = ScopeValue::Exact {
            value: "scene:a3-source".into(),
        };
    }
    let created = create_nir1_entity_relation_revision(&db, typed_request)?;
    approve_typed_revision(&db, "nir1-run", &created)?;
    let revision_id = created["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("typed revision id missing"))?
        .to_owned();
    Ok((db, revision_id))
}

fn assert_revision_current(db: &Database, revision_id: &str, context: &str) -> Result<()> {
    let a2 = db.with_read_transaction(|conn| {
        read_nir1_entity_relation_revision(conn, PROJECT, revision_id)
    })?;
    assert!(
        matches!(a2, Nir1EntityRelationRevisionRead::Available(_)),
        "{context}: A2 must stay available: {a2:?}"
    );
    let a3 = db.with_read_transaction(|conn| {
        evaluate_nir1_entity_relation_disclosure(conn, PROJECT, revision_id, "nir1")
    })?;
    assert!(
        matches!(a3, Nir1EntityRelationDisclosureRead::Eligible(_)),
        "{context}: A3 must stay eligible: {a3:?}"
    );
    Ok(())
}

fn save_body(db: &Database, scene: &str, tag: &str, updated_at: &str) -> Result<()> {
    save_scene_body_bundle(
        db,
        SaveSceneBodyBundlePayload {
            scene_id: scene.to_owned(),
            project_id: PROJECT.to_owned(),
            request_id: format!("x12-body-{tag}-request"),
            session_id: "x12-body-session".to_owned(),
            event_uid: format!("x12-body-{tag}-event"),
            origin: NarrativeChangeOrigin::Human,
            timelapse_steps: None,
            timelapse_doc_step_coverage: None,
            include_sidecars: false,
            base_version: None,
            updated_at: updated_at.to_owned(),
            content_json: format!(
                r#"{{"type":"doc","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{tag}"}}]}}]}}"#
            ),
            char_count: tag.chars().count() as i64,
            placed_beat_preview: None,
            unplaced_beats_doc: "[]".to_owned(),
            unplaced_beat_preview: None,
            authorship_spans: vec![],
            foreshadow_setups: vec![],
            foreshadow_payoffs: vec![],
            foreshadow_base_versions: Default::default(),
            annotation_anchors: vec![],
            beat_mentions: vec![],
            beat_pov_overrides: vec![],
            doc_content_size: 0,
        },
    )?;
    Ok(())
}

fn patch(
    db: &Database,
    scene: &str,
    tag: &str,
    field: &str,
    value: Value,
    bump_version: bool,
    updated_at: &str,
) -> Result<()> {
    let mut patch = serde_json::Map::new();
    patch.insert(field.to_owned(), value);
    tree_node_patch(
        db,
        TreeNodePatchPayload {
            project_id: PROJECT.to_owned(),
            request_id: format!("x12-patch-{tag}-request"),
            session_id: "x12-patch-session".to_owned(),
            event_uid: format!("x12-patch-{tag}-event"),
            node_id: scene.to_owned(),
            patch,
            base_version: None,
            bump_version,
            updated_at: updated_at.to_owned(),
            change_event: None,
            timelapse_doc_step_coverage: None,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            source_domain: None,
            op_type: None,
            canonical_payload: None,
        },
    )?;
    Ok(())
}

/// Test 1. Saving bodies through the real writer leaves every Scope
/// generation, the v1 source token and the project Scope authority token
/// untouched, advances the saved Scenes' body Source tokens, and leaves the
/// approved typed Revision available (A2) and eligible (A3) with an unchanged
/// Graph roster.
#[test]
fn body_save_keeps_scope_generation_and_project_token() -> Result<()> {
    let (db, revision_id) = approved_fixture()?;
    assert_revision_current(&db, &revision_id, "before any save")?;
    let generations_before = generations(&db)?;
    let project_before = project_token(&db)?;
    let roster_before = roster(&db)?;
    let scope_events_before = scope_event_count(&db)?;
    let source_before = body_token(&db, "a3-source")?;
    let future_before = body_token(&db, "a3-future")?;
    let query_before = body_token(&db, "nir1")?;

    save_body(&db, "a3-source", "anchor", "2026-10-17T01:00:00.000Z")?;
    save_body(&db, "a3-future", "other", "2026-10-17T01:00:01.000Z")?;

    assert_eq!(generations(&db)?, generations_before, "Scope generation");
    assert_eq!(project_token(&db)?, project_before, "project Scope token");
    assert_eq!(
        scope_event_count(&db)?,
        scope_events_before,
        "scene-scope events"
    );
    assert_ne!(body_token(&db, "a3-source")?, source_before);
    assert_ne!(body_token(&db, "a3-future")?, future_before);
    assert_eq!(body_token(&db, "nir1")?, query_before);
    assert_revision_current(
        &db,
        &revision_id,
        "after saving the anchor and another Scene",
    )?;
    assert_eq!(roster(&db)?, roster_before, "Graph roster");
    Ok(())
}

/// Test 11 (X1-2 part), body side. The Feed event of a body save is a `scene`
/// event (identity `project:scene:<id>`), never a `scene-scope` event, so the
/// Scene's body Source reaches its dependents although the writer no longer
/// refreshes the Scope binding.
#[test]
fn body_save_reaches_the_body_source_consumer_without_a_scope_refresh() -> Result<()> {
    let (db, _revision_id) = approved_fixture()?;
    write_dependency_declaration_set(
        &db,
        DependencyDeclarationSetRequest {
            project_id: PROJECT.to_owned(),
            consumer_kind: "proposal-revision".to_owned(),
            consumer_key: "x12-body-consumer".to_owned(),
            producer_id: "proposal-revision-source-basis".to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![DependencyDeclaration {
                source_object_identity: "project:scene:a3-future".to_owned(),
                role: DependencyRole::DirectEvidence,
                selector: DependencySelector::WholeSource,
            }],
            created_at: "2026-10-17T00:00:00.000Z".to_owned(),
        },
    )?;
    let scope_events_before = scope_event_count(&db)?;
    save_body(&db, "a3-future", "reach", "2026-10-17T01:00:00.000Z")?;
    assert_eq!(scope_event_count(&db)?, scope_events_before);
    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db)?
    else {
        anyhow::bail!("a body save must leave a pending Feed range");
    };
    assert_eq!(summary.v2_shadow.evaluated_declaration_count, 1);
    assert_eq!(summary.v2_shadow.consumers.len(), 1);
    assert_eq!(summary.v2_shadow.consumers[0].freshness, "stale");
    Ok(())
}

/// Test 2. Titles and display metadata keep the Scope generation; a Scope
/// field patch (POV, story order, placement, archive) advances it exactly once
/// per real change; a `bumpVersion=false` patch with the renderer's strictly
/// increasing clock advances the body Source token and not the generation.
#[test]
fn display_patches_keep_generation_and_scope_fields_advance_it() -> Result<()> {
    let (db, revision_id) = approved_fixture()?;
    let generation_before = generations(&db)?;
    let project_before = project_token(&db)?;
    let mut token = body_token(&db, "a3-source")?;
    let mut tokens = vec![token.clone()];

    for (tag, field, value) in [
        ("title", "title", json!("Retitled")),
        ("synopsis", "synopsis", json!("Synopsis only")),
        ("status", "status", json!("revision")),
        ("label", "storyTimeLabel", json!("Display label")),
        ("same-sort", "sortOrder", json!("a0")),
    ] {
        patch(
            &db,
            "a3-source",
            tag,
            field,
            value,
            true,
            "2026-10-17T02:00:00.000Z",
        )?;
        let next = body_token(&db, "a3-source")?;
        assert_ne!(next, token, "{field} advances the body Source token");
        token = next;
        tokens.push(token.clone());
        assert_eq!(generations(&db)?, generation_before, "{field}");
        assert_eq!(project_token(&db)?, project_before, "{field}");
    }
    // Renderer clock: bumpVersion=false with strictly increasing updatedAt.
    for (index, second) in ["03", "04", "05"].into_iter().enumerate() {
        patch(
            &db,
            "a3-source",
            &format!("clock-{index}"),
            "content",
            json!(format!("{{\"type\":\"doc\",\"n\":{index}}}")),
            false,
            &format!("2026-10-17T02:00:{second}.000Z"),
        )?;
        let next = body_token(&db, "a3-source")?;
        assert!(!tokens.contains(&next), "a token never returns: {next}");
        tokens.push(next);
        assert_eq!(
            generations(&db)?,
            generation_before,
            "renderer clock {index}"
        );
    }
    assert_eq!(project_token(&db)?, project_before);
    // The same-value `sortOrder` patch still appends a `scene` event with a
    // `/sortOrder` path; the Freshness cycle re-evaluates it against the
    // unchanged project token and the Revision stays current.
    run_incremental_freshness_cycle(&db)?;
    assert_revision_current(&db, &revision_id, "after display patches")?;

    // Scope fields advance the generation once per real change. (The anchor
    // itself is patched last because its own Scope edits retire the Revision
    // until X1-3 narrows the project binding.)
    let version = |db: &Database| generation(db, "a3-future").map(|g| g.version);
    let base = version(&db)?;
    patch(
        &db,
        "a3-future",
        "pov",
        "povCharacterId",
        json!("nir1-alice"),
        true,
        "2026-10-17T03:00:00.000Z",
    )?;
    assert_eq!(version(&db)?, base + 1, "POV set");
    patch(
        &db,
        "a3-future",
        "pov-same",
        "povCharacterId",
        json!("nir1-alice"),
        true,
        "2026-10-17T03:00:01.000Z",
    )?;
    assert_eq!(
        version(&db)?,
        base + 1,
        "the same POV again is not a change"
    );
    patch(
        &db,
        "a3-future",
        "pov-clear",
        "povCharacterId",
        Value::Null,
        true,
        "2026-10-17T03:00:02.000Z",
    )?;
    assert_eq!(version(&db)?, base + 2, "POV cleared");
    patch(
        &db,
        "a3-future",
        "story",
        "storyTimeOrder",
        json!("z9"),
        true,
        "2026-10-17T03:00:03.000Z",
    )?;
    assert_eq!(version(&db)?, base + 3, "story order");
    patch(
        &db,
        "a3-future",
        "sort",
        "sortOrder",
        json!("a9"),
        true,
        "2026-10-17T03:00:04.000Z",
    )?;
    assert_eq!(version(&db)?, base + 4, "reading position");
    patch(
        &db,
        "a3-future",
        "archive",
        "archivedAt",
        json!("2026-10-17T03:00:05.000Z"),
        true,
        "2026-10-17T03:00:05.000Z",
    )?;
    assert_eq!(version(&db)?, base + 5, "archive");
    assert_ne!(project_token(&db)?, project_before);
    Ok(())
}

/// Test 3. A Codex rename propagating into a Scene advances the Scene's body
/// Source token without touching any Scope generation, and the typed Revision
/// stays available; renaming the Codex entry the Revision holds retires the
/// Revision through the Codex Source instead.
#[test]
fn codex_rename_propagation_keeps_scope_generation() -> Result<()> {
    let (db, revision_id) = approved_fixture()?;
    let generation_before = generations(&db)?;
    let project_before = project_token(&db)?;
    let future_before = body_token(&db, "a3-future")?;
    let scope_events_before = scope_event_count(&db)?;

    let scene_version: i64 = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT version FROM tree_nodes WHERE id = 'a3-future'",
            [],
            |row| row.get(0),
        )?)
    })?;
    let entry_version: i64 = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT version FROM codex_entries WHERE id = 'nir1-bob'",
            [],
            |row| row.get(0),
        )?)
    })?;
    let rename = |tag: &str, updates: Vec<CodexRenameUndoUpdate>| CodexRenameApplyPayload {
        request_id: format!("x12-rename-{tag}-request"),
        project_id: PROJECT.to_owned(),
        session_id: "x12-rename-session".to_owned(),
        surface: Some("x12".to_owned()),
        entry_id: "nir1-bob".to_owned(),
        updated_at: "2026-10-17T04:00:00.000Z".to_owned(),
        updates,
        event_summary: "{}".to_owned(),
        event_uid: format!("x12-rename-{tag}-event"),
        timestamp: 1,
        redo: false,
        original_transaction_id: None,
        undo_journal_id: None,
    };
    apply_codex_rename(
        &db,
        rename(
            "scene-only",
            vec![CodexRenameUndoUpdate {
                kind: "scene-body".to_owned(),
                ref_id: "a3-future".to_owned(),
                detail_definition_id: None,
                base_version: scene_version,
                value: r#"{"type":"doc","content":[]}"#.to_owned(),
                char_count: Some(0),
                placed_beat_preview: None,
            }],
        ),
    )?;
    assert_ne!(body_token(&db, "a3-future")?, future_before);
    assert_eq!(generations(&db)?, generation_before);
    assert_eq!(project_token(&db)?, project_before);
    assert_eq!(scope_event_count(&db)?, scope_events_before);
    assert_revision_current(&db, &revision_id, "after a Scene-only rename propagation")?;

    apply_codex_rename(
        &db,
        rename(
            "entity",
            vec![CodexRenameUndoUpdate {
                kind: "codex-summary".to_owned(),
                ref_id: "nir1-bob".to_owned(),
                detail_definition_id: None,
                base_version: entry_version,
                value: "Robert".to_owned(),
                char_count: None,
                placed_beat_preview: None,
            }],
        ),
    )?;
    assert_eq!(
        generations(&db)?,
        generation_before,
        "no Scope generation moved"
    );
    assert_eq!(project_token(&db)?, project_before);
    let a2 = db.with_read_transaction(|conn| {
        read_nir1_entity_relation_revision(conn, PROJECT, &revision_id)
    })?;
    assert!(
        matches!(a2, Nir1EntityRelationRevisionRead::Unavailable { .. }),
        "the renamed Entity retires the Revision through the Codex Source: {a2:?}"
    );
    Ok(())
}
