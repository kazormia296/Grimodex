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
    // Outside unix the worker is an empty file: there is no start detector and no
    // positive control, so the marker assertions below hold vacuously there. On
    // those platforms this test only shows that the closed gate answers
    // `not-activated` and that no prepare starts (the counters and the slot).
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

/// Removes `#[cfg(test)]` items (a `mod x;` declaration, a braced item or
/// block, or a one-line field / statement ending in `,` or `;`), so a scan sees
/// only what the product build compiles. Braces are counted per character;
/// a cfg(test) item with an unbalanced brace literal would be cut short, which
/// only makes the scan stricter.
fn strip_cfg_test_items(source: &str) -> String {
    let lines: Vec<&str> = source.lines().collect();
    let mut kept = String::with_capacity(source.len());
    let mut index = 0;
    while index < lines.len() {
        let trimmed = lines[index].trim();
        if !trimmed.starts_with("#[cfg(test)]") {
            kept.push_str(lines[index]);
            kept.push('\n');
            index += 1;
            continue;
        }
        let mut cursor = index;
        if trimmed == "#[cfg(test)]" {
            cursor += 1;
            while cursor < lines.len() {
                let next = lines[cursor].trim_start();
                if next.starts_with("#[") || next.starts_with("///") || next.starts_with("//") {
                    cursor += 1;
                } else {
                    break;
                }
            }
        }
        let mut depth: i64 = 0;
        let mut opened = false;
        while cursor < lines.len() {
            let line = lines[cursor];
            for character in line.chars() {
                match character {
                    '{' => {
                        depth += 1;
                        opened = true;
                    }
                    '}' => depth -= 1,
                    _ => {}
                }
            }
            cursor += 1;
            let end = line.trim_end();
            if depth < 0
                || (opened && depth == 0)
                || (!opened && (end.ends_with(';') || end.ends_with(',')))
            {
                break;
            }
        }
        index = cursor;
    }
    kept
}

/// Every `src/**/*.rs` the product build compiles: test files (`*tests.rs`)
/// are left out and `#[cfg(test)]` items are stripped. Paths are relative to `src`.
fn product_sources() -> Vec<(String, String)> {
    fn visit(directory: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(directory).expect("read src") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                visit(&path, files);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                files.push(path);
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    visit(&root, &mut files);
    files.sort();
    files
        .into_iter()
        .filter(|path| {
            !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with("tests.rs"))
        })
        .map(|path| {
            let relative = path
                .strip_prefix(&root)
                .expect("under src")
                .to_string_lossy()
                .replace('\\', "/");
            let source = std::fs::read_to_string(&path).expect("read source");
            (relative, strip_cfg_test_items(&source))
        })
        .collect()
}

#[test]
fn cfg_test_items_are_stripped_from_the_product_scan() {
    let sample = "fn kept() {}\n#[cfg(test)]\nmod tests;\n#[cfg(test)]\n/// doc\n#[allow(dead_code)]\nfn gone() {\n    if x { y(); }\n}\nstruct S {\n    a: u8,\n    #[cfg(test)]\n    b: u8,\n    c: u8,\n}\n#[cfg(test)] fn inline_gone() { z(); }\nfn after() {}\n";
    let stripped = strip_cfg_test_items(sample);
    for kept in ["fn kept()", "a: u8,", "c: u8,", "fn after()", "struct S {"] {
        assert!(stripped.contains(kept), "{kept}: {stripped}");
    }
    for gone in ["mod tests;", "fn gone()", "y();", "b: u8,", "inline_gone"] {
        assert!(!stripped.contains(gone), "{gone}: {stripped}");
    }
    // The real files: the product owner keeps its setter, loses its test seams.
    let sources = product_sources();
    let product = &sources
        .iter()
        .find(|(path, _)| path == "nir1_graph_product.rs")
        .expect("product owner")
        .1;
    assert!(product.contains("pub(crate) fn configure_worker_path("));
    assert!(!product.contains("fn install_worker_factory_for_test("));
    assert!(!product.contains("publication_open_for_test"));
    assert!(sources.iter().all(|(path, _)| !path.ends_with("tests.rs")));
    assert!(sources.iter().any(|(path, _)| path == "lib.rs"));
}

#[test]
fn only_the_main_constructor_configures_the_worker_path() {
    let sources = product_sources();
    let compact = |source: &str| source.split_whitespace().collect::<String>();
    // Every product use of the setter, in any module, other than its definition.
    let mut setters = Vec::new();
    let mut factories = Vec::new();
    let mut slot_writes = Vec::new();
    for (path, source) in &sources {
        let uses = source.matches("configure_worker_path").count()
            - source.matches("fn configure_worker_path").count();
        setters.extend(std::iter::repeat_n(path.clone(), uses));
        factories.extend(std::iter::repeat_n(
            path.clone(),
            source
                .matches("ProcessGraphWorkerFactory::from_path(")
                .count(),
        ));
        slot_writes.extend(std::iter::repeat_n(
            path.clone(),
            compact(source).matches(".worker.set(").count(),
        ));
    }
    assert_eq!(setters, ["lib.rs"], "the product sets the worker path once");
    assert_eq!(factories, ["nir1_graph_product.rs"]);
    assert_eq!(slot_writes, ["nir1_graph_product.rs"]);

    let lib = &sources
        .iter()
        .find(|(path, _)| path == "lib.rs")
        .expect("lib.rs")
        .1;
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
    for (path, source) in &sources {
        for line in source.lines().filter(|line| line.contains("env::var")) {
            assert!(
                !line.to_ascii_uppercase().contains("WORKER"),
                "{path}: {line}"
            );
        }
    }
}
