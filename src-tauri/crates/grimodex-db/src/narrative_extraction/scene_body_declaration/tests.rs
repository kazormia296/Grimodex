#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use anyhow::Result;
use rusqlite::{params, types::Value as SqlValue, Connection};
use serde_json::{json, Value};

use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationV1, MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES,
};
use grimodex_core::narrative_scene_scope::{
    NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1, NarrativeScopePrincipalV1,
    NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
};

use super::test_support::*;
use super::*;
use crate::narrative_extraction::change_feed::{
    get_changes_since, validate_event, NarrativeChangeEventRecord,
};
use crate::narrative_extraction::task_leases::with_immediate_transaction;
use crate::narrative_extraction::{
    ensure_scene_scope_binding_in_tx, read_narrative_scene_scope, update_narrative_scene_scope,
    update_narrative_scene_scope_registry, NarrativeSceneScopeRegistryUpdatePayload,
    NarrativeSceneScopeUpdatePayload, NarrativeSceneScopeUpdateV1,
};
use crate::Database;

const NOW: &str = "2026-10-17T00:00:00.000Z";

fn fixture() -> Database {
    let db = crate::test_support::current_schema_memory().expect("schema fixture");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p1', 'P'), ('p2', 'Q');
             INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, content)
             VALUES ('s1', 'p1', 'scene', 'One', 'a0', '{\"type\":\"doc\"}'),
                    ('s2', 'p1', 'scene', 'Two', 'a1', '{\"type\":\"doc\"}'),
                    ('s3', 'p2', 'scene', 'Three', 'a0', '{\"type\":\"doc\"}');",
        )?;
        for (project, scene) in [("p1", "s1"), ("p1", "s2"), ("p2", "s3")] {
            ensure_scene_scope_binding_in_tx(conn, project, scene, NOW)?;
        }
        Ok(())
    })
    .expect("seed");
    db
}

fn in_tx<T>(db: &Database, operation: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    db.with_conn(|conn| with_immediate_transaction(conn, operation))
}

fn declare(db: &Database, project: &str, scene: &str) -> NarrativeSceneBodyDeclarationV1 {
    in_tx(db, |conn| {
        let declaration = test_declaration(conn, project, scene)?;
        set_scene_body_declaration_for_test(conn, &declaration)?;
        Ok(declaration)
    })
    .expect("declare")
}

fn read(db: &Database, project: &str, scene: &str) -> SceneBodyDeclarationRead {
    db.with_read_transaction(|conn| read_scene_body_declaration(conn, project, scene))
        .expect("read declaration")
}

fn raw(db: &Database, scene: &str, json_cell: SqlValue, token_cell: SqlValue) {
    db.with_conn(|conn| {
        set_raw_declaration_cells_for_test(conn, "p1", scene, json_cell, token_cell)
    })
    .expect("raw cells");
}

fn text(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

fn unavailable(reason: SceneBodyDeclarationUnavailableReason) -> SceneBodyDeclarationRead {
    SceneBodyDeclarationRead::Unavailable(reason)
}

// ---- reader -------------------------------------------------------------

#[test]
fn reader_returns_none_declared_and_marks_every_broken_state_unavailable() {
    use SceneBodyDeclarationUnavailableReason as Reason;
    let db = fixture();
    assert_eq!(read(&db, "p1", "s1"), SceneBodyDeclarationRead::None);

    let declaration = declare(&db, "p1", "s1");
    assert_eq!(
        read(&db, "p1", "s1"),
        SceneBodyDeclarationRead::Declared(StoredSceneBodyDeclaration {
            token: declaration.token().unwrap(),
            declaration: declaration.clone(),
        })
    );

    let json_text = declaration.canonical_json().unwrap();
    let token = declaration.token().unwrap();
    let mut value: Value = serde_json::from_str(&json_text).unwrap();

    // Only one of the two columns.
    raw(&db, "s2", text(&json_text), SqlValue::Null);
    assert_eq!(read(&db, "p1", "s2"), unavailable(Reason::HalfState));
    raw(&db, "s2", SqlValue::Null, text(&token));
    assert_eq!(read(&db, "p1", "s2"), unavailable(Reason::HalfState));

    // Unknown version, unknown field, token mismatch, malformed JSON.
    value["contractId"] = json!("narrative-scene-body-declaration/2");
    raw(&db, "s2", text(&value.to_string()), text(&token));
    assert_eq!(
        read(&db, "p1", "s2"),
        unavailable(Reason::UnsupportedVersion)
    );
    value["contractId"] = json!("narrative-scene-body-declaration/1");
    value["excerpt"] = json!("本文");
    raw(&db, "s2", text(&value.to_string()), text(&token));
    assert_eq!(read(&db, "p1", "s2"), unavailable(Reason::UnknownField));
    raw(&db, "s2", text("{not json"), text(&token));
    assert_eq!(read(&db, "p1", "s2"), unavailable(Reason::Malformed));
    // The declaration's own row, with a token that is not its token.
    raw(&db, "s1", text(&json_text), text("sha256:wrong"));
    assert_eq!(read(&db, "p1", "s1"), unavailable(Reason::TokenMismatch));
    raw(&db, "s1", text(&json_text), text(&token));

    // A declaration of another Scene copied into this row, with its own valid
    // token, is not this Scene's declaration.
    raw(&db, "s2", text(&json_text), text(&token));
    assert_eq!(read(&db, "p1", "s2"), unavailable(Reason::SceneKeyMismatch));

    // Cells that are not text.
    raw(&db, "s2", SqlValue::Integer(7), text(&token));
    assert_eq!(read(&db, "p1", "s2"), unavailable(Reason::Malformed));
    raw(&db, "s2", text(&json_text), SqlValue::Blob(vec![1, 2, 3]));
    assert_eq!(read(&db, "p1", "s2"), unavailable(Reason::Malformed));

    // No row for the Scene in this project.
    assert_eq!(
        read(&db, "p1", "s3"),
        unavailable(Reason::BindingRowMissing)
    );
    assert_eq!(
        read(&db, "p1", "missing"),
        unavailable(Reason::BindingRowMissing)
    );
    assert_eq!(
        read(&db, "p2", "s1"),
        unavailable(Reason::BindingRowMissing)
    );
}

#[test]
fn reader_rejects_oversized_declaration_before_reading_it() {
    use SceneBodyDeclarationUnavailableReason as Reason;
    let db = fixture();
    let declaration = declare(&db, "p1", "s1");
    let token = declaration.token().unwrap();
    // Valid JSON of the valid shape, one octet over the limit (trailing
    // spaces only): not read at all.
    let canonical = declaration.canonical_json().unwrap();
    let padded = format!(
        "{canonical}{}",
        " ".repeat(MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES + 1 - canonical.len())
    );
    assert_eq!(
        padded.len(),
        MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES + 1
    );
    raw(&db, "s1", text(&padded), text(&token));
    CONTENT_READS.with(|reads| reads.set(0));
    assert_eq!(read(&db, "p1", "s1"), unavailable(Reason::Oversized));
    assert_eq!(CONTENT_READS.with(|reads| reads.get()), 0);

    // A 16 MiB cell is rejected without being read either.
    raw(&db, "s1", text(&" ".repeat(16 * 1024 * 1024)), text(&token));
    assert_eq!(read(&db, "p1", "s1"), unavailable(Reason::Oversized));
    assert_eq!(CONTENT_READS.with(|reads| reads.get()), 0);

    // An oversized token cell likewise.
    raw(
        &db,
        "s1",
        text(&declaration.canonical_json().unwrap()),
        text(&"x".repeat(4096)),
    );
    assert_eq!(read(&db, "p1", "s1"), unavailable(Reason::Oversized));
    assert_eq!(CONTENT_READS.with(|reads| reads.get()), 0);

    // Exactly at the limit it is read (and then judged on its content).
    raw(
        &db,
        "s1",
        text(&format!(
            "{canonical}{}",
            " ".repeat(MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES - canonical.len())
        )),
        text(&token),
    );
    assert!(matches!(
        read(&db, "p1", "s1"),
        SceneBodyDeclarationRead::Declared(_)
    ));
    assert_eq!(CONTENT_READS.with(|reads| reads.get()), 1);
}

// ---- binding ------------------------------------------------------------

fn facts_of(declaration: &NarrativeSceneBodyDeclarationV1) -> SceneBodyDeclarationCurrentFacts {
    let binding = &declaration.binding;
    SceneBodyDeclarationCurrentFacts {
        project_id: binding.project_id.clone(),
        scene_id: binding.scene_id.clone(),
        scene_incarnation_id: binding.scene_incarnation_id.clone(),
        scope_source_token: binding.scope_source_token.clone(),
        body_source: binding.body_source.clone(),
        title_digest: binding.title_digest.clone(),
        workspace_id: binding.workspace_id.clone(),
        canonical_locator_digest: binding.canonical_locator_digest.clone(),
    }
}

#[test]
fn binding_match_names_each_component_that_changed() {
    use SceneBodyDeclarationBindingMismatch as Mismatch;
    let db = fixture();
    let declaration = declare(&db, "p1", "s1");
    let current = facts_of(&declaration);
    assert!(scene_body_declaration_binding_holds(&declaration, &current));
    assert!(scene_body_declaration_binding_mismatches(&declaration, &current).is_empty());

    type Change = Box<dyn Fn(&mut SceneBodyDeclarationCurrentFacts)>;
    let cases: Vec<(Mismatch, Change)> = vec![
        (
            Mismatch::ProjectId,
            Box::new(|f| f.project_id = "p2".into()),
        ),
        (Mismatch::SceneId, Box::new(|f| f.scene_id = "s2".into())),
        (
            Mismatch::SceneIncarnation,
            Box::new(|f| f.scene_incarnation_id = "new-incarnation".into()),
        ),
        (
            Mismatch::ScopeSourceToken,
            Box::new(|f| f.scope_source_token = test_digest('0')),
        ),
        (
            Mismatch::BodySourceIdentity,
            Box::new(|f| f.body_source.source_identity = "project:scene:s2".into()),
        ),
        (
            Mismatch::BodySourceToken,
            Box::new(|f| f.body_source.source_token = "v99@2026-10-18T00:00:00.000Z".into()),
        ),
        (
            Mismatch::BodySourceDigest,
            Box::new(|f| f.body_source.storage_digest = test_digest('0')),
        ),
        (
            Mismatch::BodySourceDigest,
            Box::new(|f| f.body_source.canonical_digest = test_digest('0')),
        ),
        (
            Mismatch::BodySourceDigest,
            Box::new(|f| f.body_source.utf16_length += 1),
        ),
        (
            Mismatch::TitleDigest,
            Box::new(|f| f.title_digest = test_digest('0')),
        ),
        (
            Mismatch::WorkspaceId,
            Box::new(|f| f.workspace_id = "other-workspace".into()),
        ),
        (
            Mismatch::CanonicalLocatorDigest,
            Box::new(|f| f.canonical_locator_digest = test_digest('0')),
        ),
    ];
    for (expected, change) in cases {
        let mut changed = current.clone();
        change(&mut changed);
        assert!(
            scene_body_declaration_binding_mismatches(&declaration, &changed).contains(&expected),
            "{expected:?}"
        );
        assert!(!scene_body_declaration_binding_holds(
            &declaration,
            &changed
        ));
    }

    // Returning to the original value matches again; that is the caller's
    // concern (title A->B->A is made unreachable by the body Source token,
    // which only moves forward), not something this function can hide.
    let mut title_b = current.clone();
    title_b.title_digest = test_digest('f');
    assert!(!scene_body_declaration_binding_holds(
        &declaration,
        &title_b
    ));
    title_b.title_digest = current.title_digest.clone();
    assert!(scene_body_declaration_binding_holds(&declaration, &title_b));
}

// ---- the row, the v1 token and the Scope authority digest are not touched ----

#[derive(Debug, PartialEq)]
struct Observed {
    binding_row: Vec<SqlValue>,
    tree_row: Vec<SqlValue>,
    // A failed read is part of the observation: a write that breaks the v1
    // token is a difference, not a panic.
    v1_token: Result<String, String>,
    scope_digest: Result<String, String>,
}

fn observe(db: &Database, project: &str, scene: &str) -> Observed {
    db.with_read_transaction(|conn| {
        let binding_row = conn.query_row(
            "SELECT scene_incarnation_id, compatibility_marker, query_identity_json,
                    material_constraint_json, knowledge_holder_json, audience_json,
                    version, source_token, updated_at
               FROM narrative_scene_scope_bindings
              WHERE project_id = ?1 AND scene_id = ?2",
            params![project, scene],
            |row| (0..9).map(|i| row.get::<_, SqlValue>(i)).collect(),
        )?;
        let tree_row = conn.query_row(
            "SELECT version, updated_at, title, content FROM tree_nodes WHERE id = ?1",
            params![scene],
            |row| (0..4).map(|i| row.get::<_, SqlValue>(i)).collect(),
        )?;
        let v1_token = read_narrative_scene_scope(conn, project, scene)
            .map(|scope| scope.binding.source_token)
            .map_err(|error| error.to_string());
        let scope_digest =
            crate::narrative_extraction::project_scope_authority::load_live_project_scope_authority(
                conn,
                project,
                &format!("project:scope-authority:{project}"),
            )
            .map(|authority| authority.source.revision_token)
            .map_err(|error| error.to_string());
        Ok(Observed {
            binding_row,
            tree_row,
            v1_token,
            scope_digest,
        })
    })
    .expect("observe")
}

/// The invariant of the declaration writes: nothing but the two columns moves.
fn check_untouched(before: &Observed, after: &Observed) -> Result<(), String> {
    if before == after {
        Ok(())
    } else {
        Err(format!("row or digest moved: {before:?} -> {after:?}"))
    }
}

#[test]
fn declaration_storage_leaves_v1_columns_and_scope_digest_unchanged() {
    let db = fixture();
    let before = observe(&db, "p1", "s1");
    let other_before = observe(&db, "p1", "s2");
    declare(&db, "p1", "s1");
    let declared = observe(&db, "p1", "s1");
    check_untouched(&before, &declared).expect("declaring must not move the v1 state");
    assert_eq!(other_before, observe(&db, "p1", "s2"));

    in_tx(&db, |conn| {
        clear_scene_body_declarations_in_tx(conn, "p1", SceneBodyDeclarationClearScope::Project)
    })
    .expect("clear");
    check_untouched(&before, &observe(&db, "p1", "s1")).expect("clearing must not either");
}

/// A declaration writer that also rewrites `updated_at`, as every other
/// writer of the row does (C15). The invariant above must catch it.
fn mutant_set_with_updated_at(conn: &Connection, declaration: &NarrativeSceneBodyDeclarationV1) {
    conn.execute(
        "UPDATE narrative_scene_scope_bindings
            SET body_declaration_json = ?3, body_declaration_token = ?4,
                updated_at = '2026-10-18T00:00:00.000Z'
          WHERE project_id = ?1 AND scene_id = ?2",
        params![
            declaration.binding.project_id,
            declaration.binding.scene_id,
            declaration.canonical_json().unwrap(),
            declaration.token().unwrap()
        ],
    )
    .expect("mutant write");
}

#[test]
fn mutant_writing_only_updated_at_is_detected() {
    let db = fixture();
    let before = observe(&db, "p1", "s1");
    // The invariant holds for a real declaration (the control).
    declare(&db, "p1", "s1");
    check_untouched(&before, &observe(&db, "p1", "s1")).expect("the real write is clean");
    in_tx(&db, |conn| {
        clear_scene_body_declarations_in_tx(conn, "p1", SceneBodyDeclarationClearScope::Project)
    })
    .unwrap();

    // The mutant leaves `version`, `source_token` and the tree alone and
    // changes only `updated_at`. The same comparison must now fail ...
    in_tx(&db, |conn| {
        let declaration = test_declaration(conn, "p1", "s1")?;
        mutant_set_with_updated_at(conn, &declaration);
        Ok(())
    })
    .unwrap();
    let after = observe(&db, "p1", "s1");
    let error = check_untouched(&before, &after).expect_err("the invariant must flag the mutant");
    assert!(error.contains("row or digest moved"), "{error}");
    // ... because the row comparison itself sees `updated_at` (not only the
    // v1 token that no longer validates), so a comparison that dropped the
    // column from its SELECT would be caught here.
    assert_ne!(before.binding_row, after.binding_row);
    assert!(after
        .binding_row
        .contains(&SqlValue::Text("2026-10-18T00:00:00.000Z".to_owned())));
    assert_eq!(before.tree_row, after.tree_row);
    assert!(before.v1_token.is_ok());
    assert!(
        after
            .v1_token
            .as_ref()
            .is_err_and(|error| error.contains("NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID")),
        "the v1 token no longer validates against the row: {:?}",
        after.v1_token
    );
}

fn explicit_a1_payload(base_version: i64, request: &str) -> NarrativeSceneScopeUpdatePayload {
    let unresolved = || NarrativeScopeConstraintV1::Unresolved {
        reason: "not-set".into(),
    };
    NarrativeSceneScopeUpdatePayload {
        project_id: "p1".into(),
        scene_id: "s1".into(),
        request_id: request.into(),
        session_id: "session".into(),
        event_uid: format!("{request}-event"),
        base_version,
        updated_at: "2026-10-17T01:00:00.000Z".into(),
        scope: NarrativeSceneScopeUpdateV1 {
            schema_version: 1,
            compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
            query_identity: NarrativeSceneQueryIdentityV1 {
                timeline: unresolved(),
                worldline: unresolved(),
                narrative_layer: unresolved(),
            },
            material_constraint: NarrativeSceneMaterialConstraintV1 {
                timeline: NarrativeScopeConstraintV1::Any,
                worldline: NarrativeScopeConstraintV1::Any,
                narrative_layer: NarrativeScopeConstraintV1::Any,
            },
            knowledge_holder: NarrativeScopePrincipalV1::Reader {},
            audience: NarrativeScopePrincipalV1::Reader {},
        },
    }
}

#[test]
fn a1_body_save_rename_registry_succeed_after_declaration() {
    use crate::domain_writes::{tree_node_patch, TreeNodePatchPayload};
    use crate::narrative_extraction::change_feed::NarrativeChangeOrigin;

    let db = fixture();
    declare(&db, "p1", "s1");
    let digest_before = observe(&db, "p1", "s1").scope_digest;

    // The A1 reader and the A1 save.
    let read_back = db
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, "p1", "s1"))
        .expect("A1 read after declaration");
    update_narrative_scene_scope(
        &db,
        explicit_a1_payload(read_back.binding.version, "a1-save"),
    )
    .expect("A1 save after declaration");

    // Body save and rename (both refresh the v1 token of the Scene).
    let patch = |request: &str, value: Value| TreeNodePatchPayload {
        project_id: "p1".into(),
        request_id: request.into(),
        session_id: "session".into(),
        event_uid: format!("{request}-event"),
        node_id: "s1".into(),
        patch: value.as_object().cloned().unwrap(),
        base_version: None,
        bump_version: true,
        updated_at: "2026-10-17T02:00:00.000Z".into(),
        change_event: None,
        timelapse_doc_step_coverage: None,
        origin: NarrativeChangeOrigin::Human,
        original_transaction_id: None,
        undo_journal_id: None,
        source_domain: None,
        op_type: None,
        canonical_payload: None,
    };
    tree_node_patch(
        &db,
        patch("body", json!({ "content": "{\"type\":\"doc\",\"x\":1}" })),
    )
    .expect("body save after declaration");
    tree_node_patch(&db, patch("rename", json!({ "title": "Renamed" })))
        .expect("rename after declaration");

    // The registry change.
    let (revision, registry) = db
        .with_read_transaction(|conn| {
            let read = read_narrative_scene_scope(conn, "p1", "s1")?;
            Ok((read.registry_revision, read.registry))
        })
        .unwrap();
    let mut registry = registry;
    registry.timeline_refs.push("timeline:extra".into());
    assert_eq!(
        registry.registry_version,
        NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID
    );
    update_narrative_scene_scope_registry(
        &db,
        NarrativeSceneScopeRegistryUpdatePayload {
            project_id: "p1".into(),
            request_id: "registry".into(),
            session_id: "session".into(),
            event_uid: "registry-event".into(),
            base_version: revision,
            updated_at: "2026-10-17T03:00:00.000Z".into(),
            registry,
        },
    )
    .expect("registry change after declaration");

    // Every v1 read still validates, the project's Scope authority moved for
    // the legitimate writers (not for the declaration), and the declaration is
    // still stored: it expires by its binding, it is not rewritten.
    let after = observe(&db, "p1", "s1");
    assert_ne!(after.scope_digest, digest_before);
    assert!(matches!(
        read(&db, "p1", "s1"),
        SceneBodyDeclarationRead::Declared(_)
    ));
}

#[test]
fn a1_update_payload_rejects_declaration_fields() {
    let mut payload = serde_json::to_value(explicit_a1_payload(1, "a1")).unwrap();
    serde_json::from_value::<NarrativeSceneScopeUpdatePayload>(payload.clone())
        .expect("the plain A1 payload is accepted");
    for pointer in ["", "/scope"] {
        let mut changed = payload.clone();
        let target = if pointer.is_empty() {
            &mut changed
        } else {
            changed.pointer_mut(pointer).unwrap()
        };
        target.as_object_mut().unwrap().insert(
            "bodyDeclaration".into(),
            json!({ "declarationId": "x", "declaredAt": "y" }),
        );
        assert!(
            serde_json::from_value::<NarrativeSceneScopeUpdatePayload>(changed).is_err(),
            "A1 payload with a declaration at '{pointer}'"
        );
    }
    payload["scope"]["bodyDeclarationJson"] = json!("{}");
    assert!(serde_json::from_value::<NarrativeSceneScopeUpdatePayload>(payload).is_err());
}

// ---- clear --------------------------------------------------------------

#[test]
fn clear_nulls_only_the_declaration_columns_and_returns_one_event_per_scene() {
    let db = fixture();
    declare(&db, "p1", "s1");
    declare(&db, "p1", "s2");
    declare(&db, "p2", "s3");
    let before = (observe(&db, "p1", "s1"), observe(&db, "p1", "s2"));

    // A single Scene.
    let events = in_tx(&db, |conn| {
        clear_scene_body_declarations_in_tx(conn, "p1", SceneBodyDeclarationClearScope::Scene("s1"))
    })
    .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(read(&db, "p1", "s1"), SceneBodyDeclarationRead::None);
    assert!(matches!(
        read(&db, "p1", "s2"),
        SceneBodyDeclarationRead::Declared(_)
    ));

    // Clearing again finds nothing to clear: no row write, no event.
    let again = in_tx(&db, |conn| {
        clear_scene_body_declarations_in_tx(conn, "p1", SceneBodyDeclarationClearScope::Scene("s1"))
    })
    .unwrap();
    assert!(again.is_empty());

    // A whole project, not the other project.
    let events = in_tx(&db, |conn| {
        clear_scene_body_declarations_in_tx(conn, "p1", SceneBodyDeclarationClearScope::Project)
    })
    .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].object_key,
        json!({ "kind": SCENE_BODY_DECLARATION_OBJECT_KIND, "sceneId": "s2" })
    );
    assert!(matches!(
        read(&db, "p2", "s3"),
        SceneBodyDeclarationRead::Declared(_)
    ));
    assert_eq!((observe(&db, "p1", "s1"), observe(&db, "p1", "s2")), before);
}

#[test]
fn clear_removes_broken_rows_without_failing_and_without_events_for_orphans() {
    let db = fixture();
    // Half-declared, corrupted, oversized and non-text rows are all cleared.
    raw(&db, "s1", text("{not json"), SqlValue::Null);
    raw(
        &db,
        "s2",
        SqlValue::Blob(vec![0; 64]),
        text(&"x".repeat(5000)),
    );
    // A row whose Scene is not a Scene of its project cannot be addressed by
    // the feed: it is cleared, with no event.
    db.with_conn(|conn| {
        conn.execute_batch("PRAGMA foreign_keys = OFF")?;
        conn.execute(
            "INSERT INTO narrative_scene_scope_bindings
                (project_id, scene_id, scene_incarnation_id, compatibility_marker,
                 query_identity_json, material_constraint_json, knowledge_holder_json,
                 audience_json, version, source_token, updated_at,
                 body_declaration_json, body_declaration_token)
             SELECT 'p1', 'ghost', scene_incarnation_id, compatibility_marker,
                    query_identity_json, material_constraint_json, knowledge_holder_json,
                    audience_json, version, source_token, updated_at, 'x', 'y'
               FROM narrative_scene_scope_bindings WHERE scene_id = 's1'",
            [],
        )?;
        conn.execute_batch("PRAGMA foreign_keys = ON")?;
        Ok(())
    })
    .expect("orphan row");
    let events = in_tx(&db, |conn| {
        clear_scene_body_declarations_in_tx(conn, "p1", SceneBodyDeclarationClearScope::Project)
    })
    .expect("clear never fails because of stored content");
    let scenes: Vec<&str> = events
        .iter()
        .map(|event| event.object_key["sceneId"].as_str().unwrap())
        .collect();
    assert_eq!(scenes, ["s1", "s2"]);
    let remaining: i64 = db
        .with_read_transaction(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_scene_scope_bindings
                  WHERE body_declaration_json IS NOT NULL OR body_declaration_token IS NOT NULL",
                [],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(remaining, 0);
    // The events of broken rows are valid feed events.
    in_tx(&db, |conn| {
        append_events_for_test(conn, "p1", "s1", events.clone())
    })
    .expect("events of cleared broken rows append");
}

// ---- feed ---------------------------------------------------------------

fn feed(db: &Database, project: &str) -> Vec<NarrativeChangeEventRecord> {
    db.with_read_transaction(|conn| get_changes_since(conn, project, 0, 500))
        .expect("feed")
}

#[test]
fn declaration_feed_event_uses_its_own_kind_and_never_scene_scope() {
    let db = fixture();
    declare(&db, "p1", "s1");
    in_tx(&db, |conn| {
        clear_scene_body_declarations_in_tx(conn, "p1", SceneBodyDeclarationClearScope::Scene("s1"))
            .and_then(|events| append_events_for_test(conn, "p1", "s1", events))
    })
    .unwrap();
    let events: Vec<_> = feed(&db, "p1")
        .into_iter()
        .filter(|event| event.object_key["sceneId"] == "s1")
        .collect();
    assert!(events.len() >= 2);
    let declaration_events: Vec<_> = events
        .iter()
        .filter(|event| event.object_key["kind"] == SCENE_BODY_DECLARATION_OBJECT_KIND)
        .collect();
    assert_eq!(declaration_events.len(), 2, "declare and clear");
    for event in &declaration_events {
        assert_ne!(event.object_key["kind"], "scene-scope");
        assert_eq!(event.change_kind, "metadata");
        assert_eq!(event.mutation_kind, "update");
        assert_eq!(event.changed_paths, ["/declaration"]);
        assert!(event.before_digest.is_some() && event.after_digest.is_some());
        let impact = event.structural_impact.as_ref().unwrap();
        assert!(impact.get("scopeAuthorityChanged").is_none());
        assert!(!crate::narrative_extraction::incremental_freshness::event_changes_project_scope_authority(event));
    }
    // The digests are those of the dedicated snapshot: declare goes from the
    // fixed "none" value to the stored cells, clear goes back.
    let none = narrative_snapshot_digest(&json!({
        "contractId": "narrative-scene-body-declaration-snapshot/1",
        "state": "none"
    }))
    .unwrap();
    assert_eq!(
        declaration_events[0].before_digest.as_deref(),
        Some(none.as_str())
    );
    assert_ne!(
        declaration_events[0].after_digest.as_deref(),
        Some(none.as_str())
    );
    assert_eq!(
        declaration_events[1].after_digest.as_deref(),
        Some(none.as_str())
    );
    assert_eq!(
        declaration_events[0].after_digest,
        declaration_events[1].before_digest
    );
    // Nothing in the feed for the declaration is a `scene-scope` event.
    assert!(events
        .iter()
        .all(|event| event.object_key["kind"] != "scene-scope"));
}

#[test]
fn snapshot_changes_with_each_cell_and_is_fixed_when_both_are_null() {
    let db = fixture();
    let snapshot = |db: &Database| {
        db.with_read_transaction(|conn| canonical_scene_body_declaration_snapshot(conn, "p1", "s1"))
            .unwrap()
    };
    let none = snapshot(&db);
    assert_eq!(snapshot(&db), none);
    // A scene with no row has the same fixed value.
    assert_eq!(
        db.with_read_transaction(|conn| canonical_scene_body_declaration_snapshot(
            conn, "p1", "nope"
        ))
        .unwrap(),
        none
    );
    let digest = |value: &Value| narrative_snapshot_digest(value).unwrap();
    let mut seen = vec![digest(&none)];
    for (json_cell, token_cell) in [
        (text("a"), SqlValue::Null),
        (SqlValue::Null, text("a")),
        (text("a"), text("a")),
        (text("a"), text("b")),
        (text("b"), text("a")),
        (SqlValue::Integer(1), text("a")),
        (
            text(&"z".repeat(MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES + 1)),
            text("a"),
        ),
    ] {
        raw(&db, "s1", json_cell, token_cell);
        let value = snapshot(&db);
        let value_digest = digest(&value);
        assert!(!seen.contains(&value_digest), "{value}");
        seen.push(value_digest);
    }
}

/// Puts bytes that are not UTF-8 into a cell that `typeof` still calls text
/// (the shape an external edit or damage leaves).
fn raw_invalid_utf8_text(
    db: &Database,
    scene: &str,
    json_bytes: Option<&[u8]>,
    token_bytes: Option<&[u8]>,
) {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_scene_scope_bindings
                SET body_declaration_json = CASE WHEN ?3 IS NULL THEN body_declaration_json
                                                 ELSE CAST(?3 AS TEXT) END,
                    body_declaration_token = CASE WHEN ?4 IS NULL THEN body_declaration_token
                                                  ELSE CAST(?4 AS TEXT) END
              WHERE project_id = 'p1' AND scene_id = ?1 AND ?2 = ?2",
            params![
                scene,
                1,
                json_bytes.map(|bytes| bytes.to_vec()),
                token_bytes.map(|bytes| bytes.to_vec())
            ],
        )?;
        Ok(())
    })
    .expect("raw invalid utf-8 cells");
}

fn snapshot_of(db: &Database, scene: &str) -> Value {
    db.with_read_transaction(|conn| canonical_scene_body_declaration_snapshot(conn, "p1", scene))
        .expect("the snapshot never fails because of the stored content")
}

#[test]
fn text_cells_that_are_not_utf8_are_unavailable_opaque_and_clearable() {
    use SceneBodyDeclarationUnavailableReason as Reason;
    let db = fixture();
    let declaration = declare(&db, "p1", "s1");
    let json_text = declaration.canonical_json().unwrap();
    let token = declaration.token().unwrap();

    // The control: the cell really is text by `typeof`, within the limit.
    raw(&db, "s2", text(&json_text), text(&token));
    raw_invalid_utf8_text(&db, "s2", Some(&[0xff]), None);
    let (json_type, json_length): (String, i64) = db
        .with_read_transaction(|conn| {
            Ok(conn.query_row(
                "SELECT typeof(body_declaration_json), octet_length(body_declaration_json)
                   FROM narrative_scene_scope_bindings WHERE scene_id = 's2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!((json_type.as_str(), json_length), ("text", 1));

    // (a) The reader names the problem instead of failing the whole read.
    assert_eq!(read(&db, "p1", "s2"), unavailable(Reason::Malformed));
    raw(&db, "s2", text(&json_text), text(&token));
    raw_invalid_utf8_text(&db, "s2", None, Some(&[0xc3, 0x28]));
    assert_eq!(read(&db, "p1", "s2"), unavailable(Reason::Malformed));
    raw_invalid_utf8_text(&db, "s2", Some(&[0xff, 0xfe]), Some(&[0xc3, 0x28]));
    assert_eq!(read(&db, "p1", "s2"), unavailable(Reason::Malformed));

    // (b) The snapshot is opaque (type, length and a digest of the bytes), and
    // two different invalid cells of one length differ in the digest.
    raw(&db, "s2", text(&json_text), text(&token));
    raw_invalid_utf8_text(&db, "s2", Some(&[0xff]), None);
    let first = snapshot_of(&db, "s2");
    assert_eq!(first["json"]["opaque"]["storageType"], "text");
    assert_eq!(first["json"]["opaque"]["octetLength"], 1);
    assert!(first["json"]["opaque"]["invalidUtf8Digest"]
        .as_str()
        .is_some_and(|digest| digest.starts_with("sha256:")));
    assert_eq!(first["token"], json!(token));
    raw_invalid_utf8_text(&db, "s2", Some(&[0xfe]), None);
    let second = snapshot_of(&db, "s2");
    assert_ne!(
        narrative_snapshot_digest(&first).unwrap(),
        narrative_snapshot_digest(&second).unwrap()
    );

    // (c) The clear does not fail, returns the event, and leaves NULLs.
    raw_invalid_utf8_text(&db, "s2", Some(&[0xff]), Some(&[0xc3, 0x28]));
    let events = in_tx(&db, |conn| {
        clear_scene_body_declarations_in_tx(conn, "p1", SceneBodyDeclarationClearScope::Project)
    })
    .expect("the clear survives cells that are not UTF-8");
    let scenes: Vec<&str> = events
        .iter()
        .map(|event| event.object_key["sceneId"].as_str().unwrap())
        .collect();
    assert_eq!(scenes, ["s1", "s2"]);
    assert_eq!(read(&db, "p1", "s2"), SceneBodyDeclarationRead::None);
    assert_eq!(snapshot_of(&db, "s2")["state"], "none");
    in_tx(&db, |conn| {
        append_events_for_test(conn, "p1", "s2", events.clone())
    })
    .expect("the events of the cleared invalid cells append");
}

// ---- feed continuity (DR-CB1-7) ---------------------------------------------

/// The stored declaration of a Scene goes back to NULL without any event in
/// several paths (a Scene's CASCADE delete, the clear of a staged DB, a row
/// the feed cannot address). The kind's object head must not turn the next
/// declaration into NARRATIVE_CHANGE_FEED_DISCONTINUITY.
#[test]
fn redeclaring_after_a_null_without_an_event_is_not_a_discontinuity() {
    let db = fixture();
    declare(&db, "p1", "s1");
    // Staged DB / orphan-row path: both columns NULL, the head still names the
    // stored declaration.
    raw(&db, "s1", SqlValue::Null, SqlValue::Null);
    let second = declare(&db, "p1", "s1");
    assert!(matches!(
        read(&db, "p1", "s1"),
        SceneBodyDeclarationRead::Declared(stored) if stored.declaration == second
    ));
    // The same after a clear that has an event (the head follows it).
    in_tx(&db, |conn| {
        let events = clear_scene_body_declarations_in_tx(
            conn,
            "p1",
            SceneBodyDeclarationClearScope::Scene("s1"),
        )?;
        append_events_for_test(conn, "p1", "s1", events)
    })
    .unwrap();
    declare(&db, "p1", "s1");
}

#[test]
fn declaration_scene_delete_restore_with_the_same_id_and_redeclare() {
    let db = fixture();
    declare(&db, "p1", "s1");
    // Delete the Scene (the binding row goes with it, with no declaration
    // event) and restore a Scene with the same id.
    db.with_conn(|conn| {
        conn.execute("DELETE FROM tree_nodes WHERE id = 's1'", [])?;
        let remaining: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_scene_scope_bindings WHERE scene_id = 's1'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(remaining, 0, "the binding row goes with the Scene");
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, content)
             VALUES ('s1', 'p1', 'scene', 'One', 'a0', '{\"type\":\"doc\"}')",
            [],
        )?;
        ensure_scene_scope_binding_in_tx(conn, "p1", "s1", NOW)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(read(&db, "p1", "s1"), SceneBodyDeclarationRead::None);
    let again = declare(&db, "p1", "s1");
    assert!(matches!(
        read(&db, "p1", "s1"),
        SceneBodyDeclarationRead::Declared(stored) if stored.declaration == again
    ));
}

#[test]
fn only_the_declaration_kind_is_exempt_from_history_continuity() {
    assert!(is_scene_body_declaration_event(
        &json!({ "kind": SCENE_BODY_DECLARATION_OBJECT_KIND, "sceneId": "s1" })
    ));
    for kind in ["scene-scope", "scope-registry", "project", "scene"] {
        assert!(!is_scene_body_declaration_event(
            &json!({ "kind": kind, "sceneId": "s1" })
        ));
    }
}

#[test]
fn unknown_declaration_like_kind_is_rejected_by_the_feed() {
    let event_for = |kind: &str| NarrativeChangeEventInput {
        object_key: json!({ "kind": kind, "sceneId": "s1" }),
        change_kind: "metadata".into(),
        mutation_kind: "update".into(),
        before_version: None,
        before_digest: Some(test_digest('a')),
        after_version: None,
        after_digest: Some(test_digest('b')),
        changed_paths: vec!["/declaration".into()],
        text_impact: None,
        structural_impact: None,
    };
    validate_event(&event_for(SCENE_BODY_DECLARATION_OBJECT_KIND)).expect("known kind");
    for misspelled in [
        "scene-body-declarations",
        "scene_body_declaration",
        "scene-body-disclosure",
        "Scene-Body-Declaration",
        "scene-body-declaration ",
        "body-declaration",
    ] {
        assert!(
            validate_event(&event_for(misspelled)).is_err(),
            "{misspelled}"
        );
    }
    let mut missing_scene = event_for(SCENE_BODY_DECLARATION_OBJECT_KIND);
    missing_scene.object_key = json!({ "kind": SCENE_BODY_DECLARATION_OBJECT_KIND });
    assert!(validate_event(&missing_scene).is_err());
    let mut unknown_change = event_for(SCENE_BODY_DECLARATION_OBJECT_KIND);
    unknown_change.change_kind = "unexpected".into();
    assert!(validate_event(&unknown_change).is_err());

    // The project check: a Scene of another project, or no Scene, is refused.
    let db = fixture();
    for scene in ["s3", "missing"] {
        let mut event = event_for(SCENE_BODY_DECLARATION_OBJECT_KIND);
        event.object_key["sceneId"] = json!(scene);
        let result = in_tx(&db, |conn| {
            append_events_for_test(conn, "p1", "s1", vec![event])
        });
        assert!(result.is_err(), "{scene}");
    }
}

#[test]
fn contribution_target_identity_and_snapshot_loader_know_the_kind() {
    let db = fixture();
    declare(&db, "p1", "s1");
    let key = json!({ "kind": SCENE_BODY_DECLARATION_OBJECT_KIND, "sceneId": "s1" });
    let identity = db
        .with_read_transaction(|conn| {
            crate::narrative_extraction::change_feed::contribution_target_identity_from_object_key(
                conn, &key,
            )
        })
        .expect("a Contribution target identity exists for the kind");
    assert_eq!(identity, "scene-body-declaration:s1");
    let snapshot = db
        .with_read_transaction(|conn| {
            crate::canonical_feed_snapshots::canonical_snapshot_for_object_key(conn, "p1", &key)
        })
        .unwrap()
        .expect("snapshot");
    assert_eq!(snapshot["state"], "stored");
    assert_eq!(
        crate::narrative_extraction::change_feed::narrative_object_key(
            "scene_body_declaration",
            "s1"
        ),
        key
    );
}

// ---- Revisions, Scope authority and Indexes -------------------------------

mod pending_and_indexes {
    use super::*;
    use crate::narrative_extraction::incremental_freshness::affected_source_identities;
    use crate::narrative_extraction::nir1_chronicle_index::NirChronicleIndexRuntime;
    use crate::narrative_extraction::nir1_entity_relation::tests::{
        approve_typed_revision, request, seed_run_and_catalog,
    };
    use crate::narrative_extraction::nir1_entity_relation::{
        create_nir1_entity_relation_revision, read_nir1_entity_relation_revision_current,
        Nir1EntityRelationRevisionCurrentRead,
    };
    use crate::narrative_extraction::nir1_entity_relation_index;
    use crate::test_support::fresh_migrated_memory;

    const PROJECT: &str = "default-project";
    const SCENE: &str = "nir1";

    struct Published {
        db: Database,
        run_id: String,
        revision_id: String,
    }

    /// An approved typed Revision, a published Graph Index and a Chronicle
    /// IR Index row, all clean.
    fn publish_fixture() -> Published {
        let db = fresh_migrated_memory().unwrap();
        let runtime = NirChronicleIndexRuntime::new(&db, 1);
        seed_run_and_catalog(&db).unwrap();
        // The Scene's binding row is part of the Scope authority; it must
        // exist before the Revision is created against that authority.
        db.with_conn(|conn| ensure_scene_scope_binding_in_tx(conn, PROJECT, SCENE, NOW))
            .unwrap();
        let created = create_nir1_entity_relation_revision(&db, request(&db)).unwrap();
        approve_typed_revision(&db, "nir1-run", &created).unwrap();
        let snapshot = db
            .with_read_transaction(|conn| {
                nir1_entity_relation_index::prepare_graph_index_build(conn, &runtime, PROJECT)
            })
            .unwrap();
        db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            nir1_entity_relation_index::publish_nir1_entity_relation_index_in_tx(
                &tx, &runtime, snapshot,
            )?;
            tx.commit()?;
            conn.execute(
                "INSERT INTO narrative_semantic_index_metadata
                    (project_id, index_key, generation, built_at, source_digest,
                     dependency_set_digest, dirty_cache_flag)
                 VALUES (?1, ?2, 3, ?3, 'ir-source', 'ir-deps', 0)",
                params![
                    PROJECT,
                    crate::narrative_extraction::nir1_chronicle_index::INDEX_KEY,
                    NOW
                ],
            )?;
            Ok(())
        })
        .unwrap();
        Published {
            db,
            run_id: created["runId"].as_str().unwrap_or("nir1-run").to_owned(),
            revision_id: created["revisionId"].as_str().unwrap().to_owned(),
        }
    }

    fn index_state(db: &Database) -> Vec<(String, i64, i64, String)> {
        db.with_read_transaction(|conn| {
            let mut statement = conn.prepare(
                "SELECT index_key, generation, dirty_cache_flag, source_digest
                   FROM narrative_semantic_index_metadata
                  WHERE project_id = ?1 ORDER BY index_key",
            )?;
            let rows = statement
                .query_map([PROJECT], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap()
    }

    fn pending_is_ok(published: &Published) -> bool {
        published
            .db
            .with_read_transaction(|conn| {
                let edges = crate::narrative_extraction::dependency_edges::find_edges_by_consumer(
                    conn,
                    PROJECT,
                    "proposal-revision",
                    &published.revision_id,
                )?;
                crate::narrative_extraction::revision_eligibility::pending::read(
                    conn, PROJECT, &edges,
                )
                .map(|result| result.is_ok())
            })
            .unwrap()
    }

    fn revision_available(published: &Published) -> bool {
        matches!(
            published
                .db
                .with_read_transaction(|conn| {
                    read_nir1_entity_relation_revision_current(conn, PROJECT, &published.run_id)
                })
                .unwrap(),
            Nir1EntityRelationRevisionCurrentRead::Available(_)
        )
    }

    fn graph_binding_usable(db: &Database) -> bool {
        db.with_read_transaction(|conn| {
            nir1_entity_relation_index::is_complete_registered(
                conn,
                PROJECT,
                nir1_entity_relation_index::INDEX_KEY,
            )
        })
        .unwrap()
    }

    #[test]
    fn declaration_event_keeps_pending_ok_and_scope_authority_clean() {
        let published = publish_fixture();
        assert!(pending_is_ok(&published), "the fixture starts current");
        assert!(revision_available(&published));
        let digest_before = observe(&published.db, PROJECT, SCENE).scope_digest;
        let head_before = feed(&published.db, PROJECT).len();

        in_tx(&published.db, |conn| {
            let declaration = test_declaration(conn, PROJECT, SCENE)?;
            set_scene_body_declaration_for_test(conn, &declaration)
        })
        .unwrap();
        let events = feed(&published.db, PROJECT);
        let new_events = &events[head_before..];
        assert!(!new_events.is_empty());
        assert!(new_events
            .iter()
            .all(|event| event.object_key["kind"] == SCENE_BODY_DECLARATION_OBJECT_KIND));
        assert!(affected_source_identities(PROJECT, new_events)
            .unwrap()
            .is_empty());
        assert!(new_events.iter().all(|event| {
            !crate::narrative_extraction::incremental_freshness::event_changes_project_scope_authority(event)
        }));

        // The Revision is not pending (no PendingUnknown / PendingRelevantChange
        // / PendingGlobalChange), is still current, and the project's Scope
        // authority did not move.
        assert!(pending_is_ok(&published));
        assert!(revision_available(&published));
        assert_eq!(
            observe(&published.db, PROJECT, SCENE).scope_digest,
            digest_before
        );

        // Clearing it again is just as quiet.
        in_tx(&published.db, |conn| {
            clear_scene_body_declarations_in_tx(
                conn,
                PROJECT,
                SceneBodyDeclarationClearScope::Project,
            )
            .and_then(|events| append_events_for_test(conn, PROJECT, SCENE, events))
        })
        .unwrap();
        assert!(pending_is_ok(&published));
        assert!(revision_available(&published));
    }

    #[test]
    fn declaration_only_transaction_does_not_dirty_indexes() {
        let published = publish_fixture();
        let before = index_state(&published.db);
        assert_eq!(before.len(), 2, "Graph and Chronicle IR rows: {before:?}");
        assert!(before.iter().all(|(_, _, dirty, _)| *dirty == 0));
        assert!(graph_binding_usable(&published.db));

        in_tx(&published.db, |conn| {
            let declaration = test_declaration(conn, PROJECT, SCENE)?;
            set_scene_body_declaration_for_test(conn, &declaration)
        })
        .unwrap();
        assert_eq!(index_state(&published.db), before);
        assert!(graph_binding_usable(&published.db));

        in_tx(&published.db, |conn| {
            clear_scene_body_declarations_in_tx(
                conn,
                PROJECT,
                SceneBodyDeclarationClearScope::Scene(SCENE),
            )
            .and_then(|events| append_events_for_test(conn, PROJECT, SCENE, events))
        })
        .unwrap();
        assert_eq!(index_state(&published.db), before);
        assert!(graph_binding_usable(&published.db));
    }

    #[test]
    fn mixed_or_empty_transaction_still_dirties_indexes() {
        // Another kind next to a declaration event: dirty, as today.
        let published = publish_fixture();
        let before = index_state(&published.db);
        in_tx(&published.db, |conn| {
            let declaration = test_declaration(conn, PROJECT, SCENE)?;
            let none = canonical_scene_body_declaration_snapshot(conn, PROJECT, SCENE)?;
            conn.execute(
                "UPDATE narrative_scene_scope_bindings
                    SET body_declaration_json = ?3, body_declaration_token = ?4
                  WHERE project_id = ?1 AND scene_id = ?2",
                params![
                    PROJECT,
                    SCENE,
                    declaration.canonical_json()?,
                    declaration.token()?
                ],
            )?;
            let stored = canonical_scene_body_declaration_snapshot(conn, PROJECT, SCENE)?;
            let refresh = crate::narrative_extraction::refresh_scene_scope_source_token_in_tx(
                conn,
                PROJECT,
                SCENE,
                "2026-10-17T05:00:00.000Z",
            )?;
            assert_eq!(refresh.object_key["kind"], "scene-scope");
            append_events_for_test(
                conn,
                PROJECT,
                SCENE,
                vec![
                    scene_body_declaration_feed_event(SCENE, &none, &stored)?,
                    refresh,
                ],
            )
        })
        .unwrap();
        let after = index_state(&published.db);
        assert!(
            after.iter().all(|(_, _, dirty, _)| *dirty == 1),
            "{before:?} -> {after:?}"
        );

        // A transaction of another kind alone: dirty, as today.
        let published = publish_fixture();
        in_tx(&published.db, |conn| {
            let refresh = crate::narrative_extraction::refresh_scene_scope_source_token_in_tx(
                conn,
                PROJECT,
                SCENE,
                "2026-10-17T05:00:00.000Z",
            )?;
            append_events_for_test(conn, PROJECT, SCENE, vec![refresh])
        })
        .unwrap();
        assert!(index_state(&published.db)
            .iter()
            .all(|(_, _, dirty, _)| *dirty == 1));

        // No event at all is not a declaration-only transaction, and a
        // transaction without events is refused outright.
        assert!(!events_are_only_scene_body_declarations(&[]));
        let published = publish_fixture();
        let before = index_state(&published.db);
        let refused = in_tx(&published.db, |conn| {
            append_events_for_test(conn, PROJECT, SCENE, Vec::new())
        });
        assert!(refused.is_err());
        assert_eq!(index_state(&published.db), before);
    }

    #[test]
    fn the_predicate_is_exactly_all_declaration_events() {
        let declaration = scene_body_declaration_feed_event("s1", &json!(1), &json!(2)).unwrap();
        let mut other = declaration.clone();
        other.object_key = json!({ "kind": "scene-scope", "sceneId": "s1" });
        assert!(events_are_only_scene_body_declarations(
            std::slice::from_ref(&declaration)
        ));
        assert!(events_are_only_scene_body_declarations(&[
            declaration.clone(),
            declaration.clone()
        ]));
        assert!(!events_are_only_scene_body_declarations(&[other.clone()]));
        assert!(!events_are_only_scene_body_declarations(&[
            declaration.clone(),
            other.clone()
        ]));
        assert!(!events_are_only_scene_body_declarations(&[
            other,
            declaration
        ]));
    }
}
