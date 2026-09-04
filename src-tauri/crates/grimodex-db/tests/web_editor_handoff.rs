use grimodex_db::narrative_extraction::{
    C2_ZC_CUTOVER_CONTRACT_VERSION, C2_ZC_CUTOVER_MIGRATION_ID,
};
use grimodex_db::protected_writers::bundled_protected_writer_registry;
use grimodex_db::web_editor_handoff::{
    import_web_editor_workspace, WEB_EDITOR_HANDOFF_SCHEMA_VERSION,
};
use grimodex_db::{Database, GlobalSettingsPath};
use rusqlite::Connection;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const RUST_ONLY_BROWSER_TABLES: &[&str] = &[
    "chat_message_chunks",
    "event_chunks",
    "fts_meta",
    "codex_fts",
    "codex_fts_en",
    "snippets_fts",
    "snippets_fts_en",
    "chat_messages_fts",
    "chat_messages_fts_en",
    "tree_nodes_fts",
    "tree_nodes_fts_en",
    "post_effect_annotations_fts",
    "post_effect_annotations_fts_en",
    "undo_journal",
];

fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "grimodex-web-handoff-{label}-{}-{nanos}",
        std::process::id()
    ))
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        output.push(TABLE[(a >> 2) as usize] as char);
        output.push(TABLE[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(c & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn malformed_database(root: &Path, project_id: &str, title: &str) -> Vec<u8> {
    std::fs::create_dir_all(root).expect("source dir");
    let path = root.join("browser.db");
    let conn = Connection::open(&path).expect("source sqlite");
    conn.execute_batch(
        "CREATE TABLE projects (
             id TEXT PRIMARY KEY,
             title TEXT NOT NULL,
             language TEXT NOT NULL DEFAULT 'ja',
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );",
    )
    .expect("source schema");
    conn.execute(
        "INSERT INTO projects (id, title, language, created_at, updated_at)
         VALUES (?1, ?2, 'ja', '2026-07-19T00:00:00Z', '2026-07-19T00:00:00Z')",
        rusqlite::params![project_id, title],
    )
    .expect("source project");
    drop(conn);
    std::fs::read(path).expect("source bytes")
}

fn browser_database(root: &Path, project_id: &str, title: &str) -> Vec<u8> {
    std::fs::create_dir_all(root).expect("source dir");
    let path = root.join("browser.db");
    let db = Database::new(&path).expect("source sqlite");
    db.migrate().expect("source schema");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title, language, created_at, updated_at)
             VALUES (?1, ?2, 'ja', '2026-07-19T00:00:00Z', '2026-07-19T00:00:00Z')",
            rusqlite::params![project_id, title],
        )?;
        Ok(())
    })
    .expect("source project");
    db.with_conn(|conn| {
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        for table in RUST_ONLY_BROWSER_TABLES {
            conn.execute_batch(&format!("DROP TABLE IF EXISTS \"{table}\";"))?;
        }
        // BrowserMock creates the renderer table subset directly and does not
        // stamp Rust's user_version. Import must add the native-only schema.
        conn.pragma_update(None, "user_version", 0)?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        Ok(())
    })
    .expect("shape browser schema");
    drop(db);
    std::fs::read(path).expect("source bytes")
}

fn mutate_browser_database(
    root: &Path,
    project_id: &str,
    title: &str,
    mutate: impl FnOnce(&Connection) -> rusqlite::Result<()>,
) -> Vec<u8> {
    let _database = browser_database(root, project_id, title);
    let path = root.join("browser.db");
    let conn = Connection::open(&path).expect("open browser database for mutation");
    mutate(&conn).expect("mutate browser database fixture");
    drop(conn);
    std::fs::read(path).expect("mutated source bytes")
}

fn handoff_json(database: &[u8], project_id: &str, title: &str) -> String {
    json!({
        "schemaVersion": WEB_EDITOR_HANDOFF_SCHEMA_VERSION,
        "encoding": "base64",
        "databaseBase64": encode_base64(database),
        "createdAt": "2026-07-19T03:04:05.000Z",
        "sourceMode": "scan",
        "uiLanguage": "ja",
        "projectId": project_id,
        "title": title,
    })
    .to_string()
}

fn settings_path(root: &Path) -> GlobalSettingsPath {
    GlobalSettingsPath {
        path: root.join("global-settings.json"),
        write_lock: Mutex::new(()),
    }
}

fn unpublished_workspace_count(root: &Path) -> usize {
    std::fs::read_dir(root)
        .expect("root entries")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("web-editor-workspace-")
        })
        .count()
}

#[test]
fn imports_a_browser_database_as_a_new_migrated_workspace() {
    let root = temp_dir("success");
    let source = browser_database(&root.join("source"), "web-project", "White Lighthouse");
    let result = import_web_editor_workspace(
        &settings_path(&root),
        &handoff_json(&source, "web-project", "White Lighthouse"),
    )
    .expect("valid handoff");

    assert_eq!(result.project_id, "web-project");
    let workspace = PathBuf::from(&result.path);
    assert!(workspace.join("grimodex.db").is_file());
    assert!(workspace.join(".grimodex/workspace.json").is_file());

    let db = Database::new(&workspace.join("grimodex.db")).expect("open imported db");
    db.migrate().expect("import is current");
    let title = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT title FROM projects WHERE id = ?1",
                ["web-project"],
                |row| row.get::<_, String>(0),
            )?)
        })
        .expect("project title");
    assert_eq!(title, "White Lighthouse");

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn imports_non_empty_timelapse_tables_and_preserves_rows() {
    let root = temp_dir("timelapse-preservation");
    let source = mutate_browser_database(
        &root.join("source"),
        "web-project",
        "White Lighthouse",
        |conn| {
            conn.execute(
                "INSERT INTO change_events
                    (event_uid, project_id, scene_id, domain, op_type,
                     entity_type, entity_id, payload, session_id, sequence,
                     timestamp, prev_hash, hash)
                 VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                rusqlite::params![
                    "event-web-timelapse",
                    "web-project",
                    "editor",
                    "doc.step",
                    "scene",
                    "scene-web",
                    r#"{"content":"typed event"}"#,
                    "browser-session",
                    7,
                    1_700_000_000_000_i64,
                    "0000000000000000000000000000000000000000000000000000000000000000",
                    "1111111111111111111111111111111111111111111111111111111111111111",
                ],
            )?;
            conn.execute(
                "INSERT INTO state_snapshots
                    (project_id, domain, entity_type, entity_id,
                     anchor_sequence, anchor_timestamp, payload, encoding,
                     created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    "web-project",
                    "editor",
                    "scene",
                    "scene-web",
                    7,
                    1_700_000_000_000_i64,
                    r#"{"type":"doc","content":[]}"#,
                    "json",
                    1_700_000_000_000_i64,
                ],
            )?;
            Ok(())
        },
    );
    let result = import_web_editor_workspace(
        &settings_path(&root),
        &handoff_json(&source, "web-project", "White Lighthouse"),
    )
    .expect("non-empty lossless timelapse rows must cross the handoff boundary");

    let db =
        Database::new(&PathBuf::from(&result.path).join("grimodex.db")).expect("open imported db");
    let preserved = db
        .with_conn(|conn| {
            let event = conn.query_row(
                "SELECT project_id, domain, op_type, entity_type, entity_id,
                        payload, session_id, sequence, timestamp, prev_hash, hash
                 FROM change_events WHERE event_uid = ?1",
                ["event-web-timelapse"],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )?;
            let snapshot = conn.query_row(
                "SELECT project_id, domain, entity_type, entity_id,
                        anchor_sequence, anchor_timestamp, payload, encoding,
                        created_at
                 FROM state_snapshots
                 WHERE project_id = ?1 AND entity_id = ?2",
                ["web-project", "scene-web"],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, i64>(8)?,
                    ))
                },
            )?;
            Ok((event, snapshot))
        })
        .expect("timelapse rows preserved");

    assert_eq!(
        preserved.0,
        (
            "web-project".to_owned(),
            "editor".to_owned(),
            "doc.step".to_owned(),
            "scene".to_owned(),
            "scene-web".to_owned(),
            r#"{"content":"typed event"}"#.to_owned(),
            "browser-session".to_owned(),
            7,
            1_700_000_000_000_i64,
            "0000000000000000000000000000000000000000000000000000000000000000".to_owned(),
            "1111111111111111111111111111111111111111111111111111111111111111".to_owned(),
        )
    );
    assert_eq!(
        preserved.1,
        (
            "web-project".to_owned(),
            "editor".to_owned(),
            "scene".to_owned(),
            "scene-web".to_owned(),
            7,
            1_700_000_000_000_i64,
            r#"{"type":"doc","content":[]}"#.to_owned(),
            "json".to_owned(),
            1_700_000_000_000_i64,
        )
    );

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn rejects_non_sqlite_and_manifest_project_mismatches_without_publishing() {
    let root = temp_dir("reject");
    std::fs::create_dir_all(&root).expect("root");
    let settings = settings_path(&root);

    let invalid = import_web_editor_workspace(
        &settings,
        &handoff_json(b"not sqlite", "web-project", "White Lighthouse"),
    )
    .expect_err("invalid sqlite must fail");
    assert!(invalid.to_string().contains("SQLite"));

    let source = browser_database(&root.join("source"), "actual-project", "Actual");
    let mismatch = import_web_editor_workspace(
        &settings,
        &handoff_json(&source, "different-project", "Actual"),
    )
    .expect_err("manifest mismatch must fail");
    assert!(mismatch.to_string().contains("project"));

    let malformed = malformed_database(
        &root.join("malformed-source"),
        "web-project",
        "White Lighthouse",
    );
    let malformed_schema = import_web_editor_workspace(
        &settings,
        &handoff_json(&malformed, "web-project", "White Lighthouse"),
    )
    .expect_err("incomplete canonical tables must fail");
    assert!(malformed_schema.to_string().contains("schema"));

    let published = std::fs::read_dir(&root)
        .expect("root entries")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("web-editor-workspace-")
        })
        .count();
    assert_eq!(published, 0);

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn rejects_unicode_control_characters_at_the_native_boundary() {
    let root = temp_dir("control-title");
    let source = browser_database(&root.join("source"), "web-project", "White Lighthouse");
    let handoff = handoff_json(&source, "web-project", "White\u{0085}Lighthouse");

    let error = import_web_editor_workspace(&settings_path(&root), &handoff)
        .expect_err("Unicode control characters must be rejected");

    assert!(error.to_string().contains("title"));
    let published = std::fs::read_dir(&root)
        .expect("root entries")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("web-editor-workspace-")
        })
        .count();
    assert_eq!(published, 0);

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn rejects_current_future_and_foreign_c2zc_cutover_markers_before_publishing() {
    let markers = [
        (
            "current",
            C2_ZC_CUTOVER_MIGRATION_ID,
            C2_ZC_CUTOVER_CONTRACT_VERSION,
        ),
        (
            "future",
            C2_ZC_CUTOVER_MIGRATION_ID,
            C2_ZC_CUTOVER_CONTRACT_VERSION + 1,
        ),
        (
            "foreign",
            "narrative-c2-canonical-freshness-foreign",
            C2_ZC_CUTOVER_CONTRACT_VERSION,
        ),
    ];

    for (label, migration_id, contract_version) in markers {
        let root = temp_dir(&format!("marker-{label}"));
        let source = mutate_browser_database(
            &root.join("source"),
            "web-project",
            "White Lighthouse",
            |conn| {
                conn.execute(
                    "DELETE FROM schema_data_migrations
                      WHERE migration_id LIKE 'narrative-c2-canonical-freshness-%'",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO schema_data_migrations
                        (migration_id, contract_version, applied_at)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![migration_id, contract_version, "2026-07-19T03:04:05.000Z"],
                )?;
                Ok(())
            },
        );

        let error = import_web_editor_workspace(
            &settings_path(&root),
            &handoff_json(&source, "web-project", "White Lighthouse"),
        )
        .expect_err("C2-ZC marker must never cross the Web Editor boundary");
        let message = error.to_string();
        assert!(
            message.contains("NEX_C2ZC_WEB_EDITOR_HANDOFF_MARKER_REJECTED"),
            "{label}: unexpected error: {message}"
        );
        assert!(
            message.contains("schema_data_migrations"),
            "{label}: {message}"
        );
        assert_eq!(unpublished_workspace_count(&root), 0, "{label}");

        std::fs::remove_dir_all(root).ok();
    }
}

#[test]
fn rejects_non_empty_semantic_epoch_before_publishing_and_cleans_candidate() {
    let root = temp_dir("semantic-epoch");
    let source = mutate_browser_database(
        &root.join("source"),
        "web-project",
        "White Lighthouse",
        |conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "epoch-web-import",
                    "web-project",
                    0,
                    "initial",
                    "2026-07-19T03:04:05.000Z"
                ],
            )?;
            Ok(())
        },
    );

    let error = import_web_editor_workspace(
        &settings_path(&root),
        &handoff_json(&source, "web-project", "White Lighthouse"),
    )
    .expect_err("native-owned Semantic Epoch must never cross the Web Editor boundary");
    let message = error.to_string();
    assert!(
        message.contains("NEX_C2ZC_WEB_EDITOR_HANDOFF_AUTHORITY_REJECTED"),
        "unexpected error: {message}"
    );
    assert!(message.contains("narrative_semantic_epochs"), "{message}");
    assert_eq!(unpublished_workspace_count(&root), 0);

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn rejects_empty_poisoned_schema_data_migrations_before_publishing() {
    let root = temp_dir("poisoned-marker-schema");
    let source = mutate_browser_database(
        &root.join("source"),
        "web-project",
        "White Lighthouse",
        |conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = OFF;
                 DROP TABLE schema_data_migrations;
                 CREATE TABLE schema_data_migrations (
                     migration_id TEXT NOT NULL,
                     contract_version INTEGER NOT NULL
                         CHECK(contract_version > 0 AND contract_version <= 1000),
                     applied_at TEXT NOT NULL,
                     PRIMARY KEY(migration_id)
                 );
                 PRAGMA foreign_keys = ON;",
            )?;
            Ok(())
        },
    );

    let error = import_web_editor_workspace(
        &settings_path(&root),
        &handoff_json(&source, "web-project", "White Lighthouse"),
    )
    .expect_err("poisoned marker schema must never be trusted after migration");
    let message = error.to_string();
    assert!(
        message.contains("NEX_C2ZC_WEB_EDITOR_HANDOFF_SCHEMA_REJECTED"),
        "unexpected error: {message}"
    );
    assert!(message.contains("schema_data_migrations"), "{message}");
    assert_eq!(unpublished_workspace_count(&root), 0);

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn rejects_empty_poisoned_semantic_epoch_schema_before_publishing() {
    let root = temp_dir("poisoned-epoch-schema");
    let source = mutate_browser_database(
        &root.join("source"),
        "web-project",
        "White Lighthouse",
        |conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = OFF;
                 DROP TABLE narrative_semantic_epochs;
                 CREATE TABLE narrative_semantic_epochs (
                     id TEXT NOT NULL COLLATE NOCASE,
                     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                     epoch_number INTEGER NOT NULL CHECK(epoch_number >= 0),
                     reason TEXT NOT NULL
                         CHECK(reason IN ('initial','restore','migration','integrity-repair','manual-rebuild')),
                     triggered_by_change_event_uid TEXT,
                     created_at TEXT NOT NULL,
                     PRIMARY KEY(id),
                     UNIQUE(project_id, epoch_number)
                 );
                 PRAGMA foreign_keys = ON;",
            )?;
            Ok(())
        },
    );

    let error = import_web_editor_workspace(
        &settings_path(&root),
        &handoff_json(&source, "web-project", "White Lighthouse"),
    )
    .expect_err("poisoned Semantic Epoch schema must never be trusted after migration");
    let message = error.to_string();
    assert!(
        message.contains("NEX_C2ZC_WEB_EDITOR_HANDOFF_SCHEMA_REJECTED"),
        "unexpected error: {message}"
    );
    assert!(message.contains("narrative_semantic_epochs"), "{message}");
    assert_eq!(unpublished_workspace_count(&root), 0);

    std::fs::remove_dir_all(root).ok();
}

#[test]
fn c2zc_native_owned_registry_has_the_exact_authority_finding_and_repair_tables() {
    let registry = bundled_protected_writer_registry();
    let tables = registry
        .c2zc_web_editor_handoff_rejected_entries()
        .map(|entry| entry.table.as_str())
        .collect::<Vec<_>>();

    assert_eq!(tables.len(), 9);
    assert_eq!(
        tables,
        vec![
            "narrative_consumer_freshness",
            "narrative_dependency_edge_states",
            "narrative_dependency_edges",
            "narrative_extraction_runs",
            "narrative_maintenance_finding_lifecycle",
            "narrative_maintenance_finding_observations",
            "narrative_maintenance_repair_leases",
            "narrative_semantic_epochs",
            "narrative_semantic_index_metadata",
        ]
    );
}
