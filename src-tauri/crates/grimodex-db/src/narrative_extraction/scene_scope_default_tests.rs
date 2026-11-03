//! SDEF/1 (`nir1-scene-scope-default-proposal/1#scope-storage-authority`)
//! acceptance on the Native side: the project default reader/writer (R1-R5,
//! MD4), the one inheritance decision (R7, MD1-MD3), the tree creation paths
//! that inherit or do not (A1, A2), the registry refusal (A5) and the default
//! write leaving every binding, the registry and the authority token alone (A4).
//! The AI plan, sticky, Trash, snapshot, body-repair, sample and seed paths are
//! tested next to their writers; the static guard (A3) is in
//! `tests/narrative_scope_storage_authority.rs`.

use anyhow::Result;
use rusqlite::params;
use serde_json::{json, Value};

use grimodex_core::narrative_scene_scope::{
    NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeSceneScopeRegistryV1, NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1,
    NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID,
};

use super::change_feed::NarrativeChangeOrigin;
use super::scene_scope::{
    scene_scope_init_for_create, SceneCreateLineage, SceneScopeInit, MAIN_LINE_LAYER_REF,
    MAIN_LINE_TIMELINE_REF, MAIN_LINE_WORLDLINE_REF,
};
use super::scene_scope_default::{
    read_narrative_scope_project_default, update_narrative_scope_project_default,
    NarrativeScopeProjectDefaultUpdatePayload, NarrativeScopeProjectDefaultValueV1,
};
use super::{
    read_narrative_scene_scope, update_narrative_scene_scope_registry,
    NarrativeSceneScopeRegistryUpdatePayload,
};
use crate::agent_writes::RendererCanonicalWriteContext;
use crate::domain_writes::{
    project_create, tree_node_create, tree_node_create_with_authority, tree_node_delete,
    ProjectCreatePayload, ProjectSceneScopeDefaultInit, TreeNodeCreatePayload,
    TreeNodeDeletePayload,
};
use crate::Database;

const P1: &str = "sdef-p1";
const P2: &str = "sdef-p2";
const NOW: &str = "2026-11-04T00:00:00.000Z";

fn db() -> Database {
    crate::test_support::current_schema_memory().expect("current-schema fixture")
}

fn create_project(db: &Database, project_id: &str, default: bool) -> Value {
    project_create(
        db,
        ProjectCreatePayload {
            project_id: project_id.to_owned(),
            request_id: format!("{project_id}:create"),
            session_id: "sdef-session".to_owned(),
            event_uid: format!("{project_id}:create-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            title: project_id.to_owned(),
            genre: None,
            pov: None,
            tense: None,
            language: None,
            style_guide: None,
            ai_instructions: None,
            outline: None,
            target_readers: None,
            created_at: NOW.to_owned(),
            updated_at: NOW.to_owned(),
            scene_scope_default: default.then_some(ProjectSceneScopeDefaultInit::MainLine),
        },
    )
    .expect("create project")
}

fn create_payload(project_id: &str, id: &str, node_type: &str) -> TreeNodeCreatePayload {
    TreeNodeCreatePayload {
        id: id.to_owned(),
        project_id: project_id.to_owned(),
        request_id: format!("{id}:create"),
        session_id: "sdef-session".to_owned(),
        event_uid: format!("{id}:create-event"),
        origin: NarrativeChangeOrigin::Human,
        original_transaction_id: None,
        undo_journal_id: None,
        parent_id: None,
        node_type: node_type.to_owned(),
        title: id.to_owned(),
        sort_order: "a0".to_owned(),
        synopsis: None,
        status: None,
        source_uri: None,
        source_mtime: None,
        content: Some("{}".to_owned()),
        canonical_payload: None,
    }
}

fn create_scene(db: &Database, project_id: &str, id: &str) -> Value {
    tree_node_create(db, create_payload(project_id, id, "scene")).expect("create scene")
}

fn delete_node(db: &Database, project_id: &str, id: &str) -> (String, String) {
    let receipt = tree_node_delete(
        db,
        TreeNodeDeletePayload {
            project_id: project_id.to_owned(),
            request_id: format!("{id}:delete"),
            session_id: "sdef-session".to_owned(),
            event_uid: format!("{id}:delete-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            node_id: id.to_owned(),
            canonical_payload: None,
        },
    )
    .expect("delete node");
    lineage_of(&receipt)
}

fn lineage_of(receipt: &Value) -> (String, String) {
    let receipt = receipt.get("__writeReceipt").unwrap_or(receipt);
    (
        receipt["maintenanceTransactionId"]
            .as_str()
            .expect("maintenance transaction")
            .to_owned(),
        receipt["undoJournalId"]
            .as_str()
            .expect("undo journal")
            .to_owned(),
    )
}

fn marker(db: &Database, project_id: &str, scene_id: &str) -> NarrativeScopeCompatibilityMarkerV1 {
    db.with_read_transaction(|conn| read_narrative_scene_scope(conn, project_id, scene_id))
        .expect("read scene scope")
        .binding
        .compatibility_marker
}

fn exact(reference: &str) -> NarrativeScopeConstraintV1 {
    NarrativeScopeConstraintV1::Exact {
        reference: reference.to_owned(),
    }
}

fn main_line() -> NarrativeScopeProjectDefaultValueV1 {
    NarrativeScopeProjectDefaultValueV1::main_line()
}

fn set_value(timeline: &str) -> NarrativeScopeProjectDefaultValueV1 {
    NarrativeScopeProjectDefaultValueV1::Set {
        query_identity: NarrativeSceneQueryIdentityV1 {
            timeline: exact(timeline),
            worldline: exact(MAIN_LINE_WORLDLINE_REF),
            narrative_layer: exact(MAIN_LINE_LAYER_REF),
        },
        material_constraint: NarrativeSceneMaterialConstraintV1 {
            timeline: exact(timeline),
            worldline: exact(MAIN_LINE_WORLDLINE_REF),
            narrative_layer: exact(MAIN_LINE_LAYER_REF),
        },
    }
}

fn write_default(
    db: &Database,
    project_id: &str,
    request: &str,
    base_version: i64,
    value: NarrativeScopeProjectDefaultValueV1,
) -> Result<Value> {
    update_narrative_scope_project_default(
        db,
        NarrativeScopeProjectDefaultUpdatePayload {
            project_id: project_id.to_owned(),
            request_id: request.to_owned(),
            session_id: "sdef-session".to_owned(),
            event_uid: format!("{request}:event"),
            base_version,
            updated_at: NOW.to_owned(),
            default: value,
        },
    )
}

/// Give `project_id` (which must exist) a registry and the main-line default,
/// whatever it had before. Used by the writer-side tests in other modules.
pub(crate) fn set_main_line_default(db: &Database, project_id: &str) {
    db.with_conn(|conn| super::ensure_scope_registry_in_tx(conn, project_id, NOW))
        .expect("ensure registry");
    let version = db
        .with_read_transaction(|conn| read_narrative_scope_project_default(conn, project_id))
        .expect("read default")
        .version;
    write_default(
        db,
        project_id,
        &format!("{project_id}:set-main-line:{version}"),
        version,
        main_line(),
    )
    .expect("set main-line default");
}

/// The marker every Scene of `project_id` has, by Scene id.
pub(crate) fn markers(db: &Database, project_id: &str) -> Vec<(String, String)> {
    db.with_conn(|conn| {
        Ok(conn
            .prepare(
                "SELECT scene_id, compatibility_marker FROM narrative_scene_scope_bindings
                  WHERE project_id = ?1 ORDER BY scene_id",
            )?
            .query_map(params![project_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    })
    .expect("read markers")
}

fn registry_row(db: &Database, project_id: &str) -> Vec<Value> {
    db.with_conn(|conn| {
        Ok(conn
            .prepare("SELECT * FROM narrative_scope_registries WHERE project_id = ?1")?
            .query_map(params![project_id], |row| {
                Ok((0..8)
                    .map(|index| match row.get_ref(index) {
                        Ok(value) => json!(format!("{value:?}")),
                        Err(_) => Value::Null,
                    })
                    .collect::<Vec<_>>())
            })?
            .flatten()
            .map(Value::from)
            .collect::<Vec<_>>())
    })
    .expect("read registry row")
}

fn binding_rows(db: &Database) -> Vec<Value> {
    db.with_conn(|conn| {
        Ok(conn
            .prepare(
                "SELECT project_id, scene_id, scene_incarnation_id, compatibility_marker,
                        query_identity_json, material_constraint_json, knowledge_holder_json,
                        audience_json, version, source_token, updated_at,
                        body_declaration_json, body_declaration_token
                   FROM narrative_scene_scope_bindings ORDER BY project_id, scene_id",
            )?
            .query_map([], |row| {
                Ok((0..13)
                    .map(|index| match row.get_ref(index) {
                        Ok(value) => json!(format!("{value:?}")),
                        Err(_) => Value::Null,
                    })
                    .collect::<Vec<_>>())
            })?
            .flatten()
            .map(Value::from)
            .collect::<Vec<_>>())
    })
    .expect("read binding rows")
}

fn authority_token(db: &Database, project_id: &str) -> String {
    db.with_read_transaction(|conn| {
        Ok(
            super::project_scope_authority::load_live_project_scope_authority(
                conn,
                project_id,
                &format!("project:scope-authority:{project_id}"),
            )?
            .source
            .revision_token,
        )
    })
    .expect("scope authority token")
}

fn renderer_context(
    payload: &TreeNodeCreatePayload,
    route: &str,
    caller: &str,
    controls: &[&str],
) -> RendererCanonicalWriteContext {
    serde_json::from_value(json!({
        "requestId": payload.request_id,
        "eventUid": payload.event_uid,
        "origin": payload.origin,
        "authorityRoute": route,
        "caller": caller,
        "controls": controls,
        "originalTransactionId": payload.original_transaction_id,
        "undoJournalId": payload.undo_journal_id,
    }))
    .expect("renderer context")
}

// ---------------------------------------------------------------- MD1 ----

/// The decision returns the inheriting value for exactly one combination: a
/// forward author or AI-apply creation with no lineage, no redo, no replay or
/// restore route and no external source (R7 (a)-(c)).
#[test]
fn the_one_decision_inherits_only_for_forward_author_and_ai_creations() {
    use NarrativeChangeOrigin::*;
    let origins = [Human, AiApply, Import, Undo, Redo, Restore, Migration];
    let lineages = [
        (None, None),
        (Some("tx"), None),
        (None, Some("journal")),
        (Some("tx"), Some("journal")),
    ];
    let routes = [
        None,
        Some("human-direct"),
        Some("interactive-agent-command"),
        Some("import-apply"),
        Some("history-replay"),
        Some("restore-or-migration"),
    ];
    let sources = [
        (None, None),
        (Some("file:///a.md"), None),
        (None, Some("1")),
        (Some(""), Some("")),
    ];
    let mut inherited = 0;
    for origin in origins {
        for (original_transaction_id, undo_journal_id) in lineages {
            for route in routes {
                for redo in [false, true] {
                    for (source_uri, source_mtime) in sources {
                        let decision = scene_scope_init_for_create(&SceneCreateLineage {
                            origin,
                            original_transaction_id,
                            undo_journal_id,
                            authority_route: route,
                            redo,
                            source_uri,
                            source_mtime,
                        });
                        let expected = matches!(origin, Human | AiApply)
                            && original_transaction_id.is_none()
                            && undo_journal_id.is_none()
                            && !matches!(route, Some("history-replay" | "restore-or-migration"))
                            && !redo
                            && source_uri.is_none()
                            && source_mtime.is_none();
                        assert_eq!(
                            decision == SceneScopeInit::NewSceneInheritProjectDefault,
                            expected,
                            "{origin:?} {original_transaction_id:?} {undo_journal_id:?} {route:?} {redo} {source_uri:?} {source_mtime:?}"
                        );
                        inherited += usize::from(expected);
                    }
                }
            }
        }
    }
    // 2 origins x 1 lineage x 4 routes x 1 redo x 1 source.
    assert_eq!(inherited, 8);
}

// ------------------------------------------------------- R12, R13, R4 ----

#[test]
fn project_create_writes_the_main_line_default_only_when_asked() {
    let db = db();
    create_project(&db, P1, true);
    create_project(&db, P2, false);
    db.with_read_transaction(|conn| {
        let with = read_narrative_scope_project_default(conn, P1)?;
        assert_eq!(with.default, main_line());
        assert_eq!(with.version, 1);
        assert!(with
            .source_token
            .as_deref()
            .is_some_and(|token| token.starts_with("sha256:")));
        let without = read_narrative_scope_project_default(conn, P2)?;
        assert_eq!(
            without.default,
            NarrativeScopeProjectDefaultValueV1::None {}
        );
        assert_eq!(without.version, 0);
        assert_eq!(without.source_token, None);
        // R13: both registries are born with the main-line vocabulary.
        for project in [P1, P2] {
            let refs: (String, String, String, i64) = conn.query_row(
                "SELECT timeline_refs_json, worldline_refs_json, narrative_layer_refs_json, version
                   FROM narrative_scope_registries WHERE project_id = ?1",
                params![project],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(
                refs,
                (
                    format!("[\"{MAIN_LINE_TIMELINE_REF}\"]"),
                    format!("[\"{MAIN_LINE_WORLDLINE_REF}\"]"),
                    format!("[\"{MAIN_LINE_LAYER_REF}\"]"),
                    1
                )
            );
        }
        // R4: one canonical event for the default, no narrative feed for it.
        let events: Vec<(String, String)> = conn
            .prepare(
                "SELECT op_type, payload FROM change_events
                  WHERE project_id = ?1 ORDER BY sequence",
            )?
            .query_map(params![P1], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "project.create");
        assert_eq!(events[1].0, "scene.scope-default.update");
        let payload: Value = serde_json::from_str(&events[1].1)?;
        assert_eq!(payload["requestId"], format!("{P1}:create"));
        assert_eq!(payload["before"], Value::Null);
        assert_eq!(payload["after"]["state"], "set");
        assert_eq!(payload["after"]["version"], 1);
        let feed_sources: Vec<String> = conn
            .prepare(
                "SELECT source_domain FROM narrative_change_transactions WHERE project_id = ?1",
            )?
            .query_map(params![P1], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(feed_sources, vec!["project.create".to_owned()]);
        Ok(())
    })
    .expect("verify project creation");
}

/// A request without `sceneScopeDefault` keeps its idempotency fingerprint (the
/// field is not serialized when absent), and an unknown value is refused.
#[test]
fn the_project_create_field_is_closed_and_absent_from_old_fingerprints() {
    let base = json!({
        "projectId": "p", "requestId": "r", "sessionId": "s", "eventUid": "e",
        "origin": "human", "title": "t", "createdAt": NOW, "updatedAt": NOW,
    });
    let payload: ProjectCreatePayload = serde_json::from_value(base.clone()).expect("no field");
    assert!(serde_json::to_value(&payload)
        .expect("serialize")
        .get("sceneScopeDefault")
        .is_none());
    let mut with = base.clone();
    with["sceneScopeDefault"] = json!("main-line");
    let payload: ProjectCreatePayload = serde_json::from_value(with).expect("main-line");
    assert_eq!(
        payload.scene_scope_default,
        Some(ProjectSceneScopeDefaultInit::MainLine)
    );
    for value in [
        json!("flashback"),
        json!({"timeline": "timeline:main"}),
        json!(true),
    ] {
        let mut other = base.clone();
        other["sceneScopeDefault"] = value.clone();
        assert!(
            serde_json::from_value::<ProjectCreatePayload>(other).is_err(),
            "{value}"
        );
    }
}

// ------------------------------------------------------------- MD4 -------

#[test]
fn the_default_writer_validates_occ_idempotency_shape_and_membership() {
    let db = db();
    create_project(&db, P1, false);
    let first = write_default(&db, P1, "set-1", 0, main_line()).expect("first write");
    assert_eq!(first["version"], 1);
    // Same request, same payload: the stored response.
    assert_eq!(
        write_default(&db, P1, "set-1", 0, main_line()).expect("retry"),
        first
    );
    // Same request, another payload: a conflict.
    let error = write_default(
        &db,
        P1,
        "set-1",
        0,
        NarrativeScopeProjectDefaultValueV1::None {},
    )
    .expect_err("conflicting retry");
    assert!(
        error
            .to_string()
            .contains("NEX_SCENE_SCOPE_DEFAULT_REQUEST_CONFLICT"),
        "{error:#}"
    );
    // A stale base version.
    let error = write_default(&db, P1, "set-2", 0, main_line()).expect_err("stale base");
    assert!(
        error
            .to_string()
            .contains("NEX_SCENE_SCOPE_DEFAULT_VERSION_MISMATCH"),
        "{error:#}"
    );
    // Not a member of this project's registry.
    let error = write_default(&db, P1, "set-3", 1, set_value("timeline:flashback"))
        .expect_err("unregistered reference");
    assert!(
        error
            .to_string()
            .contains("NEX_SCENE_SCOPE_DEFAULT_REF_UNREGISTERED"),
        "{error:#}"
    );
    // Closed shape: any, unresolved, material different from the query.
    let mut shapes = Vec::new();
    for query in [
        NarrativeScopeConstraintV1::Any,
        NarrativeScopeConstraintV1::Unresolved {
            reason: "x".to_owned(),
        },
    ] {
        shapes.push(NarrativeScopeProjectDefaultValueV1::Set {
            query_identity: NarrativeSceneQueryIdentityV1 {
                timeline: query.clone(),
                worldline: exact(MAIN_LINE_WORLDLINE_REF),
                narrative_layer: exact(MAIN_LINE_LAYER_REF),
            },
            material_constraint: NarrativeSceneMaterialConstraintV1 {
                timeline: query,
                worldline: exact(MAIN_LINE_WORLDLINE_REF),
                narrative_layer: exact(MAIN_LINE_LAYER_REF),
            },
        });
    }
    let NarrativeScopeProjectDefaultValueV1::Set { query_identity, .. } = main_line() else {
        unreachable!()
    };
    shapes.push(NarrativeScopeProjectDefaultValueV1::Set {
        query_identity,
        material_constraint: NarrativeSceneMaterialConstraintV1 {
            timeline: NarrativeScopeConstraintV1::Any,
            worldline: exact(MAIN_LINE_WORLDLINE_REF),
            narrative_layer: exact(MAIN_LINE_LAYER_REF),
        },
    });
    for (index, shape) in shapes.into_iter().enumerate() {
        let error =
            write_default(&db, P1, &format!("shape-{index}"), 1, shape).expect_err("closed shape");
        assert!(
            error
                .to_string()
                .contains("NEX_SCENE_SCOPE_DEFAULT_INVALID"),
            "{error:#}"
        );
    }
    // Unknown fields and unknown states are refused by the wire type.
    for wire in [
        json!({"state": "set", "queryIdentity": {}, "materialConstraint": {}, "holder": {}}),
        json!({"state": "any"}),
        json!({"state": "none", "queryIdentity": null}),
    ] {
        assert!(
            serde_json::from_value::<NarrativeScopeProjectDefaultValueV1>(wire.clone()).is_err(),
            "{wire}"
        );
    }
    // A project that does not exist.
    let error =
        write_default(&db, "no-such-project", "set-4", 0, main_line()).expect_err("no project");
    assert!(error.to_string().contains("does not exist"), "{error:#}");
    // Nothing above changed the row.
    let read = db
        .with_read_transaction(|conn| read_narrative_scope_project_default(conn, P1))
        .expect("read");
    assert_eq!((read.default, read.version), (main_line(), 1));
}

/// R5 and A4: `none` keeps the row and advances `version`, so setting the same
/// value again never returns to an earlier token; and no default write changes
/// a binding, the registry or the project Scope authority token (R4, R17).
#[test]
fn default_writes_change_no_binding_registry_or_authority_token() {
    let db = db();
    create_project(&db, P1, false);
    create_scene(&db, P1, "s-before");
    let bindings = binding_rows(&db);
    let registry = registry_row(&db, P1);
    let authority = authority_token(&db, P1);
    let feed_before: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("count feed");

    let set = write_default(&db, P1, "a4-set", 0, main_line()).expect("set");
    let none = write_default(
        &db,
        P1,
        "a4-none",
        1,
        NarrativeScopeProjectDefaultValueV1::None {},
    )
    .expect("none");
    let set_again = write_default(&db, P1, "a4-set-again", 2, main_line()).expect("set again");

    assert_eq!(binding_rows(&db), bindings, "binding bytes");
    assert_eq!(registry_row(&db, P1), registry, "registry row");
    assert_eq!(
        authority_token(&db, P1),
        authority,
        "project Scope authority token"
    );
    let feed_after: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("count feed");
    assert_eq!(feed_after, feed_before, "no narrative feed");
    assert_eq!(
        marker(&db, P1, "s-before"),
        NarrativeScopeCompatibilityMarkerV1::Unknown
    );

    assert_eq!(none["default"], json!({"state": "none"}));
    assert_eq!(none["version"], 2);
    assert_eq!(set_again["version"], 3);
    assert_ne!(
        set_again["sourceToken"], set["sourceToken"],
        "no token reuse after none"
    );
    db.with_conn(|conn| {
        let rows: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_scope_project_defaults WHERE project_id = ?1",
            params![P1],
            |row| row.get(0),
        )?;
        assert_eq!(rows, 1, "none keeps the row");
        let history: Vec<String> = conn
            .prepare(
                "SELECT payload FROM change_events
                  WHERE project_id = ?1 AND op_type = 'scene.scope-default.update'
                  ORDER BY sequence",
            )?
            .query_map(params![P1], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(history.len(), 3);
        let middle: Value = serde_json::from_str(&history[1])?;
        assert_eq!(middle["requestId"], "a4-none");
        assert_eq!(middle["before"]["state"], "set");
        assert_eq!(middle["after"]["state"], "none");
        assert_eq!(middle["after"]["queryIdentity"], Value::Null);
        assert_eq!(middle["updatedAt"], NOW);
        Ok(())
    })
    .expect("read history");
}

// ------------------------------------------------------------- A5 --------

#[test]
fn a_registry_update_cannot_remove_a_reference_the_default_uses() {
    let db = db();
    create_project(&db, P1, true);
    let update = |request: &str, base_version: i64, timeline: Vec<String>| {
        update_narrative_scene_scope_registry(
            &db,
            NarrativeSceneScopeRegistryUpdatePayload {
                project_id: P1.to_owned(),
                request_id: request.to_owned(),
                session_id: "sdef-session".to_owned(),
                event_uid: format!("{request}:event"),
                base_version,
                updated_at: NOW.to_owned(),
                registry: NarrativeSceneScopeRegistryV1 {
                    registry_version: NARRATIVE_SCENE_SCOPE_REGISTRY_CONTRACT_ID.to_owned(),
                    timeline_refs: timeline,
                    worldline_refs: vec![MAIN_LINE_WORLDLINE_REF.to_owned()],
                    narrative_layer_refs: vec![MAIN_LINE_LAYER_REF.to_owned()],
                },
            },
        )
    };
    let registry = registry_row(&db, P1);
    let error = update("a5-remove", 1, vec!["timeline:flashback".to_owned()])
        .expect_err("the default's reference is in use");
    assert!(
        error
            .to_string()
            .contains("NEX_SCENE_SCOPE_DEFAULT_REF_IN_USE"),
        "{error:#}"
    );
    assert_eq!(registry_row(&db, P1), registry, "nothing is written");
    // Adding a reference is allowed.
    update(
        "a5-add",
        1,
        vec![
            MAIN_LINE_TIMELINE_REF.to_owned(),
            "timeline:flashback".to_owned(),
        ],
    )
    .expect("add a reference");
    // Once the default is cleared, the reference can go.
    write_default(
        &db,
        P1,
        "a5-none",
        1,
        NarrativeScopeProjectDefaultValueV1::None {},
    )
    .expect("none");
    update(
        "a5-remove-after-none",
        2,
        vec!["timeline:flashback".to_owned()],
    )
    .expect("remove after none");
}

// ------------------------------------------------------------- A1 --------

#[test]
fn a_forward_tree_creation_inherits_the_default_and_survives_a_cold_reopen() {
    let dir = std::env::temp_dir().join(format!("grimodex-sdef-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("grimodex.db");
    let first = {
        let db = Database::new(&path).expect("open");
        db.migrate().expect("migrate");
        create_project(&db, P1, true);
        create_scene(&db, P1, "s-forward");
        // A note and a folder carry no binding.
        tree_node_create(&db, create_payload(P1, "f-forward", "folder")).expect("folder");
        let read = db
            .with_read_transaction(|conn| read_narrative_scene_scope(conn, P1, "s-forward"))
            .expect("read");
        let binding = read.binding;
        assert_eq!(
            binding.compatibility_marker,
            NarrativeScopeCompatibilityMarkerV1::Explicit
        );
        let NarrativeScopeProjectDefaultValueV1::Set {
            query_identity,
            material_constraint,
        } = main_line()
        else {
            unreachable!()
        };
        assert_eq!(binding.query_identity, query_identity);
        assert_eq!(binding.material_constraint, material_constraint);
        assert_eq!(binding.version, 1);
        assert!(!binding.scene_incarnation_id.starts_with("legacy:"));
        assert_eq!(
            grimodex_core::narrative_scene_scope::source_token(&read.registry, &binding)
                .expect("token"),
            binding.source_token
        );
        binding
    };
    let db = Database::new(&path).expect("reopen");
    db.migrate().expect("migrate on reopen");
    let after = db
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, P1, "s-forward"))
        .expect("read after reopen")
        .binding;
    assert_eq!(after.compatibility_marker, first.compatibility_marker);
    assert_eq!(after.query_identity, first.query_identity);
    assert_eq!(after.scene_incarnation_id, first.scene_incarnation_id);
    assert_eq!(after.source_token, first.source_token);
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}

// ------------------------------------------------------------- A2 --------

#[test]
fn replayed_tree_creations_stay_unknown() {
    let db = db();
    create_project(&db, P1, true);
    // Undo of a Scene delete re-creates the same id with lineage.
    create_scene(&db, P1, "s-undo");
    assert_eq!(
        marker(&db, P1, "s-undo"),
        NarrativeScopeCompatibilityMarkerV1::Explicit
    );
    let (transaction, journal) = delete_node(&db, P1, "s-undo");
    let mut undo = create_payload(P1, "s-undo", "scene");
    undo.request_id = "s-undo:undo".to_owned();
    undo.event_uid = "s-undo:undo-event".to_owned();
    undo.origin = NarrativeChangeOrigin::Undo;
    undo.original_transaction_id = Some(transaction);
    undo.undo_journal_id = Some(journal);
    let context = renderer_context(
        &undo,
        "history-replay",
        "history-controller",
        &[
            "original-transaction",
            "journal-lineage",
            "typed-writer",
            "occ",
            "change-event",
            "change-feed",
        ],
    );
    tree_node_create_with_authority(&db, undo, Some(context)).expect("undo the delete");
    assert_eq!(
        marker(&db, P1, "s-undo"),
        NarrativeScopeCompatibilityMarkerV1::Unknown
    );

    // Redo of a creation.
    let forward = create_scene(&db, P1, "s-redo");
    let (transaction, journal) = lineage_of(&forward);
    let undo_create = TreeNodeDeletePayload {
        project_id: P1.to_owned(),
        request_id: "s-redo:undo".to_owned(),
        session_id: "sdef-session".to_owned(),
        event_uid: "s-redo:undo-event".to_owned(),
        origin: NarrativeChangeOrigin::Undo,
        original_transaction_id: Some(transaction.clone()),
        undo_journal_id: Some(journal.clone()),
        node_id: "s-redo".to_owned(),
        canonical_payload: None,
    };
    tree_node_delete(&db, undo_create).expect("undo the creation");
    let mut redo = create_payload(P1, "s-redo", "scene");
    redo.request_id = "s-redo:redo".to_owned();
    redo.event_uid = "s-redo:redo-event".to_owned();
    redo.origin = NarrativeChangeOrigin::Redo;
    redo.original_transaction_id = Some(transaction);
    redo.undo_journal_id = Some(journal);
    tree_node_create(&db, redo).expect("redo the creation");
    assert_eq!(
        marker(&db, P1, "s-redo"),
        NarrativeScopeCompatibilityMarkerV1::Unknown
    );
}

#[test]
fn undoing_a_chapter_delete_leaves_every_scene_below_it_unknown() {
    let db = db();
    create_project(&db, P1, true);
    tree_node_create(&db, create_payload(P1, "chapter", "folder")).expect("chapter");
    for scene in ["c-s1", "c-s2"] {
        let mut payload = create_payload(P1, scene, "scene");
        payload.parent_id = Some("chapter".to_owned());
        tree_node_create(&db, payload).expect("scene in chapter");
        assert_eq!(
            marker(&db, P1, scene),
            NarrativeScopeCompatibilityMarkerV1::Explicit
        );
    }
    // The renderer's subtree delete (`deleteTreeSubtree`) deletes every node
    // with its own Undo Journal, children first, and its undo re-creates them
    // parents first, each with its own lineage.
    let mut lineages = std::collections::BTreeMap::new();
    for id in ["c-s1", "c-s2", "chapter"] {
        lineages.insert(id, delete_node(&db, P1, id));
    }
    assert!(markers(&db, P1).is_empty(), "the whole chapter is gone");
    for (id, node_type, parent) in [
        ("chapter", "folder", None),
        ("c-s1", "scene", Some("chapter")),
        ("c-s2", "scene", Some("chapter")),
    ] {
        let (transaction, journal) = lineages[id].clone();
        let mut undo = create_payload(P1, id, node_type);
        undo.parent_id = parent.map(str::to_owned);
        undo.request_id = format!("{id}:undo");
        undo.event_uid = format!("{id}:undo-event");
        undo.origin = NarrativeChangeOrigin::Undo;
        undo.original_transaction_id = Some(transaction);
        undo.undo_journal_id = Some(journal);
        tree_node_create(&db, undo).expect("undo the chapter delete");
    }
    assert_eq!(
        markers(&db, P1),
        vec![
            ("c-s1".to_owned(), "unknown".to_owned()),
            ("c-s2".to_owned(), "unknown".to_owned())
        ]
    );
}

#[test]
fn external_import_and_restore_creations_stay_unknown() {
    let db = db();
    create_project(&db, P1, true);
    // Mount sync: a human origin with an external source.
    let mut mount = create_payload(P1, "s-mount", "scene");
    mount.source_uri = Some("file:///manuscript/01.md".to_owned());
    mount.source_mtime = Some("2026-11-04T00:00:00Z".to_owned());
    tree_node_create(&db, mount).expect("mount scene");
    let mut mtime_only = create_payload(P1, "s-mtime", "scene");
    mtime_only.source_mtime = Some("2026-11-04T00:00:00Z".to_owned());
    tree_node_create(&db, mtime_only).expect("mtime-only scene");
    // Import, with and without the import route.
    let mut import = create_payload(P1, "s-import", "scene");
    import.origin = NarrativeChangeOrigin::Import;
    tree_node_create(&db, import).expect("import scene");
    let mut routed = create_payload(P1, "s-import-routed", "scene");
    routed.origin = NarrativeChangeOrigin::Import;
    let context = renderer_context(
        &routed,
        "import-apply",
        "import-session",
        &[
            "import-policy",
            "source-package-evidence",
            "typed-writer",
            "occ",
            "change-event",
            "change-feed",
        ],
    );
    tree_node_create_with_authority(&db, routed, Some(context)).expect("routed import scene");
    // Restore origin (the future Trash restorer wiring, R11).
    let mut restore = create_payload(P1, "s-restore", "scene");
    restore.origin = NarrativeChangeOrigin::Restore;
    tree_node_create(&db, restore).expect("restore-origin scene");
    // And the human control, created last, still inherits.
    create_scene(&db, P1, "s-human");
    let markers = markers(&db, P1);
    for (scene, marker) in &markers {
        let expected = if scene == "s-human" {
            "explicit"
        } else {
            "unknown"
        };
        assert_eq!(marker, expected, "{scene}");
    }
    assert_eq!(markers.len(), 6);
}

#[test]
fn no_default_none_dangling_corrupt_and_another_projects_default_give_unknown() {
    let db = db();
    create_project(&db, P1, false);
    create_project(&db, P2, true);
    // No default in P1 (P2's default is not read).
    create_scene(&db, P1, "s-no-default");
    // `none`.
    write_default(
        &db,
        P1,
        "none-1",
        0,
        NarrativeScopeProjectDefaultValueV1::None {},
    )
    .expect("none");
    create_scene(&db, P1, "s-none");
    // Dangling: a default row naming a reference P1's registry lacks, with a
    // valid default token (only raw SQL can make it; the writers refuse).
    let dangling = set_value("timeline:ghost");
    db.with_conn(|conn| {
        let token = super::scene_scope_default::default_source_token(P1, &dangling, 2)?;
        let NarrativeScopeProjectDefaultValueV1::Set {
            query_identity,
            material_constraint,
        } = &dangling
        else {
            unreachable!()
        };
        conn.execute(
            "UPDATE narrative_scope_project_defaults
                SET state = 'set', query_identity_json = ?1, material_constraint_json = ?2,
                    version = 2, source_token = ?3
              WHERE project_id = ?4",
            params![
                serde_json::to_string(query_identity)?,
                serde_json::to_string(material_constraint)?,
                token,
                P1
            ],
        )?;
        Ok(())
    })
    .expect("make the default dangling");
    create_scene(&db, P1, "s-dangling");
    // Corrupt: the token no longer matches.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_scope_project_defaults
                SET query_identity_json = ?1, material_constraint_json = ?1
              WHERE project_id = ?2",
            params![
                serde_json::to_string(&NarrativeSceneQueryIdentityV1 {
                    timeline: exact(MAIN_LINE_TIMELINE_REF),
                    worldline: exact(MAIN_LINE_WORLDLINE_REF),
                    narrative_layer: exact(MAIN_LINE_LAYER_REF),
                })?,
                P1
            ],
        )?;
        Ok(())
    })
    .expect("corrupt the default");
    create_scene(&db, P1, "s-corrupt");
    assert!(
        markers(&db, P1)
            .iter()
            .all(|(_, marker)| marker == "unknown"),
        "{:?}",
        markers(&db, P1)
    );
    assert_eq!(markers(&db, P1).len(), 4);
    // The corrupt row is an error for the reader and for the registry writer.
    let error = db
        .with_read_transaction(|conn| read_narrative_scope_project_default(conn, P1))
        .expect_err("corrupt default");
    assert!(
        error
            .to_string()
            .contains("NEX_SCENE_SCOPE_DEFAULT_INVALID"),
        "{error:#}"
    );
    // P2's own Scene still inherits P2's default.
    create_scene(&db, P2, "s-other-project");
    assert_eq!(
        marker(&db, P2, "s-other-project"),
        NarrativeScopeCompatibilityMarkerV1::Explicit
    );
}

/// A note or folder never gets a binding, and an existing binding is never
/// replaced by the inheriting path (the early return is unchanged).
#[test]
fn the_inheriting_path_never_replaces_an_existing_binding() {
    let db = db();
    create_project(&db, P1, true);
    create_scene(&db, P1, "s-existing");
    let before = binding_rows(&db);
    db.with_conn(|conn| {
        super::ensure_scene_scope_binding_in_tx(
            conn,
            P1,
            "s-existing",
            "2026-11-05T00:00:00.000Z",
            SceneScopeInit::NewSceneInheritProjectDefault,
        )
    })
    .expect("ensure again");
    assert_eq!(binding_rows(&db), before);
}
