//! write clock の install（冪等）と lineage の作り直し（DB 段 1 の PR-1、DR-DBC-3）。
//!
//! 表・TRIGGER の生成関数と不変条件は grimodex-core の `write_clock` が正本。ここは
//! それを使い、migration（stamp の直前、同じ tx／savepoint の中）から呼ばれて
//! 現在の DB を期待の形に揃える。収束した DB では DDL を 1 つも実行しない。
//!
//! 連番は失効の合図であって authority ではない。

use std::collections::BTreeMap;

use anyhow::Context;
use grimodex_core::write_clock::{
    clock_target_tables, expected_clock_triggers, CLOCK_KEY_ALL, CLOCK_TRIGGER_PREFIX,
    DB_LINEAGE_TABLE, DB_LINEAGE_TABLE_DDL, WRITE_CLOCK_TABLE, WRITE_CLOCK_TABLE_DDL,
};
use rusqlite::{Connection, OptionalExtension};

/// core の `has_v46_write_clock` と同じ正規化（空白除去＋小文字化）。
fn compact(sql: &str) -> String {
    sql.chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn new_lineage_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn table_exists(conn: &Connection, name: &str) -> anyhow::Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [name],
        |row| row.get(0),
    )?)
}

fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// lineage の `id` を新しい uuid v4（小文字 32 hex）に差し替えて返す。
/// 行が無ければ作る。restore・shadow migration・handoff の staged から呼ぶ。
pub fn rotate_db_lineage(conn: &Connection) -> anyhow::Result<String> {
    let id = new_lineage_id();
    conn.execute(
        &format!(
            "INSERT INTO {DB_LINEAGE_TABLE}(singleton, id) VALUES (1, ?1)
             ON CONFLICT(singleton) DO UPDATE SET id = excluded.id"
        ),
        [&id],
    )
    .context("rotating the database lineage")?;
    Ok(id)
}

/// 信頼しない画像（Web Editor の取り込み）が持つ連番を持ち込ませない：全ての行を 0 に戻す。
///
/// `rotate_db_lineage` の後に呼ぶ（lineage を作り直しているので、0 に戻しても過去の値との
/// ABA は起きない）。`i64::MAX` の seq を持ち込まれると、`INSERT OR IGNORE` の中で
/// clock だけが止まる（`grimodex_core::write_clock` の既知の限界）。restore は利用者
/// 自身の backup なので、この関数は呼ばず seq を保つ。clock 表への UPDATE は
/// clock の TRIGGER を発火しない（guard は DELETE だけ）。
pub fn reset_write_clock_seq(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(&format!("UPDATE {WRITE_CLOCK_TABLE} SET seq = 0"), [])
        .context("resetting the imported write clock")?;
    Ok(())
}

/// v46 の write clock を現在の DB に揃える（冪等）。呼び出し側が tx／savepoint を持つ。
///
/// 1. 2 表が無ければ作る。
/// 2. `'*'` の行が無ければ `MAX(seq)+1`（他の行が無ければ 0）で作り、同時に lineage を
///    作り直す（巻き戻った連番が過去の値と一致する ABA を避ける）。
/// 3. lineage の行（32 文字の hex）が無い・壊れていれば作る。
/// 4. 期待する TRIGGER と現在の `grimodex_clock_*` を名前と SQL で比べ、差分だけ
///    DROP＋CREATE し、余りは DROP する。差分が無ければ DDL は実行しない。
pub fn install_write_clock_in_tx(conn: &Connection) -> anyhow::Result<()> {
    for (table, ddl) in [
        (WRITE_CLOCK_TABLE, WRITE_CLOCK_TABLE_DDL),
        (DB_LINEAGE_TABLE, DB_LINEAGE_TABLE_DDL),
    ] {
        if !table_exists(conn, table)? {
            conn.execute_batch(ddl)
                .with_context(|| format!("creating {table}"))?;
        }
    }

    let has_global: bool = conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {WRITE_CLOCK_TABLE} WHERE name = ?1)"),
        [CLOCK_KEY_ALL],
        |row| row.get(0),
    )?;
    let lineage: Option<String> = conn
        .query_row(
            &format!("SELECT id FROM {DB_LINEAGE_TABLE} WHERE singleton = 1"),
            [],
            |row| row.get(0),
        )
        .optional()?;
    let lineage_valid = lineage
        .as_deref()
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()));

    if !has_global {
        conn.execute(
            &format!(
                "INSERT INTO {WRITE_CLOCK_TABLE}(name, seq)
                 SELECT ?1, COALESCE((SELECT MAX(seq) FROM {WRITE_CLOCK_TABLE}), -1) + 1
                 ON CONFLICT(name) DO NOTHING"
            ),
            [CLOCK_KEY_ALL],
        )
        .context("recreating the write clock global row")?;
    }
    if !has_global || !lineage_valid {
        rotate_db_lineage(conn)?;
    }

    let expected = expected_clock_triggers(&clock_target_tables(conn)?);
    let actual: BTreeMap<String, String> = conn
        .prepare(
            "SELECT name, sql FROM sqlite_master
              WHERE type = 'trigger' AND name GLOB 'grimodex_clock_*'",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .map(|row| row.map(|(name, sql)| (name, compact(&sql.unwrap_or_default()))))
        .collect::<Result<_, _>>()?;

    let mut expected_names = std::collections::BTreeSet::new();
    for (name, sql) in &expected {
        expected_names.insert(name.as_str());
        let current = actual.get(name);
        if current.is_some_and(|current| *current == compact(sql)) {
            continue;
        }
        if current.is_some() {
            conn.execute_batch(&format!(
                "DROP TRIGGER IF EXISTS {}",
                quote_identifier(name)
            ))?;
        }
        conn.execute_batch(sql)
            .with_context(|| format!("creating trigger {name}"))?;
    }
    for name in actual.keys() {
        if !expected_names.contains(name.as_str()) {
            debug_assert!(name.starts_with(CLOCK_TRIGGER_PREFIX));
            conn.execute_batch(&format!(
                "DROP TRIGGER IF EXISTS {}",
                quote_identifier(name)
            ))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use grimodex_core::write_clock::{has_v46_write_clock, CLOCK_GUARD_TRIGGER};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn temp_path(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-write-clock-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create test directory");
        dir.join("grimodex.db")
    }

    fn migrated(label: &str) -> (std::path::PathBuf, Database) {
        let path = temp_path(label);
        let db = Database::new(&path).expect("open database");
        db.migrate().expect("migrate");
        (path, db)
    }

    fn clock_seq(conn: &Connection, name: &str) -> Option<i64> {
        conn.query_row(
            &format!("SELECT seq FROM {WRITE_CLOCK_TABLE} WHERE name = ?1"),
            [name],
            |row| row.get(0),
        )
        .optional()
        .expect("read clock")
    }

    fn lineage(conn: &Connection) -> String {
        conn.query_row(
            &format!("SELECT id FROM {DB_LINEAGE_TABLE} WHERE singleton = 1"),
            [],
            |row| row.get(0),
        )
        .expect("read lineage")
    }

    fn is_hex32(id: &str) -> bool {
        id.len() == 32
            && id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn insert_project(conn: &Connection, id: &str) {
        conn.execute("INSERT INTO projects(id) VALUES (?1)", [id])
            .expect("insert project");
    }

    #[test]
    fn schema_46_installs_a_trigger_for_every_table() {
        let (_path, db) = migrated("every-table");
        db.with_conn(|conn| {
            assert!(has_v46_write_clock(conn)?);
            let tables = clock_target_tables(conn)?;
            assert!(tables.len() > 100, "{} tables", tables.len());
            for table in &tables {
                for suffix in ["ai", "au", "ad"] {
                    let name = format!("grimodex_clock_{table}_{suffix}");
                    let exists: bool = conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master
                          WHERE type = 'trigger' AND name = ?1 AND tbl_name = ?2)",
                        [&name, table],
                        |row| row.get(0),
                    )?;
                    assert!(exists, "missing trigger {name}");
                }
            }
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master
                  WHERE type = 'trigger' AND name GLOB 'grimodex_clock_*'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(count as usize, tables.len() * 3 + 1);
            assert!(clock_seq(conn, CLOCK_KEY_ALL).is_some());
            assert!(is_hex32(&lineage(conn)));
            Ok(())
        })
        .expect("verify");
    }

    fn ddl_counter(conn: &Connection) -> Arc<AtomicUsize> {
        let counter = Arc::new(AtomicUsize::new(0));
        let seen = counter.clone();
        conn.authorizer(Some(move |context: rusqlite::hooks::AuthContext<'_>| {
            let action = format!("{:?}", context.action);
            if action.starts_with("Create")
                || action.starts_with("Drop")
                || action.starts_with("Alter")
            {
                seen.fetch_add(1, Ordering::SeqCst);
            }
            rusqlite::hooks::Authorization::Allow
        }))
        .expect("install authorizer");
        counter
    }

    fn trigger_identity(conn: &Connection) -> Vec<(String, i64, String)> {
        conn.prepare(
            "SELECT name, rootpage, sql FROM sqlite_master
              WHERE type = 'trigger' AND name GLOB 'grimodex_clock_*' ORDER BY name",
        )
        .expect("prepare")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
    }

    #[test]
    fn schema_46_converged_open_performs_no_ddl() {
        let (path, db) = migrated("converged");
        let (before_rows, before_schema_version): (_, i64) = db
            .with_conn(|conn| {
                Ok((
                    trigger_identity(conn),
                    conn.pragma_query_value(None, "schema_version", |row| row.get(0))?,
                ))
            })
            .expect("snapshot");
        // install を直接呼んでも、収束していれば DDL は 1 つも走らない。
        let ddl = db
            .with_conn(|conn| {
                let counter = ddl_counter(conn);
                conn.execute_batch("SAVEPOINT t")?;
                install_write_clock_in_tx(conn)?;
                conn.execute_batch("RELEASE t")?;
                conn.authorizer(
                    None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>,
                )?;
                Ok(counter.load(Ordering::SeqCst))
            })
            .expect("converged install");
        assert_eq!(ddl, 0);
        drop(db);

        // 2 回目の open（migrate）も schema を変えない。
        let reopened = Database::new(&path).expect("reopen");
        let ddl = reopened
            .with_conn(|conn| Ok(ddl_counter(conn)))
            .expect("hook");
        reopened.migrate().expect("migrate converged");
        assert_eq!(ddl.load(Ordering::SeqCst), 0);
        let (after_rows, after_schema_version): (_, i64) = reopened
            .with_conn(|conn| {
                Ok((
                    trigger_identity(conn),
                    conn.pragma_query_value(None, "schema_version", |row| row.get(0))?,
                ))
            })
            .expect("snapshot");
        assert_eq!(before_rows, after_rows);
        assert_eq!(before_schema_version, after_schema_version);
    }

    #[test]
    fn schema_46_repairs_dropped_or_stale_clock_trigger_in_version() {
        let (_path, db) = migrated("repair-trigger");
        db.with_conn(|conn| {
            conn.execute_batch(
                "DROP TRIGGER grimodex_clock_projects_au;
                 DROP TRIGGER grimodex_clock_tree_nodes_ai;",
            )?;
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS grimodex_clock_tree_nodes_ad;
                 CREATE TRIGGER grimodex_clock_tree_nodes_ad AFTER DELETE ON tree_nodes
                   BEGIN SELECT 1; END;
                 CREATE TRIGGER grimodex_clock_bogus AFTER INSERT ON projects
                   BEGIN SELECT 1; END;",
            )?;
            assert!(!has_v46_write_clock(conn)?);
            Ok(())
        })
        .expect("break triggers");
        db.migrate().expect("repair");
        db.with_conn(|conn| {
            assert!(has_v46_write_clock(conn)?);
            let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
            assert_eq!(version, grimodex_core::SCHEMA_VERSION);
            let bogus: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'grimodex_clock_bogus')",
                [],
                |row| row.get(0),
            )?;
            assert!(!bogus);
            Ok(())
        })
        .expect("verify repair");
    }

    #[test]
    fn schema_46_repairs_missing_global_row_and_rotates_lineage() {
        let (_path, db) = migrated("repair-global");
        let (max_other, old_lineage) = db
            .with_conn(|conn| {
                insert_project(conn, "p1");
                let old = lineage(conn);
                // 表ごとの鍵は無いので、'*' 以外の行（audit の mutate の鍵）で MAX(seq) を作る。
                conn.execute(
                    &format!("INSERT INTO {WRITE_CLOCK_TABLE}(name, seq) VALUES (?1, 7)"),
                    [grimodex_core::write_clock::CLOCK_KEY_AUDIT_MUTATE],
                )?;
                conn.execute_batch(&format!("DROP TRIGGER {CLOCK_GUARD_TRIGGER}"))?;
                conn.execute(
                    &format!("DELETE FROM {WRITE_CLOCK_TABLE} WHERE name = ?1"),
                    [CLOCK_KEY_ALL],
                )?;
                assert!(!has_v46_write_clock(conn)?);
                let max: i64 = conn.query_row(
                    &format!("SELECT MAX(seq) FROM {WRITE_CLOCK_TABLE}"),
                    [],
                    |row| row.get(0),
                )?;
                Ok((max, old))
            })
            .expect("remove the global row");
        assert!(max_other > 0);
        db.migrate().expect("repair");
        db.with_conn(|conn| {
            assert!(has_v46_write_clock(conn)?);
            let seq = clock_seq(conn, CLOCK_KEY_ALL).expect("global row");
            assert!(seq > max_other, "{seq} must exceed {max_other}");
            assert_ne!(lineage(conn), old_lineage);
            Ok(())
        })
        .expect("verify");
    }

    #[test]
    fn install_write_clock_in_tx_is_idempotent_and_starts_a_fresh_clock_at_zero() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("CREATE TABLE things (id INTEGER PRIMARY KEY, v TEXT)")
            .expect("table");
        install_write_clock_in_tx(&conn).expect("first install");
        assert_eq!(clock_seq(&conn, CLOCK_KEY_ALL), Some(0));
        let first = (lineage(&conn), trigger_identity(&conn));
        assert!(has_v46_write_clock(&conn).expect("invariant"));
        install_write_clock_in_tx(&conn).expect("second install");
        assert_eq!((lineage(&conn), trigger_identity(&conn)), first);
        assert_eq!(clock_seq(&conn, CLOCK_KEY_ALL), Some(0));
    }

    #[test]
    fn rotate_db_lineage_returns_a_different_hex_id_each_time() {
        let conn = Connection::open_in_memory().expect("open");
        install_write_clock_in_tx(&conn).expect("install");
        let mut seen = std::collections::BTreeSet::new();
        seen.insert(lineage(&conn));
        for _ in 0..5 {
            let id = rotate_db_lineage(&conn).expect("rotate");
            assert!(is_hex32(&id), "{id}");
            assert_eq!(lineage(&conn), id);
            assert!(seen.insert(id), "a repeated lineage id");
        }
    }

    #[test]
    fn clock_advances_from_another_connection() {
        let (path, db) = migrated("other-connection");
        let before = db
            .with_conn(|conn| Ok(clock_seq(conn, CLOCK_KEY_ALL).expect("global")))
            .expect("read");
        let other = Connection::open(&path).expect("second connection");
        other
            .execute("INSERT INTO projects(id) VALUES ('from-other')", [])
            .expect("write from another connection");
        other
            .execute(
                "UPDATE projects SET title = 'x' WHERE id = 'from-other'",
                [],
            )
            .expect("update");
        drop(other);
        db.with_conn(|conn| {
            // projects の INSERT は既定の codex_types なども TRIGGER で作るので、2 以上。
            let global = clock_seq(conn, CLOCK_KEY_ALL).expect("global");
            assert!(global >= before + 2, "{global} must advance from {before}");
            // 通常の表には表ごとの鍵が無い（'*' だけ）。
            assert_eq!(clock_seq(conn, "projects"), None);
            Ok(())
        })
        .expect("verify");
    }

    #[test]
    fn clock_triggers_keep_changes_and_last_insert_rowid() {
        let (_path, db) = migrated("changes");
        db.with_conn(|conn| {
            assert_eq!(
                conn.execute("INSERT INTO projects(id) VALUES ('a')", [])?,
                1
            );
            let rowid: i64 =
                conn.query_row("SELECT rowid FROM projects WHERE id = 'a'", [], |row| {
                    row.get(0)
                })?;
            assert_eq!(conn.last_insert_rowid(), rowid);
            assert_eq!(
                conn.query_row("SELECT changes()", [], |r| r.get::<_, i64>(0))?,
                1
            );
            assert_eq!(
                conn.execute("UPDATE projects SET title = 't' WHERE id = 'a'", [])?,
                1
            );
            assert_eq!(
                conn.execute("INSERT INTO projects(id) VALUES ('b')", [])?,
                1
            );
            assert_eq!(
                conn.execute("DELETE FROM projects WHERE id IN ('a', 'b')", [])?,
                2
            );
            // 呼び出し側から見える変更数は TRIGGER の行を含まないが、total_changes は含む。
            let before = conn.total_changes();
            assert_eq!(
                conn.execute("INSERT INTO projects(id) VALUES ('c')", [])?,
                1
            );
            assert!(conn.total_changes() > before + 1);
            Ok(())
        })
        .expect("verify");
    }
}
