use rusqlite::{params_from_iter, Connection};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn migrate(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chapters (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title       TEXT NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS scenes (
                id          TEXT PRIMARY KEY,
                chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
                title       TEXT NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0,
                synopsis    TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS codex_entries (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                type                    TEXT NOT NULL,
                name                    TEXT NOT NULL,
                summary                 TEXT NOT NULL DEFAULT '',
                content                 TEXT NOT NULL DEFAULT '',
                tags                    TEXT NOT NULL DEFAULT '',
                source_chat_message_id  TEXT,
                source                  TEXT NOT NULL DEFAULT 'human',
                created_at              TEXT NOT NULL,
                updated_at              TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS snippets (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                title                   TEXT NOT NULL,
                content                 TEXT NOT NULL DEFAULT '',
                tags                    TEXT NOT NULL DEFAULT '',
                scene_id                TEXT,
                source_chat_message_id  TEXT,
                source                  TEXT NOT NULL DEFAULT 'human',
                original_content        TEXT,
                created_at              TEXT NOT NULL
            );

            -- FTS5 full-text search indexes (trigram tokenizer for Japanese)
            CREATE VIRTUAL TABLE IF NOT EXISTS codex_entries_fts USING fts5(
                name, summary, content, tags,
                tokenize='trigram'
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS snippets_fts USING fts5(
                title, content, tags,
                tokenize='trigram'
            );

            -- Triggers to keep FTS indexes in sync
            CREATE TRIGGER IF NOT EXISTS codex_entries_ai AFTER INSERT ON codex_entries BEGIN
                INSERT INTO codex_entries_fts(rowid, name, summary, content, tags)
                VALUES (new.id, new.name, new.summary, new.content, new.tags);
            END;
            CREATE TRIGGER IF NOT EXISTS codex_entries_ad AFTER DELETE ON codex_entries BEGIN
                DELETE FROM codex_entries_fts WHERE rowid = old.id;
            END;
            CREATE TRIGGER IF NOT EXISTS codex_entries_au AFTER UPDATE ON codex_entries BEGIN
                DELETE FROM codex_entries_fts WHERE rowid = old.id;
                INSERT INTO codex_entries_fts(rowid, name, summary, content, tags)
                VALUES (new.id, new.name, new.summary, new.content, new.tags);
            END;

            CREATE TRIGGER IF NOT EXISTS snippets_ai AFTER INSERT ON snippets BEGIN
                INSERT INTO snippets_fts(rowid, title, content, tags)
                VALUES (new.id, new.title, new.content, new.tags);
            END;
            CREATE TRIGGER IF NOT EXISTS snippets_ad AFTER DELETE ON snippets BEGIN
                DELETE FROM snippets_fts WHERE rowid = old.id;
            END;
            CREATE TRIGGER IF NOT EXISTS snippets_au AFTER UPDATE ON snippets BEGIN
                DELETE FROM snippets_fts WHERE rowid = old.id;
                INSERT INTO snippets_fts(rowid, title, content, tags)
                VALUES (new.id, new.title, new.content, new.tags);
            END;

            CREATE TABLE IF NOT EXISTS chat_threads (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                scene_id    TEXT REFERENCES scenes(id) ON DELETE CASCADE,
                created_at  TEXT NOT NULL,
                modified_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                id          TEXT PRIMARY KEY,
                thread_id   TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
                role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                content     TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );

            -- Triggers to nullify orphaned references on deletion
            CREATE TRIGGER IF NOT EXISTS nullify_codex_source_on_msg_delete
            AFTER DELETE ON chat_messages BEGIN
                UPDATE codex_entries SET source_chat_message_id = NULL
                WHERE source_chat_message_id = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS nullify_snippet_source_on_msg_delete
            AFTER DELETE ON chat_messages BEGIN
                UPDATE snippets SET source_chat_message_id = NULL
                WHERE source_chat_message_id = old.id;
            END;

            CREATE TRIGGER IF NOT EXISTS nullify_snippet_scene_on_scene_delete
            AFTER DELETE ON scenes BEGIN
                UPDATE snippets SET scene_id = NULL
                WHERE scene_id = old.id;
            END;

            CREATE TABLE IF NOT EXISTS authorship_spans (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                scene_id        TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
                offset_start    INTEGER NOT NULL,
                offset_end      INTEGER NOT NULL,
                source          TEXT NOT NULL CHECK(source IN ('human','ai','unknown')),
                trace_id        TEXT,
                model           TEXT,
                ai_message_id   TEXT,
                manual_override INTEGER NOT NULL DEFAULT 0,
                content_hash    TEXT,
                tool_name       TEXT,
                tool_version    TEXT,
                created_at      TEXT NOT NULL
            );

            -- Seed default project + chapter so scenes can reference chapter_id=1
            INSERT OR IGNORE INTO projects (id, title, description, created_at, updated_at)
              VALUES (1, '無題のプロジェクト', '', datetime('now'), datetime('now'));
            INSERT OR IGNORE INTO chapters (id, project_id, title, sort_order, created_at, updated_at)
              VALUES (1, 1, '第1章', 0, datetime('now'), datetime('now'));",
        )?;

        // Incremental migrations gated by PRAGMA user_version
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if version < 1 {
            // v1: Add source/original_content to snippets & codex_entries,
            //     migrate authorship_spans 'snippet' → 'ai'
            //
            // ALTER TABLE ADD COLUMN is a no-op error if the column already
            // exists (new databases have them in the CREATE TABLE).  We
            // ignore the error per-statement so we can re-run safely.
            let alter_stmts = [
                "ALTER TABLE snippets ADD COLUMN source TEXT NOT NULL DEFAULT 'human'",
                "ALTER TABLE snippets ADD COLUMN original_content TEXT",
                "ALTER TABLE codex_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'human'",
            ];
            for stmt in &alter_stmts {
                // Ignore "duplicate column name" errors
                let _ = conn.execute(stmt, []);
            }

            conn.execute_batch(
                "UPDATE snippets SET source = 'ai'
                   WHERE source_chat_message_id IS NOT NULL AND source = 'human';
                 UPDATE snippets SET original_content = content
                   WHERE source_chat_message_id IS NOT NULL AND original_content IS NULL;
                 UPDATE codex_entries SET source = 'ai'
                   WHERE source_chat_message_id IS NOT NULL AND source = 'human';
                 UPDATE authorship_spans SET source = 'ai'
                   WHERE source = 'snippet';
                 PRAGMA user_version = 1;",
            )?;
        }

        Ok(())
    }

    pub fn execute(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;

        let native_params: Vec<Box<dyn rusqlite::types::ToSql>> = params
            .iter()
            .map(|v| -> Box<dyn rusqlite::types::ToSql> {
                match v {
                    Value::Null => Box::new(Option::<String>::None),
                    Value::Bool(b) => Box::new(*b),
                    Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            Box::new(i)
                        } else {
                            Box::new(n.as_f64().unwrap_or(0.0))
                        }
                    }
                    Value::String(s) => Box::new(s.clone()),
                    _ => Box::new(v.to_string()),
                }
            })
            .collect();

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            native_params.iter().map(|p| p.as_ref()).collect();

        match method {
            "run" => {
                conn.execute(sql, params_from_iter(param_refs.iter()))?;
                Ok(vec![])
            }
            _ => {
                // "all" or "get"
                let mut stmt = conn.prepare(sql)?;
                let column_names: Vec<String> = stmt
                    .column_names()
                    .iter()
                    .map(|s| s.to_string())
                    .collect();

                let rows = stmt.query_map(params_from_iter(param_refs.iter()), |row| {
                    let mut map = serde_json::Map::new();
                    for (i, col_name) in column_names.iter().enumerate() {
                        let val: Value = match row.get_ref(i) {
                            Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                            Ok(rusqlite::types::ValueRef::Integer(n)) => {
                                Value::Number(n.into())
                            }
                            Ok(rusqlite::types::ValueRef::Real(f)) => {
                                Value::Number(
                                    serde_json::Number::from_f64(f)
                                        .unwrap_or_else(|| 0.into()),
                                )
                            }
                            Ok(rusqlite::types::ValueRef::Text(s)) => {
                                Value::String(
                                    String::from_utf8_lossy(s).to_string(),
                                )
                            }
                            Ok(rusqlite::types::ValueRef::Blob(b)) => {
                                Value::String(format!("[blob {} bytes]", b.len()))
                            }
                            Err(_) => Value::Null,
                        };
                        map.insert(col_name.clone(), val);
                    }
                    Ok(map)
                })?;

                let mut result = Vec::new();
                for row in rows {
                    result.push(row?);
                }

                if method == "get" {
                    return Ok(result.into_iter().take(1).collect());
                }

                Ok(result)
            }
        }
    }
    pub fn integrity_check(&self) -> anyhow::Result<serde_json::Map<String, serde_json::Value>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut report = serde_json::Map::new();

        let orphaned_codex_sources: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_entries WHERE source_chat_message_id IS NOT NULL AND source_chat_message_id NOT IN (SELECT id FROM chat_messages)",
            [],
            |row| row.get(0),
        )?;
        report.insert("orphanedCodexSources".into(), orphaned_codex_sources.into());

        let orphaned_snippet_sources: i64 = conn.query_row(
            "SELECT COUNT(*) FROM snippets WHERE source_chat_message_id IS NOT NULL AND source_chat_message_id NOT IN (SELECT id FROM chat_messages)",
            [],
            |row| row.get(0),
        )?;
        report.insert("orphanedSnippetSources".into(), orphaned_snippet_sources.into());

        let orphaned_snippet_scenes: i64 = conn.query_row(
            "SELECT COUNT(*) FROM snippets WHERE scene_id IS NOT NULL AND scene_id NOT IN (SELECT id FROM scenes)",
            [],
            |row| row.get(0),
        )?;
        report.insert("orphanedSnippetScenes".into(), orphaned_snippet_scenes.into());

        Ok(report)
    }

    pub fn repair_integrity(&self) -> anyhow::Result<serde_json::Map<String, serde_json::Value>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut report = serde_json::Map::new();

        let codex_fixed = conn.execute(
            "UPDATE codex_entries SET source_chat_message_id = NULL WHERE source_chat_message_id IS NOT NULL AND source_chat_message_id NOT IN (SELECT id FROM chat_messages)",
            [],
        )?;
        report.insert("codexSourcesFixed".into(), (codex_fixed as i64).into());

        let snippet_sources_fixed = conn.execute(
            "UPDATE snippets SET source_chat_message_id = NULL WHERE source_chat_message_id IS NOT NULL AND source_chat_message_id NOT IN (SELECT id FROM chat_messages)",
            [],
        )?;
        report.insert("snippetSourcesFixed".into(), (snippet_sources_fixed as i64).into());

        let snippet_scenes_fixed = conn.execute(
            "UPDATE snippets SET scene_id = NULL WHERE scene_id IS NOT NULL AND scene_id NOT IN (SELECT id FROM scenes)",
            [],
        )?;
        report.insert("snippetScenesFixed".into(), (snippet_scenes_fixed as i64).into());

        Ok(report)
    }

    pub fn fts_optimize(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        conn.execute_batch(
            "INSERT INTO codex_entries_fts(codex_entries_fts) VALUES('optimize');
             INSERT INTO snippets_fts(snippets_fts) VALUES('optimize');",
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db
    }

    #[test]
    fn test_migrate_creates_projects_table() {
        let db = test_db();
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'",
                &[],
                "all",
            )
            .expect("query");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_crud_projects() {
        let db = test_db();

        // Create
        db.execute(
            "INSERT INTO projects (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
            &[
                Value::String("Test Novel".into()),
                Value::String("A test description".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        // Read all (includes seed project)
        let rows = db
            .execute("SELECT * FROM projects", &[], "all")
            .expect("select all");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["title"], Value::String("Test Novel".into()));

        // Read one (test-inserted project gets id=2 since seed has id=1)
        let rows = db
            .execute(
                "SELECT * FROM projects WHERE id = ?",
                &[Value::Number(2.into())],
                "get",
            )
            .expect("select one");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], Value::Number(2.into()));

        // Update
        db.execute(
            "UPDATE projects SET title = ?, updated_at = ? WHERE id = ?",
            &[
                Value::String("Updated Novel".into()),
                Value::String("2025-06-01T00:00:00Z".into()),
                Value::Number(2.into()),
            ],
            "run",
        )
        .expect("update");

        let rows = db
            .execute(
                "SELECT * FROM projects WHERE id = ?",
                &[Value::Number(2.into())],
                "get",
            )
            .expect("select after update");
        assert_eq!(rows[0]["title"], Value::String("Updated Novel".into()));

        // Delete
        db.execute(
            "DELETE FROM projects WHERE id = ?",
            &[Value::Number(2.into())],
            "run",
        )
        .expect("delete");

        let rows = db
            .execute("SELECT * FROM projects", &[], "all")
            .expect("select after delete");
        assert_eq!(rows.len(), 1); // seed project remains
    }

    #[test]
    fn test_migrate_creates_chapters_table() {
        let db = test_db();
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='chapters'",
                &[],
                "all",
            )
            .expect("query");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_migrate_creates_scenes_table() {
        let db = test_db();
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='scenes'",
                &[],
                "all",
            )
            .expect("query");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_crud_chapters() {
        let db = test_db();

        // Create project first (FK)
        db.execute(
            "INSERT INTO projects (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
            &[
                Value::String("Novel".into()),
                Value::String("".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert project");

        // Create chapter (project_id=2 is the test project; seed has id=1)
        db.execute(
            "INSERT INTO chapters (project_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::Number(2.into()),
                Value::String("Chapter 1".into()),
                Value::Number(0.into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert chapter");

        let rows = db
            .execute(
                "SELECT * FROM chapters WHERE project_id = ?",
                &[Value::Number(2.into())],
                "all",
            )
            .expect("select chapters");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("Chapter 1".into()));

        // Update (test chapter gets id=2 since seed chapter has id=1)
        db.execute(
            "UPDATE chapters SET title = ? WHERE id = ?",
            &[
                Value::String("Renamed Chapter".into()),
                Value::Number(2.into()),
            ],
            "run",
        )
        .expect("update chapter");

        let rows = db
            .execute(
                "SELECT * FROM chapters WHERE id = ?",
                &[Value::Number(2.into())],
                "get",
            )
            .expect("get chapter");
        assert_eq!(rows[0]["title"], Value::String("Renamed Chapter".into()));
    }

    #[test]
    fn test_crud_scenes() {
        let db = test_db();

        // Setup: project + chapter
        db.execute(
            "INSERT INTO projects (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
            &[
                Value::String("Novel".into()),
                Value::String("".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert project");
        db.execute(
            "INSERT INTO chapters (project_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::Number(1.into()),
                Value::String("Ch1".into()),
                Value::Number(0.into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert chapter");

        // Create scene with UUID id
        let scene_id = "550e8400-e29b-41d4-a716-446655440000";
        db.execute(
            "INSERT INTO scenes (id, chapter_id, title, sort_order, synopsis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String(scene_id.into()),
                Value::Number(1.into()),
                Value::String("Opening".into()),
                Value::Number(0.into()),
                Value::String("".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert scene");

        let rows = db
            .execute(
                "SELECT * FROM scenes WHERE chapter_id = ?",
                &[Value::Number(1.into())],
                "all",
            )
            .expect("select scenes");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], Value::String(scene_id.into()));
        assert_eq!(rows[0]["title"], Value::String("Opening".into()));

        // Update synopsis
        db.execute(
            "UPDATE scenes SET synopsis = ? WHERE id = ?",
            &[
                Value::String("A dramatic opening".into()),
                Value::String(scene_id.into()),
            ],
            "run",
        )
        .expect("update scene");

        let rows = db
            .execute(
                "SELECT synopsis FROM scenes WHERE id = ?",
                &[Value::String(scene_id.into())],
                "get",
            )
            .expect("get scene");
        assert_eq!(
            rows[0]["synopsis"],
            Value::String("A dramatic opening".into())
        );
    }

    #[test]
    fn test_cascade_delete() {
        let db = test_db();

        // project → chapter → scene
        db.execute(
            "INSERT INTO projects (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
            &[
                Value::String("Novel".into()),
                Value::String("".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert project");
        db.execute(
            "INSERT INTO chapters (project_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::Number(1.into()),
                Value::String("Ch1".into()),
                Value::Number(0.into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert chapter");
        db.execute(
            "INSERT INTO scenes (id, chapter_id, title, sort_order, synopsis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("scene-1".into()),
                Value::Number(1.into()),
                Value::String("S1".into()),
                Value::Number(0.into()),
                Value::String("".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert scene");

        // Delete project → should cascade to chapter → scene
        db.execute(
            "DELETE FROM projects WHERE id = ?",
            &[Value::Number(1.into())],
            "run",
        )
        .expect("delete project");

        let chapters = db
            .execute("SELECT * FROM chapters", &[], "all")
            .expect("select chapters");
        assert_eq!(chapters.len(), 0);

        let scenes = db
            .execute("SELECT * FROM scenes", &[], "all")
            .expect("select scenes");
        assert_eq!(scenes.len(), 0);
    }

    #[test]
    fn test_data_persists_across_reopen() {
        let dir = std::env::temp_dir().join("noveloom_test_persist");
        std::fs::create_dir_all(&dir).ok();
        let db_path = dir.join("persist.db");

        // Remove any leftover from previous runs
        std::fs::remove_file(&db_path).ok();

        // First session: create data
        {
            let db = Database::new(&db_path).expect("open db");
            db.migrate().expect("migrate");
            db.execute(
                "INSERT INTO projects (title, description, created_at, updated_at) VALUES (?, ?, ?, ?)",
                &[
                    Value::String("Persisted Novel".into()),
                    Value::String("desc".into()),
                    Value::String("2025-01-01T00:00:00Z".into()),
                    Value::String("2025-01-01T00:00:00Z".into()),
                ],
                "run",
            )
            .expect("insert");
            db.execute(
                "INSERT INTO chapters (project_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                &[
                    Value::Number(2.into()),
                    Value::String("Ch1".into()),
                    Value::Number(0.into()),
                    Value::String("2025-01-01T00:00:00Z".into()),
                    Value::String("2025-01-01T00:00:00Z".into()),
                ],
                "run",
            )
            .expect("insert chapter");
            db.execute(
                "INSERT INTO scenes (id, chapter_id, title, sort_order, synopsis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                &[
                    Value::String("persist-scene".into()),
                    Value::Number(2.into()),
                    Value::String("Scene 1".into()),
                    Value::Number(0.into()),
                    Value::String("synopsis".into()),
                    Value::String("2025-01-01T00:00:00Z".into()),
                    Value::String("2025-01-01T00:00:00Z".into()),
                ],
                "run",
            )
            .expect("insert scene");
        }
        // Connection dropped here

        // Second session: verify data survived
        {
            let db = Database::new(&db_path).expect("reopen db");
            db.migrate().expect("migrate again");

            // 2 projects: seed + test-inserted
            let projects = db
                .execute("SELECT * FROM projects", &[], "all")
                .expect("select projects");
            assert_eq!(projects.len(), 2);

            // Verify test-inserted data survived (id=2)
            let rows = db
                .execute(
                    "SELECT * FROM projects WHERE id = ?",
                    &[Value::Number(2.into())],
                    "get",
                )
                .expect("select test project");
            assert_eq!(rows[0]["title"], Value::String("Persisted Novel".into()));

            // 2 chapters: seed + test-inserted
            let chapters = db
                .execute("SELECT * FROM chapters", &[], "all")
                .expect("select chapters");
            assert_eq!(chapters.len(), 2);

            let scenes = db
                .execute("SELECT * FROM scenes WHERE id = ?",
                    &[Value::String("persist-scene".into())],
                    "get",
                )
                .expect("select scene");
            assert_eq!(scenes.len(), 1);
            assert_eq!(
                scenes[0]["synopsis"],
                Value::String("synopsis".into())
            );
        }

        // Cleanup
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_migrate_creates_codex_entries_table() {
        let db = test_db();
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='codex_entries'",
                &[],
                "all",
            )
            .expect("query");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_migrate_creates_snippets_table() {
        let db = test_db();
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='snippets'",
                &[],
                "all",
            )
            .expect("query");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_crud_codex_entries() {
        let db = test_db();

        // Create
        db.execute(
            "INSERT INTO codex_entries (type, name, summary, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("character".into()),
                Value::String("太郎".into()),
                Value::String("主人公".into()),
                Value::String("太郎は勇敢な青年。".into()),
                Value::String("主人公,勇者".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert codex entry");

        // Read
        let rows = db
            .execute("SELECT * FROM codex_entries", &[], "all")
            .expect("select all");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], Value::String("太郎".into()));
        assert_eq!(rows[0]["type"], Value::String("character".into()));

        // Update
        db.execute(
            "UPDATE codex_entries SET summary = ?, updated_at = ? WHERE id = ?",
            &[
                Value::String("更新された主人公".into()),
                Value::String("2025-06-01T00:00:00Z".into()),
                Value::Number(1.into()),
            ],
            "run",
        )
        .expect("update codex entry");

        let rows = db
            .execute(
                "SELECT * FROM codex_entries WHERE id = ?",
                &[Value::Number(1.into())],
                "get",
            )
            .expect("get codex entry");
        assert_eq!(
            rows[0]["summary"],
            Value::String("更新された主人公".into())
        );

        // Delete
        db.execute(
            "DELETE FROM codex_entries WHERE id = ?",
            &[Value::Number(1.into())],
            "run",
        )
        .expect("delete codex entry");

        let rows = db
            .execute("SELECT * FROM codex_entries", &[], "all")
            .expect("select after delete");
        assert_eq!(rows.len(), 0);
    }

    #[test]
    fn test_crud_snippets() {
        let db = test_db();

        // Create
        db.execute(
            "INSERT INTO snippets (title, content, tags, scene_id, created_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("伏線メモ".into()),
                Value::String("第3章で回収する伏線。".into()),
                Value::String("伏線".into()),
                Value::Null,
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert snippet");

        // Read
        let rows = db
            .execute("SELECT * FROM snippets", &[], "all")
            .expect("select all");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("伏線メモ".into()));
        assert_eq!(rows[0]["scene_id"], Value::Null);

        // Create with scene_id
        db.execute(
            "INSERT INTO snippets (title, content, tags, scene_id, source_chat_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Value::String("シーンメモ".into()),
                Value::String("雰囲気の詳細。".into()),
                Value::String("雰囲気".into()),
                Value::String("scene-uuid-1".into()),
                Value::String("msg-001".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert snippet with scene");

        let rows = db
            .execute(
                "SELECT * FROM snippets WHERE scene_id = ?",
                &[Value::String("scene-uuid-1".into())],
                "all",
            )
            .expect("select by scene_id");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0]["source_chat_message_id"],
            Value::String("msg-001".into())
        );

        // Update
        db.execute(
            "UPDATE snippets SET title = ? WHERE id = ?",
            &[
                Value::String("更新されたメモ".into()),
                Value::Number(1.into()),
            ],
            "run",
        )
        .expect("update snippet");

        let rows = db
            .execute(
                "SELECT * FROM snippets WHERE id = ?",
                &[Value::Number(1.into())],
                "get",
            )
            .expect("get snippet");
        assert_eq!(rows[0]["title"], Value::String("更新されたメモ".into()));

        // Delete
        db.execute(
            "DELETE FROM snippets WHERE id = ?",
            &[Value::Number(1.into())],
            "run",
        )
        .expect("delete snippet");

        let rows = db
            .execute("SELECT * FROM snippets", &[], "all")
            .expect("select after delete");
        assert_eq!(rows.len(), 1); // second snippet remains
    }

    #[test]
    fn test_fts5_tables_and_triggers_exist() {
        let db = test_db();

        // Check FTS virtual tables exist
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='codex_entries_fts'",
                &[],
                "all",
            )
            .expect("query fts table");
        assert_eq!(rows.len(), 1, "codex_entries_fts should exist");

        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='snippets_fts'",
                &[],
                "all",
            )
            .expect("query fts table");
        assert_eq!(rows.len(), 1, "snippets_fts should exist");

        // Check triggers exist
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'codex_entries_%'",
                &[],
                "all",
            )
            .expect("query triggers");
        assert_eq!(rows.len(), 3, "codex_entries should have 3 triggers (ai, ad, au)");

        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'snippets_%'",
                &[],
                "all",
            )
            .expect("query triggers");
        assert_eq!(rows.len(), 3, "snippets should have 3 triggers (ai, ad, au)");
    }

    #[test]
    fn test_fts5_codex_entries_search() {
        let db = test_db();

        db.execute(
            "INSERT INTO codex_entries (type, name, summary, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("character".into()),
                Value::String("太郎".into()),
                Value::String("勇敢な主人公".into()),
                Value::String("太郎は村を守る勇者である。".into()),
                Value::String("主人公,勇者".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        db.execute(
            "INSERT INTO codex_entries (type, name, summary, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("location".into()),
                Value::String("魔王城".into()),
                Value::String("最終ダンジョン".into()),
                Value::String("暗黒の城。魔物が棲む。".into()),
                Value::String("ダンジョン".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        // Verify base table has data
        let base_rows = db
            .execute("SELECT * FROM codex_entries", &[], "all")
            .expect("base table");
        assert_eq!(base_rows.len(), 2, "base table should have 2 entries");

        // FTS trigram search: queries must be >= 3 Unicode codepoints
        // Search for "勇敢な" (3 chars) which appears in summary of 太郎's entry
        let rows = db
            .execute(
                "SELECT name FROM codex_entries_fts WHERE codex_entries_fts MATCH ?",
                &[Value::String("勇敢な主人公".into())],
                "all",
            )
            .expect("fts search");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], Value::String("太郎".into()));

        // Search for "魔王城" (3 chars) which appears in name
        let rows = db
            .execute(
                "SELECT name FROM codex_entries_fts WHERE codex_entries_fts MATCH ?",
                &[Value::String("魔王城".into())],
                "all",
            )
            .expect("fts search");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], Value::String("魔王城".into()));

        // Search across content field: "村を守る" appears in 太郎's content
        let rows = db
            .execute(
                "SELECT name FROM codex_entries_fts WHERE codex_entries_fts MATCH ?",
                &[Value::String("村を守る".into())],
                "all",
            )
            .expect("fts content search");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_fts5_snippets_search() {
        let db = test_db();

        db.execute(
            "INSERT INTO snippets (title, content, tags, created_at) VALUES (?, ?, ?, ?)",
            &[
                Value::String("森の描写".into()),
                Value::String("暗い森の中、一筋の光が差し込んだ。".into()),
                Value::String("描写,森".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        // FTS search
        let rows = db
            .execute(
                "SELECT title FROM snippets_fts WHERE snippets_fts MATCH ?",
                &[Value::String("森の描写".into())],
                "all",
            )
            .expect("fts search");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("森の描写".into()));
    }

    #[test]
    fn test_fts5_sync_on_update() {
        let db = test_db();

        db.execute(
            "INSERT INTO codex_entries (type, name, summary, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("character".into()),
                Value::String("山田太郎".into()),
                Value::String("主人公キャラ".into()),
                Value::String("勇者である".into()),
                Value::String("".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        // Update name (trigram: >= 3 chars)
        db.execute(
            "UPDATE codex_entries SET name = ? WHERE id = ?",
            &[
                Value::String("鈴木次郎".into()),
                Value::Number(1.into()),
            ],
            "run",
        )
        .expect("update");

        // Old name should not match
        let rows = db
            .execute(
                "SELECT name FROM codex_entries_fts WHERE codex_entries_fts MATCH ?",
                &[Value::String("山田太郎".into())],
                "all",
            )
            .expect("fts search old");
        assert_eq!(rows.len(), 0);

        // New name should match
        let rows = db
            .execute(
                "SELECT name FROM codex_entries_fts WHERE codex_entries_fts MATCH ?",
                &[Value::String("鈴木次郎".into())],
                "all",
            )
            .expect("fts search new");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_fts5_sync_on_delete() {
        let db = test_db();

        db.execute(
            "INSERT INTO codex_entries (type, name, summary, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("item".into()),
                Value::String("伝説の聖剣".into()),
                Value::String("伝説の武器".into()),
                Value::String("古代の鍛冶師".into()),
                Value::String("".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        // Verify FTS has data before delete
        let rows = db
            .execute(
                "SELECT name FROM codex_entries_fts WHERE codex_entries_fts MATCH ?",
                &[Value::String("伝説の聖剣".into())],
                "all",
            )
            .expect("fts search before delete");
        assert_eq!(rows.len(), 1);

        db.execute(
            "DELETE FROM codex_entries WHERE id = ?",
            &[Value::Number(1.into())],
            "run",
        )
        .expect("delete");

        let rows = db
            .execute(
                "SELECT name FROM codex_entries_fts WHERE codex_entries_fts MATCH ?",
                &[Value::String("伝説の聖剣".into())],
                "all",
            )
            .expect("fts search after delete");
        assert_eq!(rows.len(), 0);
    }

    #[test]
    fn test_short_query_like_fallback_codex() {
        let db = test_db();

        db.execute(
            "INSERT INTO codex_entries (type, name, summary, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("character".into()),
                Value::String("太郎".into()),
                Value::String("主人公".into()),
                Value::String("勇敢な青年".into()),
                Value::String("主人公,勇者".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        db.execute(
            "INSERT INTO codex_entries (type, name, summary, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            &[
                Value::String("location".into()),
                Value::String("魔王城".into()),
                Value::String("最終ダンジョン".into()),
                Value::String("暗黒の城".into()),
                Value::String("ダンジョン".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        // 2-char query "太郎" — LIKE fallback should find it
        let rows = db
            .execute(
                "SELECT * FROM codex_entries WHERE name LIKE ? OR summary LIKE ? OR content LIKE ? OR tags LIKE ?",
                &[
                    Value::String("%太郎%".into()),
                    Value::String("%太郎%".into()),
                    Value::String("%太郎%".into()),
                    Value::String("%太郎%".into()),
                ],
                "all",
            )
            .expect("like search");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], Value::String("太郎".into()));

        // 1-char query "城" — should match 魔王城
        let rows = db
            .execute(
                "SELECT * FROM codex_entries WHERE name LIKE ? OR summary LIKE ? OR content LIKE ? OR tags LIKE ?",
                &[
                    Value::String("%城%".into()),
                    Value::String("%城%".into()),
                    Value::String("%城%".into()),
                    Value::String("%城%".into()),
                ],
                "all",
            )
            .expect("like search single char");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["name"], Value::String("魔王城".into()));

        // "勇者" in tags — should match via tags column
        let rows = db
            .execute(
                "SELECT * FROM codex_entries WHERE name LIKE ? OR summary LIKE ? OR content LIKE ? OR tags LIKE ?",
                &[
                    Value::String("%勇者%".into()),
                    Value::String("%勇者%".into()),
                    Value::String("%勇者%".into()),
                    Value::String("%勇者%".into()),
                ],
                "all",
            )
            .expect("like search tags");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_short_query_like_fallback_snippets() {
        let db = test_db();

        db.execute(
            "INSERT INTO snippets (title, content, tags, created_at) VALUES (?, ?, ?, ?)",
            &[
                Value::String("伏線".into()),
                Value::String("第3章で回収する。".into()),
                Value::String("伏線,設定".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");

        // 2-char query "伏線" — LIKE should match
        let rows = db
            .execute(
                "SELECT * FROM snippets WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?",
                &[
                    Value::String("%伏線%".into()),
                    Value::String("%伏線%".into()),
                    Value::String("%伏線%".into()),
                ],
                "all",
            )
            .expect("like search");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("伏線".into()));
    }

    #[test]
    fn test_migrate_creates_chat_threads_table() {
        let db = test_db();
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_threads'",
                &[],
                "all",
            )
            .expect("query");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_migrate_creates_chat_messages_table() {
        let db = test_db();
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages'",
                &[],
                "all",
            )
            .expect("query");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn test_crud_chat_threads() {
        let db = test_db();

        db.execute(
            "INSERT INTO chat_threads (id, title, scene_id, created_at, modified_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("thread-1".into()),
                Value::String("Test Thread".into()),
                Value::Null,
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert thread");

        let rows = db
            .execute("SELECT * FROM chat_threads", &[], "all")
            .expect("select threads");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("Test Thread".into()));
        assert_eq!(rows[0]["scene_id"], Value::Null);

        db.execute(
            "DELETE FROM chat_threads WHERE id = ?",
            &[Value::String("thread-1".into())],
            "run",
        )
        .expect("delete thread");
        let rows = db
            .execute("SELECT * FROM chat_threads", &[], "all")
            .expect("select after delete");
        assert_eq!(rows.len(), 0);
    }

    #[test]
    fn test_crud_chat_messages() {
        let db = test_db();

        db.execute(
            "INSERT INTO chat_threads (id, title, scene_id, created_at, modified_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("thread-1".into()),
                Value::String("Thread".into()),
                Value::Null,
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert thread");

        db.execute(
            "INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("msg-1".into()),
                Value::String("thread-1".into()),
                Value::String("user".into()),
                Value::String("Hello".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert message");

        db.execute(
            "INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("msg-2".into()),
                Value::String("thread-1".into()),
                Value::String("assistant".into()),
                Value::String("Hi there!".into()),
                Value::String("2025-01-01T00:00:01Z".into()),
            ],
            "run",
        )
        .expect("insert assistant message");

        let rows = db
            .execute(
                "SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at",
                &[Value::String("thread-1".into())],
                "all",
            )
            .expect("select messages");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["role"], Value::String("user".into()));
        assert_eq!(rows[1]["role"], Value::String("assistant".into()));
    }

    #[test]
    fn test_chat_messages_role_check_constraint() {
        let db = test_db();

        db.execute(
            "INSERT INTO chat_threads (id, title, scene_id, created_at, modified_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("thread-1".into()),
                Value::String("Thread".into()),
                Value::Null,
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert thread");

        let result = db.execute(
            "INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("msg-bad".into()),
                Value::String("thread-1".into()),
                Value::String("invalid_role".into()),
                Value::String("test".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_chat_cascade_delete_thread() {
        let db = test_db();

        db.execute(
            "INSERT INTO chat_threads (id, title, scene_id, created_at, modified_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("thread-1".into()),
                Value::String("Thread".into()),
                Value::Null,
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert thread");

        db.execute(
            "INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::String("msg-1".into()),
                Value::String("thread-1".into()),
                Value::String("user".into()),
                Value::String("Hello".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert message");

        db.execute(
            "DELETE FROM chat_threads WHERE id = ?",
            &[Value::String("thread-1".into())],
            "run",
        )
        .expect("delete thread");

        let msgs = db
            .execute("SELECT * FROM chat_messages", &[], "all")
            .expect("select messages");
        assert_eq!(msgs.len(), 0);
    }

    #[test]
    fn test_chat_persist_across_reopen() {
        let dir = std::env::temp_dir().join("noveloom_test_chat_persist");
        std::fs::create_dir_all(&dir).ok();
        let db_path = dir.join("chat_persist.db");
        std::fs::remove_file(&db_path).ok();

        {
            let db = Database::new(&db_path).expect("open db");
            db.migrate().expect("migrate");
            db.execute(
                "INSERT INTO chat_threads (id, title, scene_id, created_at, modified_at) VALUES (?, ?, ?, ?, ?)",
                &[
                    Value::String("thread-p".into()),
                    Value::String("Persisted Thread".into()),
                    Value::Null,
                    Value::String("2025-01-01T00:00:00Z".into()),
                    Value::String("2025-01-01T00:00:00Z".into()),
                ],
                "run",
            )
            .expect("insert thread");
            db.execute(
                "INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                &[
                    Value::String("msg-p".into()),
                    Value::String("thread-p".into()),
                    Value::String("user".into()),
                    Value::String("Persisted message".into()),
                    Value::String("2025-01-01T00:00:00Z".into()),
                ],
                "run",
            )
            .expect("insert message");
        }

        {
            let db = Database::new(&db_path).expect("reopen db");
            db.migrate().expect("migrate again");

            let threads = db
                .execute("SELECT * FROM chat_threads", &[], "all")
                .expect("select threads");
            assert_eq!(threads.len(), 1);
            assert_eq!(threads[0]["title"], Value::String("Persisted Thread".into()));

            let msgs = db
                .execute(
                    "SELECT * FROM chat_messages WHERE thread_id = ?",
                    &[Value::String("thread-p".into())],
                    "all",
                )
                .expect("select messages");
            assert_eq!(msgs.len(), 1);
            assert_eq!(msgs[0]["content"], Value::String("Persisted message".into()));
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_wal_mode_enabled() {
        let dir = std::env::temp_dir().join("noveloom_test_wal");
        std::fs::create_dir_all(&dir).ok();
        let db_path = dir.join("test.db");
        let db = Database::new(&db_path).expect("open db");
        let rows = db
            .execute("PRAGMA journal_mode", &[], "get")
            .expect("pragma");
        let mode = rows[0]
            .values()
            .next()
            .expect("value")
            .as_str()
            .expect("str")
            .to_lowercase();
        assert_eq!(mode, "wal");
        // Cleanup
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_nullify_codex_source_on_message_delete() {
        let db = test_db();
        // Create a scene and thread and message
        db.execute(
            "INSERT INTO scenes (id, chapter_id, title, sort_order, synopsis, created_at, updated_at) VALUES (?, 1, ?, 0, '', datetime('now'), datetime('now'))",
            &[Value::String("s1".into()), Value::String("シーン1".into())],
            "run",
        ).expect("insert scene");
        db.execute(
            "INSERT INTO chat_threads (id, title, scene_id, created_at, modified_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("t1".into()), Value::String("スレッド1".into()), Value::String("s1".into())],
            "run",
        ).expect("insert thread");
        db.execute(
            "INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
            &[Value::String("msg1".into()), Value::String("t1".into()), Value::String("user".into()), Value::String("hello".into())],
            "run",
        ).expect("insert message");

        // Create codex entry referencing the message
        db.execute(
            "INSERT INTO codex_entries (type, name, source_chat_message_id, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("character".into()), Value::String("テスト".into()), Value::String("msg1".into())],
            "run",
        ).expect("insert codex");

        // Delete the message
        db.execute(
            "DELETE FROM chat_messages WHERE id = ?",
            &[Value::String("msg1".into())],
            "run",
        ).expect("delete message");

        // Verify source was nullified
        let rows = db.execute(
            "SELECT source_chat_message_id FROM codex_entries WHERE name = ?",
            &[Value::String("テスト".into())],
            "all",
        ).expect("query");
        assert_eq!(rows[0]["source_chat_message_id"], Value::Null);
    }

    #[test]
    fn test_nullify_snippet_scene_on_scene_delete() {
        let db = test_db();
        // Create a scene
        db.execute(
            "INSERT INTO scenes (id, chapter_id, title, sort_order, synopsis, created_at, updated_at) VALUES (?, 1, ?, 0, '', datetime('now'), datetime('now'))",
            &[Value::String("s1".into()), Value::String("シーン1".into())],
            "run",
        ).expect("insert scene");

        // Create snippet referencing the scene
        db.execute(
            "INSERT INTO snippets (title, content, tags, scene_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
            &[Value::String("テスト".into()), Value::String("内容".into()), Value::String("".into()), Value::String("s1".into())],
            "run",
        ).expect("insert snippet");

        // Delete the scene
        db.execute(
            "DELETE FROM scenes WHERE id = ?",
            &[Value::String("s1".into())],
            "run",
        ).expect("delete scene");

        // Verify scene_id was nullified
        let rows = db.execute(
            "SELECT scene_id FROM snippets WHERE title = ?",
            &[Value::String("テスト".into())],
            "all",
        ).expect("query");
        assert_eq!(rows[0]["scene_id"], Value::Null);
    }

    #[test]
    fn test_integrity_check_clean_db() {
        let db = test_db();
        let report = db.integrity_check().expect("integrity check");
        assert_eq!(report["orphanedCodexSources"], Value::Number(0.into()));
        assert_eq!(report["orphanedSnippetSources"], Value::Number(0.into()));
        assert_eq!(report["orphanedSnippetScenes"], Value::Number(0.into()));
    }

    #[test]
    fn test_integrity_check_detects_and_repairs_orphans() {
        let db = test_db();
        // Insert codex with non-existent source_chat_message_id
        db.execute(
            "INSERT INTO codex_entries (type, name, source_chat_message_id, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
            &[Value::String("character".into()), Value::String("孤立テスト".into()), Value::String("nonexistent".into())],
            "run",
        ).expect("insert");

        // Check should detect orphan
        let report = db.integrity_check().expect("check");
        assert_eq!(report["orphanedCodexSources"], Value::Number(1.into()));

        // Repair should fix it
        let repair = db.repair_integrity().expect("repair");
        assert_eq!(repair["codexSourcesFixed"], Value::Number(1.into()));

        // Re-check should be clean
        let report2 = db.integrity_check().expect("check2");
        assert_eq!(report2["orphanedCodexSources"], Value::Number(0.into()));
    }

    #[test]
    fn test_fts_optimize_succeeds() {
        let db = test_db();
        // Insert some data to make FTS indexes non-empty
        db.execute(
            "INSERT INTO codex_entries (type, name, summary, content, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
            &[
                Value::String("character".into()),
                Value::String("テスト太郎".into()),
                Value::String("テスト用キャラクター".into()),
                Value::String("テスト内容".into()),
                Value::String("テスト".into()),
            ],
            "run",
        ).expect("insert codex");

        db.execute(
            "INSERT INTO snippets (title, content, tags, created_at) VALUES (?, ?, ?, datetime('now'))",
            &[
                Value::String("テストスニペット".into()),
                Value::String("スニペット内容".into()),
                Value::String("タグ".into()),
            ],
            "run",
        ).expect("insert snippet");

        // fts_optimize should succeed without error
        db.fts_optimize().expect("fts_optimize should succeed");
    }
}
