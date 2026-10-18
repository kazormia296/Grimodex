//! D9 to D12 (CB-2): the entries refuse before they read anything while the
//! pre-publication gate is closed, and the gate's own call is Main-only. These
//! run on a real `Backend` with no workspace, so a refusal that came from the
//! database or the workspace would be a different message.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::*;

fn declare_payload() -> serde_json::Value {
    serde_json::json!({
        "expectedWorkspacePath": "/must-not-be-opened",
        "payload": {
            "projectId": "p1",
            "sceneId": "s1",
            "requestId": "r1",
            "expected": { "scopeVersion": 1, "scopeToken": "t", "declarationToken": null },
            "values": {
                "story": "independent", "auto": "independent", "phase": "independent",
                "reveal": "non-secret", "pov": "independent"
            },
        },
    })
}

fn revoke_payload() -> serde_json::Value {
    serde_json::json!({
        "expectedWorkspacePath": "/must-not-be-opened",
        "payload": {
            "projectId": "p1", "sceneId": "s1", "requestId": "r2", "declarationToken": "t",
        },
    })
}

fn grant_sidecar() -> String {
    serde_json::json!({ "grantId": "g", "senderId": 1, "windowId": 2 }).to_string()
}

fn backend(label: &str) -> (Backend, std::path::PathBuf) {
    let root =
        std::env::temp_dir().join(format!("body-declaration-{label}-{}", uuid::Uuid::new_v4()));
    let backend = Backend::new(root.to_string_lossy().into_owned(), None, None)
        .expect("create backend without a workspace");
    (backend, root)
}

const GATE_CLOSED: &str = "NEX_BODY_DECLARATION_REFUSED:gate-closed";

// D9
#[tokio::test]
async fn a_closed_gate_refuses_every_entry_before_anything_is_read() {
    let (backend, root) = backend("closed");
    let error = backend
        .narrative_scene_body_declaration_declare(declare_payload(), None, Some(grant_sidecar()))
        .await
        .expect_err("closed gate");
    assert_eq!(error.reason, GATE_CLOSED);
    // Not even a malformed payload, a missing grant or an absent workspace
    // changes the reason: the gate is the first thing after admission.
    for payload in [serde_json::Value::Null, serde_json::json!({ "bad": 1 })] {
        let error = backend
            .narrative_scene_body_declaration_declare(payload.clone(), None, None)
            .await
            .expect_err("closed gate");
        assert_eq!(error.reason, GATE_CLOSED);
        let error = backend
            .narrative_scene_body_declaration_revoke(payload, None)
            .await
            .expect_err("closed gate");
        assert_eq!(error.reason, GATE_CLOSED);
    }
    let error = backend
        .narrative_scene_body_declaration_revoke(revoke_payload(), None)
        .await
        .expect_err("closed gate");
    assert_eq!(error.reason, GATE_CLOSED);
    let error = backend
        .main_grant_preview(
            "body-declaration".into(),
            declare_payload().to_string(),
            1,
            2,
            None,
        )
        .await
        .expect_err("closed gate");
    assert_eq!(error.reason, GATE_CLOSED);
    // Nothing was stored: the slot is still free.
    assert!(backend
        .state
        .main_grant
        .registry
        .ensure_can_preview()
        .is_ok());
    drop(backend);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn the_gate_opens_only_by_the_main_only_call_and_only_for_a_known_kind() {
    let (backend, root) = backend("open");
    for kind in ["", "all", "local-send", "Scene-Body-Declaration"] {
        let error = backend
            .main_open_pre_publication_gate(kind.into())
            .expect_err("unknown kind");
        assert_eq!(error.reason, "MAIN_GATE_KIND");
    }
    assert!(!backend
        .state
        .main_grant
        .gate
        .is_open(main_grant::PrePublicationEntry::SceneBodyDeclaration));
    backend
        .main_open_pre_publication_gate("scene-body-declaration".into())
        .expect("open");
    // Open, the entries go on to the next check. No workspace is open, so
    // the refusal is the workspace's now and the grant's.
    let error = backend
        .narrative_scene_body_declaration_declare(declare_payload(), None, None)
        .await
        .expect_err("no grant");
    assert_eq!(error.reason, "MAIN_GRANT_REQUIRED");
    let error = backend
        .narrative_scene_body_declaration_declare(declare_payload(), None, Some(grant_sidecar()))
        .await
        .expect_err("no workspace");
    assert_ne!(error.reason, GATE_CLOSED);
    assert!(
        error.reason.contains("No workspace is open"),
        "{}",
        error.reason
    );
    let error = backend
        .narrative_scene_body_declaration_revoke(revoke_payload(), None)
        .await
        .expect_err("no workspace");
    assert!(
        error.reason.contains("No workspace is open"),
        "{}",
        error.reason
    );
    // A grant sidecar that is not the closed shape is a missing grant.
    for sidecar in [
        "not json".to_string(),
        serde_json::json!({ "grantId": "g", "senderId": 1, "windowId": 2, "extra": 1 }).to_string(),
        serde_json::json!({ "grantId": "", "senderId": 1, "windowId": 2 }).to_string(),
        serde_json::json!({ "grantId": "g", "senderId": -1, "windowId": 2 }).to_string(),
    ] {
        let error = backend
            .narrative_scene_body_declaration_declare(declare_payload(), None, Some(sidecar))
            .await
            .expect_err("bad sidecar");
        assert_eq!(error.reason, "MAIN_GRANT_REQUIRED");
    }
    drop(backend);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_renderer_payload_cannot_carry_a_grant_or_the_fields_the_writer_makes() {
    let (backend, root) = backend("closed-shape");
    backend
        .main_open_pre_publication_gate("scene-body-declaration".into())
        .expect("open");
    for extra in [
        ("grant", serde_json::json!({ "grantId": "g" })),
        ("senderId", serde_json::json!(1)),
        ("declarationId", serde_json::json!("d")),
        ("declaredAt", serde_json::json!("2026-10-18T00:00:00Z")),
        ("digest", serde_json::json!("sha256:x")),
    ] {
        // At the top level and inside the request.
        let mut top = declare_payload();
        top[extra.0] = extra.1.clone();
        let mut inner = declare_payload();
        inner["payload"][extra.0] = extra.1.clone();
        for payload in [top, inner] {
            let error = backend
                .narrative_scene_body_declaration_declare(payload, None, Some(grant_sidecar()))
                .await
                .expect_err("unknown field");
            assert!(
                error.reason.contains("unknown field"),
                "{}: {}",
                extra.0,
                error.reason
            );
        }
    }
    drop(backend);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn the_main_only_calls_are_not_renderer_commands() {
    // The names are exported by the addon and called by Main; the contract
    // test (ipcContract.test.ts) keeps them out of `NAPI_COMMANDS`. Here the
    // Native half: revoke by an unknown id and by an unknown sender are
    // harmless no-ops.
    let (backend, root) = backend("main-only");
    backend.main_grant_revoke("unknown".into());
    backend.main_grant_revoke_sender(9);
    let error = backend
        .main_grant_issue("unknown".into(), 1, 2)
        .await
        .expect_err("no preview");
    assert_eq!(error.reason, "MAIN_GRANT_NOT_FOUND");
    let error = backend
        .main_grant_preview("profile-activation".into(), "{}".into(), 1, 2, None)
        .await
        .expect_err("unknown kind");
    assert_eq!(error.reason, "MAIN_GRANT_KIND");
    drop(backend);
    let _ = std::fs::remove_dir_all(root);
}

// D12 (and the db layer's restart-required, seen through the entries)
#[tokio::test]
async fn a_quarantined_workspace_answers_restart_required_and_nothing_else_stops() {
    use grimodex_db::narrative_extraction::scene_body_declaration::{
        clear_scene_body_declaration_workspace_quarantine_for_test,
        quarantine_scene_body_declaration_workspace_for_test,
    };
    let (backend, root) = backend("quarantine");
    let workspace_path = root.join("workspace");
    backend
        .open_workspace(workspace_path.to_string_lossy().into_owned())
        .await
        .expect("open workspace");
    backend
        .main_open_pre_publication_gate("scene-body-declaration".into())
        .expect("open gate");
    let snapshot = grimodex_db::state::active_workspace_snapshot(&backend.state.ws).unwrap();
    let with_path = |mut payload: serde_json::Value| {
        payload["expectedWorkspacePath"] =
            serde_json::json!(workspace_path.to_string_lossy().into_owned());
        payload
    };
    quarantine_scene_body_declaration_workspace_for_test(&snapshot);

    let declare = backend
        .narrative_scene_body_declaration_declare(
            with_path(declare_payload()),
            None,
            Some(grant_sidecar()),
        )
        .await
        .expect_err("quarantined");
    assert_eq!(
        declare.reason,
        "NEX_BODY_DECLARATION_REFUSED:restart-required"
    );
    let revoke = backend
        .narrative_scene_body_declaration_revoke(with_path(revoke_payload()), None)
        .await
        .expect_err("quarantined");
    assert_eq!(
        revoke.reason,
        "NEX_BODY_DECLARATION_REFUSED:restart-required"
    );
    let preview = backend
        .main_grant_preview(
            "body-declaration".into(),
            with_path(declare_payload()).to_string(),
            1,
            2,
            None,
        )
        .await
        .expect_err("quarantined");
    assert_eq!(
        preview.reason,
        "NEX_BODY_DECLARATION_REFUSED:restart-required"
    );
    // The refusal came before the grant: nothing was stored, and the unknown
    // grant id of the declare call above did not need to exist.
    assert!(backend
        .state
        .main_grant
        .registry
        .ensure_can_preview()
        .is_ok());

    // Another operation of the workspace is unaffected.
    backend
        .db_execute(
            "SELECT 1".into(),
            serde_json::json!([]),
            "all".into(),
            None,
            None,
        )
        .await
        .expect("the workspace still serves other operations");

    // A restart (here: releasing the key) lets the next request through to
    // the database.
    clear_scene_body_declaration_workspace_quarantine_for_test(&snapshot);
    drop(snapshot);
    let after = backend
        .narrative_scene_body_declaration_revoke(with_path(revoke_payload()), None)
        .await;
    match after {
        Ok(response) => assert!(!response.contains("restart-required"), "{response}"),
        Err(error) => assert_ne!(
            error.reason,
            "NEX_BODY_DECLARATION_REFUSED:restart-required"
        ),
    }
    drop(backend);
    let _ = std::fs::remove_dir_all(root);
}
