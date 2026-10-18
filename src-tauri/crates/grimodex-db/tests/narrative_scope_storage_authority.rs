//! X1-2 acceptance test 14 (scene-scope-projection proposal 1, "writer coverage").
//!
//! The Scene Scope generation (`narrative_scene_scope_bindings.version` and the v1
//! source token) and the Scene body Source token (`v{version}@{updated_at}`) are
//! only sound while every production writer that can change them is known. This
//! file scans the production Rust sources (test modules and test-only files are
//! excluded) and compares the SQL writers of `narrative_scene_scope_bindings`,
//! `tree_nodes` and `codex_entries` with a closed manifest. A new writer, a moved
//! writer or a changed statement count fails the test until the manifest (and
//! the contract that the writer must keep) is reviewed.
//!
//! What the manifest pins, per the proposal's "Mandatory defenses":
//! 1. every function that writes a binding row (and that every UPDATE of an
//!    existing binding advances `version`, except the one declaration-only clear
//!    that writes just the two Scene body declaration columns and nothing else);
//! 2. every function that writes a Scope column of `tree_nodes` (`parent_id`,
//!    `sort_order`, `story_time_order`, `archived_at`, `pov_character_id`) and that
//!    each of them reaches a Scope refresh helper;
//! 3. the foreign-key actions that change those columns without a writer
//!    (`parent_id ... ON DELETE CASCADE`, `pov_character_id ... ON DELETE SET
//!    NULL`, the binding row's own `scene_id` cascade);
//! 4. every path that deletes, re-inserts or changes the type of a `codex_entries`
//!    row that a holder/audience reference can name (native writers and the
//!    grimodex-core undo journal, which is only reached through the method J1
//!    guard in `replay_undo_journal_via_core_in_tx`);
//! 5. the Scene rewrites that do not advance `version`: only W1
//!    (`tree_node_patch_with_authority`, `bumpVersion=false`) and W2
//!    (`update_scene_to_state`, Chronicle bulk) may exist, and both keep
//!    `updated_at` strictly later as an instant.
//!
//! Scope of the guarantee (proposal Delta 1, (i)-(iii)): only rewrites inside one
//! restore epoch are counted. INSERTs, whole-project restores and the FK
//! `SET NULL` of `pov_character_id`/`location_id` are listed separately and are
//! not "unversioned Scene rewrites".
//!
//! The scanner assumes rustfmt layout: a `#[cfg(test)]` item ends at the first
//! line that is exactly its indentation plus `}`, and a function body ends the
//! same way.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const SCOPE_COLUMNS: &[&str] = &[
    "parent_id",
    "sort_order",
    "story_time_order",
    "archived_at",
    "pov_character_id",
];

const TABLES: &[&str] = &[
    "narrative_scene_scope_bindings",
    "tree_nodes",
    "codex_entries",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Class {
    /// INSERT (including the upsert) of a binding row.
    BindingCreate,
    /// UPDATE of a binding row; the statement must write `version`.
    BindingAdvance,
    /// UPDATE of a binding row that writes only the two Scene body declaration
    /// columns (to NULL, or the declaration writer's one compare-and-set). It
    /// deliberately does not advance the Scope generation: `version`,
    /// `source_token`, `updated_at` and the A1 columns keep their bytes, so a
    /// declaration never moves the v1 token (CB-1, K2/4).
    BindingDeclarationOnly,
    /// Explicit DELETE of a Scene's binding row next to the Scene row delete.
    BindingDelete,
    /// UPDATE of `tree_nodes` that writes Scope columns (or builds its SET list
    /// dynamically); the function must reach a Scope refresh helper.
    TreeScopeWriter,
    /// UPDATE of `tree_nodes` that writes no Scope column.
    TreeNoScope,
    /// INSERT of a Scene row; the function must create the binding.
    SceneCreate,
    /// INSERT of a folder row only (no binding).
    FolderCreate,
    /// DELETE of a Scene row whose binding row goes with it (explicit delete or
    /// the `scene_id ... ON DELETE CASCADE` foreign key).
    TreeDelete,
    /// Whole-project restore; rebuilds bindings under a new epoch.
    ProjectRestore,
    /// Codex delete that is guarded by the character reference check and
    /// refreshes the Scenes that name the entry as POV.
    CodexDeleteGuarded,
    /// grimodex-core undo journal write. Reached only through the J1 guard.
    CodexJournalCore,
    /// Codex patch that can change `type`; guarded by the reference check.
    CodexTypeChangeGuarded,
    /// Codex re-insert of a deleted entry that invalidates holder/audience.
    CodexReinsertInvalidates,
    /// Codex INSERT with a fresh id, or a re-insert that cannot be referenced
    /// (deletion is refused while referenced), outside the undo-journal paths.
    CodexInsertNoReference,
    /// Codex write that never writes `type` and never deletes.
    CodexNoTypeChange,
}

use Class::*;

/// (repo-relative path, function, "VERB table", statement count, class)
type ManifestRow = (&'static str, &'static str, &'static str, usize, Class);

const MANIFEST: &[ManifestRow] = &[
    (
        "src-tauri/crates/grimodex-core/src/undo_journal.rs",
        "apply_undo_journal_in_tx",
        "DELETE codex_entries",
        1,
        CodexJournalCore,
    ),
    (
        "src-tauri/crates/grimodex-core/src/undo_journal.rs",
        "insert_codex_from_snap",
        "INSERT codex_entries",
        1,
        CodexJournalCore,
    ),
    (
        "src-tauri/crates/grimodex-core/src/undo_journal.rs",
        "restore_codex_entry_fields",
        "UPDATE codex_entries",
        1,
        CodexJournalCore,
    ),
    (
        "src-tauri/crates/grimodex-core/src/undo_journal.rs",
        "revert_undo_journal_in_tx",
        "DELETE codex_entries",
        1,
        CodexJournalCore,
    ),
    (
        "src-tauri/crates/grimodex-core/src/workspace_schema.rs",
        "<none>",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-core/src/writes/codex.rs",
        "link_codex_tags",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-core/src/writes/codex.rs",
        "tracked_codex_create_in_tx",
        "INSERT codex_entries",
        1,
        CodexInsertNoReference,
    ),
    (
        "src-tauri/crates/grimodex-core/src/writes/codex.rs",
        "tracked_codex_update_in_tx",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-db/src/agent_writes.rs",
        "apply_codex_entry_create_in_tx",
        "INSERT codex_entries",
        1,
        CodexInsertNoReference,
    ),
    (
        "src-tauri/crates/grimodex-db/src/agent_writes.rs",
        "apply_codex_entry_patch_in_tx",
        "UPDATE codex_entries",
        1,
        CodexTypeChangeGuarded,
    ),
    (
        "src-tauri/crates/grimodex-db/src/agent_writes.rs",
        "apply_renderer_codex_create_fields",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-db/src/agent_writes.rs",
        "delete_codex_entry_cascade",
        "DELETE codex_entries",
        2,
        CodexDeleteGuarded,
    ),
    (
        "src-tauri/crates/grimodex-db/src/agent_writes.rs",
        "replace_codex_tags_in_tx",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-db/src/agent_writes.rs",
        "restore_deleted_codex_entry_from_snapshot",
        "INSERT codex_entries",
        1,
        CodexReinsertInvalidates,
    ),
    (
        "src-tauri/crates/grimodex-db/src/agent_writes.rs",
        "restore_deleted_codex_entry_from_snapshot",
        "UPDATE codex_entries",
        1,
        CodexReinsertInvalidates,
    ),
    (
        "src-tauri/crates/grimodex-db/src/chronicle_bulk.rs",
        "update_scene_to_state",
        "UPDATE tree_nodes",
        1,
        TreeScopeWriter,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "apply_ai_tree_plan",
        "INSERT tree_nodes",
        1,
        SceneCreate,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "apply_ai_tree_plan",
        "UPDATE tree_nodes",
        3,
        TreeScopeWriter,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "apply_codex_rename_updates_in_tx",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "apply_codex_rename_updates_in_tx",
        "UPDATE tree_nodes",
        2,
        TreeNoScope,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "set_entity_tags",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "tree_node_create_with_authority",
        "INSERT tree_nodes",
        1,
        SceneCreate,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "tree_node_delete_with_authority",
        "DELETE narrative_scene_scope_bindings",
        1,
        BindingDelete,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "tree_node_delete_with_authority",
        "DELETE tree_nodes",
        1,
        TreeDelete,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "tree_node_patch_with_authority",
        "UPDATE tree_nodes",
        1,
        TreeScopeWriter,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "undo_ai_tree_plan",
        "DELETE tree_nodes",
        1,
        TreeDelete,
    ),
    (
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        "undo_ai_tree_plan",
        "UPDATE tree_nodes",
        1,
        TreeScopeWriter,
    ),
    (
        "src-tauri/crates/grimodex-db/src/integrity.rs",
        "repair_integrity",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-db/src/map_writes.rs",
        "extract_frame_to_codex",
        "INSERT codex_entries",
        1,
        CodexInsertNoReference,
    ),
    (
        "src-tauri/crates/grimodex-db/src/map_writes.rs",
        "promote_sticky",
        "INSERT codex_entries",
        1,
        CodexInsertNoReference,
    ),
    (
        "src-tauri/crates/grimodex-db/src/map_writes.rs",
        "promote_sticky",
        "INSERT tree_nodes",
        1,
        SceneCreate,
    ),
    (
        "src-tauri/crates/grimodex-db/src/migrate.rs",
        "migrate_tree_nodes_note_context",
        "UPDATE tree_nodes",
        1,
        TreeNoScope,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/codex_snapshots.rs",
        "reapply_codex_entry_create_snapshot",
        "INSERT codex_entries",
        1,
        CodexInsertNoReference,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/codex_snapshots.rs",
        "restore_codex_entry_patch",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_capacity_fixtures.rs",
        "hide_report_heavy_sources",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_capacity_fixtures.rs",
        "mutate_source_drift_candidates",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_capacity_fixtures.rs",
        "seed_catalog_and_authorities",
        "INSERT codex_entries",
        1,
        CodexInsertNoReference,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_capacity_fixtures.rs",
        "seed_catalog_and_authorities",
        "INSERT tree_nodes",
        2,
        SceneCreate,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/scene_body_declaration.rs",
        "null_declaration_columns",
        "UPDATE narrative_scene_scope_bindings",
        1,
        BindingDeclarationOnly,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/scene_body_declaration/writer.rs",
        "set_declaration_columns",
        "UPDATE narrative_scene_scope_bindings",
        1,
        BindingDeclarationOnly,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/scene_scope.rs",
        "insert_binding_in_tx",
        "INSERT narrative_scene_scope_bindings",
        1,
        BindingCreate,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/scene_scope.rs",
        "invalidate_character_references_with_events_in_tx",
        "UPDATE narrative_scene_scope_bindings",
        1,
        BindingAdvance,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/scene_scope.rs",
        "refresh_scene_scope_source_token_in_tx",
        "UPDATE narrative_scene_scope_bindings",
        1,
        BindingAdvance,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/scene_scope.rs",
        "update_narrative_scene_scope",
        "INSERT narrative_scene_scope_bindings",
        1,
        BindingCreate,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/scene_scope.rs",
        "update_narrative_scene_scope_registry",
        "UPDATE narrative_scene_scope_bindings",
        1,
        BindingAdvance,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/temporal_operations.rs",
        "apply_scene_metadata_patch_in_tx",
        "UPDATE tree_nodes",
        1,
        TreeNoScope,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/temporal_operations.rs",
        "apply_scene_temporal_patch_in_tx",
        "UPDATE tree_nodes",
        1,
        TreeScopeWriter,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/temporal_operations.rs",
        "apply_story_order_materialize_in_tx",
        "UPDATE tree_nodes",
        1,
        TreeScopeWriter,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/temporal_operations.rs",
        "restore_scene_chronicle_patch",
        "UPDATE tree_nodes",
        1,
        TreeNoScope,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/temporal_operations.rs",
        "restore_scene_story_order_patch",
        "UPDATE tree_nodes",
        1,
        TreeScopeWriter,
    ),
    (
        "src-tauri/crates/grimodex-db/src/narrative_extraction/undo.rs",
        "mutate_commit",
        "UPDATE codex_entries",
        1,
        CodexNoTypeChange,
    ),
    (
        "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
        "apply_project_snapshot_restore",
        "DELETE codex_entries",
        1,
        ProjectRestore,
    ),
    (
        "src-tauri/crates/grimodex-db/src/project_snapshots.rs",
        "apply_project_snapshot_restore",
        "DELETE tree_nodes",
        1,
        ProjectRestore,
    ),
    (
        "src-tauri/crates/grimodex-db/src/revision_restore.rs",
        "restore_scene_revision",
        "UPDATE tree_nodes",
        1,
        TreeNoScope,
    ),
    (
        "src-tauri/crates/grimodex-db/src/runtime_performance_seed.rs",
        "seed_runtime_performance_fixture",
        "INSERT tree_nodes",
        1,
        SceneCreate,
    ),
    (
        "src-tauri/crates/grimodex-db/src/sample_seed.rs",
        "insert_seed_rows",
        "INSERT codex_entries",
        1,
        CodexInsertNoReference,
    ),
    (
        "src-tauri/crates/grimodex-db/src/sample_seed.rs",
        "insert_seed_rows",
        "INSERT tree_nodes",
        1,
        SceneCreate,
    ),
    (
        "src-tauri/crates/grimodex-db/src/scene_body.rs",
        "save_scene_body_bundle",
        "UPDATE tree_nodes",
        1,
        TreeNoScope,
    ),
    (
        "src-tauri/crates/grimodex-db/src/trash_bin.rs",
        "restore_codex_in_tx",
        "INSERT codex_entries",
        1,
        CodexInsertNoReference,
    ),
    (
        "src-tauri/crates/grimodex-db/src/trash_bin.rs",
        "restore_grid_chapter_in_tx",
        "INSERT tree_nodes",
        1,
        FolderCreate,
    ),
    (
        "src-tauri/crates/grimodex-db/src/trash_bin.rs",
        "restore_scene_in_tx",
        "INSERT tree_nodes",
        1,
        SceneCreate,
    ),
];

struct Hit {
    file: String,
    function: String,
    verb_table: String,
    /// lower-cased text after the table name up to `where` / the closing quote
    set_text: String,
    body: String,
}

struct Source {
    path: String,
    lines: Vec<String>,
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Blank `#[cfg(test)]` items (keeping line numbers) and `//` comment lines.
/// Returns the module names declared as `#[cfg(test)] mod name;`.
fn blank_test_items(lines: &[String], out: &mut Vec<String>) -> Vec<String> {
    let mut test_modules = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        if line.trim() == "#[cfg(test)]" {
            let indent = indent_of(line);
            let mut header = i + 1;
            while lines[header].trim_start().starts_with("#[") {
                header += 1;
            }
            let header_text = lines[header].trim();
            let module_decl = header_text
                .trim_start_matches("pub(crate) ")
                .trim_start_matches("pub(super) ")
                .trim_start_matches("pub ");
            if let Some(rest) = module_decl.strip_prefix("mod ") {
                if let Some(name) = rest.strip_suffix(';') {
                    test_modules.push(name.trim().to_string());
                }
            }
            let mut end = header;
            if header_text.starts_with("use ")
                || header_text.starts_with("pub use ")
                || header_text.starts_with("pub(crate) use ")
            {
                while !lines[end].trim_end().ends_with(';') {
                    end += 1;
                }
            } else {
                loop {
                    let current = lines[end].trim_end();
                    if current.ends_with(';') {
                        break;
                    }
                    if current.ends_with('{') {
                        let closing = format!("{}}}", " ".repeat(indent));
                        let closing_semi = format!("{}}};", " ".repeat(indent));
                        while lines[end].trim_end() != closing
                            && lines[end].trim_end() != closing_semi
                        {
                            end += 1;
                        }
                        break;
                    }
                    if current.ends_with('}') {
                        break;
                    }
                    end += 1;
                }
            }
            for _ in i..=end {
                out.push(String::new());
            }
            i = end + 1;
        } else {
            if line.trim_start().starts_with("//") {
                out.push(String::new());
            } else {
                out.push(line.clone());
            }
            i += 1;
        }
    }
    test_modules
}

fn collect_rs_files(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if name == "tests" || name == "target" || name == "node_modules" {
                continue;
            }
            collect_rs_files(&path, files);
        } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") && name != "tests.rs" {
            files.push(path);
        }
    }
}

fn scan_roots(root: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let crates = root.join("src-tauri/crates");
    let mut crate_dirs: Vec<_> = fs::read_dir(&crates)
        .expect("crates dir")
        .flatten()
        .map(|entry| entry.path())
        .collect();
    crate_dirs.sort();
    for crate_dir in crate_dirs {
        let src = crate_dir.join("src");
        if src.is_dir() {
            roots.push(src);
        }
    }
    roots.push(root.join("src-tauri/src"));
    roots.push(root.join("electron/native/grimodex-node/src"));
    for scan_root in &roots {
        assert!(scan_root.is_dir(), "missing scan root {scan_root:?}");
    }
    roots
}

fn load_production_sources(root: &Path) -> Vec<Source> {
    let mut files = Vec::new();
    for scan_root in scan_roots(root) {
        collect_rs_files(&scan_root, &mut files);
    }
    let mut blanked: Vec<(PathBuf, Vec<String>)> = Vec::new();
    // (directory, module name) pairs for `#[cfg(test)] mod name;`.
    let mut excluded: Vec<PathBuf> = Vec::new();
    for path in &files {
        let text = fs::read_to_string(path).expect("read source");
        let lines: Vec<String> = text.lines().map(str::to_string).collect();
        let mut out = Vec::with_capacity(lines.len());
        let modules = blank_test_items(&lines, &mut out);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let parent = path.parent().expect("parent");
        let module_dir = if matches!(stem, "mod" | "lib" | "main") {
            parent.to_path_buf()
        } else {
            parent.join(stem)
        };
        for module in modules {
            excluded.push(module_dir.join(format!("{module}.rs")));
            excluded.push(module_dir.join(&module));
        }
        blanked.push((path.clone(), out));
    }
    blanked
        .into_iter()
        .filter(|(path, _)| !excluded.iter().any(|ex| path == ex || path.starts_with(ex)))
        .map(|(path, lines)| Source {
            path: path
                .strip_prefix(root)
                .expect("under root")
                .to_string_lossy()
                .replace('\\', "/"),
            lines,
        })
        .collect()
}

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn function_name(line: &str) -> Option<String> {
    let mut rest = line.trim_start();
    for prefix in ["pub(crate) ", "pub(super) ", "pub "] {
        if let Some(stripped) = rest.strip_prefix(prefix) {
            rest = stripped;
        }
    }
    for prefix in ["const ", "async ", "unsafe "] {
        if let Some(stripped) = rest.strip_prefix(prefix) {
            rest = stripped;
        }
    }
    let rest = rest.strip_prefix("fn ")?;
    let name: String = rest.chars().take_while(|c| is_ident(*c as u8)).collect();
    (!name.is_empty()).then_some(name)
}

/// Index of the nearest `fn` line at or before `line_index`.
fn enclosing_function(lines: &[String], line_index: usize) -> Option<(usize, String)> {
    (0..=line_index)
        .rev()
        .find_map(|index| function_name(&lines[index]).map(|name| (index, name)))
}

fn function_body(lines: &[String], def_index: usize) -> String {
    let closing = format!("{}}}", " ".repeat(indent_of(&lines[def_index])));
    let mut end = def_index;
    while end + 1 < lines.len() && lines[end].trim_end() != closing {
        end += 1;
    }
    lines[def_index..=end].join("\n")
}

fn previous_word(lower: &str, before: usize) -> (String, usize) {
    let bytes = lower.as_bytes();
    let mut end = before;
    while end > 0 && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && is_ident(bytes[start - 1]) {
        start -= 1;
    }
    (lower[start..end].to_string(), start)
}

fn scan_hits(sources: &[Source]) -> Vec<Hit> {
    let mut hits = Vec::new();
    for source in sources {
        let text = source.lines.join("\n");
        let lower = text.to_ascii_lowercase();
        for table in TABLES {
            let mut from = 0;
            while let Some(found) = lower[from..].find(table) {
                let start = from + found;
                let end = start + table.len();
                from = end;
                let bytes = lower.as_bytes();
                if start > 0 && is_ident(bytes[start - 1]) {
                    continue;
                }
                if end < bytes.len() && is_ident(bytes[end]) {
                    continue;
                }
                let (word, word_start) = previous_word(&lower, start);
                let verb = match word.as_str() {
                    "update" => "UPDATE",
                    "into" => "INSERT",
                    "from" => {
                        let (earlier, _) = previous_word(&lower, word_start);
                        if earlier == "delete" {
                            "DELETE"
                        } else {
                            continue;
                        }
                    }
                    _ => continue,
                };
                let line_index = text[..start].matches('\n').count();
                let (function, def_index) = match enclosing_function(&source.lines, line_index) {
                    Some((index, name)) => (name, Some(index)),
                    None => ("<none>".to_string(), None),
                };
                let statement_end = lower[end..].find('"').map_or(lower.len(), |i| end + i);
                let tail = &lower[end..statement_end];
                let set_text = match tail.find("where") {
                    Some(index) => tail[..index].to_string(),
                    None => tail.to_string(),
                };
                let body = def_index
                    .map(|index| function_body(&source.lines, index))
                    .unwrap_or_default();
                hits.push(Hit {
                    file: source.path.clone(),
                    function,
                    verb_table: format!("{verb} {table}"),
                    set_text,
                    body,
                });
            }
        }
    }
    hits
}

fn tokens(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .collect()
}

fn writes_scope_column(set_text: &str) -> bool {
    let found = tokens(set_text);
    SCOPE_COLUMNS.iter().any(|column| found.contains(*column))
}

/// The column names on the left of each `column = value` of a SET list (the
/// scanned text starts with the `SET` keyword).
fn assignment_columns(set_text: &str) -> BTreeSet<String> {
    let list = set_text.trim();
    let list = list.strip_prefix("set").unwrap_or(list);
    list.split(',')
        .filter_map(|assignment| assignment.split('=').next())
        .map(|column| column.trim().to_owned())
        .filter(|column| !column.is_empty())
        .collect()
}

fn is_dynamic(set_text: &str) -> bool {
    set_text.contains('{')
}

fn writes_version(set_text: &str) -> bool {
    tokens(set_text).contains("version")
}

fn describe(rows: &BTreeMap<(String, String, String), usize>) -> String {
    rows.iter()
        .map(|((file, function, verb_table), count)| {
            format!("    (\"{file}\", \"{function}\", \"{verb_table}\", {count}, ?),")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn count_hits(hits: &[Hit]) -> BTreeMap<(String, String, String), usize> {
    let mut counts = BTreeMap::new();
    for hit in hits {
        *counts
            .entry((
                hit.file.clone(),
                hit.function.clone(),
                hit.verb_table.clone(),
            ))
            .or_insert(0) += 1;
    }
    counts
}

fn manifest_counts() -> BTreeMap<(String, String, String), usize> {
    let mut counts = BTreeMap::new();
    for (file, function, verb_table, count, _) in MANIFEST {
        let key = (
            file.to_string(),
            function.to_string(),
            verb_table.to_string(),
        );
        assert!(
            counts.insert(key, *count).is_none(),
            "duplicate manifest row {file} {function} {verb_table}"
        );
    }
    counts
}

fn class_of(hit: &Hit) -> Class {
    MANIFEST
        .iter()
        .find(|(file, function, verb_table, _, _)| {
            *file == hit.file && *function == hit.function && *verb_table == hit.verb_table
        })
        .map(|row| row.4)
        .expect("manifest row exists after the coverage comparison")
}

fn assert_body_contains(hit: &Hit, needles: &[&str]) {
    for needle in needles {
        assert!(
            hit.body.contains(needle),
            "{} :: {} ({}) must contain `{needle}`",
            hit.file,
            hit.function,
            hit.verb_table
        );
    }
}

#[test]
fn scope_writer_coverage_manifest_is_complete() {
    let root = repo_root();
    let sources = load_production_sources(&root);
    let hits = scan_hits(&sources);

    // (1)(2)(4)(5) The writer set is closed: nothing added, moved or recounted.
    let actual = count_hits(&hits);
    let expected = manifest_counts();
    let missing: BTreeMap<_, _> = expected
        .iter()
        .filter(|(key, count)| actual.get(*key) != Some(*count))
        .map(|(key, count)| (key.clone(), *count))
        .collect();
    let unexpected: BTreeMap<_, _> = actual
        .iter()
        .filter(|(key, count)| expected.get(*key) != Some(*count))
        .map(|(key, count)| (key.clone(), *count))
        .collect();
    assert!(
        missing.is_empty() && unexpected.is_empty(),
        "writer manifest mismatch.\nmanifest rows without a matching scan result:\n{}\nscan results without a matching manifest row:\n{}\n\
         A new writer of narrative_scene_scope_bindings / tree_nodes / codex_entries must be added to MANIFEST \
         with the contract of its class (see the header of this file).",
        describe(&missing),
        describe(&unexpected)
    );

    // Per-class contracts.
    for hit in &hits {
        let class = class_of(hit);
        match class {
            BindingCreate | ProjectRestore | CodexJournalCore | CodexInsertNoReference
            | FolderCreate => {}
            BindingAdvance => assert!(
                hit.verb_table.starts_with("UPDATE") && writes_version(&hit.set_text),
                "{} :: {}: a binding UPDATE must advance `version`",
                hit.file,
                hit.function
            ),
            BindingDeclarationOnly => {
                let written = assignment_columns(&hit.set_text);
                assert_eq!(
                    written,
                    BTreeSet::from([
                        "body_declaration_json".to_owned(),
                        "body_declaration_token".to_owned()
                    ]),
                    "{} :: {}: a declaration UPDATE writes exactly the two declaration columns \
                     (never `version`, `source_token`, `updated_at` or an A1 column)",
                    hit.file,
                    hit.function
                );
            }
            BindingDelete => assert_body_contains(hit, &["DELETE FROM tree_nodes"]),
            TreeDelete => {}
            TreeScopeWriter => assert_body_contains(hit, &["refresh_scene_scope_source_token"]),
            TreeNoScope => assert!(
                !writes_scope_column(&hit.set_text),
                "{} :: {}: a Scope column was added to a writer that does not refresh the Scope generation",
                hit.file,
                hit.function
            ),
            SceneCreate => assert_body_contains(hit, &["ensure_scene_scope_binding_in_tx"]),
            CodexDeleteGuarded => assert_body_contains(
                hit,
                &[
                    "ensure_character_reference_mutation_allowed_in_tx",
                    "scene_ids_with_pov_character_in_tx",
                    "refresh_scene_scope_source_tokens_in_tx",
                ],
            ),
            CodexTypeChangeGuarded => assert_body_contains(
                hit,
                &["ensure_character_reference_mutation_allowed_in_tx"],
            ),
            CodexReinsertInvalidates => assert_body_contains(
                hit,
                &["invalidate_character_references_with_events_in_tx"],
            ),
            CodexNoTypeChange => {
                assert!(
                    !tokens(&hit.set_text).contains("type"),
                    "{} :: {}: writes `type` but is classified as not changing it",
                    hit.file,
                    hit.function
                );
                assert!(
                    !hit.body.contains("\"type = "),
                    "{} :: {}: builds a `type = ` assignment",
                    hit.file,
                    hit.function
                );
            }
        }
    }

    // A statement that writes a Scope column (or builds its SET list at run
    // time without `version`) belongs to a writer that refreshes the Scope
    // generation; a Codex DELETE belongs to a guarded path.
    for hit in &hits {
        let class = class_of(hit);
        if hit.verb_table == "UPDATE tree_nodes"
            && (writes_scope_column(&hit.set_text)
                || (is_dynamic(&hit.set_text) && !writes_version(&hit.set_text)))
        {
            assert_eq!(
                class, TreeScopeWriter,
                "{} :: {} writes a Scope column without refreshing the Scope generation",
                hit.file, hit.function
            );
        }
        if hit.verb_table == "DELETE codex_entries" {
            assert!(
                matches!(
                    class,
                    CodexDeleteGuarded | CodexJournalCore | ProjectRestore
                ),
                "{} :: {} deletes a Codex row outside a guarded path",
                hit.file,
                hit.function
            );
        }
    }

    // A Scene row is deleted together with its binding row: explicit delete in
    // `tree_node_delete_with_authority`, and the foreign key below for the others.
    for hit in hits.iter().filter(|hit| {
        class_of(hit) == BindingDelete && hit.verb_table == "DELETE narrative_scene_scope_bindings"
    }) {
        assert_body_contains(hit, &["DELETE FROM tree_nodes"]);
    }
    for hit in hits.iter().filter(|hit| class_of(hit) == ProjectRestore) {
        if hit.verb_table == "DELETE tree_nodes" {
            assert_body_contains(hit, &["ensure_scene_scope_binding_in_tx"]);
        }
    }
}

#[test]
fn only_w1_and_w2_rewrite_a_scene_without_advancing_version() {
    let root = repo_root();
    let sources = load_production_sources(&root);
    let hits = scan_hits(&sources);

    let unversioned: BTreeSet<(String, String)> = hits
        .iter()
        .filter(|hit| hit.verb_table == "UPDATE tree_nodes" && !writes_version(&hit.set_text))
        .map(|hit| (hit.file.clone(), hit.function.clone()))
        .collect();
    // migrate_tree_nodes_note_context is the one-shot schema migration of the
    // `context_mode` column for notes; it writes no Scene column.
    let expected: BTreeSet<(String, String)> = [
        (
            "src-tauri/crates/grimodex-db/src/domain_writes.rs",
            "tree_node_patch_with_authority",
        ),
        (
            "src-tauri/crates/grimodex-db/src/chronicle_bulk.rs",
            "update_scene_to_state",
        ),
        (
            "src-tauri/crates/grimodex-db/src/migrate.rs",
            "migrate_tree_nodes_note_context",
        ),
    ]
    .into_iter()
    .map(|(file, function)| (file.to_string(), function.to_string()))
    .collect();
    assert_eq!(
        unversioned, expected,
        "a Scene rewrite that does not advance `version` was added or removed: the body Source token \
         `v{{version}}@{{updated_at}}` is only monotonic while such rewrites keep `updated_at` strictly later \
         (T method). Add the guarantee, then update this set."
    );

    // W1: the helper is used by the writer itself.
    let w1 = hits
        .iter()
        .find(|hit| hit.function == "tree_node_patch_with_authority")
        .expect("W1");
    assert_body_contains(w1, &["strictly_later_updated_at("]);

    // W2: `fresh_updated_at` delegates to the same helper, and every caller of
    // `update_scene_to_state` draws the new `updated_at` from it.
    let chronicle = sources
        .iter()
        .find(|source| source.path.ends_with("grimodex-db/src/chronicle_bulk.rs"))
        .expect("chronicle_bulk.rs");
    let def_index = chronicle
        .lines
        .iter()
        .position(|line| function_name(line).as_deref() == Some("fresh_updated_at"))
        .expect("fresh_updated_at");
    assert!(function_body(&chronicle.lines, def_index).contains("strictly_later_updated_at("));
    let mut callers = BTreeSet::new();
    for (index, line) in chronicle.lines.iter().enumerate() {
        if line.contains("update_scene_to_state(") && function_name(line).is_none() {
            let (def, name) = enclosing_function(&chronicle.lines, index).expect("caller fn");
            assert!(
                function_body(&chronicle.lines, def).contains("fresh_updated_at("),
                "{name} calls update_scene_to_state without fresh_updated_at"
            );
            callers.insert(name);
        }
    }
    assert_eq!(
        callers.len(),
        2,
        "unexpected update_scene_to_state callers: {callers:?}"
    );
}

#[test]
fn undo_journal_core_is_reached_only_through_the_j1_guard() {
    let root = repo_root();
    let sources = load_production_sources(&root);
    let mut callers = BTreeSet::new();
    for source in &sources {
        for (index, line) in source.lines.iter().enumerate() {
            for callee in ["revert_undo_journal_in_tx(", "apply_undo_journal_in_tx("] {
                if line.contains(callee) && function_name(line).is_none() {
                    let (_, name) = enclosing_function(&source.lines, index).expect("caller fn");
                    callers.insert((source.path.clone(), name, callee.to_string()));
                }
            }
        }
    }
    let expected: BTreeSet<(String, String, String)> =
        ["revert_undo_journal_in_tx(", "apply_undo_journal_in_tx("]
            .into_iter()
            .map(|callee| {
                (
                    "src-tauri/crates/grimodex-db/src/agent_writes.rs".to_string(),
                    "replay_undo_journal_via_core_in_tx".to_string(),
                    callee.to_string(),
                )
            })
            .collect();
    assert_eq!(
        callers, expected,
        "the core undo journal revert/apply may only run inside the J1 guard"
    );

    let agent = sources
        .iter()
        .find(|source| source.path.ends_with("grimodex-db/src/agent_writes.rs"))
        .expect("agent_writes.rs");
    let def = agent
        .lines
        .iter()
        .position(|line| {
            function_name(line).as_deref() == Some("replay_undo_journal_via_core_in_tx")
        })
        .expect("guard fn");
    let body = function_body(&agent.lines, def);
    for needle in [
        "ensure_character_reference_mutation_allowed_in_tx",
        "invalidate_character_references_with_events_in_tx",
        "scene_ids_with_pov_character_in_tx",
        "refresh_scene_scope_source_tokens_in_tx",
    ] {
        assert!(body.contains(needle), "J1 guard must contain {needle}");
    }
    // The guard itself is only called from the journal entry point.
    let mut guard_callers = BTreeSet::new();
    for (index, line) in agent.lines.iter().enumerate() {
        if line.contains("replay_undo_journal_via_core_in_tx(") && function_name(line).is_none() {
            guard_callers.insert(enclosing_function(&agent.lines, index).expect("fn").1);
        }
    }
    assert_eq!(
        guard_callers,
        BTreeSet::from(["agent_undo_journal_impl".to_string()])
    );
}

/// `column -> foreign key clause` of a `CREATE TABLE IF NOT EXISTS <table> (` block.
fn foreign_keys(migrate: &str, table: &str) -> BTreeMap<String, String> {
    let header = format!("CREATE TABLE IF NOT EXISTS {table} (");
    let mut keys = BTreeMap::new();
    let mut in_table = false;
    let mut last_column = String::new();
    for line in migrate.lines() {
        let trimmed = line.trim();
        if !in_table {
            if trimmed == header {
                in_table = true;
            }
            continue;
        }
        if trimmed.starts_with(");") || trimmed.starts_with(")\"") {
            break;
        }
        let mut words = trimmed.split_whitespace();
        let first = words.next().unwrap_or("");
        let second = words.next().unwrap_or("");
        let is_column_line = first
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            && second
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_uppercase());
        if is_column_line {
            last_column = first.to_string();
        }
        if let Some(index) = trimmed.find("REFERENCES ") {
            let clause = trimmed[index + "REFERENCES ".len()..]
                .trim_end_matches(',')
                .to_string();
            keys.insert(last_column.clone(), clause);
        }
    }
    keys
}

#[test]
fn foreign_key_actions_that_change_scope_columns_are_pinned() {
    let root = repo_root();
    let migrate = fs::read_to_string(root.join("src-tauri/crates/grimodex-db/src/migrate.rs"))
        .expect("migrate.rs");

    let tree = foreign_keys(&migrate, "tree_nodes");
    assert_eq!(
        tree.get("parent_id").map(String::as_str),
        Some("tree_nodes(id) ON DELETE CASCADE"),
        "deleting a parent removes its descendants: their bindings go with them"
    );
    assert_eq!(
        tree.get("pov_character_id").map(String::as_str),
        Some("codex_entries(id) ON DELETE SET NULL"),
        "deleting a character NULLs the POV; the delete paths advance the Scene generation"
    );
    assert_eq!(
        tree.get("location_id").map(String::as_str),
        Some("codex_entries(id) ON DELETE SET NULL"),
        "location NULLing is outside the Scope list (proposal Delta 1 (iii))"
    );
    assert_eq!(
        tree.len(),
        4,
        "unexpected tree_nodes foreign keys: {tree:?}"
    );

    let bindings = foreign_keys(&migrate, "narrative_scene_scope_bindings");
    assert_eq!(
        bindings.get("scene_id").map(String::as_str),
        Some("tree_nodes(id) ON DELETE CASCADE")
    );
    assert_eq!(
        bindings.get("project_id").map(String::as_str),
        Some("projects(id) ON DELETE CASCADE")
    );
    assert_eq!(
        bindings.len(),
        2,
        "unexpected binding foreign keys: {bindings:?}"
    );
}

#[test]
fn scanner_skips_test_items_and_non_write_statements() {
    let source = [
        "fn production(conn: &Conn) {",
        "    conn.execute(\"UPDATE tree_nodes",
        "        SET title = ?1 WHERE id = ?2\", []);",
        "    conn.query(\"SELECT id FROM tree_nodes WHERE id = ?1\", []);",
        "    // UPDATE tree_nodes SET sort_order = 'x'",
        "}",
        "#[cfg(test)]",
        "mod tests {",
        "    fn fixture() {",
        "        conn.execute(\"DELETE FROM tree_nodes\", []);",
        "    }",
        "}",
        "#[cfg(test)]",
        "mod other_tests;",
    ]
    .map(str::to_string);
    let mut blanked = Vec::new();
    let modules = blank_test_items(&source, &mut blanked);
    assert_eq!(modules, vec!["other_tests".to_string()]);
    let hits = scan_hits(&[Source {
        path: "x.rs".to_string(),
        lines: blanked,
    }]);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].function, "production");
    assert_eq!(hits[0].verb_table, "UPDATE tree_nodes");
    assert!(!writes_scope_column(&hits[0].set_text));
    assert!(writes_scope_column(" sort_order = ?1 "));
    assert!(writes_version("title = ?1, version = version + 1"));
}
