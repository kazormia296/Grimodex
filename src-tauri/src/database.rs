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
            );",
        )?;
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

        // Read all
        let rows = db
            .execute("SELECT * FROM projects", &[], "all")
            .expect("select all");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("Test Novel".into()));

        // Read one
        let rows = db
            .execute(
                "SELECT * FROM projects WHERE id = ?",
                &[Value::Number(1.into())],
                "get",
            )
            .expect("select one");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], Value::Number(1.into()));

        // Update
        db.execute(
            "UPDATE projects SET title = ?, updated_at = ? WHERE id = ?",
            &[
                Value::String("Updated Novel".into()),
                Value::String("2025-06-01T00:00:00Z".into()),
                Value::Number(1.into()),
            ],
            "run",
        )
        .expect("update");

        let rows = db
            .execute(
                "SELECT * FROM projects WHERE id = ?",
                &[Value::Number(1.into())],
                "get",
            )
            .expect("select after update");
        assert_eq!(rows[0]["title"], Value::String("Updated Novel".into()));

        // Delete
        db.execute(
            "DELETE FROM projects WHERE id = ?",
            &[Value::Number(1.into())],
            "run",
        )
        .expect("delete");

        let rows = db
            .execute("SELECT * FROM projects", &[], "all")
            .expect("select after delete");
        assert_eq!(rows.len(), 0);
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

        // Create chapter
        db.execute(
            "INSERT INTO chapters (project_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            &[
                Value::Number(1.into()),
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
                &[Value::Number(1.into())],
                "all",
            )
            .expect("select chapters");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], Value::String("Chapter 1".into()));

        // Update
        db.execute(
            "UPDATE chapters SET title = ? WHERE id = ?",
            &[
                Value::String("Renamed Chapter".into()),
                Value::Number(1.into()),
            ],
            "run",
        )
        .expect("update chapter");

        let rows = db
            .execute(
                "SELECT * FROM chapters WHERE id = ?",
                &[Value::Number(1.into())],
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
                    Value::String("persist-scene".into()),
                    Value::Number(1.into()),
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

            let projects = db
                .execute("SELECT * FROM projects", &[], "all")
                .expect("select projects");
            assert_eq!(projects.len(), 1);
            assert_eq!(
                projects[0]["title"],
                Value::String("Persisted Novel".into())
            );

            let chapters = db
                .execute("SELECT * FROM chapters", &[], "all")
                .expect("select chapters");
            assert_eq!(chapters.len(), 1);
            assert_eq!(chapters[0]["title"], Value::String("Ch1".into()));

            let scenes = db
                .execute("SELECT * FROM scenes", &[], "all")
                .expect("select scenes");
            assert_eq!(scenes.len(), 1);
            assert_eq!(
                scenes[0]["id"],
                Value::String("persist-scene".into())
            );
            assert_eq!(
                scenes[0]["synopsis"],
                Value::String("synopsis".into())
            );
        }

        // Cleanup
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
}
