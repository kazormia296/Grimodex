use super::*;

#[tokio::test]
async fn direct_native_graph_requests_cannot_reach_the_unactivated_reader() {
    let root = std::env::temp_dir().join(format!("nir1-graph-gate-{}", uuid::Uuid::new_v4()));
    let backend = Backend::new(root.to_string_lossy().into_owned(), None, None)
        .expect("create backend without a workspace");
    for payload in [
        serde_json::json!({
            "expectedWorkspacePath": "/must-not-be-opened",
            "projectId": "project",
            "querySceneId": "scene",
            "seedEntityId": "entity",
        }),
        serde_json::json!({ "testTransport": true, "qualified": true }),
        serde_json::Value::Null,
    ] {
        let error = backend
            .nir1_graph_query(payload)
            .await
            .expect_err("internal implementation cannot authorize product Graph");
        assert_eq!(error.reason, "NIR1_GRAPH_NOT_ACTIVATED");
    }
    drop(backend);
    let _ = std::fs::remove_dir_all(root);
}

// ---- CP-2b P1 (cp2b-decisions.md DR-CP2B-P1-1〜3): Main's worker path ----

fn graph_worker_name() -> &'static str {
    if cfg!(windows) {
        "nir1-c-query-worker.exe"
    } else {
        "nir1-c-query-worker"
    }
}

fn worker_test_root(label: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("nir1-graph-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("test root");
    root
}

#[test]
fn main_worker_path_refusals_keep_the_backend_and_leave_the_worker_unset() {
    let root = worker_test_root("main-path-refusal");
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).expect("bin");
    let misnamed = bin.join("grimodex-mcp");
    std::fs::write(&misnamed, b"").expect("misnamed file");
    let as_directory = root.join("as-directory").join(graph_worker_name());
    std::fs::create_dir_all(&as_directory).expect("directory named like the worker");
    for (index, path) in [
        None,
        Some(String::new()),
        Some(graph_worker_name().to_owned()),
        Some(format!("bin/{}", graph_worker_name())),
        Some(bin.join(graph_worker_name()).to_string_lossy().into_owned()),
        Some(misnamed.to_string_lossy().into_owned()),
        Some(as_directory.to_string_lossy().into_owned()),
    ]
    .into_iter()
    .enumerate()
    {
        let app = root.join(format!("app-{index}"));
        let backend =
            Backend::new_from_main(app.to_string_lossy().into_owned(), None, None, path.clone())
                .unwrap_or_else(|error| panic!("{path:?} must not break the backend: {error}"));
        assert!(
            !backend.state.nir1_graph.worker_configured_for_test(),
            "{path:?} must leave the worker unset"
        );
        drop(backend);
    }

    let worker = bin.join(graph_worker_name());
    std::fs::write(&worker, b"").expect("worker file");
    let backend = Backend::new_from_main(
        root.join("app-valid").to_string_lossy().into_owned(),
        None,
        None,
        Some(worker.to_string_lossy().into_owned()),
    )
    .expect("backend with a valid worker path");
    assert!(backend.state.nir1_graph.worker_configured_for_test());
    // The Rust-only constructor (tests, evaluation harness) never configures it.
    let plain = Backend::new(
        root.join("app-plain").to_string_lossy().into_owned(),
        None,
        None,
    )
    .expect("plain backend");
    assert!(!plain.state.nir1_graph.worker_configured_for_test());
    drop((backend, plain));
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn configured_worker_is_never_started_while_the_graph_is_unpublished() {
    use crate::nir1_graph_product::{GraphBegin, GraphQuery, GraphSlotKind, GraphUnavailable};

    let root = worker_test_root("no-spawn");
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).expect("bin");
    let worker = bin.join(graph_worker_name());
    let marker = root.join("worker-started");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(
            &worker,
            format!(
                "#!/bin/sh\necho started >> '{}'\nexit 0\n",
                marker.display()
            ),
        )
        .expect("worker script");
        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o755))
            .expect("executable");
        // Positive control: executing the file leaves the marker, so a start
        // through any path below would be seen.
        let status = std::process::Command::new(&worker)
            .status()
            .expect("run the worker");
        assert!(status.success());
        assert!(marker.exists(), "the start detector must work");
        std::fs::remove_file(&marker).expect("reset marker");
    }
    #[cfg(not(unix))]
    std::fs::write(&worker, b"").expect("worker file");

    let backend = Backend::new_from_main(
        root.join("app").to_string_lossy().into_owned(),
        None,
        None,
        Some(worker.to_string_lossy().into_owned()),
    )
    .expect("backend");
    let state = Arc::clone(&backend.state);
    assert!(state.nir1_graph.worker_configured_for_test());
    let query = || GraphQuery {
        project_id: "project".to_owned(),
        query_scene_id: "scene".to_owned(),
        seed_entity_id: "entity".to_owned(),
    };
    for _ in 0..8 {
        for begin in [
            state.nir1_graph.begin(&state, query()),
            state.nir1_graph.begin_deferred(&state, query()),
        ] {
            assert!(
                matches!(
                    begin,
                    GraphBegin::Unavailable(GraphUnavailable::NotActivated)
                ),
                "the closed gate must answer before the worker is read"
            );
        }
        let error = backend
            .nir1_graph_query(serde_json::json!({
                "projectId": "project",
                "querySceneId": "scene",
                "seedEntityId": "entity",
            }))
            .await
            .expect_err("the exported Graph entry stays closed");
        assert_eq!(error.reason, "NIR1_GRAPH_NOT_ACTIVATED");
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(state.nir1_graph.slot_kind_for_test(), GraphSlotKind::Empty);
    let diagnostics = state.nir1_graph.diagnostics();
    assert_eq!(diagnostics.prepares_started, 0);
    assert_eq!(diagnostics.pending, 0);
    assert!(!marker.exists(), "no product path may start the worker");
    drop(state);
    drop(backend);
    assert!(
        !marker.exists(),
        "shutdown must not start the worker either"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn only_the_main_constructor_configures_the_worker_path() {
    let lib = include_str!("lib.rs");
    assert_eq!(lib.matches(".configure_worker_path(").count(), 1);
    let constructor_start = lib
        .find("pub fn new_from_main(")
        .expect("the napi constructor");
    let constructor = &lib[constructor_start..];
    let constructor = &constructor[..constructor.find("\n    }\n").expect("constructor end")];
    assert!(constructor.contains(".configure_worker_path("));
    let preceding = &lib[..constructor_start];
    let attribute = preceding.rfind("#[napi").expect("attribute");
    assert!(preceding[attribute..].starts_with("#[napi(constructor)]"));
    // The worker path is never read from the environment by Native either.
    for source in [
        lib,
        include_str!("nir1_graph_product.rs"),
        include_str!("state.rs"),
    ] {
        for line in source.lines().filter(|line| line.contains("env::var")) {
            assert!(!line.to_ascii_uppercase().contains("WORKER"), "{line}");
        }
    }
}
