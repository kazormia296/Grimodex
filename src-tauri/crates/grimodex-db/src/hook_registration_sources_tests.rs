//! DR-DBC-4, P3-1: production code registers an SQLite hook only through
//! `hook_registration` (which reserves the clientdata entry first and clears the
//! hook when a registration fails). A direct `conn.authorizer(...)` and the like
//! in production code would bring back the use after free that rusqlite 0.41
//! leaves after a failed first registration.

use std::path::{Path, PathBuf};

/// rusqlite 0.41's hook registrations that go through `set_clientdata`.
const HOOK_CALLS: &[&str] = &[
    ".authorizer(",
    ".progress_handler(",
    ".commit_hook(",
    ".rollback_hook(",
    ".update_hook(",
    ".preupdate_hook(",
    ".busy_handler(",
    ".trace_v2(",
    ".trace(",
    ".profile(",
    ".set_clientdata(",
];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("read src dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

fn is_test_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    name.ends_with("tests.rs")
        || name.ends_with("_test.rs")
        || name == "test_support.rs"
        || path.components().any(|c| {
            let c = c.as_os_str().to_str().unwrap_or_default();
            c == "tests" || c == "test-support" || c.ends_with("_tests")
        })
}

/// The text before the file's `#[cfg(test)] mod ...` (the production part).
fn production_part(source: &str) -> &str {
    let mut offset = 0;
    let mut previous_was_cfg_test = false;
    for line in source.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if previous_was_cfg_test
            && (trimmed.starts_with("mod ") || trimmed.starts_with("pub(crate) mod "))
        {
            return &source[..offset];
        }
        // Other attributes may sit between `#[cfg(test)]` and `mod`.
        if !trimmed.is_empty() && !trimmed.starts_with("#[") {
            previous_was_cfg_test = false;
        }
        if trimmed.starts_with("#[cfg(test)]") {
            previous_was_cfg_test = true;
        }
        offset += line.len();
    }
    source
}

#[test]
fn production_code_registers_hooks_only_through_hook_registration() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut offenders = Vec::new();
    for path in files {
        if is_test_file(&path) || path.ends_with("hook_registration.rs") {
            continue;
        }
        let source = std::fs::read_to_string(&path).expect("read source");
        for (number, line) in production_part(&source).lines().enumerate() {
            let code = line.split("//").next().unwrap_or_default();
            if let Some(call) = HOOK_CALLS.iter().find(|call| code.contains(**call)) {
                offenders.push(format!("{}:{}: {call}", path.display(), number + 1));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "register hooks through crate::hook_registration: {offenders:#?}"
    );
}
