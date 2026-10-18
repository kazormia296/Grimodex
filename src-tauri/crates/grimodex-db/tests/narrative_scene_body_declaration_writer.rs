//! CB-2 A13: the declaration writer is reachable only from the Electron Native
//! build, and exactly one production statement can make the declaration
//! columns non-NULL.
//!
//! These are source-level checks, the same style as the writer-coverage
//! manifest of `narrative_scope_storage_authority.rs`: they read the files and
//! pin the structure, so a later change that moves the writer into a path the
//! MCP server or a generic caller could reach fails here.

use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn collect(dir: &Path, extension: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if matches!(name.as_str(), "target" | "node_modules" | ".git") {
                continue;
            }
            collect(&path, extension, out);
        } else if name.ends_with(extension) {
            out.push(path);
        }
    }
}

fn declaration_dir() -> PathBuf {
    repo_root().join("src-tauri/crates/grimodex-db/src/narrative_extraction/scene_body_declaration")
}

const FEATURE_GATE: &str = "#[cfg(feature = \"native-current-human-capture\")]";

#[test]
fn writer_modules_sit_behind_the_native_feature() {
    let parent =
        read(&repo_root().join(
            "src-tauri/crates/grimodex-db/src/narrative_extraction/scene_body_declaration.rs",
        ));
    for module in ["commit_outcome", "facts", "revoke", "writer"] {
        let declaration = format!("mod {module};");
        let at = parent
            .find(&declaration)
            .unwrap_or_else(|| panic!("`{declaration}` is missing"));
        let before = parent[..at].trim_end();
        assert!(
            before.ends_with(FEATURE_GATE),
            "`mod {module};` must be gated by the Native feature"
        );
    }
    for export in [
        "pub use writer::{declare_scene_body",
        "pub use revoke::{revoke_scene_body",
        "pub use facts::{preview_scene_body_declaration",
    ] {
        let at = parent
            .find(export)
            .unwrap_or_else(|| panic!("`{export}` is missing"));
        assert!(
            parent[..at].trim_end().ends_with(FEATURE_GATE),
            "`{export}` must be gated by the Native feature"
        );
    }
}

#[test]
fn only_the_electron_native_crate_enables_the_native_feature() {
    let root = repo_root();
    let mut manifests = Vec::new();
    collect(&root.join("src-tauri"), "Cargo.toml", &mut manifests);
    collect(&root.join("electron/native"), "Cargo.toml", &mut manifests);
    assert!(manifests.len() >= 5, "found {} manifests", manifests.len());
    let allowed = [
        "src-tauri/crates/grimodex-db/Cargo.toml",
        "electron/native/grimodex-node/Cargo.toml",
    ];
    for manifest in &manifests {
        let relative = manifest
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let text = read(manifest);
        if allowed.contains(&relative.as_str()) {
            continue;
        }
        assert!(
            !text.contains("native-current-human-capture"),
            "{relative} must not enable the Native-only feature (the MCP server and every other \
             crate stay without the declaration writer)"
        );
    }
    // The Native crate does enable it, in its normal dependencies.
    let node = read(&root.join("electron/native/grimodex-node/Cargo.toml"));
    assert!(node.contains("features = [\"native-current-human-capture\"]"));
    // The MCP server depends on grimodex-db without it.
    let mcp = read(&root.join("src-tauri/crates/grimodex-mcp/Cargo.toml"));
    assert!(mcp.contains("grimodex-db"), "grimodex-mcp uses grimodex-db");
    assert!(!mcp.contains("native-current-human-capture"));
}

fn is_test_source(path: &Path) -> bool {
    let name = path.file_name().unwrap().to_string_lossy();
    name.ends_with("_tests.rs")
        || name == "tests.rs"
        || name == "test_support.rs"
        || name.contains("test_support")
        || path.components().any(|part| part.as_os_str() == "tests")
}

#[test]
fn exactly_one_production_statement_sets_the_declaration_columns() {
    let root = repo_root();
    let mut files = Vec::new();
    for crate_src in ["src-tauri/crates", "electron/native"] {
        collect(&root.join(crate_src), ".rs", &mut files);
    }
    let mut setters = Vec::new();
    for file in files {
        if is_test_source(&file) {
            continue;
        }
        let text = read(&file);
        for (index, line) in text.lines().enumerate() {
            let line = line.trim();
            let sets_a_value = [
                "body_declaration_json = ?",
                "body_declaration_json = excluded",
            ]
            .iter()
            .any(|pattern| line.contains(pattern));
            if sets_a_value {
                setters.push(format!(
                    "{}:{}",
                    file.strip_prefix(&root).unwrap().to_string_lossy(),
                    index + 1
                ));
            }
        }
    }
    assert_eq!(setters.len(), 1, "{setters:?}");
    assert!(
        setters[0].contains("scene_body_declaration/writer.rs"),
        "the one setter is the declaration writer's: {setters:?}"
    );
    // That statement lives in one function that does nothing else to the row.
    let writer = read(&declaration_dir().join("writer.rs"));
    let at = writer
        .find("fn set_declaration_columns")
        .expect("setter function");
    let body = &writer[at..];
    let end = body.find("\n}\n").expect("end of the function");
    let body = &body[..end];
    assert_eq!(body.matches("conn.execute(").count(), 1);
    assert_eq!(
        body.matches("UPDATE narrative_scene_scope_bindings")
            .count(),
        1
    );
    for forbidden in ["updated_at", "source_token =", "version =", "tree_nodes"] {
        let set_clause = body
            .split("SET")
            .nth(1)
            .and_then(|rest| rest.split("WHERE").next())
            .expect("SET clause");
        assert!(
            !set_clause.contains(forbidden),
            "the SET clause must write only the two columns, found `{forbidden}`"
        );
    }
    // The v1 writers never mention the declaration columns.
    let scope =
        read(&root.join("src-tauri/crates/grimodex-db/src/narrative_extraction/scene_scope.rs"));
    assert!(!scope.contains("body_declaration"));
}

#[test]
fn the_writer_does_not_touch_the_v1_columns_or_other_tables_directly() {
    let dir = declaration_dir();
    for name in ["writer.rs", "revoke.rs", "facts.rs", "commit_outcome.rs"] {
        let text = read(&dir.join(name));
        let production = text.clone();
        for statement in [
            "INSERT INTO tree_nodes",
            "UPDATE tree_nodes",
            "DELETE FROM",
            "DROP ",
            "ALTER ",
        ] {
            assert!(
                !production.contains(statement),
                "{name} must not contain `{statement}`"
            );
        }
    }
}

/// The proof of a consumed grant is a `pub` constructor, so this scan pins who
/// may call it: in production source only the definition and the grant code of
/// the Electron Native crate (`main_grant.rs`, after it consumed a grant).
/// Any other production caller would bypass Main's dialog.
#[test]
fn only_the_native_grant_code_makes_a_consumed_binding() {
    let root = repo_root();
    let mut files = Vec::new();
    for crate_src in ["src-tauri/crates", "electron/native"] {
        collect(&root.join(crate_src), ".rs", &mut files);
    }
    let allowed = [
        "src-tauri/crates/grimodex-db/src/narrative_extraction/scene_body_declaration/binding.rs",
        "electron/native/grimodex-node/src/main_grant.rs",
    ];
    let mut callers = Vec::new();
    for file in files {
        if is_test_source(&file) {
            continue;
        }
        let relative = file
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if read(&file).contains("from_consumed_grant") {
            callers.push(relative);
        }
    }
    callers.sort();
    let mut expected: Vec<String> = allowed.iter().map(|path| path.to_string()).collect();
    expected.sort();
    assert_eq!(
        callers, expected,
        "`ConsumedBodyDeclarationBinding::from_consumed_grant` may only be called by the Native \
         grant code"
    );
}
