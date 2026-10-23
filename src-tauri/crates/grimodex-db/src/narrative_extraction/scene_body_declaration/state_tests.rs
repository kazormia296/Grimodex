//! CB-3 S1: the state read (`read_scene_body_declaration_state`).
//!
//! The Scene is declared with the production writer through the preview; the
//! state is then read after each way the Scene can change. What the reader
//! (CB-4) answers for the same Scene is compared in the reader's E group
//! (`nir1_graph/scene_disclosure/invalidation_tests.rs`), whose `assert_holds`
//! and `assert_expired` also read this state: a state that says `effective`
//! while the reader refuses, or the other way round, fails there.
#![cfg(feature = "native-current-human-capture")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use rusqlite::params;
use rusqlite::types::Value as SqlValue;
use serde_json::{json, Value};

use grimodex_core::narrative_scene_body_declaration::MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES;

use super::invalidation_tests as writers;
use super::test_support::{set_raw_declaration_cells_for_test, test_declaration};
use super::writer_support_tests::*;
use super::*;
use crate::narrative_extraction::project_scope_authority::load_live_project_scope_authority;
use crate::narrative_extraction::read_narrative_scene_scope;
use crate::nir1_generation::{Nir1AdmissionSqlBudget, Nir1StoreFailure};

// ---- helpers ---------------------------------------------------------------

fn state_request(project: &str, scene: &str) -> StateRequest {
    StateRequest {
        project_id: project.into(),
        scene_id: scene.into(),
    }
}

fn try_read(
    env: &Env,
    project: &str,
    scene: &str,
) -> Result<BodyDeclarationStateRead, DeclareRefusal> {
    read_scene_body_declaration_state(&env.snapshot(), &state_request(project, scene), &budget())
}

fn read_state(env: &Env, scene: &str) -> BodyDeclarationStateRead {
    try_read(env, PROJECT, scene).expect("state read")
}

fn raw(env: &Env, sql: &str, args: &[&dyn rusqlite::ToSql]) {
    env.with_conn(|conn| {
        conn.execute(sql, args)?;
        Ok(())
    });
}

fn declare_scene(env: &Env, scene: &str) {
    declare(env, request_for(env, PROJECT, scene)).expect("declaration");
}

fn preview_refusal(env: &Env, scene: &str) -> DeclareRefusal {
    preview_scene_body_declaration(
        &env.snapshot(),
        &request_for(env, PROJECT, scene),
        &budget(),
    )
    .unwrap_err()
}

fn db(env: &Env) -> &crate::Database {
    env.authority.as_ref().expect("authority").db()
}

fn effective(read: &BodyDeclarationStateRead) -> bool {
    read.state.is_effective()
}

/// The state is a declared one that does not hold; its groups are returned.
fn expired_groups(env: &Env, scene: &str, step: &str) -> Vec<ExpiryGroup> {
    match read_state(env, scene).state {
        BodyDeclarationState::Declared {
            effective: false,
            expired_by,
            blocker: None,
        } => {
            assert!(!expired_by.is_empty(), "{step}: expired with no group");
            expired_by
        }
        other => panic!("{step}: a declared, expired state was expected, got {other:?}"),
    }
}

/// The state is a declared one that is blocked: effective is false and no
/// group is named.
fn blocked_by(env: &Env, scene: &str, step: &str) -> DeclareRefusal {
    match read_state(env, scene).state {
        BodyDeclarationState::Declared {
            effective: false,
            expired_by,
            blocker: Some(blocker),
        } => {
            assert!(expired_by.is_empty(), "{step}: {expired_by:?}");
            blocker
        }
        other => panic!("{step}: a declared, blocked state was expected, got {other:?}"),
    }
}

fn assert_effective(env: &Env, scene: &str, step: &str) {
    let read = read_state(env, scene);
    assert_eq!(
        read.state,
        BodyDeclarationState::Declared {
            effective: true,
            expired_by: Vec::new(),
            blocker: None
        },
        "{step}"
    );
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

// ---- N-1: no declaration ----------------------------------------------------

#[test]
fn st_none_reports_none_and_a_blocker_when_a_declaration_is_impossible() {
    let env = Env::new();
    // A declarable Scene: none, no blocker, and the OCC the next declare names.
    let read = read_state(&env, SCENE);
    assert_eq!(read.state, BodyDeclarationState::None { blocker: None });
    assert_eq!(read.declaration_token, None);
    let request = request_for(&env, PROJECT, SCENE);
    let occ = read.occ.expect("OCC");
    assert_eq!(occ.scope_version, request.expected.scope_version);
    assert_eq!(occ.scope_token, request.expected.scope_token);
    assert_eq!(request.expected.declaration_token, None);

    // Each way a declaration is impossible: the blocker is the code the preview
    // refuses with, and there is no OCC.
    raw(
        &env,
        "UPDATE tree_nodes SET title = ?2 WHERE id = ?1",
        &[&"s5", &"t".repeat(SCENE_BODY_TITLE_MAX_BYTES + 1)],
    );
    let big = format!(
        "{{\"type\":\"doc\",\"content\":[{{\"type\":\"paragraph\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}]}}",
        "x".repeat(SCENE_BODY_READ_MAX_BYTES + 1)
    );
    raw(
        &env,
        "UPDATE tree_nodes SET content = ?2 WHERE id = ?1",
        &[&"s6", &big],
    );
    // s5 (no A1) is refused for its A1 first; give it an explicit one so the
    // title is what blocks.
    set_a1(db(&env), PROJECT, LEGACY_SCENE, true);
    let cases = [
        (ARCHIVED_SCENE, DeclareRefusal::SceneArchived),
        (EMPTY_SCENE, DeclareRefusal::BodyEmpty),
        (LEGACY_SCENE, DeclareRefusal::TitleTooLarge),
        (SECOND_SCENE, DeclareRefusal::BodyTooLarge),
    ];
    for (scene, expected) in cases {
        let read = read_state(&env, scene);
        assert_eq!(
            read.state,
            BodyDeclarationState::None {
                blocker: Some(expected)
            },
            "{scene}"
        );
        assert_eq!(
            read.occ, None,
            "{scene}: no OCC while a declaration is impossible"
        );
        assert_eq!(
            preview_refusal(&env, scene),
            expected,
            "{scene}: same as the preview"
        );
    }
    // A1 that is not explicit, and A1 that is unresolved.
    let env = Env::new();
    set_a1(db(&env), PROJECT, SECOND_SCENE, false);
    for (scene, expected) in [
        (LEGACY_SCENE, DeclareRefusal::ScopeNotExplicit),
        (SECOND_SCENE, DeclareRefusal::ScopeUnresolved),
    ] {
        assert_eq!(
            read_state(&env, scene).state.blocker(),
            Some(expected),
            "{scene}"
        );
        assert_eq!(preview_refusal(&env, scene), expected, "{scene}");
    }
    // A Scene that does not exist in the project, and one of another project.
    let missing = try_read(&env, PROJECT, "missing").unwrap();
    assert_eq!(
        missing.state,
        BodyDeclarationState::Unavailable {
            reason: SceneBodyDeclarationUnavailableReason::BindingRowMissing,
            blocker: Some(DeclareRefusal::SceneNotFound),
        }
    );
    assert_eq!(
        try_read(&env, PROJECT, OTHER_SCENE)
            .unwrap()
            .state
            .blocker(),
        Some(DeclareRefusal::SceneNotFound)
    );
    // A Scene under an archived folder.
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
        read_state(&env, SCENE).state,
        BodyDeclarationState::None {
            blocker: Some(DeclareRefusal::SceneArchived)
        }
    );
}

#[test]
fn st_none_reports_the_veto_blockers_with_the_preview_codes() {
    type Setup = fn(&Env);
    let cases: [(&str, Setup, DeclareRefusal); 5] = [
        (
            "secret foreshadow",
            |env| {
                env.with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO foreshadows (id, project_id, title, secret, created_at, updated_at)
                         VALUES ('f-secret', 'p1', 'F', 1, 0, 0)",
                        [],
                    )?;
                    conn.execute(
                        "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                                                        semantic_key, created_at, updated_at)
                         VALUES ('su-secret', 'f-secret', 's1', 0, 1, 'plant', 'su-secret', 0, 0)",
                        [],
                    )?;
                    Ok(())
                });
            },
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
    ];
    for (name, setup, expected) in cases {
        let env = Env::new();
        setup(&env);
        let read = read_state(&env, SCENE);
        assert_eq!(
            read.state,
            BodyDeclarationState::None {
                blocker: Some(expected)
            },
            "{name}"
        );
        assert_eq!(
            preview_refusal(&env, SCENE),
            expected,
            "{name}: same as the preview"
        );
    }
    // The veto's row limit is a blocker, not a failure.
    let env = Env::new();
    env.with_conn(|conn| {
        conn.execute(
            "INSERT INTO foreshadows (id, project_id, title, secret, created_at, updated_at)
             VALUES ('f-open', 'p1', 'F', 0, 0, 0)",
            [],
        )?;
        for index in 0..=SCENE_BODY_VETO_MAX_ROWS {
            conn.execute(
                "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                                                semantic_key, created_at, updated_at)
                 VALUES (?1, 'f-open', ?2, ?3, ?4, 'plant', ?1, 0, 0)",
                params![format!("su{index}"), SCENE, index as i64, index as i64 + 1],
            )?;
        }
        Ok(())
    });
    assert_eq!(
        read_state(&env, SCENE).state,
        BodyDeclarationState::None {
            blocker: Some(DeclareRefusal::VetoLimit)
        }
    );
    // A workspace whose canonical locator cannot be determined.
    let env = Env::without_durable_identity();
    let read = read_state(&env, SCENE);
    assert_eq!(
        read.state,
        BodyDeclarationState::None {
            blocker: Some(DeclareRefusal::LocatorUnavailable)
        }
    );
    assert_eq!(read.occ, None);
}

// ---- N-2: a fresh declaration -----------------------------------------------

#[test]
fn st_declared_current_is_effective_only_when_every_binding_component_holds() {
    let env = Env::new();
    declare_scene(&env, SCENE);
    let read = read_state(&env, SCENE);
    assert_effective(&env, SCENE, "right after the declaration");
    // The token a revoke names is the stored one, and the OCC is the Scene's
    // current one: a declare or revoke built on this answer is accepted.
    assert_eq!(read.declaration_token, env.declaration_token(SCENE));
    let request = request_for(&env, PROJECT, SCENE);
    let occ = read.occ.expect("OCC");
    assert_eq!(occ.scope_version, request.expected.scope_version);
    assert_eq!(occ.scope_token, request.expected.scope_token);
    assert_eq!(read.declaration_token, request.expected.declaration_token);
    // Another Scene of the project is untouched.
    assert_eq!(
        read_state(&env, SECOND_SCENE).state,
        BodyDeclarationState::None { blocker: None }
    );
    // A revoke built from the answer revokes.
    let token = read.declaration_token.unwrap();
    let revoked = revoke_scene_body(
        &env.snapshot(),
        revoke_request(PROJECT, SCENE, &token),
        &budget(),
    )
    .expect("revoke");
    assert_eq!(revoked.response, RevokeResponse::Revoked);
    let after = read_state(&env, SCENE);
    assert_eq!(after.state, BodyDeclarationState::None { blocker: None });
    assert_eq!(after.declaration_token, None);
}

// ---- N-3: invalidation paths --------------------------------------------------

#[test]
fn st_content_paths_turn_effective_off_with_the_content_group_and_never_back() {
    // Body save (different text), the same text saved again, the original text
    // saved back.
    let env = Env::new();
    declare_scene(&env, SCENE);
    let original: String = writers::scene_row(db(&env), SCENE, "content");
    writers::save_body(
        db(&env),
        SCENE,
        &body_json("Another text."),
        "2026-10-18T01:00:00.000Z",
    );
    assert!(expired_groups(&env, SCENE, "body save").contains(&ExpiryGroup::Content));
    writers::save_body(
        db(&env),
        SCENE,
        &body_json("Another text."),
        "2026-10-18T02:00:00.000Z",
    );
    assert!(expired_groups(&env, SCENE, "same text again").contains(&ExpiryGroup::Content));
    writers::save_body(db(&env), SCENE, &original, "2026-10-18T03:00:00.000Z");
    assert_eq!(writers::scene_row(db(&env), SCENE, "content"), original);
    assert!(expired_groups(&env, SCENE, "original text back").contains(&ExpiryGroup::Content));

    // Title A -> B -> A with `updatedAt` restored, and a metadata patch.
    for bump in [true, false] {
        let env = Env::new();
        declare_scene(&env, SCENE);
        let first_updated_at = writers::scene_row(db(&env), SCENE, "updated_at");
        writers::patch(
            db(&env),
            SCENE,
            json!({ "title": "B" }),
            bump,
            "2026-10-18T01:00:00.000Z",
        )
        .unwrap();
        assert!(expired_groups(&env, SCENE, "title B").contains(&ExpiryGroup::Content));
        writers::patch(
            db(&env),
            SCENE,
            json!({ "title": "One" }),
            bump,
            &first_updated_at,
        )
        .unwrap();
        assert_eq!(writers::scene_row(db(&env), SCENE, "title"), "One");
        assert!(
            expired_groups(&env, SCENE, "title back with the first updatedAt")
                .contains(&ExpiryGroup::Content)
        );

        let env = Env::new();
        declare_scene(&env, SCENE);
        writers::patch(
            db(&env),
            SCENE,
            json!({ "synopsis": "A synopsis" }),
            bump,
            "2026-10-18T01:00:00.000Z",
        )
        .unwrap();
        assert!(expired_groups(&env, SCENE, "metadata patch").contains(&ExpiryGroup::Content));
    }
}

#[test]
fn st_scope_paths_turn_effective_off_with_the_scope_group_and_never_back() {
    // Registry change and change back: every declaration of the project.
    let env = Env::new();
    declare_scene(&env, SCENE);
    declare_scene(&env, SECOND_SCENE);
    set_a1(db(&env), PROJECT, SECOND_SCENE, true);
    // A1 of the second Scene was set before its declaration only by the seed;
    // declare it again after the A1 write so both hold.
    let token = read_state(&env, SECOND_SCENE).declaration_token.unwrap();
    revoke_scene_body(
        &env.snapshot(),
        revoke_request(PROJECT, SECOND_SCENE, &token),
        &budget(),
    )
    .unwrap();
    declare_scene(&env, SECOND_SCENE);
    assert_effective(&env, SECOND_SCENE, "before the registry change");
    writers::registry_edit(db(&env), Some("timeline:extra"));
    for scene in [SCENE, SECOND_SCENE] {
        assert!(expired_groups(&env, scene, "registry change").contains(&ExpiryGroup::Scope));
    }
    writers::registry_edit(db(&env), None);
    for scene in [SCENE, SECOND_SCENE] {
        assert!(expired_groups(&env, scene, "registry put back").contains(&ExpiryGroup::Scope));
    }

    // A1 saved again (the same explicit value).
    let env = Env::new();
    declare_scene(&env, SCENE);
    set_a1(db(&env), PROJECT, SCENE, true);
    assert!(expired_groups(&env, SCENE, "A1 update").contains(&ExpiryGroup::Scope));

    // Chronicle bulk (POV) and its undo and redo.
    let env = Env::new();
    declare_scene(&env, SCENE);
    let forward = writers::bulk(
        db(&env),
        json!([{ "kind": "sceneSetPov", "sceneId": SCENE,
                 "baseUpdatedAt": writers::scene_row(db(&env), SCENE, "updated_at"),
                 "povCharacterId": "c1" }]),
    );
    // The POV is a veto record too: blocked, not merely expired.
    assert_eq!(
        blocked_by(&env, SCENE, "bulk POV"),
        DeclareRefusal::Veto(BodyDeclarationVeto::Pov)
    );
    let journal = forward["undoJournalId"].as_str().unwrap().to_owned();
    for direction in ["undo", "redo", "undo"] {
        writers::undo_or_redo(db(&env), &journal, direction);
        assert!(!effective(&read_state(&env, SCENE)), "{direction}");
    }
    // The POV is gone after the last undo: nothing blocks, yet it is expired.
    assert!(expired_groups(&env, SCENE, "after the undo").contains(&ExpiryGroup::Scope));
}

#[test]
fn st_blocker_paths_report_effective_off_with_a_blocker_and_no_group() {
    // A1 that is no longer explicit and resolved: blocker, not an expiry group.
    let env = Env::new();
    declare_scene(&env, SCENE);
    let read = env.with_conn(|conn| read_narrative_scene_scope(conn, PROJECT, SCENE));
    let unresolved = writers::a1_payload(
        read.binding.version,
        grimodex_core::narrative_scene_scope::NarrativeScopePrincipalV1::Reader {},
        "2026-10-18T01:00:00.000Z",
    );
    crate::narrative_extraction::update_narrative_scene_scope(db(&env), unresolved).unwrap();
    assert_eq!(
        blocked_by(&env, SCENE, "A1 unresolved"),
        DeclareRefusal::ScopeUnresolved
    );
    let read = read_state(&env, SCENE);
    assert_eq!(read.occ, None);
    assert!(
        read.declaration_token.is_some(),
        "the declaration can still be revoked"
    );

    // The Scene archived, and put back.
    for bump in [true, false] {
        let env = Env::new();
        declare_scene(&env, SCENE);
        writers::patch(
            db(&env),
            SCENE,
            json!({ "archivedAt": "2026-10-18T01:00:00.000Z" }),
            bump,
            "2026-10-18T01:00:00.000Z",
        )
        .unwrap();
        assert_eq!(
            blocked_by(&env, SCENE, "archived"),
            DeclareRefusal::SceneArchived
        );
        writers::patch(
            db(&env),
            SCENE,
            json!({ "archivedAt": null }),
            bump,
            "2026-10-18T02:00:00.000Z",
        )
        .unwrap();
        assert!(
            !effective(&read_state(&env, SCENE)),
            "archived and put back, bump={bump}"
        );
    }

    // A folder above the Scene archived: blocker; moved back: still not effective.
    let env = Env::new();
    raw(
        &env,
        "UPDATE tree_nodes SET parent_id = 'f1' WHERE id = ?1",
        &[&SCENE],
    );
    // The Scene's parent changed by SQL does not move the token; bind afresh.
    declare_scene(&env, SCENE);
    assert_effective(&env, SCENE, "under a folder");
    writers::patch(
        db(&env),
        "f1",
        json!({ "archivedAt": "2026-10-18T01:00:00.000Z" }),
        true,
        "2026-10-18T01:00:00.000Z",
    )
    .unwrap();
    assert_eq!(
        blocked_by(&env, SCENE, "folder archived"),
        DeclareRefusal::SceneArchived
    );
    writers::patch(
        db(&env),
        "f1",
        json!({ "archivedAt": null }),
        true,
        "2026-10-18T02:00:00.000Z",
    )
    .unwrap();
    assert!(expired_groups(&env, SCENE, "folder archive put back").contains(&ExpiryGroup::Scope));
    // Moving or reordering the folder moves the Scene's Scope token.
    let env = Env::new();
    raw(
        &env,
        "UPDATE tree_nodes SET parent_id = 'f1' WHERE id = ?1",
        &[&SCENE],
    );
    declare_scene(&env, SCENE);
    writers::patch(
        db(&env),
        "f1",
        json!({ "sortOrder": "z0" }),
        true,
        "2026-10-18T01:00:00.000Z",
    )
    .unwrap();
    assert!(expired_groups(&env, SCENE, "folder reorder").contains(&ExpiryGroup::Scope));
    writers::patch(
        db(&env),
        "f1",
        json!({ "sortOrder": "a0" }),
        true,
        "2026-10-18T02:00:00.000Z",
    )
    .unwrap();
    assert!(expired_groups(&env, SCENE, "folder reorder put back").contains(&ExpiryGroup::Scope));
}

#[test]
fn st_identity_paths_report_no_declaration_for_a_new_scene_and_never_the_old_one() {
    let env = Env::new();
    declare_scene(&env, SCENE);
    let content = writers::scene_row(db(&env), SCENE, "content");
    // A duplicate is a new Scene: no declaration.
    writers::create_scene(db(&env), "s1-copy", "One", &content);
    assert_eq!(
        read_state(&env, "s1-copy").state.kind(),
        "none",
        "a duplicate carries no declaration"
    );
    assert_effective(&env, SCENE, "the original is untouched by its duplicate");
    // Delete: nothing to read. Re-created with the same ID: none, not the old.
    writers::delete_scene(db(&env), SCENE);
    assert_eq!(
        read_state(&env, SCENE).state,
        BodyDeclarationState::Unavailable {
            reason: SceneBodyDeclarationUnavailableReason::BindingRowMissing,
            blocker: Some(DeclareRefusal::SceneNotFound),
        }
    );
    writers::create_scene(db(&env), SCENE, "One", &content);
    let recreated = read_state(&env, SCENE);
    assert_eq!(recreated.state.kind(), "none");
    assert_eq!(recreated.declaration_token, None);
}

#[test]
fn st_workspace_paths_report_the_workspace_group_and_return_with_the_original() {
    // The workspace ID changes.
    let mut env = Env::new();
    declare_scene(&env, SCENE);
    let original_id = env.workspace_id.clone();
    env.close();
    env.workspace_id = "another-workspace-id".into();
    env.reopen();
    assert_eq!(
        expired_groups(&env, SCENE, "another workspace ID"),
        vec![ExpiryGroup::Workspace]
    );
    // The ID comes back with the folder: the same bytes hold again, as the
    // reader's E7 shows. Only a rewrite could make it otherwise.
    env.close();
    env.workspace_id = original_id;
    env.reopen();
    assert_effective(&env, SCENE, "the original ID");

    // A copy of the workspace folder: the same ID, another canonical locator.
    #[cfg(unix)]
    {
        fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
            std::fs::create_dir_all(to).unwrap();
            for entry in std::fs::read_dir(from).unwrap() {
                let entry = entry.unwrap();
                let target = to.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    copy_dir(&entry.path(), &target);
                } else {
                    std::fs::copy(entry.path(), target).unwrap();
                }
            }
        }
        env.close();
        let name = env.path.file_name().unwrap().to_string_lossy().into_owned();
        let copy = env.path.with_file_name(format!("{name}-state-copy"));
        copy_dir(&env.path, &copy);
        env.reopen_via(&copy);
        assert_eq!(
            expired_groups(&env, SCENE, "a copy"),
            vec![ExpiryGroup::Workspace]
        );
        env.close();
        let _ = std::fs::remove_dir_all(&copy);
        env.reopen();
        assert_effective(&env, SCENE, "back at the original folder");
    }
}

#[test]
fn st_every_binding_component_maps_to_one_group() {
    use SceneBodyDeclarationBindingMismatch as Mismatch;
    let table = [
        (Mismatch::ProjectId, ExpiryGroup::Identity),
        (Mismatch::SceneId, ExpiryGroup::Identity),
        (Mismatch::SceneIncarnation, ExpiryGroup::Identity),
        (Mismatch::ScopeSourceToken, ExpiryGroup::Scope),
        (Mismatch::BodySourceIdentity, ExpiryGroup::Content),
        (Mismatch::BodySourceToken, ExpiryGroup::Content),
        (Mismatch::BodySourceDigest, ExpiryGroup::Content),
        (Mismatch::TitleDigest, ExpiryGroup::Content),
        (Mismatch::WorkspaceId, ExpiryGroup::Workspace),
        (Mismatch::CanonicalLocatorDigest, ExpiryGroup::Workspace),
    ];
    for (mismatch, group) in table {
        assert_eq!(expiry_group(mismatch), group, "{mismatch:?}");
    }
    let codes: Vec<_> = [
        ExpiryGroup::Content,
        ExpiryGroup::Scope,
        ExpiryGroup::Identity,
        ExpiryGroup::Workspace,
    ]
    .into_iter()
    .map(ExpiryGroup::code)
    .collect();
    assert_eq!(codes, ["content", "scope", "identity", "workspace"]);
}

// ---- N-4: veto after a declaration --------------------------------------------

#[test]
fn st_veto_after_a_declaration_keeps_declared_but_not_effective() {
    type Setup = fn(&Env);
    type Teardown = fn(&Env);
    let cases: [(&str, Setup, Teardown, BodyDeclarationVeto); 4] = [
        (
            "secret foreshadow",
            |env| {
                env.with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO foreshadows (id, project_id, title, secret, created_at, updated_at)
                         VALUES ('f-secret', 'p1', 'F', 1, 0, 0)",
                        [],
                    )?;
                    conn.execute(
                        "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                                                        semantic_key, created_at, updated_at)
                         VALUES ('su-secret', 'f-secret', 's1', 0, 1, 'plant', 'su-secret', 0, 0)",
                        [],
                    )?;
                    Ok(())
                });
            },
            |env| {
                raw(
                    env,
                    "DELETE FROM foreshadow_setups WHERE id = 'su-secret'",
                    &[],
                )
            },
            BodyDeclarationVeto::SecretForeshadow,
        ),
        (
            "secret event reveal",
            |env| {
                raw(env, "INSERT INTO events (id, project_id, secret, reveal_scene_id) VALUES ('e1','p1',1,'s1')", &[]);
            },
            |env| raw(env, "DELETE FROM events WHERE id = 'e1'", &[]),
            BodyDeclarationVeto::SecretEventReveal,
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
                    "INSERT INTO scene_events (scene_id, event_id) VALUES ('s1','e1')",
                    &[],
                );
            },
            |env| raw(env, "DELETE FROM scene_events WHERE event_id = 'e1'", &[]),
            BodyDeclarationVeto::SecretEventLink,
        ),
        (
            "beat POV cache",
            |env| {
                raw(env, "INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id) VALUES ('s1','c1')", &[])
            },
            |env| {
                raw(
                    env,
                    "DELETE FROM scene_beat_pov_cache WHERE scene_id = 's1'",
                    &[],
                )
            },
            BodyDeclarationVeto::Pov,
        ),
    ];
    for (name, add, remove, veto) in cases {
        let env = Env::new();
        declare_scene(&env, SCENE);
        let token_before = env.declaration_token(SCENE);
        add(&env);
        let read = read_state(&env, SCENE);
        assert_eq!(
            read.state,
            BodyDeclarationState::Declared {
                effective: false,
                expired_by: Vec::new(),
                blocker: Some(DeclareRefusal::Veto(veto)),
            },
            "{name}"
        );
        assert_eq!(
            read.declaration_token, token_before,
            "{name}: still revocable"
        );
        // The declaration was not rewritten, so removing the record makes the
        // same bytes hold again (draft: 'a veto record added').
        remove(&env);
        assert_effective(&env, SCENE, name);
        assert_eq!(
            env.declaration_token(SCENE),
            token_before,
            "{name}: bytes unchanged"
        );
    }
}

// ---- N-5: nothing leaks ---------------------------------------------------------

#[test]
fn st_response_carries_no_body_title_digest_or_locator() {
    let env = Env::new();
    declare_scene(&env, SCENE);
    let read = read_state(&env, SCENE);

    // The type has no field for anything but the state and the OCC tokens: an
    // exhaustive pattern stops compiling when a field is added.
    let BodyDeclarationStateRead {
        occ,
        declaration_token,
        state,
    } = read.clone();
    let StateOcc {
        scope_version: _,
        scope_token,
    } = occ.expect("OCC");
    let declaration_token = declaration_token.expect("declaration token");
    assert!(matches!(
        state,
        BodyDeclarationState::Declared {
            effective: true,
            ..
        }
    ));

    // The values that must not appear anywhere in the answer.
    let stored = env.with_conn(|conn| read_scene_body_declaration(conn, PROJECT, SCENE));
    let SceneBodyDeclarationRead::Declared(stored) = stored else {
        panic!("declared")
    };
    let binding = &stored.declaration.binding;
    let forbidden = [
        BODY_TEXT.to_owned(),
        "One".to_owned(), // the title
        binding.title_digest.clone(),
        binding.body_source.storage_digest.clone(),
        binding.body_source.canonical_digest.clone(),
        binding.body_source.source_identity.clone(),
        binding.canonical_locator_digest.clone(),
        binding.workspace_id.clone(),
        binding.scene_incarnation_id.clone(),
        stored.declaration.declaration_id.clone(),
        env.path.to_string_lossy().into_owned(),
    ];
    // Every string the answer holds is one of the three OCC tokens, and none
    // of them contains a forbidden value; the Debug output holds none either.
    for token in [&scope_token, &declaration_token] {
        for value in &forbidden {
            assert!(!token.contains(value.as_str()), "token holds {value}");
        }
    }
    let printed = format!("{read:?}");
    for value in forbidden.iter().chain([&scope_token, &declaration_token]) {
        assert!(!printed.contains(value.as_str()), "Debug holds {value}");
    }
    // The blockers are closed codes that name none of those values, nor the
    // project or the Scene.
    for blocker in [
        DeclareRefusal::SceneArchived,
        DeclareRefusal::Veto(BodyDeclarationVeto::Pov),
        DeclareRefusal::VetoLimit,
    ] {
        for value in forbidden.iter().map(String::as_str).chain([PROJECT, SCENE]) {
            assert!(
                !blocker.code().contains(value),
                "blocker code {} holds {value}",
                blocker.code()
            );
        }
    }
}

// ---- N-6: read-only ---------------------------------------------------------------

#[derive(Debug, Eq, PartialEq)]
struct Snapshot {
    binding: std::collections::BTreeMap<String, String>,
    other_binding: std::collections::BTreeMap<String, String>,
    tree: std::collections::BTreeMap<String, String>,
    other_tree: std::collections::BTreeMap<String, String>,
    registry: std::collections::BTreeMap<String, String>,
    counts: [i64; 5],
    scope_digest: String,
}

fn snapshot(env: &Env, scene: &str) -> Snapshot {
    let scope_digest = scope_digest(env);
    env.with_conn(|conn| {
        let row = |sql: &str, key: &[&str]| dump_row(conn, sql, key, &[]);
        Ok(Snapshot {
            binding: row(
                "SELECT * FROM narrative_scene_scope_bindings WHERE project_id = ?1 AND scene_id = ?2",
                &[PROJECT, scene],
            ),
            other_binding: row(
                "SELECT * FROM narrative_scene_scope_bindings WHERE project_id = ?1 AND scene_id = ?2",
                &[PROJECT, SECOND_SCENE],
            ),
            tree: row("SELECT * FROM tree_nodes WHERE id = ?1", &[scene]),
            other_tree: row("SELECT * FROM tree_nodes WHERE id = ?1", &[SECOND_SCENE]),
            registry: row("SELECT * FROM narrative_scope_registries WHERE project_id = ?1", &[PROJECT]),
            counts: [
                count(conn, "SELECT count(*) FROM change_events"),
                count(conn, "SELECT count(*) FROM idempotency_requests"),
                count(conn, "SELECT count(*) FROM narrative_change_events"),
                count(conn, "SELECT count(*) FROM narrative_change_transactions"),
                count(conn, "SELECT count(*) FROM tree_nodes"),
            ],
            scope_digest,
        })
    })
}

#[test]
fn st_read_is_read_only() {
    // No declaration, a declaration that holds, an expired one, a blocked one.
    let env = Env::new();
    let none = snapshot(&env, SCENE);
    read_state(&env, SCENE);
    assert_eq!(none, snapshot(&env, SCENE), "none");

    declare_scene(&env, SCENE);
    let declared = snapshot(&env, SCENE);
    read_state(&env, SCENE);
    assert_eq!(declared, snapshot(&env, SCENE), "declared");

    writers::patch(
        db(&env),
        SCENE,
        json!({ "title": "B" }),
        true,
        "2026-10-18T01:00:00.000Z",
    )
    .unwrap();
    let expired = snapshot(&env, SCENE);
    read_state(&env, SCENE);
    assert_eq!(expired, snapshot(&env, SCENE), "expired");

    raw(
        &env,
        "INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id) VALUES (?1,'c1')",
        &[&SCENE],
    );
    let blocked = snapshot(&env, SCENE);
    read_state(&env, SCENE);
    assert_eq!(blocked, snapshot(&env, SCENE), "blocked");

    // A read that is refused writes nothing either.
    let before = snapshot(&env, ARCHIVED_SCENE);
    read_state(&env, ARCHIVED_SCENE);
    let _ = try_read(&env, PROJECT, "missing");
    assert_eq!(before, snapshot(&env, ARCHIVED_SCENE), "archived");
}

// ---- N-7: broken cells ----------------------------------------------------------

fn set_cells(env: &Env, scene: &str, json_cell: SqlValue, token_cell: SqlValue) {
    env.with_conn(|conn| {
        set_raw_declaration_cells_for_test(conn, PROJECT, scene, json_cell, token_cell)
    });
}

fn text(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

#[test]
fn st_half_state_and_malformed_rows_are_unavailable() {
    use SceneBodyDeclarationUnavailableReason as Reason;
    let env = Env::new();
    let declaration = env.with_conn(|conn| test_declaration(conn, PROJECT, SCENE));
    let declaration_json = declaration.canonical_json().unwrap();
    let token = declaration.token().unwrap();
    let mut value: Value = serde_json::from_str(&declaration_json).unwrap();

    let check = |env: &Env, expected: Reason, step: &str| {
        let read =
            try_read(env, PROJECT, SCENE).unwrap_or_else(|refusal| panic!("{step}: {refusal}"));
        match &read.state {
            BodyDeclarationState::Unavailable { reason, blocker } => {
                assert_eq!(*reason, expected, "{step}");
                assert_ne!(
                    *blocker,
                    Some(DeclareRefusal::DeclarationUnreadable),
                    "{step}"
                );
            }
            other => panic!("{step}: {other:?}"),
        }
        assert!(!effective(&read), "{step}");
        read
    };

    // Only one of the two columns. A lone token is still revocable; a lone
    // JSON cell has no token to name.
    set_cells(&env, SCENE, text(&declaration_json), SqlValue::Null);
    let read = check(&env, Reason::HalfState, "json only");
    assert_eq!(read.declaration_token, None);
    set_cells(&env, SCENE, SqlValue::Null, text(&token));
    let read = check(&env, Reason::HalfState, "token only");
    assert_eq!(read.declaration_token.as_deref(), Some(token.as_str()));

    // Unknown version, unknown field, malformed JSON, a token that is not the
    // declaration's, a declaration of another Scene.
    value["contractId"] = json!("narrative-scene-body-declaration/2");
    set_cells(&env, SCENE, text(&value.to_string()), text(&token));
    check(&env, Reason::UnsupportedVersion, "unknown version");
    value["contractId"] = json!("narrative-scene-body-declaration/1");
    value["excerpt"] = json!("本文");
    set_cells(&env, SCENE, text(&value.to_string()), text(&token));
    let read = check(&env, Reason::UnknownField, "unknown field");
    assert!(
        !format!("{read:?}").contains("本文"),
        "the cell is not returned"
    );
    set_cells(&env, SCENE, text("{not json"), text(&token));
    let read = check(&env, Reason::Malformed, "malformed JSON");
    assert_eq!(
        read.declaration_token.as_deref(),
        Some(token.as_str()),
        "revocable"
    );
    set_cells(&env, SCENE, text(&declaration_json), text("sha256:wrong"));
    check(&env, Reason::TokenMismatch, "token mismatch");
    let other = env.with_conn(|conn| test_declaration(conn, PROJECT, SECOND_SCENE));
    set_cells(
        &env,
        SCENE,
        text(&other.canonical_json().unwrap()),
        text(&other.token().unwrap()),
    );
    check(
        &env,
        Reason::SceneKeyMismatch,
        "another Scene's declaration",
    );

    // A text cell that is not UTF-8, and cells above their limits.
    env.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_scene_scope_bindings
                SET body_declaration_json = CAST(x'80ff' AS TEXT), body_declaration_token = 'tok'
              WHERE scene_id = ?1",
            [SCENE],
        )?;
        Ok(())
    });
    check(&env, Reason::Malformed, "not UTF-8");
    set_cells(
        &env,
        SCENE,
        SqlValue::Text("x".repeat(MAX_NARRATIVE_SCENE_BODY_DECLARATION_JSON_BYTES + 1)),
        text(&token),
    );
    let read = check(&env, Reason::Oversized, "oversized JSON");
    assert!(!format!("{read:?}").contains("xxxxxxxx"));
    set_cells(
        &env,
        SCENE,
        text(&declaration_json),
        SqlValue::Text("t".repeat(10_000)),
    );
    let read = check(&env, Reason::Oversized, "oversized token");
    assert_eq!(
        read.declaration_token, None,
        "an unreadable token cell is not named"
    );
    set_cells(&env, SCENE, SqlValue::Integer(7), SqlValue::Integer(7));
    check(&env, Reason::Malformed, "not text");
}

// ---- N-8: quarantine ----------------------------------------------------------------

#[test]
fn st_quarantined_workspace_reports_restart_required() {
    let env = Env::new();
    declare_scene(&env, SCENE);
    let snapshot_before = snapshot(&env, SCENE);
    quarantine_scene_body_declaration_workspace_for_test(&env.snapshot());
    // Refused before the database is read: not even a missing Scene is looked up.
    let refused = try_read(&env, PROJECT, SCENE);
    let missing = try_read(&env, PROJECT, "missing");
    clear_scene_body_declaration_workspace_quarantine_for_test(&env.snapshot());
    assert_eq!(refused.unwrap_err(), DeclareRefusal::RestartRequired);
    assert_eq!(missing.unwrap_err(), DeclareRefusal::RestartRequired);
    assert_eq!(snapshot_before, snapshot(&env, SCENE));
    assert_effective(&env, SCENE, "after the quarantine was cleared");
}

// ---- N-9: cancel and deadline -------------------------------------------------------

#[test]
fn st_cancel_and_deadline_return_err_without_a_partial_result() {
    let env = Env::new();
    declare_scene(&env, SCENE);
    let cancelled = Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(true)), Arc::new(|| true))
        .for_untimed_test();
    let result = read_scene_body_declaration_state(
        &env.snapshot(),
        &state_request(PROJECT, SCENE),
        &cancelled,
    );
    assert_eq!(
        result.unwrap_err(),
        DeclareRefusal::Store(Nir1StoreFailure::Cancelled)
    );
    // The admission going away (a lifecycle edge) stops it too.
    let closed = Nir1AdmissionSqlBudget::new(Arc::new(AtomicBool::new(false)), Arc::new(|| false))
        .for_untimed_test();
    let result =
        read_scene_body_declaration_state(&env.snapshot(), &state_request(PROJECT, SCENE), &closed);
    assert_eq!(
        result.unwrap_err(),
        DeclareRefusal::Store(Nir1StoreFailure::Fenced)
    );
    // A budget that works answers.
    assert_effective(&env, SCENE, "after the refused reads");
}

// ---- the request ----------------------------------------------------------------------

#[test]
fn st_request_is_closed_and_validated() {
    let ok: StateRequest =
        serde_json::from_value(json!({ "projectId": "p1", "sceneId": "s1" })).unwrap();
    assert_eq!(ok, state_request("p1", "s1"));
    for extra in [
        json!({ "projectId": "p1", "sceneId": "s1", "requestId": "r" }),
        json!({ "projectId": "p1", "sceneId": "s1", "declarationToken": "t" }),
        json!({ "projectId": "p1", "sceneId": "s1", "grantId": "g" }),
        json!({ "projectId": "p1" }),
    ] {
        assert!(
            serde_json::from_value::<StateRequest>(extra.clone()).is_err(),
            "{extra}"
        );
    }
    let env = Env::new();
    for (project, scene) in [("", "s1"), ("p1", ""), (" p1", "s1"), ("p1", "s1 ")] {
        assert_eq!(
            try_read(&env, project, scene).unwrap_err(),
            DeclareRefusal::InvalidRequest,
            "{project:?} {scene:?}"
        );
    }
    let long = "x"
        .repeat(grimodex_core::narrative_scene_body_declaration::MAX_BODY_DECLARATION_ID_BYTES + 1);
    assert_eq!(
        try_read(&env, &long, "s1").unwrap_err(),
        DeclareRefusal::InvalidRequest
    );
}
