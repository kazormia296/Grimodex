//! A group: the invariants of the declaration and revoke writers (CB-2 S1).
#![cfg(feature = "native-current-human-capture")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection};
use serde_json::json;

use super::writer::{test_hooks, Stage};
use super::writer_test_support::*;
use super::*;
use crate::domain_writes::{tree_node_patch, TreeNodePatchPayload};
use crate::narrative_extraction::change_feed::NarrativeChangeOrigin;
use crate::narrative_extraction::project_scope_authority::load_live_project_scope_authority;
use crate::narrative_extraction::{
    read_narrative_scene_scope, update_narrative_scene_scope_registry,
    NarrativeSceneScopeRegistryUpdatePayload,
};
use crate::nir1_generation::Nir1StoreFailure;

#[derive(Debug, Eq, PartialEq)]
struct Counts {
    change_events: i64,
    idempotency: i64,
    feed_events: i64,
    feed_transactions: i64,
}

fn counts(env: &Env) -> Counts {
    env.with_conn(|conn| {
        Ok(Counts {
            change_events: count(conn, "SELECT count(*) FROM change_events"),
            idempotency: count(conn, "SELECT count(*) FROM idempotency_requests"),
            feed_events: count(conn, "SELECT count(*) FROM narrative_change_events"),
            feed_transactions: count(conn, "SELECT count(*) FROM narrative_change_transactions"),
        })
    })
}

fn declared_token(env: &Env, scene: &str) -> Option<String> {
    env.declaration_token(scene)
}

fn declare_ok(env: &Env, scene: &str) -> DeclareOutcome {
    let project = if scene == OTHER_SCENE {
        OTHER_PROJECT
    } else {
        PROJECT
    };
    declare(env, request_for(env, project, scene)).expect("declaration")
}

// ---- A1 / A2 / A3 -----------------------------------------------------------

struct Rows {
    binding: std::collections::BTreeMap<String, String>,
    tree: std::collections::BTreeMap<String, String>,
    other_binding: std::collections::BTreeMap<String, String>,
    other_tree: std::collections::BTreeMap<String, String>,
    registry: std::collections::BTreeMap<String, String>,
}

fn rows(env: &Env) -> Rows {
    env.with_conn(|conn| {
        Ok(Rows {
            binding: binding_row_without_declaration(conn, PROJECT, SCENE),
            tree: tree_row(conn, SCENE),
            other_binding: binding_row_without_declaration(conn, PROJECT, SECOND_SCENE),
            other_tree: tree_row(conn, SECOND_SCENE),
            registry: dump_row(
                conn,
                "SELECT * FROM narrative_scope_registries WHERE project_id = ?1",
                &[PROJECT],
                &[],
            ),
        })
    })
}

fn assert_same_rows(before: &Rows, after: &Rows, step: &str) {
    assert_eq!(
        before.binding, after.binding,
        "{step}: binding row (updated_at included)"
    );
    assert_eq!(
        before.tree, after.tree,
        "{step}: tree_nodes row (version and updated_at included)"
    );
    assert_eq!(
        before.other_binding, after.other_binding,
        "{step}: another Scene's binding"
    );
    assert_eq!(
        before.other_tree, after.other_tree,
        "{step}: another Scene's tree row"
    );
    assert_eq!(before.registry, after.registry, "{step}: registry");
}

#[test]
fn declare_writes_only_the_two_declaration_columns() {
    let env = Env::new();
    let before = rows(&env);

    let outcome = declare_ok(&env, SCENE);
    assert_eq!(outcome.response, DeclareResponse::Declared);
    assert!(!outcome.replayed);
    assert_eq!(outcome.evidence.kind(), TerminalKind::Committed);
    let token = declared_token(&env, SCENE).expect("token set");
    assert_same_rows(&before, &rows(&env), "after declare");

    // The stored declaration reads back as the one the writer made.
    let read = env.with_conn(|conn| read_scene_body_declaration(conn, PROJECT, SCENE));
    match read {
        SceneBodyDeclarationRead::Declared(stored) => {
            assert_eq!(stored.token, token);
            assert!(stored.declaration.canonical_json().unwrap().len() <= 2400);
        }
        other => panic!("{other:?}"),
    }

    let revoked = revoke_scene_body(
        &env.snapshot(),
        revoke_request(PROJECT, SCENE, &token),
        &budget(),
    )
    .expect("revoke");
    assert_eq!(revoked.response, RevokeResponse::Revoked);
    assert_eq!(declared_token(&env, SCENE), None);
    assert_same_rows(&before, &rows(&env), "after revoke");
    let json_cell: Option<String> = env.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT body_declaration_json FROM narrative_scene_scope_bindings WHERE scene_id = ?1",
            [SCENE],
            |row| row.get(0),
        )?)
    });
    assert_eq!(json_cell, None);
}

#[test]
fn declare_writer_mutation_updated_at_is_detected() {
    // The same writer, with a change that also rewrites `updated_at`: the byte
    // comparison of A1 and the v1 token check both fail.
    let env = Env::new();
    let before = rows(&env);
    test_hooks::mutate_updated_at(true);
    let result = declare(&env, scene_request(&env));
    test_hooks::mutate_updated_at(false);
    result.expect("the mutated writer still writes");
    let after = rows(&env);
    assert_ne!(
        before.binding, after.binding,
        "A1's byte comparison sees the change"
    );
    let read = env.with_conn(|conn| Ok(read_narrative_scene_scope(conn, PROJECT, SCENE).is_err()));
    assert!(
        read,
        "A3's v1 reader refuses the row (NEX_SCENE_SCOPE_SOURCE_TOKEN_INVALID)"
    );
}

fn rename_scene(env: &Env, scene: &str, title: &str) {
    let label = unique("patch");
    tree_node_patch(
        env.db().db(),
        TreeNodePatchPayload {
            project_id: PROJECT.into(),
            request_id: label.clone(),
            session_id: "session".into(),
            event_uid: format!("{label}-event"),
            node_id: scene.into(),
            patch: json!({ "title": title }).as_object().cloned().unwrap(),
            base_version: None,
            bump_version: true,
            updated_at: "2026-10-18T05:00:00.000Z".into(),
            change_event: None,
            timelapse_doc_step_coverage: None,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            source_domain: None,
            op_type: None,
            canonical_payload: None,
        },
    )
    .expect("rename");
}

fn scope_digest(env: &Env) -> String {
    env.with_conn(|conn| {
        Ok(
            load_live_project_scope_authority(conn, PROJECT, "project:scope-authority:p1")?
                .source
                .revision_token,
        )
    })
}

#[test]
fn v1_readers_and_writers_keep_working_after_declare_and_revoke() {
    let env = Env::new();
    let authority_before = scope_digest(&env);
    declare_ok(&env, SCENE);
    let token = declared_token(&env, SCENE).unwrap();
    assert_eq!(
        scope_digest(&env),
        authority_before,
        "scope_extension_digest unchanged by a declaration"
    );

    // A1 reader, A1 save, rename and a registry change succeed.
    let ok_reads = |env: &Env| {
        env.with_conn(|conn| {
            let read = read_narrative_scene_scope(conn, PROJECT, SCENE)?;
            assert!(read.binding.version >= 1);
            Ok(())
        })
    };
    ok_reads(&env);
    revoke_scene_body(
        &env.snapshot(),
        revoke_request(PROJECT, SCENE, &token),
        &budget(),
    )
    .unwrap();
    assert_eq!(
        scope_digest(&env),
        authority_before,
        "unchanged by a revoke"
    );
    ok_reads(&env);

    set_a1(env.db().db(), PROJECT, SCENE, true);
    rename_scene(&env, SCENE, "Renamed");
    let read = env
        .db()
        .db()
        .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, SCENE))
        .unwrap();
    let mut registry = read.registry.clone();
    registry.timeline_refs.push("tl2".into());
    update_narrative_scene_scope_registry(
        env.db().db(),
        NarrativeSceneScopeRegistryUpdatePayload {
            project_id: PROJECT.into(),
            request_id: unique("registry"),
            session_id: "session".into(),
            event_uid: unique("registry-event"),
            base_version: read.registry_revision,
            updated_at: "2026-10-18T06:00:00.000Z".into(),
            registry,
        },
    )
    .expect("registry change after a declaration");
    // The row is still a valid v1 row and the Scene can be declared again.
    declare_ok(&env, SCENE);
}

// ---- A4 -----------------------------------------------------------------------

#[test]
fn declare_feed_and_idempotency_share_the_transaction() {
    for stage in [
        Stage::BeforeUpdate,
        Stage::AfterUpdate,
        Stage::AfterFeed,
        Stage::AfterIdempotency,
    ] {
        let env = Env::new();
        let before = counts(&env);
        let rows_before = rows(&env);
        let request = scene_request(&env);
        test_hooks::fail_at(Some(stage));
        let failure = declare(&env, request.clone()).expect_err("injected failure");
        test_hooks::fail_at(None);
        assert_eq!(failure.refusal, DeclareRefusal::Internal, "{stage:?}");
        assert_eq!(failure.evidence.unwrap().kind(), TerminalKind::RolledBack);
        assert_eq!(declared_token(&env, SCENE), None, "{stage:?}");
        assert_eq!(counts(&env), before, "{stage:?}: nothing partial remains");
        assert_same_rows(&rows_before, &rows(&env), &format!("{stage:?}"));
        // Nothing was retried and the request can be made again.
        declare(&env, request).expect("a new attempt");
    }
}

#[test]
fn the_same_failure_in_a_revoke_leaves_nothing_partial() {
    for stage in [
        Stage::AfterUpdate,
        Stage::AfterFeed,
        Stage::AfterIdempotency,
    ] {
        let env = Env::new();
        declare_ok(&env, SCENE);
        let token = declared_token(&env, SCENE).unwrap();
        let before = counts(&env);
        test_hooks::fail_at(Some(stage));
        let failure = revoke_scene_body(
            &env.snapshot(),
            revoke_request(PROJECT, SCENE, &token),
            &budget(),
        )
        .expect_err("injected failure");
        test_hooks::fail_at(None);
        assert_eq!(failure.refusal, DeclareRefusal::Internal);
        assert_eq!(declared_token(&env, SCENE), Some(token), "{stage:?}");
        assert_eq!(counts(&env), before, "{stage:?}");
    }
}

// ---- A5 -----------------------------------------------------------------------

fn index_rows(env: &Env) -> Vec<(String, i64, i64)> {
    env.with_conn(|conn| {
        let mut statement = conn.prepare(
            "SELECT index_key, generation, dirty_cache_flag
               FROM narrative_semantic_index_metadata WHERE project_id = ?1 ORDER BY index_key",
        )?;
        let rows = statement
            .query_map([PROJECT], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

#[test]
fn declaration_does_not_touch_revisions_or_indexes() {
    let env = Env::new();
    env.with_conn(|conn| {
        for key in [
            crate::narrative_extraction::nir1_chronicle_index::INDEX_KEY,
            crate::narrative_extraction::nir1_entity_relation_index::INDEX_KEY,
        ] {
            conn.execute(
                "INSERT INTO narrative_semantic_index_metadata
                    (project_id, index_key, generation, built_at, source_digest,
                     dependency_set_digest, dirty_cache_flag)
                 VALUES (?1, ?2, 3, ?3, 'source', 'deps', 0)",
                params![PROJECT, key, NOW],
            )?;
        }
        Ok(())
    });
    let before = index_rows(&env);
    assert_eq!(before.len(), 2);
    let authority = scope_digest(&env);

    declare_ok(&env, SCENE);
    let token = declared_token(&env, SCENE).unwrap();
    assert_eq!(
        index_rows(&env),
        before,
        "declare leaves the Index metadata alone"
    );
    assert_eq!(scope_digest(&env), authority);
    revoke_scene_body(
        &env.snapshot(),
        revoke_request(PROJECT, SCENE, &token),
        &budget(),
    )
    .unwrap();
    assert_eq!(
        index_rows(&env),
        before,
        "revoke leaves the Index metadata alone"
    );
    assert_eq!(scope_digest(&env), authority);

    // Control: the metadata rows do react to a transaction of another kind.
    set_a1(env.db().db(), PROJECT, EMPTY_SCENE, true);
    assert!(
        index_rows(&env).iter().all(|(_, _, dirty)| *dirty == 1),
        "an A1 change dirties them as today"
    );
}

// ---- A6 / A7 ------------------------------------------------------------------

#[test]
fn redeclare_after_revoke_changes_declaration_id_and_token() {
    let env = Env::new();
    declare_ok(&env, SCENE);
    let first_token = declared_token(&env, SCENE).unwrap();
    let first = env.with_conn(|conn| read_scene_body_declaration(conn, PROJECT, SCENE));
    revoke_scene_body(
        &env.snapshot(),
        revoke_request(PROJECT, SCENE, &first_token),
        &budget(),
    )
    .unwrap();
    declare_ok(&env, SCENE);
    let second_token = declared_token(&env, SCENE).unwrap();
    assert_ne!(
        first_token, second_token,
        "ABA: the same values and binding, a new declaration"
    );
    let second = env.with_conn(|conn| read_scene_body_declaration(conn, PROJECT, SCENE));
    let (SceneBodyDeclarationRead::Declared(first), SceneBodyDeclarationRead::Declared(second)) =
        (first, second)
    else {
        panic!("both declared");
    };
    assert_ne!(
        first.declaration.declaration_id,
        second.declaration.declaration_id
    );
    assert_eq!(
        first.declaration.binding.body_source,
        second.declaration.binding.body_source
    );
    assert_eq!(
        first.declaration.binding.title_digest,
        second.declaration.binding.title_digest
    );
}

#[test]
fn the_payload_has_no_field_for_an_id_a_time_a_digest_or_a_grant() {
    let valid = json!({
        "projectId": "p1", "sceneId": "s1", "requestId": "r1",
        "expected": { "scopeVersion": 1, "scopeToken": "sha256:aa", "declarationToken": null },
        "values": { "story": "independent", "auto": "independent", "phase": "independent",
                    "reveal": "non-secret", "pov": "independent" },
    });
    serde_json::from_value::<DeclareRequest>(valid.clone()).expect("the valid payload parses");
    for (field, value) in [
        (
            "declarationId",
            json!("3f2b8f0e-5a41-4c1d-9e0a-7b6d2c4e8a11"),
        ),
        ("declaredAt", json!("2026-10-18T00:00:00.000Z")),
        ("titleDigest", json!("sha256:aa")),
        ("grant", json!({ "grantId": "x" })),
        ("senderId", json!(1)),
        ("windowId", json!(1)),
        ("previewId", json!("p")),
        ("binding", json!({})),
    ] {
        let mut forged = valid.clone();
        forged[field] = value;
        assert!(
            serde_json::from_value::<DeclareRequest>(forged).is_err(),
            "{field} must be refused"
        );
    }
    // A value outside the G-01 subset, a missing axis, a missing `null`.
    for (axis, value) in [
        ("story", json!("after-scene-3")),
        ("reveal", json!("secret")),
        ("pov", json!("character")),
        ("auto", json!("conditional")),
    ] {
        let mut forged = valid.clone();
        forged["values"][axis] = value;
        assert!(
            serde_json::from_value::<DeclareRequest>(forged).is_err(),
            "{axis}"
        );
    }
    let mut forged = valid.clone();
    forged["values"].as_object_mut().unwrap().remove("phase");
    assert!(serde_json::from_value::<DeclareRequest>(forged).is_err());
    let mut forged = valid.clone();
    forged["expected"]
        .as_object_mut()
        .unwrap()
        .remove("declarationToken");
    assert!(serde_json::from_value::<DeclareRequest>(forged).is_err());
    // The revoke payload is closed in the same way.
    let revoke =
        json!({ "projectId": "p1", "sceneId": "s1", "requestId": "r", "declarationToken": "t" });
    serde_json::from_value::<RevokeRequest>(revoke.clone()).unwrap();
    let mut forged = revoke;
    forged["grant"] = json!("g");
    assert!(serde_json::from_value::<RevokeRequest>(forged).is_err());
}

#[test]
fn declaration_survives_close_and_reopen() {
    let mut env = Env::new();
    declare_ok(&env, SCENE);
    let token = declared_token(&env, SCENE).unwrap();
    env.reopen();
    assert_eq!(declared_token(&env, SCENE), Some(token.clone()));
    let SceneBodyDeclarationRead::Declared(stored) =
        env.with_conn(|conn| read_scene_body_declaration(conn, PROJECT, SCENE))
    else {
        panic!("declared");
    };
    // The binding still holds: the facts are read by a new authority instance.
    let preview =
        preview_scene_body_declaration(&env.snapshot(), &scene_request(&env), &budget()).unwrap();
    let binding = preview.binding;
    let facts = SceneBodyDeclarationCurrentFacts {
        project_id: binding.project_id.clone(),
        scene_id: binding.scene_id.clone(),
        scene_incarnation_id: binding.scene_incarnation_id.clone(),
        scope_source_token: binding.scope_token.clone(),
        body_source: binding.body_source.clone(),
        title_digest: binding.title_digest.clone(),
        workspace_id: binding.workspace_id.clone(),
        canonical_locator_digest: binding.canonical_locator_digest.clone(),
    };
    assert!(scene_body_declaration_binding_holds(
        &stored.declaration,
        &facts
    ));
    assert_eq!(stored.declaration.binding.workspace_id, env.workspace_id);
    assert_eq!(
        stored.declaration.binding.canonical_locator_digest,
        env.identity().canonical_locator_digest.as_str()
    );
}

// ---- A8 -----------------------------------------------------------------------

/// Previews, applies `change`, then writes with the old confirmation. The write
/// is refused, nothing is written, and the refusal is `expected`.
fn changed_between_preview_and_write(
    change: impl FnOnce(&mut Env),
    expected: impl FnOnce(DeclareRefusal) -> bool,
    label: &str,
) {
    let mut env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).expect("preview");
    let counts_before = counts(&env);
    change(&mut env);
    let counts_mid = counts(&env);
    let failure =
        declare_scene_body(&env.snapshot(), consumed, request, &budget()).expect_err(label);
    assert!(expected(failure.refusal), "{label}: {:?}", failure.refusal);
    assert_eq!(
        counts(&env),
        counts_mid,
        "{label}: the refused write adds nothing (before the change: {counts_before:?})"
    );
}

fn state_changed(component: StateComponent) -> impl FnOnce(DeclareRefusal) -> bool {
    move |refusal| refusal == DeclareRefusal::StateChanged(component)
}

fn any_state_change(refusal: DeclareRefusal) -> bool {
    matches!(refusal, DeclareRefusal::StateChanged(_))
}

fn raw(env: &Env, sql: &str, args: &[&dyn rusqlite::ToSql]) {
    env.with_conn(|conn| {
        conn.execute(sql, args)?;
        Ok(())
    });
}

#[test]
fn occ_rejects_each_changed_component() {
    changed_between_preview_and_write(
        |env| set_a1(env.db().db(), PROJECT, SCENE, true),
        state_changed(StateComponent::ScopeVersion),
        "A1 change (v1 version and token)",
    );
    changed_between_preview_and_write(
        |env| {
            let read = env
                .db()
                .db()
                .with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, SCENE))
                .unwrap();
            let mut registry = read.registry.clone();
            registry.timeline_refs.push("tl2".into());
            update_narrative_scene_scope_registry(
                env.db().db(),
                NarrativeSceneScopeRegistryUpdatePayload {
                    project_id: PROJECT.into(),
                    request_id: unique("registry"),
                    session_id: "session".into(),
                    event_uid: unique("registry-event"),
                    base_version: read.registry_revision,
                    updated_at: "2026-10-18T06:00:00.000Z".into(),
                    registry,
                },
            )
            .unwrap();
        },
        any_state_change,
        "registry change",
    );
    changed_between_preview_and_write(
        |env| {
            env.with_conn(|conn| {
                crate::narrative_extraction::task_leases::with_immediate_transaction(conn, |tx| {
                    let declaration = super::test_support::test_declaration(tx, PROJECT, SCENE)?;
                    super::test_support::set_scene_body_declaration_for_test(tx, &declaration)
                })
            });
        },
        state_changed(StateComponent::DeclarationToken),
        "another declaration appeared",
    );
    changed_between_preview_and_write(
        |env| {
            // A new incarnation of the same Scene id (what deleting and creating
            // it again gives), with a v1 token that is consistent with it.
            env.with_conn(|conn| {
                let read = read_narrative_scene_scope(conn, PROJECT, SCENE)?;
                let mut binding = read.binding.clone();
                binding.scene_incarnation_id = "incarnation-b".into();
                binding.source_token =
                    grimodex_core::narrative_scene_scope::source_token(&read.registry, &binding)?;
                conn.execute(
                    "UPDATE narrative_scene_scope_bindings
                        SET scene_incarnation_id = ?3, source_token = ?4
                      WHERE project_id = ?1 AND scene_id = ?2",
                    params![
                        PROJECT,
                        SCENE,
                        binding.scene_incarnation_id,
                        binding.source_token
                    ],
                )?;
                Ok(())
            });
        },
        state_changed(StateComponent::Incarnation),
        "the Scene was deleted and created again",
    );
    changed_between_preview_and_write(
        |env| {
            raw(
                env,
                "UPDATE tree_nodes SET version = version + 1, updated_at = ?2 WHERE id = ?1",
                &[&SCENE, &"2026-10-18T07:00:00.000Z"],
            )
        },
        state_changed(StateComponent::BodyToken),
        "body Source token (version and updated_at)",
    );
    changed_between_preview_and_write(
        |env| {
            raw(
                env,
                "UPDATE tree_nodes SET content = ?2 WHERE id = ?1",
                &[&SCENE, &body_json("Same token, other bytes.")],
            )
        },
        state_changed(StateComponent::BodyDigest),
        "body bytes under the same token",
    );
    changed_between_preview_and_write(
        |env| {
            raw(
                env,
                "UPDATE tree_nodes SET title = ?2 WHERE id = ?1",
                &[&SCENE, &"Other title"],
            )
        },
        state_changed(StateComponent::TitleDigest),
        "title",
    );
    changed_between_preview_and_write(
        |env| env.reopen(),
        state_changed(StateComponent::Workspace),
        "the workspace was closed and opened again (a new authority instance)",
    );
    changed_between_preview_and_write(
        |env| {
            let label = unique("move");
            tree_node_patch(
                env.db().db(),
                TreeNodePatchPayload {
                    project_id: PROJECT.into(),
                    request_id: label.clone(),
                    session_id: "session".into(),
                    event_uid: format!("{label}-event"),
                    node_id: SCENE.into(),
                    patch: json!({ "parentId": "f1" }).as_object().cloned().unwrap(),
                    base_version: None,
                    bump_version: true,
                    updated_at: "2026-10-18T08:00:00.000Z".into(),
                    change_event: None,
                    timelapse_doc_step_coverage: None,
                    origin: NarrativeChangeOrigin::Human,
                    original_transaction_id: None,
                    undo_journal_id: None,
                    source_domain: None,
                    op_type: None,
                    canonical_payload: None,
                },
            )
            .unwrap();
        },
        any_state_change,
        "the Scene moved into a folder",
    );
}

#[test]
fn a_binding_that_names_another_request_is_refused_before_a_transaction() {
    let env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).unwrap();
    test_hooks::reset();
    let mut other = request.clone();
    other.scene_id = SECOND_SCENE.into();
    let failure = declare_scene_body(&env.snapshot(), consumed, other, &budget()).unwrap_err();
    assert_eq!(
        failure.refusal,
        DeclareRefusal::StateChanged(StateComponent::Request)
    );
    assert!(failure.evidence.is_none());
    assert_eq!(test_hooks::transactions_opened(), 0);

    // The OCC of the request must be the binding's OCC too.
    let consumed = consumed_for(&env, &request).unwrap();
    let mut stale = request.clone();
    stale.expected.scope_version += 1;
    let failure = declare_scene_body(&env.snapshot(), consumed, stale, &budget()).unwrap_err();
    assert_eq!(
        failure.refusal,
        DeclareRefusal::StateChanged(StateComponent::ScopeVersion)
    );
}

// ---- A9 -----------------------------------------------------------------------

fn add_secret_foreshadow(env: &Env, scene: &str) {
    env.with_conn(|conn| {
        conn.execute(
            "INSERT INTO foreshadows (id, project_id, title, secret, created_at, updated_at)
             VALUES ('f-secret', 'p1', 'F', 1, 0, 0)",
            [],
        )?;
        conn.execute(
            "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                                            semantic_key, created_at, updated_at)
             VALUES ('su-secret', 'f-secret', ?1, 0, 1, 'plant', 'su-secret', 0, 0)",
            [scene],
        )?;
        Ok(())
    });
}

#[test]
fn veto_refuses_in_preview_and_in_writer() {
    type Setup = fn(&Env);
    let cases: [(&str, Setup, DeclareRefusal); 6] = [
        (
            "secret foreshadow",
            |env| add_secret_foreshadow(env, SCENE),
            DeclareRefusal::Veto(BodyDeclarationVeto::SecretForeshadow),
        ),
        (
            "secret event reveal",
            |env| {
                raw(env, "INSERT INTO events (id, project_id, secret, reveal_scene_id) VALUES ('e1','p1',1,?1)", &[&SCENE]);
            },
            DeclareRefusal::Veto(BodyDeclarationVeto::SecretEventReveal),
        ),
        (
            "secret event link",
            |env| {
                raw(
                    env,
                    "INSERT INTO events (id, project_id, secret) VALUES ('e1','p1',1)",
                    &[],
                );
                raw(
                    env,
                    "INSERT INTO scene_events (scene_id, event_id) VALUES (?1,'e1')",
                    &[&SCENE],
                );
            },
            DeclareRefusal::Veto(BodyDeclarationVeto::SecretEventLink),
        ),
        (
            "scene POV",
            |env| {
                raw(
                    env,
                    "UPDATE tree_nodes SET pov_character_id = 'c1' WHERE id = ?1",
                    &[&SCENE],
                )
            },
            DeclareRefusal::Veto(BodyDeclarationVeto::Pov),
        ),
        (
            "beat POV cache",
            |env| {
                raw(env, "INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id) VALUES (?1,'c1')", &[&SCENE])
            },
            DeclareRefusal::Veto(BodyDeclarationVeto::Pov),
        ),
        (
            "sceneBeat pov attribute",
            |env| {
                let content = json!({"type":"doc","content":[
                    {"type":"paragraph","content":[{"type":"text","text":"x"}]},
                    {"type":"sceneBeat","attrs":{"pov":"c1"},"content":[]}]});
                raw(
                    env,
                    "UPDATE tree_nodes SET content = ?2 WHERE id = ?1",
                    &[&SCENE, &content.to_string()],
                );
            },
            DeclareRefusal::Veto(BodyDeclarationVeto::Pov),
        ),
    ];
    for (name, setup, expected) in cases {
        // The preview refuses.
        let env = Env::new();
        setup(&env);
        let request = scene_request(&env);
        assert_eq!(
            preview_scene_body_declaration(&env.snapshot(), &request, &budget()).unwrap_err(),
            expected,
            "{name}: preview"
        );
        // A record added after the preview is refused by the writer.
        let env = Env::new();
        let request = scene_request(&env);
        let consumed = consumed_for(&env, &request).expect("preview before the record");
        setup(&env);
        let failure =
            declare_scene_body(&env.snapshot(), consumed, request, &budget()).expect_err(name);
        // A record that changes the Scene's own columns also moves a binding
        // component; either way the write is refused.
        assert!(
            failure.refusal == expected
                || matches!(failure.refusal, DeclareRefusal::StateChanged(_)),
            "{name}: {:?}",
            failure.refusal
        );
        assert_eq!(declared_token(&env, SCENE), None, "{name}");
    }
}

#[test]
fn a_veto_record_added_after_the_preview_is_refused_by_the_writer_itself() {
    let env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).unwrap();
    add_secret_foreshadow(&env, SCENE);
    let failure = declare_scene_body(&env.snapshot(), consumed, request, &budget()).unwrap_err();
    assert_eq!(
        failure.refusal,
        DeclareRefusal::Veto(BodyDeclarationVeto::SecretForeshadow)
    );
    assert_eq!(failure.refusal.code(), "veto-secret-foreshadow");
}

// ---- A10 ----------------------------------------------------------------------

fn preview_refusal(env: &Env, project: &str, scene: &str) -> DeclareRefusal {
    preview_scene_body_declaration(
        &env.snapshot(),
        &request_for(env, project, scene),
        &budget(),
    )
    .unwrap_err()
}

#[test]
fn preconditions_refuse() {
    let env = Env::new();
    assert_eq!(
        preview_refusal(&env, PROJECT, LEGACY_SCENE),
        DeclareRefusal::ScopeNotExplicit
    );
    assert_eq!(
        preview_refusal(&env, PROJECT, ARCHIVED_SCENE),
        DeclareRefusal::SceneArchived
    );
    assert_eq!(
        preview_refusal(&env, PROJECT, EMPTY_SCENE),
        DeclareRefusal::BodyEmpty
    );
    // The Scene exists, but in another project.
    let mut request = request_for(&env, OTHER_PROJECT, OTHER_SCENE);
    request.project_id = PROJECT.into();
    assert_eq!(
        preview_scene_body_declaration(&env.snapshot(), &request, &budget()).unwrap_err(),
        DeclareRefusal::SceneNotFound
    );
    let mut request = scene_request(&env);
    request.scene_id = "missing".into();
    assert_eq!(
        preview_scene_body_declaration(&env.snapshot(), &request, &budget()).unwrap_err(),
        DeclareRefusal::SceneNotFound
    );
    // Unresolved query axes are not "explicit and resolved".
    set_a1(env.db().db(), PROJECT, SECOND_SCENE, false);
    assert_eq!(
        preview_refusal(&env, PROJECT, SECOND_SCENE),
        DeclareRefusal::ScopeUnresolved
    );
    // A Scene under an archived folder is not live.
    raw(
        &env,
        "UPDATE tree_nodes SET parent_id = 'f1' WHERE id = ?1",
        &[&SCENE],
    );
    raw(
        &env,
        "UPDATE tree_nodes SET archived_at = '2026-10-17 00:00:00' WHERE id = 'f1'",
        &[],
    );
    assert_eq!(
        preview_refusal(&env, PROJECT, SCENE),
        DeclareRefusal::SceneArchived
    );
    // Invalid payload values.
    let mut request = scene_request(&env);
    request.request_id = " ".into();
    assert_eq!(
        preview_scene_body_declaration(&env.snapshot(), &request, &budget()).unwrap_err(),
        DeclareRefusal::InvalidRequest
    );
    // The codes are the closed ones.
    for refusal in [
        DeclareRefusal::ScopeNotExplicit,
        DeclareRefusal::SceneArchived,
        DeclareRefusal::BodyEmpty,
        DeclareRefusal::SceneNotFound,
    ] {
        assert!(!refusal.code().contains("p1") && !refusal.code().contains("s1"));
    }
}

#[test]
fn a_workspace_without_a_canonical_locator_cannot_declare() {
    let env = Env::without_durable_identity();
    let request = scene_request(&env);
    assert_eq!(
        preview_scene_body_declaration(&env.snapshot(), &request, &budget()).unwrap_err(),
        DeclareRefusal::LocatorUnavailable
    );
    let counts_before = counts(&env);
    let binding = {
        // Even a consumed binding made elsewhere cannot be written here.
        let other = Env::new();
        consumed_for(&other, &scene_request(&other)).unwrap()
    };
    let failure = declare_scene_body(&env.snapshot(), binding, request, &budget()).unwrap_err();
    assert_eq!(failure.refusal, DeclareRefusal::LocatorUnavailable);
    assert_eq!(counts(&env), counts_before);
    assert_eq!(declared_token(&env, SCENE), None);
}

#[test]
fn a_binding_made_in_another_workspace_is_refused() {
    let env = Env::new();
    let other = Env::new();
    let request = scene_request(&other);
    let consumed = consumed_for(&other, &request).expect("other preview");
    let failure = declare_scene_body(&env.snapshot(), consumed, request, &budget()).unwrap_err();
    assert!(
        matches!(failure.refusal, DeclareRefusal::StateChanged(_)),
        "{:?}",
        failure.refusal
    );
    assert_eq!(declared_token(&env, SCENE), None);
}

// ---- A11 ----------------------------------------------------------------------

#[test]
fn idempotent_resend_returns_recorded_response() {
    let env = Env::new();
    let request = scene_request(&env);
    let binding = preview_scene_body_declaration(&env.snapshot(), &request, &budget())
        .unwrap()
        .binding;
    let first = declare_scene_body(
        &env.snapshot(),
        ConsumedBodyDeclarationBinding::from_consumed_grant(binding.clone()),
        request.clone(),
        &budget(),
    )
    .unwrap();
    assert!(!first.replayed);
    let token = declared_token(&env, SCENE).unwrap();
    let after_first = counts(&env);

    // The same request and payload again (with its own confirmation): the
    // recorded response, no new declaration ID and no new event.
    let again = declare_scene_body(
        &env.snapshot(),
        ConsumedBodyDeclarationBinding::from_consumed_grant(binding.clone()),
        request.clone(),
        &budget(),
    )
    .unwrap();
    assert!(again.replayed);
    assert_eq!(again.response, DeclareResponse::Declared);
    assert_eq!(declared_token(&env, SCENE), Some(token));
    assert_eq!(counts(&env), after_first);

    // The same request ID with another payload is a conflict.
    let second_request = DeclareRequest {
        scene_id: SECOND_SCENE.into(),
        request_id: request.request_id.clone(),
        ..request_for(&env, PROJECT, SECOND_SCENE)
    };
    let second_binding =
        preview_scene_body_declaration(&env.snapshot(), &second_request, &budget())
            .unwrap()
            .binding;
    let failure = declare_scene_body(
        &env.snapshot(),
        ConsumedBodyDeclarationBinding::from_consumed_grant(second_binding),
        second_request,
        &budget(),
    )
    .unwrap_err();
    assert_eq!(failure.refusal, DeclareRefusal::RequestConflict);
    assert_eq!(declared_token(&env, SECOND_SCENE), None);
    assert_eq!(counts(&env), after_first);
}

// ---- A12 ----------------------------------------------------------------------

fn undo_rows(env: &Env) -> i64 {
    env.with_conn(|conn| Ok(count(conn, "SELECT count(*) FROM undo_journal")))
}

#[test]
fn revoke_with_nothing_to_revoke_writes_nothing() {
    let env = Env::new();
    let before = counts(&env);
    let rows_before = rows(&env);

    // No declaration: nothing written, nothing recorded.
    let none = revoke_scene_body(
        &env.snapshot(),
        revoke_request(PROJECT, SCENE, "sha256:x"),
        &budget(),
    )
    .unwrap();
    assert_eq!(none.response, RevokeResponse::NoDeclaration);
    assert_eq!(none.response.code(), "no-declaration");
    assert_eq!(counts(&env), before);

    // A different token: nothing written.
    declare_ok(&env, SCENE);
    let token = declared_token(&env, SCENE).unwrap();
    let after_declare = counts(&env);
    let changed = revoke_scene_body(
        &env.snapshot(),
        revoke_request(PROJECT, SCENE, "sha256:other"),
        &budget(),
    )
    .unwrap();
    assert_eq!(changed.response, RevokeResponse::DeclarationChanged);
    assert_eq!(changed.response.code(), "declaration-changed");
    assert_eq!(counts(&env), after_declare);
    assert_eq!(declared_token(&env, SCENE), Some(token.clone()));

    // The right token revokes: both columns NULL, v1 bytes identical, one new
    // canonical event, one feed event and one idempotency record.
    let request = revoke_request(PROJECT, SCENE, &token);
    let undo_before = undo_rows(&env);
    let revoked = revoke_scene_body(&env.snapshot(), request.clone(), &budget()).unwrap();
    assert_eq!(revoked.response, RevokeResponse::Revoked);
    assert_eq!(revoked.evidence.kind(), TerminalKind::Committed);
    assert_eq!(declared_token(&env, SCENE), None);
    assert_same_rows(&rows_before, &rows(&env), "after revoke");
    let after = counts(&env);
    assert_eq!(after.change_events, after_declare.change_events + 1);
    assert_eq!(after.feed_events, after_declare.feed_events + 1);
    assert_eq!(after.idempotency, after_declare.idempotency + 1);
    assert_eq!(undo_rows(&env), undo_before, "a revoke has no undo");

    // A resend returns the recorded response and brings nothing back, even
    // after the Scene was declared again.
    let replay = revoke_scene_body(&env.snapshot(), request.clone(), &budget()).unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.response, RevokeResponse::Revoked);
    assert_eq!(declared_token(&env, SCENE), None);
    declare_ok(&env, SCENE);
    let new_token = declared_token(&env, SCENE).unwrap();
    let replay = revoke_scene_body(&env.snapshot(), request, &budget()).unwrap();
    assert!(replay.replayed);
    assert_eq!(
        declared_token(&env, SCENE),
        Some(new_token),
        "the resend did not revoke the new declaration"
    );
}

#[test]
fn revoke_names_only_closed_values_and_a_missing_scene_is_refused() {
    for code in [
        RevokeResponse::Revoked.code(),
        RevokeResponse::NoDeclaration.code(),
        RevokeResponse::DeclarationChanged.code(),
    ] {
        assert!(["revoked", "no-declaration", "declaration-changed"].contains(&code));
    }
    let env = Env::new();
    let failure = revoke_scene_body(
        &env.snapshot(),
        revoke_request(PROJECT, "missing", "sha256:x"),
        &budget(),
    )
    .unwrap_err();
    assert_eq!(failure.refusal, DeclareRefusal::SceneNotFound);
    let failure = revoke_scene_body(
        &env.snapshot(),
        revoke_request(PROJECT, OTHER_SCENE, "sha256:x"),
        &budget(),
    )
    .unwrap_err();
    assert_eq!(
        failure.refusal,
        DeclareRefusal::SceneNotFound,
        "another project's Scene"
    );
}

// ---- A15 / A16 ------------------------------------------------------------------

#[test]
fn bounded_wait_does_not_hold_forever() {
    let env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).unwrap();
    let db = env.db();
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let holder_db = Arc::clone(&db);
    std::thread::scope(|scope| {
        scope.spawn(move || {
            holder_db
                .db()
                .with_conn(|_conn| {
                    held_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(10)).ok();
                    Ok(())
                })
                .unwrap();
        });
        held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let started = Instant::now();
        let failure =
            declare_scene_body(&env.snapshot(), consumed, request.clone(), &budget()).unwrap_err();
        assert_eq!(
            failure.refusal,
            DeclareRefusal::Store(Nir1StoreFailure::ConnectionBusy)
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the wait ended at the mutex limit, took {:?}",
            started.elapsed()
        );
        let revoke = revoke_scene_body(
            &env.snapshot(),
            revoke_request(PROJECT, SCENE, "sha256:x"),
            &budget(),
        )
        .unwrap_err();
        assert_eq!(
            revoke.refusal,
            DeclareRefusal::Store(Nir1StoreFailure::ConnectionBusy)
        );
        let preview =
            preview_scene_body_declaration(&env.snapshot(), &request, &budget()).unwrap_err();
        assert_eq!(
            preview,
            DeclareRefusal::Store(Nir1StoreFailure::ConnectionBusy)
        );
        release_tx.send(()).unwrap();
    });
    assert_eq!(declared_token(&env, SCENE), None, "nothing was written");
    // A new confirmation is needed; the same request then works.
    declare(&env, request).expect("after the wait");
}

#[test]
fn a_busy_database_fails_within_the_busy_limit() {
    let env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).unwrap();
    let other = Connection::open(env.path.join("workspace.db")).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    let started = Instant::now();
    let failure = declare_scene_body(&env.snapshot(), consumed, request, &budget()).unwrap_err();
    assert_eq!(
        failure.refusal,
        DeclareRefusal::Store(Nir1StoreFailure::SqliteBusy)
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    other.execute_batch("ROLLBACK").unwrap();
    assert_eq!(declared_token(&env, SCENE), None);
}

#[test]
fn resource_limits() {
    // Body bytes: above the limit is refused before the body is read.
    let env = Env::new();
    let big = format!(
        "{{\"type\":\"doc\",\"content\":[{{\"type\":\"paragraph\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}]}}",
        "x".repeat(SCENE_BODY_READ_MAX_BYTES + 1)
    );
    raw(
        &env,
        "UPDATE tree_nodes SET content = ?2 WHERE id = ?1",
        &[&SCENE, &big],
    );
    assert_eq!(
        preview_refusal(&env, PROJECT, SCENE),
        DeclareRefusal::BodyTooLarge
    );
    // Above the shared reader's own 32 KiB parse limit, below the early check.
    let above_parse_limit = long_body(70, 150);
    assert!(
        above_parse_limit.len() > 32 * 1024 && above_parse_limit.len() < SCENE_BODY_READ_MAX_BYTES
    );
    raw(
        &env,
        "UPDATE tree_nodes SET content = ?2 WHERE id = ?1",
        &[&SCENE, &above_parse_limit],
    );
    assert_eq!(
        preview_refusal(&env, PROJECT, SCENE),
        DeclareRefusal::BodyTooLarge
    );
    // A long Scene (about 8,800 characters in 55 paragraphs) is declarable.
    let long_scene = long_body(55, 160);
    assert!(long_scene.len() < 32 * 1024, "{}", long_scene.len());
    raw(
        &env,
        "UPDATE tree_nodes SET content = ?2 WHERE id = ?1",
        &[&SCENE, &long_scene],
    );
    declare(&env, scene_request(&env)).expect("a long Scene under the limits");

    // Title bytes.
    let env = Env::new();
    raw(
        &env,
        "UPDATE tree_nodes SET title = ?2 WHERE id = ?1",
        &[&SCENE, &"t".repeat(SCENE_BODY_TITLE_MAX_BYTES + 1)],
    );
    assert_eq!(
        preview_refusal(&env, PROJECT, SCENE),
        DeclareRefusal::TitleTooLarge
    );
    raw(
        &env,
        "UPDATE tree_nodes SET title = ?2 WHERE id = ?1",
        &[&SCENE, &"t".repeat(SCENE_BODY_TITLE_MAX_BYTES)],
    );
    preview_scene_body_declaration(&env.snapshot(), &scene_request(&env), &budget())
        .expect("a title at the limit is accepted");

    // Veto rows: N is accepted, N + 1 is refused.
    let env = Env::new();
    env.with_conn(|conn| {
        conn.execute(
            "INSERT INTO foreshadows (id, project_id, title, secret, created_at, updated_at)
             VALUES ('f-open', 'p1', 'F', 0, 0, 0)",
            [],
        )?;
        for index in 0..SCENE_BODY_VETO_MAX_ROWS {
            conn.execute(
                "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                                                semantic_key, created_at, updated_at)
                 VALUES (?1, 'f-open', ?2, ?3, ?4, 'plant', ?1, 0, 0)",
                params![format!("su{index}"), SCENE, index as i64, index as i64 + 1],
            )?;
        }
        Ok(())
    });
    preview_scene_body_declaration(&env.snapshot(), &scene_request(&env), &budget())
        .expect("N veto rows are looked at");
    raw(
        &env,
        "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos, kind, semantic_key, created_at, updated_at)
         VALUES ('su-last', 'f-open', ?1, 9999, 10000, 'plant', 'su-last', 0, 0)",
        &[&SCENE],
    );
    assert_eq!(
        preview_refusal(&env, PROJECT, SCENE),
        DeclareRefusal::VetoLimit
    );
}

#[test]
fn a_cancelled_write_leaves_no_partial_result() {
    let env = Env::new();
    let request = scene_request(&env);
    let consumed = consumed_for(&env, &request).unwrap();
    let cancelled = crate::nir1_generation::Nir1AdmissionSqlBudget::new(
        Arc::new(AtomicBool::new(true)),
        Arc::new(|| true),
    )
    .for_untimed_test();
    let before = counts(&env);
    let failure = declare_scene_body(&env.snapshot(), consumed, request, &cancelled).unwrap_err();
    assert!(
        matches!(
            failure.refusal,
            DeclareRefusal::Store(Nir1StoreFailure::Cancelled)
        ),
        "{:?}",
        failure.refusal
    );
    assert_eq!(counts(&env), before);
    assert_eq!(declared_token(&env, SCENE), None);
    // The probe going false (the caller left its admission) stops it too.
    let consumed = consumed_for(&env, &scene_request(&env)).unwrap();
    let closed = crate::nir1_generation::Nir1AdmissionSqlBudget::new(
        Arc::new(AtomicBool::new(false)),
        Arc::new(|| false),
    )
    .for_untimed_test();
    let failure =
        declare_scene_body(&env.snapshot(), consumed, scene_request(&env), &closed).unwrap_err();
    assert!(matches!(
        failure.refusal,
        DeclareRefusal::Store(Nir1StoreFailure::Fenced)
    ));
    assert_eq!(declared_token(&env, SCENE), None);
}

// ---- K1b measurement (DR-CB2-7) ---------------------------------------------------

/// Not part of the normal run. `cargo test --release -- --ignored
/// measure_k1b --nocapture` finds the largest body the limits admit and prints
/// how long the preview and the declaration take there, with the plan's
/// unchanged limits (mutex 100 ms, busy 100 ms, operation 250 ms).
#[test]
#[ignore = "K1b measurement; run in release with --ignored --nocapture"]
fn measure_k1b_timings() {
    let env = Env::new();
    let try_body = |paragraphs: usize, width: usize| {
        let body = long_body(paragraphs, width);
        raw(
            &env,
            "UPDATE tree_nodes SET content = ?2 WHERE id = ?1",
            &[&SCENE, &body],
        );
        let request = scene_request(&env);
        let started = Instant::now();
        let preview = preview_scene_body_declaration(&env.snapshot(), &request, &plan_budget());
        (body.len(), request, started.elapsed(), preview)
    };
    // Largest accepted number of 170-character paragraphs (binary search).
    let (mut low, mut high) = (1usize, 400usize);
    while low < high {
        let middle = (low + high).div_ceil(2);
        if try_body(middle, 170).3.is_ok() {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    for paragraphs in [10, low / 4, low / 2, low, low + 1] {
        let (bytes, request, preview_elapsed, preview) = try_body(paragraphs.max(1), 170);
        match preview {
            Ok(preview) => {
                let consumed = ConsumedBodyDeclarationBinding::from_consumed_grant(preview.binding);
                let started = Instant::now();
                let outcome =
                    declare_scene_body(&env.snapshot(), consumed, request, &plan_budget());
                println!(
                    "body {bytes} bytes ({paragraphs} paragraphs): preview {preview_elapsed:?}, declare {:?} -> {}",
                    started.elapsed(),
                    outcome.map_or_else(|failure| failure.refusal.code().to_owned(), |_| "declared".into())
                );
                // Start the next size from a clean Scene.
                raw(&env, "UPDATE narrative_scene_scope_bindings SET body_declaration_json = NULL, body_declaration_token = NULL WHERE scene_id = ?1", &[&SCENE]);
            }
            Err(refusal) => println!(
                "body {bytes} bytes ({paragraphs} paragraphs): preview {preview_elapsed:?} -> {}",
                refusal.code()
            ),
        }
    }
}
