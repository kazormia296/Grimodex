//! E5 (Linux part): the declaration follows the workspace's canonical locator.
//! Opening the same workspace through a symlink keeps the declaration valid;
//! a copy of the workspace folder does not (the locator digest differs while
//! the workspace ID is the same). Windows (`\\?\` forms) and macOS
//! (`/private` prefixes) are checked by the `from_parts` input-form tests and
//! the hosted CI, not here.
#![cfg(all(unix, feature = "native-current-human-capture"))]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};

use super::writer_support_tests::*;
use super::*;

fn declared_current_facts(env: &Env) -> SceneBodyDeclarationCurrentFacts {
    let preview =
        preview_scene_body_declaration(&env.snapshot(), &scene_request(env), &budget()).unwrap();
    let binding = preview.binding;
    SceneBodyDeclarationCurrentFacts {
        project_id: binding.project_id.clone(),
        scene_id: binding.scene_id.clone(),
        scene_incarnation_id: binding.scene_incarnation_id.clone(),
        scope_source_token: binding.scope_token.clone(),
        body_source: binding.body_source.clone(),
        title_digest: binding.title_digest.clone(),
        workspace_id: binding.workspace_id.clone(),
        canonical_locator_digest: binding.canonical_locator_digest.clone(),
    }
}

fn stored_declaration(env: &Env) -> NarrativeSceneBodyDeclarationV1 {
    let SceneBodyDeclarationRead::Declared(stored) =
        env.with_conn(|conn| read_scene_body_declaration(conn, PROJECT, SCENE))
    else {
        panic!("declared");
    };
    stored.declaration
}

fn copy_dir(from: &Path, to: &Path) {
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

fn sibling(env: &Env, suffix: &str) -> PathBuf {
    let name = env.path.file_name().unwrap().to_string_lossy().into_owned();
    env.path.with_file_name(format!("{name}-{suffix}"))
}

#[test]
fn symlink_open_keeps_the_declaration() {
    let mut env = Env::new();
    declare(&env, request_for(&env, PROJECT, SCENE)).expect("declaration");
    let declaration = stored_declaration(&env);
    let identity_before = env.identity();

    let link = sibling(&env, "link");
    std::os::unix::fs::symlink(&env.path, &link).expect("symlink");
    env.reopen_via(&link);

    // The path the author opened through differs, the canonical locator does not.
    assert_eq!(env.identity(), identity_before);
    let facts = declared_current_facts(&env);
    assert_eq!(
        scene_body_declaration_binding_mismatches(&declaration, &facts),
        Vec::new()
    );
    assert!(scene_body_declaration_binding_holds(&declaration, &facts));
    let _ = std::fs::remove_file(&link);
}

#[test]
fn copy_of_workspace_does_not_keep_the_declaration() {
    let mut env = Env::new();
    declare(&env, request_for(&env, PROJECT, SCENE)).expect("declaration");
    let declaration = stored_declaration(&env);
    let identity_before = env.identity();

    // The database is closed before it is copied, so the copy is whole.
    env.close();
    let copy = sibling(&env, "copy");
    copy_dir(&env.path, &copy);
    env.reopen_via(&copy);

    // The copy keeps the workspace ID and the declaration cells, but its
    // canonical locator is another folder's.
    let identity_after = env.identity();
    assert_eq!(
        identity_after.workspace_id_digest,
        identity_before.workspace_id_digest
    );
    assert_ne!(
        identity_after.canonical_locator_digest,
        identity_before.canonical_locator_digest
    );
    assert_eq!(stored_declaration(&env), declaration);
    let facts = declared_current_facts(&env);
    assert_eq!(
        scene_body_declaration_binding_mismatches(&declaration, &facts),
        vec![SceneBodyDeclarationBindingMismatch::CanonicalLocatorDigest]
    );
    assert!(!scene_body_declaration_binding_holds(&declaration, &facts));
    env.close();
    let _ = std::fs::remove_dir_all(&copy);
}
