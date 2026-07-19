use grimodex_db::web_editor_handoff::{
    import_web_editor_workspace, WEB_EDITOR_HANDOFF_SCHEMA_VERSION,
};
use grimodex_db::{Database, GlobalSettingsPath};
use rusqlite::Connection;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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

fn browser_database(root: &Path, project_id: &str, title: &str) -> Vec<u8> {
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
