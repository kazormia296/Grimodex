//! X1-3 acceptance for `typed-revision-material` and `scope-storage-authority`.
//!
//! A version-2 typed Revision binds the Scene Scope projection of each Scene
//! its Entities anchor to, not the project Scope token. These tests drive the
//! real writers (body save, tree patch, Scope and registry writers, delete and
//! create, character cascade, snapshot restore) and read the Revision back
//! through A2, A3 and B's roster. They check both directions: a change that
//! does not touch the anchor's Scope leaves the Revision available, and a
//! change that does retires it for good (no round trip restores it).

use std::collections::BTreeSet;

use anyhow::Result;
use grimodex_core::narrative_nir1::ScopeValue;
use grimodex_core::narrative_scene_scope::{
    NarrativeSceneScopeRegistryV1, NarrativeScopeConstraintV1, NarrativeScopePrincipalV1,
};
use serde_json::{json, Value};

use super::scope_storage_authority_tests::{
    approved_fixture, approved_fixture_in, assert_revision_current, generation, patch,
    project_token, revision_is_current, roster, save_body, PROJECT, SCENES,
};
use crate::domain_writes::{
    tree_node_create, tree_node_delete, TreeNodeCreatePayload, TreeNodeDeletePayload,
};
use crate::narrative_extraction::change_feed::NarrativeChangeOrigin;
use crate::narrative_extraction::dependency_edges::find_edges_by_consumer;
use crate::narrative_extraction::revision_eligibility::{pending, RevisionFreshnessReason};
use crate::narrative_extraction::incremental_freshness::{
    run_incremental_freshness_cycle, IncrementalFreshnessCycleOutcome,
};
use crate::narrative_extraction::nir1_entity_relation::tests::{
    approve_typed_revision, rebind_scope_tokens, request_for_run,
    scene_scope_projection_token_for_test,
};
use crate::narrative_extraction::nir1_entity_relation::{
    create_nir1_entity_relation_revision, read_nir1_entity_relation_revision,
    Nir1EntityRelationRevisionRead,
};
use crate::narrative_extraction::scene_scope::{
    read_narrative_scene_scope, update_narrative_scene_scope_registry,
    NarrativeSceneScopeRegistryUpdatePayload,
};
use crate::narrative_extraction::{
    update_narrative_scene_scope, NarrativeSceneScopeUpdatePayload, NarrativeSceneScopeUpdateV1,
};
use crate::Database;

fn projection(db: &Database, scene: &str) -> Result<String> {
    scene_scope_projection_token_for_test(db, PROJECT, scene)
}

fn projections(db: &Database) -> Result<Vec<String>> {
    SCENES.iter().map(|scene| projection(db, scene)).collect()
}

fn a2_available(db: &Database, revision_id: &str) -> Result<bool> {
    let a2 = db.with_read_transaction(|conn| {
        read_nir1_entity_relation_revision(conn, PROJECT, revision_id)
    })?;
    Ok(matches!(a2, Nir1EntityRelationRevisionRead::Available(_)))
}

fn a2_reason(db: &Database, revision_id: &str) -> Result<Option<String>> {
    let a2 = db.with_read_transaction(|conn| {
        read_nir1_entity_relation_revision(conn, PROJECT, revision_id)
    })?;
    Ok(match a2 {
        Nir1EntityRelationRevisionRead::Unavailable { reason } => Some(reason),
        _ => None,
    })
}

/// A new approved Revision of the seed Entities whose readings all name
/// `anchors[index % anchors.len()]`, bound to those Scenes' projections.
fn approve_anchored(db: &Database, anchors: &[&str], proposal_key: &str) -> Result<String> {
    let mut typed = request_for_run(db, "nir1-run", proposal_key);
    for (index, entity) in typed.bundle.entities.iter_mut().enumerate() {
        entity.scope.reading = ScopeValue::Exact {
            value: format!("scene:{}", anchors[index % anchors.len()]),
        };
        entity.scope.phase = "draft".into();
    }
    rebind_scope_tokens(db, &mut typed)?;
    let created = create_nir1_entity_relation_revision(db, typed)?;
    approve_typed_revision(db, "nir1-run", &created)?;
    Ok(created["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("typed revision id missing"))?
        .to_owned())
}

fn source_basis(db: &Database, revision_id: &str) -> Result<Vec<(String, String, String)>> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT source_kind, source_key, revision_token
               FROM narrative_revision_source_basis
              WHERE revision_id = ?1 ORDER BY source_key",
        )?;
        let rows = statement
            .query_map([revision_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

/// The pending-Feed answer for the Revision's own edges, read before the
/// Freshness cycle has processed anything (`None`: nothing pending touches it).
fn pending_reason(db: &Database, revision_id: &str) -> Result<Option<RevisionFreshnessReason>> {
    db.with_read_transaction(|conn| {
        let edges = find_edges_by_consumer(conn, PROJECT, "proposal-revision", revision_id)?;
        Ok(pending::read(conn, PROJECT, &edges)?.err())
    })
}

fn drain_freshness(db: &Database) -> Result<()> {
    while matches!(
        run_incremental_freshness_cycle(db)?,
        IncrementalFreshnessCycleOutcome::Processed(_)
    ) {}
    Ok(())
}

fn set_registry(db: &Database, timeline_refs: Vec<String>, tag: &str) -> Result<()> {
    let current =
        db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, "nir1"))?;
    update_narrative_scene_scope_registry(
        db,
        NarrativeSceneScopeRegistryUpdatePayload {
            project_id: PROJECT.to_owned(),
            request_id: format!("x13-registry-{tag}"),
            session_id: "x13-session".to_owned(),
            event_uid: format!("x13-registry-event-{tag}"),
            base_version: current.registry_revision,
            updated_at: format!("2026-10-18T00:00:0{}.000Z", tag.len() % 10),
            registry: NarrativeSceneScopeRegistryV1 {
                timeline_refs,
                ..current.registry
            },
        },
    )?;
    Ok(())
}

/// Set the scene's material timeline constraint to `reference`.
fn set_material_timeline(db: &Database, scene: &str, reference: &str, tag: &str) -> Result<()> {
    let current =
        db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, scene))?;
    let mut material_constraint = current.binding.material_constraint.clone();
    material_constraint.timeline = NarrativeScopeConstraintV1::Exact {
        reference: reference.to_owned(),
    };
    update_narrative_scene_scope(
        db,
        NarrativeSceneScopeUpdatePayload {
            project_id: PROJECT.to_owned(),
            scene_id: scene.to_owned(),
            request_id: format!("x13-scope-{tag}"),
            session_id: "x13-session".to_owned(),
            event_uid: format!("x13-scope-event-{tag}"),
            base_version: current.binding.version,
            updated_at: format!("2026-10-18T01:00:0{}.000Z", tag.len() % 10),
            scope: NarrativeSceneScopeUpdateV1 {
                schema_version: 1,
                compatibility_marker: current.binding.compatibility_marker,
                query_identity: current.binding.query_identity.clone(),
                material_constraint,
                knowledge_holder: current.binding.knowledge_holder.clone(),
                audience: current.binding.audience.clone(),
            },
        },
    )?;
    Ok(())
}

fn material_timeline(db: &Database, scene: &str) -> Result<String> {
    let scope =
        db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, scene))?;
    match scope.binding.material_constraint.timeline {
        NarrativeScopeConstraintV1::Exact { reference } => Ok(reference),
        other => anyhow::bail!("fixture timeline is not Exact: {other:?}"),
    }
}

/// Test 1. A new Revision binds the anchor's projection (and no project
/// token). Saving the anchor's body, another Scene's body and the query
/// Scene's body leaves every projection, the project token and B's roster
/// untouched and the Revision available (A2) and eligible (A3), also after the
/// Feed has settled and after a cold reopen.
#[test]
fn x13_other_scene_body_save_keeps_v2_revision_and_projection() -> Result<()> {
    let directory = std::env::temp_dir().join(format!("x13-reopen-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("grimodex.db");
    let db = Database::new(&path)?;
    db.migrate()?;
    let (db, revision_id) = approved_fixture_in(db)?;

    let basis = source_basis(&db, &revision_id)?;
    let anchor_projection = projection(&db, "a3-source")?;
    assert!(
        basis
            .iter()
            .any(|(kind, key, token)| kind == "scene-scope-projection-v1"
                && key == "project:scene-scope-projection:a3-source"
                && token == &anchor_projection),
        "the basis binds the anchor's projection: {basis:?}"
    );
    assert!(
        basis
            .iter()
            .all(|(kind, _, _)| kind != "project-scope-authority"),
        "no project token is bound: {basis:?}"
    );
    assert_revision_current(&db, &revision_id, "before any save")?;

    let projections_before = projections(&db)?;
    let project_before = project_token(&db)?;
    let roster_before = roster(&db)?;
    assert!(
        !roster_before.roster.is_empty(),
        "the Revision is in the roster"
    );

    save_body(&db, "a3-source", "anchor", "2026-10-18T02:00:00.000Z")?;
    save_body(&db, "a3-future", "other", "2026-10-18T02:00:01.000Z")?;
    save_body(&db, "nir1", "query", "2026-10-18T02:00:02.000Z")?;
    assert_eq!(projections(&db)?, projections_before, "projections");
    assert_eq!(project_token(&db)?, project_before, "project token");
    assert_revision_current(&db, &revision_id, "after saving bodies")?;
    assert_eq!(roster(&db)?, roster_before, "roster after saves");

    drain_freshness(&db)?;
    assert_revision_current(&db, &revision_id, "after the Feed settled")?;
    assert_eq!(roster(&db)?, roster_before, "roster after the Feed settled");

    drop(db);
    let reopened = Database::new(&path)?;
    reopened.migrate()?;
    assert_eq!(projections(&reopened)?, projections_before, "reopened");
    assert_revision_current(&reopened, &revision_id, "after a cold reopen")?;
    assert_eq!(roster(&reopened)?, roster_before, "roster after reopen");
    drop(reopened);
    std::fs::remove_dir_all(&directory)?;
    Ok(())
}

/// Test 2 (display side). Title, synopsis, status, label and the renderer's
/// `bumpVersion=false` writes keep every projection, so both Revisions stay
/// available.
#[test]
fn x13_display_patches_keep_projection() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    let before = projections(&db)?;
    for (tag, field, value) in [
        ("title", "title", json!("Retitled")),
        ("synopsis", "synopsis", json!("Synopsis only")),
        ("status", "status", json!("revision")),
        ("label", "storyTimeLabel", json!("Display label")),
    ] {
        patch(
            &db,
            "a3-source",
            tag,
            field,
            value,
            true,
            "2026-10-18T03:00:00.000Z",
        )?;
    }
    patch(
        &db,
        "a3-source",
        "clock",
        "content",
        json!("{\"type\":\"doc\"}"),
        false,
        "2026-10-18T03:00:01.000Z",
    )?;
    drain_freshness(&db)?;
    assert_eq!(projections(&db)?, before);
    assert_revision_current(&db, &anchor_revision, "anchor after display patches")?;
    assert!(a2_available(&db, &other_revision)?);
    Ok(())
}

/// Test 2 (Scope side). An anchor's POV patch retires only the Revisions that
/// anchor to it.
#[test]
fn x13_anchor_pov_patch_invalidates_only_the_anchor_revision() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    let other_projection = projection(&db, "a3-future")?;
    patch(
        &db,
        "a3-source",
        "pov",
        "povCharacterId",
        json!("nir1-alice"),
        true,
        "2026-10-18T03:00:00.000Z",
    )?;
    assert!(!a2_available(&db, &anchor_revision)?);
    assert_eq!(
        a2_reason(&db, &anchor_revision)?.as_deref(),
        Some("source-revision-changed")
    );
    assert!(a2_available(&db, &other_revision)?);
    assert_eq!(projection(&db, "a3-future")?, other_projection);
    // The Feed settles without reviving the retired Revision.
    drain_freshness(&db)?;
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(a2_available(&db, &other_revision)?);
    Ok(())
}

/// Test 4. Moving the anchor retires its Revision only; moving another Scene
/// in front of the anchor does not, and A3 judges "reading before" by today's
/// rank.
#[test]
fn x13_anchor_move_invalidates_only_anchor_revision() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    patch(
        &db,
        "a3-source",
        "move",
        "sortOrder",
        json!("a5"),
        true,
        "2026-10-18T03:00:00.000Z",
    )?;
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(a2_available(&db, &other_revision)?);
    Ok(())
}

#[test]
fn x13_moving_another_scene_before_the_anchor_keeps_eligibility() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let anchor_projection = projection(&db, "a3-source")?;
    let project_before = project_token(&db)?;
    // `Z0` sorts before the anchor's `a0`.
    patch(
        &db,
        "a3-future",
        "move-before",
        "sortOrder",
        json!("Z0"),
        true,
        "2026-10-18T03:00:00.000Z",
    )?;
    assert_ne!(
        project_token(&db)?,
        project_before,
        "the project token moves"
    );
    assert_eq!(projection(&db, "a3-source")?, anchor_projection);
    drain_freshness(&db)?;
    assert_revision_current(&db, &anchor_revision, "after another Scene moved first")?;
    Ok(())
}

/// Test 5. A folder that holds the anchor moves, archives and comes back:
/// the anchor's Revision is retired and never returns; a Revision anchored
/// outside the folder is not touched. Moving or archiving a folder with no
/// Scene below it changes no projection.
#[test]
fn x13_folder_move_archive_roundtrip_invalidates_descendant_anchors_only() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES ('x13-folder', ?1, 'folder', 'Folder', '{}', 'a9')",
            [PROJECT],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES ('x13-empty', ?1, 'folder', 'Empty', '{}', 'b0')",
            [PROJECT],
        )?;
        Ok(())
    })?;
    // An empty folder and a note change no projection.
    let before = projections(&db)?;
    let project_before = project_token(&db)?;
    patch(
        &db,
        "x13-empty",
        "e-move",
        "sortOrder",
        json!("b5"),
        true,
        "2026-10-18T04:00:00.000Z",
    )?;
    patch(
        &db,
        "x13-empty",
        "e-archive",
        "archivedAt",
        json!("2026-10-18T04:00:01.000Z"),
        true,
        "2026-10-18T04:00:01.000Z",
    )?;
    patch(
        &db,
        "x13-empty",
        "e-title",
        "title",
        json!("Renamed"),
        true,
        "2026-10-18T04:00:02.000Z",
    )?;
    drain_freshness(&db)?;
    assert_eq!(projections(&db)?, before);
    assert_eq!(
        project_token(&db)?,
        project_before,
        "project token (empty folder)"
    );
    assert_revision_current(&db, &anchor_revision, "after empty-folder operations")?;

    // Put the anchor below the folder; that is the anchor's own move.
    let anchor_before_move = projection(&db, "a3-source")?;
    patch(
        &db,
        "a3-source",
        "into-folder",
        "parentId",
        json!("x13-folder"),
        true,
        "2026-10-18T04:01:00.000Z",
    )?;
    assert!(!a2_available(&db, &anchor_revision)?);
    let in_folder = projection(&db, "a3-source")?;
    assert_ne!(in_folder, anchor_before_move);

    // A Revision made while the anchor sits below the folder is retired by the
    // folder's move and archive, and not restored when they are undone.
    drain_freshness(&db)?;
    let nested_revision = approve_anchored(&db, &["a3-source"], "nir1:review:x13-nested")?;
    assert!(a2_available(&db, &nested_revision)?);
    patch(
        &db,
        "x13-folder",
        "f-move",
        "sortOrder",
        json!("a7"),
        true,
        "2026-10-18T04:02:00.000Z",
    )?;
    assert!(!a2_available(&db, &nested_revision)?, "folder move");
    let after_move = projection(&db, "a3-source")?;
    assert_ne!(after_move, in_folder);
    patch(
        &db,
        "x13-folder",
        "f-move-back",
        "sortOrder",
        json!("a9"),
        true,
        "2026-10-18T04:02:01.000Z",
    )?;
    let after_move_back = projection(&db, "a3-source")?;
    assert!(
        ![&in_folder, &after_move].contains(&&after_move_back),
        "moving the folder back does not return an earlier token"
    );
    patch(
        &db,
        "x13-folder",
        "f-archive",
        "archivedAt",
        json!("2026-10-18T04:03:00.000Z"),
        true,
        "2026-10-18T04:03:00.000Z",
    )?;
    assert!(!a2_available(&db, &nested_revision)?, "folder archive");
    patch(
        &db,
        "x13-folder",
        "f-restore",
        "archivedAt",
        Value::Null,
        true,
        "2026-10-18T04:04:00.000Z",
    )?;
    let restored = projection(&db, "a3-source")?;
    assert!(
        ![&in_folder, &after_move, &after_move_back].contains(&&restored),
        "unarchiving the folder does not return an earlier token"
    );
    assert!(!a2_available(&db, &nested_revision)?, "still retired");
    drain_freshness(&db)?;
    assert!(!a2_available(&db, &nested_revision)?);
    assert!(a2_available(&db, &other_revision)?, "outside the folder");
    Ok(())
}

/// Test 6. The anchor's Scope round trips (X to Y to X, archive and back,
/// story order and back) never restore a retired Revision, and each state has
/// a token no earlier state had. Another Scene's setting changes nothing.
#[test]
fn x13_anchor_scope_roundtrips_never_restore_eligibility() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    let original = projection(&db, "a3-source")?;
    let mut seen = BTreeSet::from([original.clone()]);
    let mut observe = |db: &Database, what: &str| -> Result<()> {
        let token = projection(db, "a3-source")?;
        assert!(seen.insert(token), "{what}: the token was seen before");
        assert!(!a2_available(db, &anchor_revision)?, "{what}");
        Ok(())
    };

    // A neighbour's setting is not the anchor's.
    let original_timeline = material_timeline(&db, "nir1")?;
    set_material_timeline(&db, "nir1", "timeline:other", "neighbour")?;
    set_material_timeline(&db, "nir1", &original_timeline, "neighbour-back")?;
    drain_freshness(&db)?;
    assert_eq!(projection(&db, "a3-source")?, original);
    assert!(a2_available(&db, &anchor_revision)?);

    let timeline = material_timeline(&db, "a3-source")?;
    set_material_timeline(&db, "a3-source", "timeline:other", "to-y")?;
    observe(&db, "X to Y")?;
    set_material_timeline(&db, "a3-source", &timeline, "to-x")?;
    observe(&db, "Y back to X")?;

    patch(
        &db,
        "a3-source",
        "archive",
        "archivedAt",
        json!("2026-10-18T05:00:00.000Z"),
        true,
        "2026-10-18T05:00:00.000Z",
    )?;
    assert!(!a2_available(&db, &anchor_revision)?, "archived");
    patch(
        &db,
        "a3-source",
        "unarchive",
        "archivedAt",
        Value::Null,
        true,
        "2026-10-18T05:00:01.000Z",
    )?;
    observe(&db, "archive and back")?;

    let story: Option<String> = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT story_time_order FROM tree_nodes WHERE id = 'a3-source' AND project_id = ?1",
            [PROJECT],
            |row| row.get(0),
        )?)
    })?;
    patch(
        &db,
        "a3-source",
        "story",
        "storyTimeOrder",
        json!("z9"),
        true,
        "2026-10-18T05:00:02.000Z",
    )?;
    observe(&db, "story order changed")?;
    patch(
        &db,
        "a3-source",
        "story-back",
        "storyTimeOrder",
        story.map_or(Value::Null, Value::from),
        true,
        "2026-10-18T05:00:03.000Z",
    )?;
    observe(&db, "story order back")?;

    drain_freshness(&db)?;
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(a2_available(&db, &other_revision)?);
    Ok(())
}

/// Test 7. Adding a registry reference retires every Revision (the registry
/// is shared by every binding, Q2) and cannot be undone by removing it.
#[test]
fn x13_registry_ref_addition_invalidates_every_revision() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    let before = projections(&db)?;
    let current =
        db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, "nir1"))?;
    let mut extended = current.registry.timeline_refs.clone();
    extended.push("timeline:x13-extra".into());
    set_registry(&db, extended, "add")?;
    for (scene, token) in SCENES.iter().zip(&before) {
        assert_ne!(&projection(&db, scene)?, token, "{scene}");
    }
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(!a2_available(&db, &other_revision)?);
    set_registry(&db, current.registry.timeline_refs.clone(), "remove")?;
    for (scene, token) in SCENES.iter().zip(&before) {
        assert_ne!(&projection(&db, scene)?, token, "{scene} after removal");
    }
    drain_freshness(&db)?;
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(!a2_available(&db, &other_revision)?);
    Ok(())
}

/// Test 8. Deleting the anchor retires its Revision; creating a Scene with the
/// same id again is a new incarnation and does not revive it.
#[test]
fn x13_anchor_delete_recreate_stays_invalidated() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    let original = projection(&db, "a3-source")?;
    tree_node_delete(
        &db,
        TreeNodeDeletePayload {
            project_id: PROJECT.to_owned(),
            request_id: "x13-delete".to_owned(),
            session_id: "x13-session".to_owned(),
            event_uid: "x13-delete-event".to_owned(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            node_id: "a3-source".to_owned(),
            canonical_payload: None,
        },
    )?;
    assert!(!a2_available(&db, &anchor_revision)?, "deleted anchor");
    assert!(a2_available(&db, &other_revision)?);
    tree_node_create(
        &db,
        TreeNodeCreatePayload {
            id: "a3-source".to_owned(),
            project_id: PROJECT.to_owned(),
            request_id: "x13-create".to_owned(),
            session_id: "x13-session".to_owned(),
            event_uid: "x13-create-event".to_owned(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: None,
            node_type: "scene".to_owned(),
            title: "A3 source".to_owned(),
            sort_order: "a0".to_owned(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: Some("{}".to_owned()),
            canonical_payload: None,
        },
    )?;
    assert_ne!(projection(&db, "a3-source")?, original, "a new incarnation");
    assert!(
        !a2_available(&db, &anchor_revision)?,
        "recreated under the same id"
    );
    drain_freshness(&db)?;
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(a2_available(&db, &other_revision)?);
    Ok(())
}

/// Test 9. The A1 invalidation that follows a character's restore (holder or
/// audience) and the POV cleared by deleting the character each retire the
/// Revisions that anchor to that Scene only.
#[test]
fn x13_holder_character_restore_invalidates_only_the_anchor() -> Result<()> {
    use crate::narrative_extraction::invalidate_character_references_with_events_in_tx;
    let (db, _first) = approved_fixture()?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, content)
             VALUES ('x13-holder', ?1, 'character', 'Holder', '{}')",
            [PROJECT],
        )?;
        Ok(())
    })?;
    let current =
        db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, "a3-source"))?;
    update_narrative_scene_scope(
        &db,
        NarrativeSceneScopeUpdatePayload {
            project_id: PROJECT.to_owned(),
            scene_id: "a3-source".to_owned(),
            request_id: "x13-holder-request".to_owned(),
            session_id: "x13-session".to_owned(),
            event_uid: "x13-holder-event".to_owned(),
            base_version: current.binding.version,
            updated_at: "2026-10-18T06:00:00.000Z".to_owned(),
            scope: NarrativeSceneScopeUpdateV1 {
                schema_version: 1,
                compatibility_marker: current.binding.compatibility_marker,
                query_identity: current.binding.query_identity.clone(),
                material_constraint: current.binding.material_constraint.clone(),
                knowledge_holder: NarrativeScopePrincipalV1::Character {
                    reference: "x13-holder".to_owned(),
                },
                audience: current.binding.audience.clone(),
            },
        },
    )?;
    drain_freshness(&db)?;
    let anchor_revision = approve_anchored(&db, &["a3-source"], "nir1:review:x13-holder")?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    assert!(a2_available(&db, &anchor_revision)?);
    let named = projection(&db, "a3-source")?;
    let other_projection = projection(&db, "a3-future")?;
    let events = db.with_conn(|conn| {
        invalidate_character_references_with_events_in_tx(
            conn,
            PROJECT,
            "x13-holder",
            "2026-10-18T06:01:00.000Z",
        )
    })?;
    assert_eq!(events.len(), 1);
    assert_ne!(projection(&db, "a3-source")?, named);
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(a2_available(&db, &other_revision)?);
    assert_eq!(projection(&db, "a3-future")?, other_projection);
    drain_freshness(&db)?;
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(a2_available(&db, &other_revision)?);
    Ok(())
}

#[test]
fn x13_pov_only_character_delete_invalidates_only_the_anchor() -> Result<()> {
    let (db, _first) = approved_fixture()?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, content, version)
             VALUES ('x13-pov', ?1, 'character', 'Pov', '{}', 1)",
            [PROJECT],
        )?;
        Ok(())
    })?;
    patch(
        &db,
        "a3-source",
        "pov-set",
        "povCharacterId",
        json!("x13-pov"),
        true,
        "2026-10-18T07:00:00.000Z",
    )?;
    drain_freshness(&db)?;
    let anchor_revision = approve_anchored(&db, &["a3-source"], "nir1:review:x13-pov")?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    let before = generation(&db, "a3-source")?;
    let other_before = generation(&db, "a3-future")?;
    let events = db.with_conn(|conn| {
        super::codex_snapshots::undo_created_codex_entry(conn, PROJECT, "x13-pov", 1)
    })?;
    assert_eq!(events.len(), 1);
    assert_eq!(generation(&db, "a3-source")?.version, before.version + 1);
    assert_eq!(generation(&db, "a3-future")?, other_before);
    assert!(!a2_available(&db, &anchor_revision)?, "POV cleared");
    assert!(a2_available(&db, &other_revision)?);
    drain_freshness(&db)?;
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(a2_available(&db, &other_revision)?);
    Ok(())
}

/// Test 15 (writer and reader). A Revision whose Entities anchor to two Scenes
/// binds one projection row per Scene; one anchor's change retires the whole
/// Revision, and B's roster loses it.
#[test]
fn x13_multi_anchor_revision_is_all_or_nothing() -> Result<()> {
    let (db, _first) = approved_fixture()?;
    let revision = approve_anchored(&db, &["a3-source", "a3-future"], "nir1:review:x13-multi")?;
    let basis = source_basis(&db, &revision)?;
    let projection_rows = basis
        .iter()
        .filter(|(kind, _, _)| kind == "scene-scope-projection-v1")
        .map(|(_, key, token)| (key.clone(), token.clone()))
        .collect::<Vec<_>>();
    assert_eq!(
        projection_rows,
        vec![
            (
                "project:scene-scope-projection:a3-future".to_owned(),
                projection(&db, "a3-future")?
            ),
            (
                "project:scene-scope-projection:a3-source".to_owned(),
                projection(&db, "a3-source")?
            ),
        ],
        "one row per distinct anchor: {basis:?}"
    );
    assert!(basis
        .iter()
        .all(|(kind, _, _)| kind != "project-scope-authority"));
    assert!(a2_available(&db, &revision)?);
    let roster_with = roster(&db)?;
    assert!(!roster_with.roster.is_empty());

    // Only the second anchor changes; the whole Revision is retired.
    patch(
        &db,
        "a3-future",
        "multi-pov",
        "povCharacterId",
        json!("nir1-alice"),
        true,
        "2026-10-18T08:00:00.000Z",
    )?;
    assert!(!a2_available(&db, &revision)?, "one anchor changed");
    let roster_without = roster(&db)?;
    assert!(!roster_without.roster.is_empty(), "the other Revision stays");
    assert_ne!(
        roster_without.digest, roster_with.digest,
        "B's roster no longer lists the retired Revision"
    );
    Ok(())
}

/// Test 15 (accounting). Each distinct anchor adds one source-basis row, one
/// `nir1:scope:<sceneId>` dependency and one V1 edge, and grows the sealed
/// envelope by a bounded amount; two Entities on one anchor add nothing. The
/// measured sizes are recorded in DR-X1-3-9 (run with `--nocapture`).
#[test]
fn x13_multi_anchor_revision_accounting() -> Result<()> {
    let (db, _first) = approved_fixture()?;
    let one = approve_anchored(&db, &["a3-source"], "nir1:review:x13-one")?;
    let two = approve_anchored(&db, &["a3-source", "a3-future"], "nir1:review:x13-two")?;
    let sizes = |revision: &str| -> Result<(i64, i64, i64, i64, i64, i64)> {
        db.with_conn(|conn| {
            let (payload, envelope): (i64, i64) = conn.query_row(
                "SELECT length(CAST(payload_json AS BLOB)),
                        length(CAST(reconciliation_envelope_json AS BLOB))
                   FROM narrative_proposal_revisions WHERE id = ?1",
                [revision],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let count = |sql: &str| -> rusqlite::Result<i64> {
                conn.query_row(sql, [revision], |row| row.get(0))
            };
            let basis = count("SELECT COUNT(*) FROM narrative_revision_source_basis WHERE revision_id = ?1")?;
            let projection_rows = count(
                "SELECT COUNT(*) FROM narrative_revision_source_basis
                  WHERE revision_id = ?1 AND source_kind = 'scene-scope-projection-v1'",
            )?;
            let edges = count(
                "SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1",
            )?;
            let scope_edges = count(
                "SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE consumer_kind = 'proposal-revision' AND consumer_key = ?1
                    AND source_object_identity LIKE 'project:scene-scope-projection:%'",
            )?;
            Ok((payload, envelope, basis, projection_rows, edges, scope_edges))
        })
    };
    let (p1, e1, b1, r1, d1, s1) = sizes(&one)?;
    let (p2, e2, b2, r2, d2, s2) = sizes(&two)?;
    println!("x13 accounting one-anchor: payload={p1} envelope={e1} basis={b1} projection_rows={r1} edges={d1} scope_edges={s1}");
    println!("x13 accounting two-anchor: payload={p2} envelope={e2} basis={b2} projection_rows={r2} edges={d2} scope_edges={s2}");
    assert_eq!((r1, s1), (1, 1));
    assert_eq!((r2, s2), (2, 2));
    assert_eq!(b2, b1 + 1, "one more source-basis row per anchor");
    assert_eq!(d2, d1 + 1, "one more V1 edge per anchor");
    assert!(e2 > e1 && e2 - e1 < 4096, "bounded envelope growth: {e1} -> {e2}");
    Ok(())
}

/// Test 11. A body save appends a `scene` event only: the Revisions' edges
/// are not selected, so neither Revision is pending before the Feed is
/// processed, and the cycle leaves both current.
#[test]
fn x13_body_events_do_not_make_v2_revisions_pending() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    drain_freshness(&db)?;
    save_body(&db, "a3-source", "pending-a", "2026-10-18T09:00:00.000Z")?;
    save_body(&db, "a3-future", "pending-b", "2026-10-18T09:00:01.000Z")?;
    assert!(
        revision_is_current(&db, &anchor_revision)?,
        "before the cycle (the Feed holds only body events)"
    );
    assert!(a2_available(&db, &other_revision)?, "before the cycle");
    drain_freshness(&db)?;
    assert!(revision_is_current(&db, &anchor_revision)?);
    assert!(a2_available(&db, &other_revision)?);
    Ok(())
}

/// Test 11. An anchor's `scene-scope` event makes the Revisions anchored to it
/// pending at once, before the Freshness cycle has run, and no other Revision.
#[test]
fn x13_anchor_scene_scope_event_marks_only_anchor_pending() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    drain_freshness(&db)?;
    let pending_before: i64 = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_events event
               JOIN narrative_change_transactions tx ON tx.id = event.transaction_id
              WHERE tx.project_id = ?1
                AND json_extract(event.object_key_json, '$.kind') = 'scene-scope'",
            [PROJECT],
            |row| row.get(0),
        )?)
    })?;
    patch(
        &db,
        "a3-future",
        "pending-pov",
        "povCharacterId",
        json!("nir1-alice"),
        true,
        "2026-10-18T10:00:00.000Z",
    )?;
    let pending_after: i64 = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_events event
               JOIN narrative_change_transactions tx ON tx.id = event.transaction_id
              WHERE tx.project_id = ?1
                AND json_extract(event.object_key_json, '$.kind') = 'scene-scope'",
            [PROJECT],
            |row| row.get(0),
        )?)
    })?;
    assert!(pending_after > pending_before, "a scene-scope event was appended");
    // The pending reader (before any cycle) selects the patched Scene's
    // Revision only.
    assert_eq!(
        pending_reason(&db, &other_revision)?,
        Some(RevisionFreshnessReason::PendingRelevantChange),
        "the anchor's own scene-scope event"
    );
    assert_eq!(
        pending_reason(&db, &anchor_revision)?,
        None,
        "another Scene's Revision is not pending"
    );
    assert!(revision_is_current(&db, &anchor_revision)?, "pending but unrelated");
    assert!(!a2_available(&db, &other_revision)?, "the anchor's own event");
    drain_freshness(&db)?;
    assert_eq!(pending_reason(&db, &other_revision)?, None, "after the cycle");
    assert!(revision_is_current(&db, &anchor_revision)?);
    assert!(!a2_available(&db, &other_revision)?);
    Ok(())
}

/// Test 11. After the Freshness cycle has processed an anchor's `scene-scope`
/// event, the saved state of the projection edge of the Revision anchored there
/// is stale (`source-revision-changed`), and the other Revisions' projection
/// edges stay fresh.
#[test]
fn x13_incremental_freshness_marks_only_anchor_stale() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    drain_freshness(&db)?;
    let projection_edge_state = |revision: &str| -> Result<Vec<(String, Option<String>)>> {
        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT state.evidence_freshness, state.reason_code
                   FROM narrative_dependency_edges edge
                   JOIN narrative_dependency_edge_states state ON state.edge_id = edge.id
                  WHERE edge.project_id = ?1 AND edge.consumer_kind = 'proposal-revision'
                    AND edge.consumer_key = ?2
                    AND edge.source_object_identity LIKE 'project:scene-scope-projection:%'",
            )?;
            let rows = statement
                .query_map(rusqlite::params![PROJECT, revision], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    };
    let fresh = |states: &[(String, Option<String>)]| {
        !states.is_empty() && states.iter().all(|(state, _)| state == "fresh")
    };
    assert!(fresh(&projection_edge_state(&anchor_revision)?), "before the change");
    assert!(fresh(&projection_edge_state(&other_revision)?), "before the change");
    patch(
        &db,
        "a3-future",
        "stale-pov",
        "povCharacterId",
        json!("nir1-alice"),
        true,
        "2026-10-18T19:00:00.000Z",
    )?;
    drain_freshness(&db)?;
    let touched = projection_edge_state(&other_revision)?;
    assert!(
        touched
            .iter()
            .any(|(state, reason)| state == "stale"
                && reason.as_deref() == Some("source-revision-changed")),
        "the touched Revision's projection edge is stale: {touched:?}"
    );
    assert!(
        fresh(&projection_edge_state(&anchor_revision)?),
        "another Scene's Revision stays fresh"
    );
    Ok(())
}

/// Test 7 (Feed side). A registry write appends one `scene-scope` event per
/// binding and a `scope-registry` event: every anchor's Revision is pending at
/// once, before any cycle has run.
#[test]
fn x13_registry_update_marks_every_anchor_pending() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    let third_revision = approve_anchored(&db, &["nir1"], "nir1:review:x13-third")?;
    drain_freshness(&db)?;
    for revision in [&anchor_revision, &other_revision, &third_revision] {
        assert_eq!(pending_reason(&db, revision)?, None, "settled");
    }
    let mut refs = db
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, "nir1"))?
        .registry
        .timeline_refs;
    refs.push("timeline:x13-pending".to_owned());
    set_registry(&db, refs, "pending")?;
    for revision in [&anchor_revision, &other_revision, &third_revision] {
        assert_eq!(
            pending_reason(&db, revision)?,
            Some(RevisionFreshnessReason::PendingRelevantChange),
            "a registry change reaches every projection Edge"
        );
    }
    Ok(())
}

/// Test 5 (empty folder and notes). An empty folder and a note (move, archive,
/// rename, and a note filed into the folder) change no projection and the
/// project token, and no Revision is pending, before and after the cycle.
#[test]
fn x13_empty_folder_and_note_operations_keep_projection() -> Result<()> {
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES ('x13-empty', ?1, 'folder', 'Empty', '{}', 'b0')",
            [PROJECT],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES ('x13-note', ?1, 'note', 'Note', '{}', 'b1')",
            [PROJECT],
        )?;
        Ok(())
    })?;
    drain_freshness(&db)?;
    let projections_before = projections(&db)?;
    let project_before = project_token(&db)?;
    let mut step = 0;
    let mut operate = |node: &str, field: &str, value: Value| -> Result<()> {
        step += 1;
        patch(
            &db,
            node,
            &format!("x13-ops-{step}"),
            field,
            value,
            true,
            &format!("2026-10-18T14:00:{step:02}.000Z"),
        )
    };
    for node in ["x13-empty", "x13-note"] {
        operate(node, "sortOrder", json!("c5"))?;
        operate(node, "title", json!("Renamed"))?;
        operate(node, "archivedAt", json!("2026-10-18T14:30:00.000Z"))?;
        operate(node, "archivedAt", Value::Null)?;
    }
    operate("x13-note", "parentId", json!("x13-empty"))?;
    operate("x13-note", "sortOrder", json!("c6"))?;
    for revision in [&anchor_revision, &other_revision] {
        assert_eq!(
            pending_reason(&db, revision)?,
            None,
            "no operation on an empty folder or a note is pending"
        );
    }
    assert_eq!(projections(&db)?, projections_before, "projections");
    assert_eq!(project_token(&db)?, project_before, "project token");
    assert_revision_current(&db, &anchor_revision, "after folder and note operations")?;
    assert!(a2_available(&db, &other_revision)?);
    drain_freshness(&db)?;
    assert_revision_current(&db, &anchor_revision, "after the cycle")?;
    assert!(a2_available(&db, &other_revision)?);
    Ok(())
}

/// Test 8 (Trash). A Scene put in the Trash and deleted retires its Revision;
/// the Trash restore creates a different Scene (its own id and incarnation),
/// so the restore does not revive the Revision and does not retire another.
#[test]
fn x13_anchor_trash_restore_stays_invalidated() -> Result<()> {
    use crate::trash_bin::{create, restore, TrashBinCreatePayload, TrashBinRestorePayload};
    let (db, anchor_revision) = approved_fixture()?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    let original = projection(&db, "a3-source")?;
    let trash: TrashBinCreatePayload = serde_json::from_value(json!({
        "id": "x13-trash-scene",
        "projectId": PROJECT,
        "kind": "structure-item",
        "subKind": "scene",
        "originSceneId": null,
        "originCodexId": null,
        "previewText": "A3 source",
        "previewMeta": null,
        "payload": json!({
            "originalId": "a3-source",
            "title": "A3 source",
            "body": "{\"type\":\"doc\",\"content\":[]}",
            "beats": "[]",
            "povCharacterId": null,
            "folderHintId": null,
            "folderHintName": null,
            "metadata": { "sortOrder": "a0", "nodeType": "scene" },
            "charCount": 0
        }).to_string(),
        "charCount": 0,
        "isInteresting": false,
        "deletedAt": "2026-10-18T15:00:00.000Z"
    }))?;
    create(&db, trash)?;
    tree_node_delete(
        &db,
        TreeNodeDeletePayload {
            project_id: PROJECT.to_owned(),
            request_id: "x13-trash-delete".to_owned(),
            session_id: "x13-session".to_owned(),
            event_uid: "x13-trash-delete-event".to_owned(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            node_id: "a3-source".to_owned(),
            canonical_payload: None,
        },
    )?;
    assert!(!a2_available(&db, &anchor_revision)?, "deleted anchor");
    let restored = restore(
        &db,
        TrashBinRestorePayload {
            request_id: "x13-trash-restore".to_owned(),
            session_id: "x13-session".to_owned(),
            project_id: PROJECT.to_owned(),
            item_id: "x13-trash-scene".to_owned(),
            board_id_override: None,
            drop_x: None,
            drop_y: None,
        },
    )?;
    assert_eq!(restored.new_id, "restored-scene:x13-trash-scene");
    assert!(
        projection(&db, "a3-source").is_err(),
        "the old id is not back"
    );
    assert_ne!(projection(&db, &restored.new_id)?, original);
    assert!(!a2_available(&db, &anchor_revision)?, "after the restore");
    assert!(a2_available(&db, &other_revision)?);
    drain_freshness(&db)?;
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(a2_available(&db, &other_revision)?);
    Ok(())
}

/// Test 9 (journal paths). The undo journal replays a Codex entry's creation
/// and removal (method J1): removing the person that is a Scene's POV clears
/// the POV and advances the Scene's Scope generation, and re-inserting the
/// person does not bring the cleared Scope back. The Revision anchored to that
/// Scene stays retired until a new one is approved; a Revision of another Scene
/// is untouched. A person named as holder cannot be removed by the journal.
#[test]
fn x13_journal_paths_keep_anchor_revision_ineligible() -> Result<()> {
    use super::codex_operations::scope_journal_support::{create_character, replay_journal};
    let (db, _first) = approved_fixture()?;
    let journal = create_character(&db, PROJECT, "x13-journal-char", "Journal")?;
    let replay = |direction: &str| -> Result<Value> {
        replay_journal(&db, PROJECT, &journal, direction)
    };
    let pov_of_anchor = |db: &Database| -> Result<Option<String>> {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT pov_character_id FROM tree_nodes WHERE id = 'a3-source'",
                [],
                |row| row.get(0),
            )?)
        })
    };
    let character_exists = |db: &Database| -> Result<bool> {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM codex_entries WHERE id = 'x13-journal-char'",
                [],
                |row| row.get::<_, i64>(0),
            )? == 1)
        })
    };

    patch(
        &db,
        "a3-source",
        "journal-pov",
        "povCharacterId",
        json!("x13-journal-char"),
        true,
        "2026-10-18T16:00:00.000Z",
    )?;
    drain_freshness(&db)?;
    let anchor_revision = approve_anchored(&db, &["a3-source"], "nir1:review:x13-journal")?;
    let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-other")?;
    assert!(a2_available(&db, &anchor_revision)?);
    let approved = projection(&db, "a3-source")?;
    let other_projection = projection(&db, "a3-future")?;

    // Undo of the creation removes the person; the POV foreign key clears and
    // the Scene's Scope generation advances in the same transaction.
    replay("undo")?;
    assert!(!character_exists(&db)?);
    assert_eq!(pov_of_anchor(&db)?, None);
    assert_ne!(projection(&db, "a3-source")?, approved);
    assert!(!a2_available(&db, &anchor_revision)?, "POV cleared by undo");
    assert!(a2_available(&db, &other_revision)?);
    assert_eq!(projection(&db, "a3-future")?, other_projection);

    // Redo re-inserts the person. The POV is not restored and the Revision is
    // not eligible again without a new approval.
    replay("redo")?;
    assert!(character_exists(&db)?);
    assert_eq!(pov_of_anchor(&db)?, None);
    let after_redo = projection(&db, "a3-source")?;
    assert_ne!(after_redo, approved);
    assert!(!a2_available(&db, &anchor_revision)?, "person back, still retired");
    drain_freshness(&db)?;
    assert!(!a2_available(&db, &anchor_revision)?);

    drain_freshness(&db)?;
    assert!(!a2_available(&db, &anchor_revision)?);
    assert!(a2_available(&db, &other_revision)?);

    // A holder is a stronger reference: the journal may not remove it.
    let current =
        db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, "a3-source"))?;
    update_narrative_scene_scope(
        &db,
        NarrativeSceneScopeUpdatePayload {
            project_id: PROJECT.to_owned(),
            scene_id: "a3-source".to_owned(),
            request_id: "x13-journal-holder".to_owned(),
            session_id: "x13-session".to_owned(),
            event_uid: "x13-journal-holder-event".to_owned(),
            base_version: current.binding.version,
            updated_at: "2026-10-18T16:01:00.000Z".to_owned(),
            scope: NarrativeSceneScopeUpdateV1 {
                schema_version: 1,
                compatibility_marker: current.binding.compatibility_marker,
                query_identity: current.binding.query_identity.clone(),
                material_constraint: current.binding.material_constraint.clone(),
                knowledge_holder: NarrativeScopePrincipalV1::Character {
                    reference: "x13-journal-char".to_owned(),
                },
                audience: current.binding.audience.clone(),
            },
        },
    )?;
    drain_freshness(&db)?;
    let holder_revision = approve_anchored(&db, &["a3-source"], "nir1:review:x13-holder-journal")?;
    assert!(a2_available(&db, &holder_revision)?);
    let holder_projection = projection(&db, "a3-source")?;
    let refused = replay("undo").expect_err("a holder cannot be removed through the journal");
    assert!(
        refused
            .to_string()
            .contains("NEX_SCENE_SCOPE_CHARACTER_REFERENCED"),
        "{refused:#}"
    );
    assert!(character_exists(&db)?, "nothing was removed");
    assert_eq!(projection(&db, "a3-source")?, holder_projection);
    assert!(a2_available(&db, &holder_revision)?);
    Ok(())
}

fn set_scope_holder(db: &Database, scene: &str, tag: &str, character: &str) -> Result<()> {
    db.with_conn(|conn| {
        crate::narrative_extraction::scene_scope::ensure_scene_scope_binding_in_tx(
            conn,
            PROJECT,
            scene,
            "2026-10-18T16:20:00.000Z",
        )
    })?;
    let current =
        db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, scene))?;
    update_narrative_scene_scope(
        db,
        NarrativeSceneScopeUpdatePayload {
            project_id: PROJECT.to_owned(),
            scene_id: scene.to_owned(),
            request_id: format!("x13-holder-{tag}"),
            session_id: "x13-session".to_owned(),
            event_uid: format!("x13-holder-event-{tag}"),
            base_version: current.binding.version,
            updated_at: "2026-10-18T16:30:00.000Z".to_owned(),
            scope: NarrativeSceneScopeUpdateV1 {
                schema_version: 1,
                compatibility_marker: current.binding.compatibility_marker,
                query_identity: current.binding.query_identity.clone(),
                material_constraint: current.binding.material_constraint.clone(),
                knowledge_holder: NarrativeScopePrincipalV1::Character {
                    reference: character.to_owned(),
                },
                audience: current.binding.audience.clone(),
            },
        },
    )?;
    Ok(())
}

fn force_entry_type(db: &Database, entry: &str, type_slug: &str) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE codex_entries SET type = ?1 WHERE id = ?2",
            rusqlite::params![type_slug, entry],
        )?;
        Ok(())
    })
}

fn entry_type(db: &Database, entry: &str) -> Result<Option<String>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT type FROM codex_entries WHERE id = ?1",
                [entry],
                |row| row.get(0),
            )
            .ok())
    })
}

/// Test 9 (journal paths, continued). The two journal routes the creation
/// test does not reach, against a version 2 anchor Revision whose Scene names
/// the person as holder:
/// - a type-change journal: undoing it writes `character` back onto an entry
///   a stale holder still names, which invalidates that A1 and retires the
///   anchor's Revision (another Scene's Revision is untouched);
/// - a delete journal written before C1: its undo re-inserts the person under
///   a stale holder, which retires the anchor's Revision; the redo then fails
///   closed (and, once the holder is named again, is refused), and nothing
///   brings the Revision back without a new approval.
#[test]
fn x13_journal_type_change_and_pre_c1_delete_keep_anchor_revision_ineligible() -> Result<()> {
    use super::codex_operations::scope_journal_support::{
        create_character, delete_entry, replay_journal, retype_entry,
        rewrite_as_pre_c1_delete_journal,
    };

    // (1) Type-change journal undo.
    {
        let (db, _first) = approved_fixture()?;
        create_character(&db, PROJECT, "x13-typed", "Typed")?;
        let update_journal = retype_entry(&db, PROJECT, "x13-typed", 1, "location")?;
        assert_eq!(entry_type(&db, "x13-typed")?.as_deref(), Some("location"));
        // A reference that predates the guard: the entry is a character only
        // while the holder is written.
        force_entry_type(&db, "x13-typed", "character")?;
        set_scope_holder(&db, "a3-source", "typed", "x13-typed")?;
        drain_freshness(&db)?;
        let anchor_revision = approve_anchored(&db, &["a3-source"], "nir1:review:x13-typed-a")?;
        let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-typed-b")?;
        assert!(a2_available(&db, &anchor_revision)?);
        assert!(a2_available(&db, &other_revision)?);
        let approved = projection(&db, "a3-source")?;
        let other_projection = projection(&db, "a3-future")?;
        force_entry_type(&db, "x13-typed", "location")?;
        // The stale holder fails closed while the entry is not a character.
        // The undo below makes it a character again, so the Revision would
        // become readable unless the undo invalidates that A1.
        assert!(!a2_available(&db, &anchor_revision)?, "stale holder");
        assert!(a2_available(&db, &other_revision)?);

        replay_journal(&db, PROJECT, &update_journal, "undo")?;
        assert_eq!(entry_type(&db, "x13-typed")?.as_deref(), Some("character"));
        let invalidated =
            db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, "a3-source"))?;
        assert_eq!(
            invalidated.binding.knowledge_holder,
            NarrativeScopePrincipalV1::Reader {}
        );
        assert_ne!(projection(&db, "a3-source")?, approved);
        assert!(
            !a2_available(&db, &anchor_revision)?,
            "A1 invalidated by the type-change undo"
        );
        assert!(a2_available(&db, &other_revision)?);
        assert_eq!(projection(&db, "a3-future")?, other_projection);
        drain_freshness(&db)?;
        assert!(!a2_available(&db, &anchor_revision)?);
        assert!(a2_available(&db, &other_revision)?);

        // Naming the person again does not bring the old Revision back.
        set_scope_holder(&db, "a3-source", "typed-again", "x13-typed")?;
        drain_freshness(&db)?;
        assert!(!a2_available(&db, &anchor_revision)?, "needs a new approval");
        assert!(a2_available(&db, &other_revision)?);
    }

    // (2) A delete journal written before C1.
    {
        let (db, _first) = approved_fixture()?;
        create_character(&db, PROJECT, "x13-legacy", "Legacy")?;
        set_scope_holder(&db, "a3-source", "legacy", "x13-legacy")?;
        drain_freshness(&db)?;
        let anchor_revision = approve_anchored(&db, &["a3-source"], "nir1:review:x13-legacy-a")?;
        let other_revision = approve_anchored(&db, &["a3-future"], "nir1:review:x13-legacy-b")?;
        assert!(a2_available(&db, &anchor_revision)?);
        let approved = projection(&db, "a3-source")?;
        let other_projection = projection(&db, "a3-future")?;

        // Reproduce a reference that outlived its person: detach the holder,
        // delete, then put the saved binding row back.
        let saved = db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT knowledge_holder_json FROM narrative_scene_scope_bindings
                  WHERE scene_id = 'a3-source'",
                [],
                |row| row.get::<_, String>(0),
            )?)
        })?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_scene_scope_bindings
                    SET knowledge_holder_json = '{\"kind\":\"reader\"}'
                  WHERE scene_id = 'a3-source'",
                [],
            )?;
            Ok(())
        })?;
        let delete_journal = delete_entry(&db, PROJECT, "x13-legacy", 1)?;
        assert_eq!(entry_type(&db, "x13-legacy")?, None);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_scene_scope_bindings SET knowledge_holder_json = ?1
                  WHERE scene_id = 'a3-source'",
                [&saved],
            )?;
            Ok(())
        })?;
        rewrite_as_pre_c1_delete_journal(&db, &delete_journal)?;
        // Same shape as above: the holder names a person who no longer exists,
        // and re-inserting the person would make the Revision readable again
        // unless the undo invalidates that A1.
        assert!(!a2_available(&db, &anchor_revision)?, "stale holder");
        assert!(a2_available(&db, &other_revision)?);

        replay_journal(&db, PROJECT, &delete_journal, "undo")?;
        assert_eq!(entry_type(&db, "x13-legacy")?.as_deref(), Some("character"));
        let invalidated =
            db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, "a3-source"))?;
        assert_eq!(
            invalidated.binding.knowledge_holder,
            NarrativeScopePrincipalV1::Reader {}
        );
        assert_ne!(projection(&db, "a3-source")?, approved);
        assert!(
            !a2_available(&db, &anchor_revision)?,
            "person re-inserted by the pre-C1 undo"
        );
        assert!(a2_available(&db, &other_revision)?);
        assert_eq!(projection(&db, "a3-future")?, other_projection);

        // The pre-C1 redo has no before/after state to build its Feed event
        // from, so it fails closed and changes nothing.
        let after_undo = projection(&db, "a3-source")?;
        let failed = replay_journal(&db, PROJECT, &delete_journal, "redo")
            .expect_err("a pre-C1 delete redo fails closed");
        assert!(
            failed.to_string().contains("no before or after state"),
            "{failed:#}"
        );
        assert_eq!(entry_type(&db, "x13-legacy")?.as_deref(), Some("character"));
        assert_eq!(projection(&db, "a3-source")?, after_undo);
        assert!(!a2_available(&db, &anchor_revision)?);

        // Naming the person again makes the redo a refused route; the old
        // Revision still needs a new approval.
        set_scope_holder(&db, "a3-source", "legacy-again", "x13-legacy")?;
        drain_freshness(&db)?;
        let refused = replay_journal(&db, PROJECT, &delete_journal, "redo")
            .expect_err("a holder cannot be removed through the journal");
        assert!(
            refused
                .to_string()
                .contains("NEX_SCENE_SCOPE_CHARACTER_REFERENCED"),
            "{refused:#}"
        );
        assert_eq!(entry_type(&db, "x13-legacy")?.as_deref(), Some("character"));
        assert!(!a2_available(&db, &anchor_revision)?, "still retired");
        assert!(a2_available(&db, &other_revision)?);
    }
    Ok(())
}

/// DR-X1-3-14. Graph's own consumer edges are its roster's Sources
/// (`codex:`, `codex-relation:`, Evidence keys) and the Graph Source itself;
/// a Revision's Scene Scope projection is not among them. So the edges the
/// publish transaction re-checks do not grow with the anchors, and neither do
/// its Scope reads. Both projects below hold three approved Revisions (every
/// per-Revision read is the same); the first anchors all of them to one Scene,
/// the second to three Scenes.
#[test]
fn x13_graph_publish_reads_the_scope_once_for_any_number_of_anchors() -> Result<()> {
    use crate::narrative_extraction::nir1_capacity::project_read_probe::{self, Read};
    use crate::narrative_extraction::nir1_entity_relation_index::{
        prepare_graph_index_build, publish_nir1_entity_relation_index_in_tx,
    };

    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let publish_with = |anchors: [&str; 2]| -> Result<(i64, i64, std::collections::BTreeMap<Read, usize>)> {
        let directory =
            std::env::temp_dir().join(format!("nir1-x13-publish-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory)?;
        let _cleanup = Cleanup(directory.clone());
        let db = Database::new(&directory.join("grimodex.db"))?;
        db.migrate()?;
        // The fixture's own Revision anchors `a3-source`.
        let (db, _seed) = approved_fixture_in(db)?;
        approve_anchored(&db, &[anchors[0]], "nir1:review:x13-publish-1")?;
        approve_anchored(&db, &[anchors[1]], "nir1:review:x13-publish-2")?;
        let authority = crate::state::WorkspaceAuthority::from_database_for_test(db, directory.clone())?;
        let anchor_edges: i64 = authority.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(DISTINCT source_object_identity)
                   FROM narrative_dependency_edges
                  WHERE consumer_kind = 'proposal-revision'
                    AND source_object_identity LIKE 'project:scene-scope-projection:%'",
                [],
                |row| row.get(0),
            )?)
        })?;
        let runtime = authority.nir_chronicle_index_runtime();
        let snapshot = authority
            .with_read_transaction(|conn| prepare_graph_index_build(conn, runtime, PROJECT))?;
        let (published, reads) = project_read_probe::recording(|| {
            authority.with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                publish_nir1_entity_relation_index_in_tx(&tx, runtime, snapshot)?;
                tx.commit()?;
                Ok(())
            })
        });
        published?;
        let graph_projection: i64 = authority.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE consumer_kind = 'semantic-index'
                    AND source_object_identity LIKE 'project:scene-scope-projection:%'",
                [],
                |row| row.get(0),
            )?)
        })?;
        Ok((anchor_edges, graph_projection, reads))
    };

    let (one_edge, one_graph, one) = publish_with(["a3-source", "a3-source"])?;
    let (three_edges, three_graph, three) = publish_with(["a3-future", "nir1"])?;
    let graph_projection_edges = (one_graph, three_graph);
    assert_eq!((one_edge, three_edges), (1, 3), "Revisions' projection edges");
    assert_eq!(graph_projection_edges, (0, 0), "Graph edges never name a projection");
    assert_eq!(
        one.get(&Read::AuthorityTree),
        three.get(&Read::AuthorityTree),
        "{one:?} {three:?}"
    );
    assert_eq!(
        one.get(&Read::ScopeExtension),
        three.get(&Read::ScopeExtension),
        "{one:?} {three:?}"
    );
    Ok(())
}

/// Measurement (not an assertion of speed; run with `-- --ignored --nocapture`).
/// A projection edge's evaluation reads the project Scope authority and the
/// Scene bindings once (DR-X1-3-13), so a Revision with k anchors costs about
/// 2k such reads in an incremental cycle. This prints the time of one read
/// for projects of different Scene counts, so k and the project size can be
/// combined. Debug build, in-memory database.
#[test]
#[ignore = "measurement for DR-X1-3-13"]
fn x13_authority_read_time_by_scene_count() -> Result<()> {
    use crate::narrative_extraction::project_scope_authority::load_live_project_scope_authority_with_scene_bindings;
    use crate::narrative_extraction::scene_scope::ensure_scene_scope_binding_in_tx;
    for scenes in [3usize, 64, 512] {
        let db = crate::test_support::fresh_migrated_memory()?;
        db.with_conn(|conn| {
            for index in 0..scenes {
                let id = format!("m-scene-{index:04}");
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
                     VALUES (?1, ?2, 'scene', 'Scene', '{}', ?3)",
                    rusqlite::params![id, PROJECT, format!("a{index:05}")],
                )?;
                ensure_scene_scope_binding_in_tx(conn, PROJECT, &id, "2026-10-18T00:00:00.000Z")?;
            }
            Ok(())
        })?;
        let rounds = 20;
        let started = std::time::Instant::now();
        for _ in 0..rounds {
            db.with_read_transaction(|conn| {
                load_live_project_scope_authority_with_scene_bindings(
                    conn,
                    PROJECT,
                    &format!("project:scope-authority:{PROJECT}"),
                )?;
                Ok(())
            })?;
        }
        let per_read = started.elapsed() / rounds;
        println!("x13-measure scenes={scenes} one_read={per_read:?}");
    }
    Ok(())
}

/// Measurement for DR-X1-3-15 (`-- --ignored --nocapture`). A folder move
/// refreshes the Scope generation of every live Scene below it, so its time
/// grows with the subtree. Debug build, in-memory database.
#[test]
#[ignore = "measurement for DR-X1-3-15"]
fn x13_folder_move_time_by_subtree_size() -> Result<()> {
    use crate::narrative_extraction::scene_scope::ensure_scene_scope_binding_in_tx;
    for scenes in [1usize, 64, 512] {
        let (db, _revision) = approved_fixture()?;
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
                 VALUES ('m-folder', ?1, 'folder', 'Folder', '{}', 'z0')",
                [PROJECT],
            )?;
            for index in 0..scenes {
                let id = format!("m-scene-{index:04}");
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, content, sort_order)
                     VALUES (?1, ?2, 'm-folder', 'scene', 'Scene', '{}', ?3)",
                    rusqlite::params![id, PROJECT, format!("a{index:05}")],
                )?;
                ensure_scene_scope_binding_in_tx(conn, PROJECT, &id, "2026-10-18T00:00:00.000Z")?;
            }
            Ok(())
        })?;
        let started = std::time::Instant::now();
        patch(
            &db,
            "m-folder",
            "measure-move",
            "sortOrder",
            json!("z5"),
            true,
            "2026-10-18T17:00:00.000Z",
        )?;
        let moved = started.elapsed();
        let started = std::time::Instant::now();
        drain_freshness(&db)?;
        println!(
            "x13-measure subtree_scenes={scenes} folder_move={moved:?} freshness_cycle={:?}",
            started.elapsed()
        );
    }
    Ok(())
}

/// Observation for F10 (not a pass/fail condition of X1). A request is
/// prepared against a Revision's eligibility proof; a save lands between the
/// preparation and the return, which revalidates the proof
/// (`revalidate_nir1_entity_relation_disclosure`). Recorded outcome: any save,
/// of the query Scene, the anchor or an unrelated Scene, makes the return fail
/// closed, because the Revision's canonical Freshness snapshot (and so the
/// proof's Freshness token) carries the Feed coordinates. The Scope side of the
/// proof does not change for a body save: the project token, the query Scene's
/// Scope token and the material Scene proofs (the anchors' projections' source)
/// are equal. The same save therefore does not retire the Revision for a new
/// request (`x13_new_request_qualifies_after_other_scene_save`).
#[test]
fn x13_return_revalidation_observation() -> Result<()> {
    use crate::narrative_extraction::{
        evaluate_nir1_entity_relation_disclosure, revalidate_nir1_entity_relation_disclosure,
        Nir1EntityRelationDisclosureRead,
    };
    let (db, revision_id) = approved_fixture()?;
    let evaluate = |db: &Database| {
        db.with_read_transaction(|conn| {
            match evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &revision_id, "nir1")? {
                Nir1EntityRelationDisclosureRead::Eligible(proof) => Ok(proof),
                Nir1EntityRelationDisclosureRead::Unavailable { reason } => {
                    anyhow::bail!("fixture unavailable: {reason}")
                }
            }
        })
    };
    let proof = evaluate(&db)?;
    let valid = |db: &Database| -> Result<bool> {
        db.with_read_transaction(|conn| revalidate_nir1_entity_relation_disclosure(conn, &proof))
    };
    assert!(valid(&db)?, "before any save");
    for (scene, tag) in [
        ("a3-future", "f10-other"),
        ("a3-source", "f10-anchor"),
        ("nir1", "f10-query"),
    ] {
        save_body(&db, scene, tag, "2026-10-18T18:00:00.000Z")?;
        let current = evaluate(&db)?;
        assert_eq!(
            current.scope_authority_revision, proof.scope_authority_revision,
            "{scene}: project token"
        );
        assert_eq!(
            current.query_scene_scope_token, proof.query_scene_scope_token,
            "{scene}: query Scene Scope token"
        );
        assert_eq!(
            current.material_scene_proofs.len(),
            proof.material_scene_proofs.len()
        );
        assert_ne!(
            current.freshness_token, proof.freshness_token,
            "{scene}: the Freshness token moves with the Feed"
        );
        assert!(!valid(&db)?, "{scene}: the return fails closed");
    }
    Ok(())
}
