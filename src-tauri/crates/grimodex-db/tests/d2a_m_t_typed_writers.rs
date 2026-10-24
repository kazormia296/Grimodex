//! NIR-1 DA-2b M and T (DR-DA2-51, DR-DA2-52): the typed Native writers for
//! the version history, the project snapshot deletion and the Impact Review
//! baseline's visibility metadata. Each test pins the renderer's current
//! result (D-11: the same rows as the generic SQL it replaces) and the typed
//! refusals.

#[path = "../test-support/adapter.rs"]
mod test_support;

use grimodex_db::impact_review_baselines::{
    stable_hash, update_visibility, ImpactBaselineWriteRefusal, UpdateVisibilityRequest,
};
use grimodex_db::revision_writes::{
    create_revision, delete_project_snapshot, prune_revisions, CreateRevisionRequest,
    DeleteProjectSnapshotRequest, PruneRevisionsRequest, RevisionEntityType, RevisionSnapshotType,
    RevisionWriteRefusal,
};
use grimodex_db::Database;
use serde_json::Value;

fn fixture() -> Database {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p1', 'One'), ('p2', 'Two');
             INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, version)
               VALUES ('scene-1', 'p1', 'scene', 'Scene', 'a0', 0),
                      ('note-1', 'p1', 'note', 'Note', 'a1', 0),
                      ('scene-2', 'p2', 'scene', 'Other', 'a0', 0),
                      ('note-2', 'p2', 'note', 'Other note', 'a1', 0);
             INSERT INTO codex_entries (id, project_id, name) VALUES ('codex-1', 'p1', 'Entry');
             INSERT INTO snippets (id, project_id, title) VALUES ('snippet-1', 'p1', 'Snip');",
        )?;
        Ok(())
    })
    .expect("seed fixture");
    db
}

fn create(
    db: &Database,
    entity_type: RevisionEntityType,
    entity: &str,
    content: &str,
) -> anyhow::Result<grimodex_db::revision_writes::CreatedRevision> {
    create_revision(
        db,
        CreateRevisionRequest {
            project_id: "p1".into(),
            entity_type,
            entity_id: entity.into(),
            content: content.into(),
            snapshot_type: RevisionSnapshotType::Auto,
        },
    )
}

fn versions(db: &Database, entity: &str) -> Vec<(i64, String, String)> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT version_number, content, snapshot_type FROM content_versions
              WHERE entity_id = ?1 ORDER BY version_number",
        )?;
        let rows = statement
            .query_map([entity], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("read versions")
}

fn count(db: &Database, sql: &str) -> i64 {
    db.with_conn(|conn| Ok(conn.query_row(sql, [], |row| row.get(0))?))
        .expect("count")
}

#[test]
fn revision_create_numbers_versions_and_skips_an_identical_latest_body() {
    let db = fixture();
    let first = create(&db, RevisionEntityType::Scene, "scene-1", "{\"a\":1}").expect("first");
    assert!(first.created);
    assert_eq!(first.version_number, 1);
    assert_eq!(
        first.created_at.len(),
        24,
        "toISOString shape: {}",
        first.created_at
    );
    let same = create(&db, RevisionEntityType::Scene, "scene-1", "{\"a\":1}").expect("same");
    assert!(!same.created);
    assert_eq!(
        (same.id.as_str(), same.version_number),
        (first.id.as_str(), 1)
    );
    let second = create(&db, RevisionEntityType::Scene, "scene-1", "{\"a\":2}").expect("second");
    assert!(second.created);
    assert_eq!(second.version_number, 2);
    // A body equal to an older (not the latest) version is recorded again.
    let back = create(&db, RevisionEntityType::Scene, "scene-1", "{\"a\":1}").expect("back");
    assert!(back.created);
    assert_eq!(back.version_number, 3);
    // The editor records any tree binding as `scene`, notes included.
    assert!(
        create(&db, RevisionEntityType::Scene, "note-1", "{}")
            .expect("note as scene")
            .created
    );
    assert!(
        create(&db, RevisionEntityType::CodexEntry, "codex-1", "{}")
            .expect("codex")
            .created
    );
    assert!(
        create(&db, RevisionEntityType::Snippet, "snippet-1", "{}")
            .expect("snippet")
            .created
    );
    // The result carries no body (wire shape).
    assert_eq!(
        serde_json::to_value(&second)
            .expect("wire")
            .as_object()
            .expect("object")
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ["created", "id", "versionNumber", "createdAt"]
    );
}

#[test]
fn revision_create_matches_the_current_generic_sql_rows() {
    let current = fixture();
    let next = fixture();
    // The renderer's current INSERT (createRevision) with its max+1 subquery.
    for content in ["{\"a\":1}", "{\"a\":2}"] {
        current
            .execute_renderer(
                "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type, created_at)
                 VALUES (?, 'scene', 'scene-1', ?, (SELECT coalesce(max(version_number), 0) + 1 FROM content_versions WHERE entity_type = 'scene' AND entity_id = 'scene-1'), 'manual', '2026-10-25T00:00:00.000Z')",
                &[Value::from(uuid_like(content)), Value::from(content)],
                "run",
            )
            .expect("generic insert");
        create_revision(
            &next,
            CreateRevisionRequest {
                project_id: "p1".into(),
                entity_type: RevisionEntityType::Scene,
                entity_id: "scene-1".into(),
                content: content.into(),
                snapshot_type: RevisionSnapshotType::Manual,
            },
        )
        .expect("typed insert");
    }
    assert_eq!(versions(&next, "scene-1"), versions(&current, "scene-1"));
    // The entity type and the `toISOString()` shape of created_at (the
    // renderer passed `new Date().toISOString()`; review P3-3).
    assert_eq!(row_shapes(&next), row_shapes(&current));
}

/// (entity_type, created_at's `YYYY-MM-DDTHH:MM:SS.mmmZ` shape) per version.
fn row_shapes(db: &Database) -> Vec<(String, bool)> {
    db.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT entity_type, created_at FROM content_versions ORDER BY version_number",
        )?;
        let rows = statement
            .query_map([], |row| {
                let created_at: String = row.get(1)?;
                let bytes = created_at.as_bytes();
                let iso = bytes.len() == 24
                    && bytes[10] == b'T'
                    && bytes[19] == b'.'
                    && bytes[23] == b'Z';
                Ok((row.get(0)?, iso))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .expect("read shapes")
}

fn uuid_like(seed: &str) -> String {
    format!("generic-{}", stable_hash(seed))
}

#[test]
fn revision_writers_refuse_entities_outside_the_project() {
    let db = fixture();
    let refusal =
        create(&db, RevisionEntityType::Scene, "scene-2", "{}").expect_err("other project");
    assert_eq!(
        refusal.downcast_ref::<RevisionWriteRefusal>(),
        Some(&RevisionWriteRefusal::NotFound)
    );
    assert_eq!(format!("{refusal}"), "REVISION_WRITE_REFUSED:not-found");
    let refusal = prune_revisions(
        &db,
        PruneRevisionsRequest {
            project_id: "p1".into(),
            entity_type: RevisionEntityType::Scene,
            entity_id: "scene-1".into(),
            keep_count: -1,
        },
    )
    .expect_err("negative keep count");
    assert_eq!(
        format!("{refusal}"),
        "REVISION_WRITE_REFUSED:invalid-request"
    );
    assert_eq!(count(&db, "SELECT count(*) FROM content_versions"), 0);
}

#[test]
fn revision_prune_keeps_the_newest_manual_and_snapshot_referenced_versions() {
    let db = fixture();
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type)
               VALUES ('v1', 'scene', 'scene-1', '1', 1, 'auto'),
                      ('v2', 'scene', 'scene-1', '2', 2, 'manual'),
                      ('v3', 'scene', 'scene-1', '3', 3, 'auto'),
                      ('v4', 'scene', 'scene-1', '4', 4, 'auto'),
                      ('v5', 'scene', 'scene-1', '5', 5, 'auto'),
                      ('v6', 'scene', 'scene-1', '6', 6, 'auto'),
                      ('other', 'scene', 'note-1', 'x', 1, 'auto');
             INSERT INTO project_snapshots (id, project_id, name) VALUES ('snap', 'p1', 'S');
             INSERT INTO project_snapshot_tree_nodes (snapshot_id, node_id, node_type, title, sort_order, body_version_id, created_at, updated_at)
               VALUES ('snap', 'scene-1', 'scene', 'Scene', 'a0', 'v3', 'T', 'T');",
        )?;
        Ok(())
    })
    .expect("seed versions");
    let pruned = prune_revisions(
        &db,
        PruneRevisionsRequest {
            project_id: "p1".into(),
            entity_type: RevisionEntityType::Scene,
            entity_id: "scene-1".into(),
            keep_count: 2,
        },
    )
    .expect("prune");
    // Older than the newest 2 (v6, v5): v4, v3 (referenced), v2 (manual), v1.
    assert_eq!(pruned.deleted, 2);
    assert_eq!(
        versions(&db, "scene-1")
            .iter()
            .map(|(number, _, _)| *number)
            .collect::<Vec<_>>(),
        [2, 3, 5, 6]
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM content_versions WHERE id = 'other'"
        ),
        1
    );
    // keepCount above the count deletes nothing.
    let none = prune_revisions(
        &db,
        PruneRevisionsRequest {
            project_id: "p1".into(),
            entity_type: RevisionEntityType::Scene,
            entity_id: "scene-1".into(),
            keep_count: 50,
        },
    )
    .expect("prune nothing");
    assert_eq!(none.deleted, 0);
}

#[test]
fn snapshot_delete_cascades_children_and_keeps_versions() {
    let db = fixture();
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number)
               VALUES ('v1', 'scene', 'scene-1', '{}', 1);
             INSERT INTO project_snapshots (id, project_id, name) VALUES ('snap-1', 'p1', 'A'), ('snap-2', 'p2', 'B');
             INSERT INTO project_snapshot_entries (snapshot_id, version_id) VALUES ('snap-1', 'v1');
             INSERT INTO project_snapshot_tree_nodes (snapshot_id, node_id, node_type, title, sort_order, body_version_id, created_at, updated_at)
               VALUES ('snap-1', 'scene-1', 'scene', 'Scene', 'a0', 'v1', 'T', 'T');
             INSERT INTO project_snapshot_codex_entries (snapshot_id, entry_id, type, name, context_mode, children_budget, body_version_id)
               VALUES ('snap-1', 'codex-1', 'lore', 'Entry', 'mentioned', 'compact', 'v1');
             INSERT INTO project_snapshot_snippets (snapshot_id, snippet_id, title, body_version_id)
               VALUES ('snap-1', 'snippet-1', 'Snip', 'v1');
             INSERT INTO project_snapshot_aux (snapshot_id, scope, payload_json) VALUES ('snap-1', 'labels', '[]');",
        )?;
        Ok(())
    })
    .expect("seed snapshots");
    // Another project's snapshot is not deleted through p1.
    let other = delete_project_snapshot(
        &db,
        DeleteProjectSnapshotRequest {
            project_id: "p1".into(),
            snapshot_id: "snap-2".into(),
        },
    )
    .expect("other project");
    assert_eq!(other.deleted, 0);
    let deleted = delete_project_snapshot(
        &db,
        DeleteProjectSnapshotRequest {
            project_id: "p1".into(),
            snapshot_id: "snap-1".into(),
        },
    )
    .expect("delete snapshot");
    assert_eq!(deleted.deleted, 1);
    for table in [
        "project_snapshot_entries",
        "project_snapshot_tree_nodes",
        "project_snapshot_codex_entries",
        "project_snapshot_snippets",
        "project_snapshot_aux",
    ] {
        assert_eq!(
            count(&db, &format!("SELECT count(*) FROM {table}")),
            0,
            "{table}"
        );
    }
    assert_eq!(count(&db, "SELECT count(*) FROM project_snapshots"), 1);
    assert_eq!(count(&db, "SELECT count(*) FROM content_versions"), 1);
}

fn seed_baseline(db: &Database, snapshot_json: &str) -> String {
    let hash = stable_hash(snapshot_json);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO impact_review_baselines (entry_id, project_id, snapshot_json, content_hash, reviewed_at)
             VALUES ('codex-1', 'p1', ?1, ?2, 'R')",
            rusqlite::params![snapshot_json, hash],
        )?;
        Ok(())
    })
    .expect("seed baseline");
    hash
}

fn visibility_request(expected: &str, snapshot_json: &str) -> UpdateVisibilityRequest {
    UpdateVisibilityRequest {
        project_id: "p1".into(),
        entry_id: "codex-1".into(),
        expected_content_hash: expected.into(),
        snapshot_json: snapshot_json.into(),
        content_hash: stable_hash(snapshot_json),
    }
}

const STORED: &str = r#"{"allPhaseIds":["a","b"],"phases":[{"phaseId":"a","body":"x"}],"restrictedPhaseIds":[],"visibilityProvenanceVersion":1}"#;
const RESTRICTED: &str = r#"{"allPhaseIds":["a","b"],"phases":[{"body":"x","phaseId":"a"}],"restrictedPhaseIds":["a","b"],"visibilityProvenanceVersion":1,"visibleDeletedPhaseIds":[]}"#;

#[test]
fn baseline_visibility_update_is_a_hash_checked_cas() {
    let db = fixture();
    let stored_hash = seed_baseline(&db, STORED);
    let updated =
        update_visibility(&db, visibility_request(&stored_hash, RESTRICTED)).expect("update");
    assert!(updated.updated);
    let row: (String, String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT snapshot_json, content_hash, reviewed_at FROM impact_review_baselines",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("read baseline");
    assert_eq!(
        row,
        (
            RESTRICTED.to_string(),
            stable_hash(RESTRICTED),
            "R".to_string()
        )
    );
    // A stale expected hash loses the CAS and changes nothing.
    let stale = update_visibility(&db, visibility_request(&stored_hash, STORED)).expect("stale");
    assert!(!stale.updated);
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT count(*) FROM impact_review_baselines WHERE content_hash = '{}'",
                stable_hash(RESTRICTED)
            )
        ),
        1
    );
    // A missing baseline is not an error either.
    let mut missing = visibility_request(&stable_hash(RESTRICTED), STORED);
    missing.entry_id = "gone".into();
    assert!(!update_visibility(&db, missing).expect("missing").updated);
}

#[test]
fn baseline_visibility_update_refuses_other_changes() {
    let db = fixture();
    let stored_hash = seed_baseline(&db, STORED);
    let refusal = |request: UpdateVisibilityRequest| {
        let error = update_visibility(&db, request).expect_err("expected a refusal");
        *error
            .downcast_ref::<ImpactBaselineWriteRefusal>()
            .unwrap_or_else(|| panic!("untyped refusal: {error:#}"))
    };
    let mut wrong_hash = visibility_request(&stored_hash, RESTRICTED);
    wrong_hash.content_hash = "00000000".into();
    assert_eq!(
        refusal(wrong_hash),
        ImpactBaselineWriteRefusal::HashMismatch
    );
    let body_change = r#"{"allPhaseIds":["a","b"],"phases":[{"phaseId":"a","body":"changed"}],"restrictedPhaseIds":["a"],"visibilityProvenanceVersion":1}"#;
    assert_eq!(
        refusal(visibility_request(&stored_hash, body_change)),
        ImpactBaselineWriteRefusal::NotVisibilityOnly
    );
    let bad_ids = r#"{"allPhaseIds":["a","b"],"phases":[{"phaseId":"a","body":"x"}],"restrictedPhaseIds":[1],"visibilityProvenanceVersion":1}"#;
    assert_eq!(
        refusal(visibility_request(&stored_hash, bad_ids)),
        ImpactBaselineWriteRefusal::InvalidRequest
    );
    assert_eq!(
        refusal(visibility_request(&stored_hash, "[]")),
        ImpactBaselineWriteRefusal::InvalidRequest
    );
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT count(*) FROM impact_review_baselines WHERE content_hash = '{stored_hash}'"
            )
        ),
        1
    );
}

/// Review F-1: each of the four snapshot references keeps its version (a
/// prune that ignored one would hit the RESTRICT foreign key and fail every
/// time, the regression `revision/api.ts` describes).
#[test]
fn revision_prune_keeps_a_version_referenced_by_each_snapshot_table() {
    let db = fixture();
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type)
               VALUES ('v1', 'scene', 'scene-1', '1', 1, 'auto'),
                      ('v2', 'scene', 'scene-1', '2', 2, 'auto'),
                      ('v3', 'scene', 'scene-1', '3', 3, 'auto'),
                      ('v4', 'scene', 'scene-1', '4', 4, 'auto'),
                      ('v5', 'scene', 'scene-1', '5', 5, 'auto'),
                      ('v6', 'scene', 'scene-1', '6', 6, 'auto'),
                      ('v7', 'scene', 'scene-1', '7', 7, 'auto'),
                      ('v8', 'scene', 'scene-1', '8', 8, 'auto');
             INSERT INTO project_snapshots (id, project_id, name) VALUES ('snap', 'p1', 'S');
             INSERT INTO project_snapshot_entries (snapshot_id, version_id) VALUES ('snap', 'v1');
             INSERT INTO project_snapshot_tree_nodes (snapshot_id, node_id, node_type, title, sort_order, body_version_id, created_at, updated_at)
               VALUES ('snap', 'scene-1', 'scene', 'Scene', 'a0', 'v2', 'T', 'T');
             INSERT INTO project_snapshot_codex_entries (snapshot_id, entry_id, type, name, context_mode, children_budget, body_version_id)
               VALUES ('snap', 'codex-1', 'lore', 'Entry', 'mentioned', 'compact', 'v3');
             INSERT INTO project_snapshot_snippets (snapshot_id, snippet_id, title, body_version_id)
               VALUES ('snap', 'snippet-1', 'Snip', 'v4');",
        )?;
        Ok(())
    })
    .expect("seed referenced versions");
    let pruned = prune_revisions(
        &db,
        PruneRevisionsRequest {
            project_id: "p1".into(),
            entity_type: RevisionEntityType::Scene,
            entity_id: "scene-1".into(),
            keep_count: 2,
        },
    )
    .expect("prune succeeds with every reference in place");
    // Older than the newest 2 (v8, v7): v1..v4 are referenced, v5 and v6 go.
    assert_eq!(pruned.deleted, 2);
    assert_eq!(
        versions(&db, "scene-1")
            .iter()
            .map(|(number, _, _)| *number)
            .collect::<Vec<_>>(),
        [1, 2, 3, 4, 7, 8]
    );
}

/// Review F-2 and P3-2: `note` (what `projectSnapshotApi.ts` passes for a
/// note node) is recorded and pruned on the project's `tree_nodes` row of
/// any node type, as `scene` is; another project's node, a Codex id and an
/// entity of another project are refused by both writers.
#[test]
fn note_versions_are_bound_to_the_projects_tree_nodes() {
    let db = fixture();
    assert!(
        create(&db, RevisionEntityType::Note, "note-1", "{\"n\":1}")
            .expect("note")
            .created
    );
    assert!(
        create(&db, RevisionEntityType::Note, "note-1", "{\"n\":2}")
            .expect("note again")
            .created
    );
    // Any tree binding: the node type does not narrow `note` (or `scene`).
    assert!(
        create(&db, RevisionEntityType::Note, "scene-1", "{}")
            .expect("note on a scene node")
            .created
    );
    for (entity_type, entity) in [
        (RevisionEntityType::Note, "note-2"),
        (RevisionEntityType::Note, "codex-1"),
        (RevisionEntityType::Scene, "codex-1"),
        (RevisionEntityType::CodexEntry, "note-1"),
        (RevisionEntityType::Snippet, "note-1"),
    ] {
        let refusal = create(&db, entity_type, entity, "{}").expect_err("outside the project");
        assert_eq!(
            refusal.downcast_ref::<RevisionWriteRefusal>(),
            Some(&RevisionWriteRefusal::NotFound),
            "{entity_type:?} {entity}"
        );
    }
    let pruned = prune_revisions(
        &db,
        PruneRevisionsRequest {
            project_id: "p1".into(),
            entity_type: RevisionEntityType::Note,
            entity_id: "note-1".into(),
            keep_count: 1,
        },
    )
    .expect("prune note");
    assert_eq!(pruned.deleted, 1);
    assert_eq!(
        count(&db, "SELECT count(*) FROM content_versions WHERE entity_type = 'note' AND entity_id = 'note-1'"),
        1
    );
    // The prune of another project's entity is refused before it deletes.
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type)
               VALUES ('o1', 'note', 'note-2', 'a', 1, 'auto'), ('o2', 'note', 'note-2', 'b', 2, 'auto');",
        )?;
        Ok(())
    })
    .expect("seed the other project's versions");
    let refusal = prune_revisions(
        &db,
        PruneRevisionsRequest {
            project_id: "p1".into(),
            entity_type: RevisionEntityType::Note,
            entity_id: "note-2".into(),
            keep_count: 0,
        },
    )
    .expect_err("other project's note");
    assert_eq!(format!("{refusal}"), "REVISION_WRITE_REFUSED:not-found");
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM content_versions WHERE entity_id = 'note-2'"
        ),
        2
    );
}

/// Review P3-2 (f): the baseline is looked up by project as well as entry.
/// A request naming another project does not reach the p1 row, so even a
/// body change is no refusal there, just `updated: false`.
#[test]
fn baseline_visibility_update_is_bound_to_the_project() {
    let db = fixture();
    let stored_hash = seed_baseline(&db, STORED);
    let body_change = r#"{"allPhaseIds":["a","b"],"phases":[{"phaseId":"a","body":"changed"}],"restrictedPhaseIds":["a"],"visibilityProvenanceVersion":1}"#;
    for snapshot_json in [RESTRICTED, body_change] {
        let mut request = visibility_request(&stored_hash, snapshot_json);
        request.project_id = "p2".into();
        assert!(
            !update_visibility(&db, request)
                .expect("another project's request")
                .updated
        );
    }
    assert_eq!(
        count(
            &db,
            &format!(
                "SELECT count(*) FROM impact_review_baselines WHERE project_id = 'p1' AND content_hash = '{stored_hash}'"
            )
        ),
        1
    );
}
