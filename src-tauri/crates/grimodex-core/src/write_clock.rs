//! DB の中の書込み連番（write clock）の表・TRIGGER・不変条件（DB 段 1 の PR-1、DR-DBC-3）。
//!
//! 生成関数と不変条件はここ（core）が正本。MCP の `schema_allows_writes` と
//! `has_current_schema_checkpoint_invariants` が core を使うため。install（冪等な
//! DROP＋CREATE、余分な `grimodex_clock_%` の削除）と lineage の作り直しは
//! grimodex-db が持つ。
//!
//! 連番は失効の合図であって authority ではない。TRIGGER の本体は `NEW`／`OLD` を
//! 参照しない（D2a で closed の表の Read 拒否に当たり、renderer の書込みが止まるため）。

use std::collections::BTreeMap;

use rusqlite::Connection;

/// clock の表名。
pub const WRITE_CLOCK_TABLE: &str = "grimodex_write_clock";
/// lineage（DB の系譜 id）の表名。
pub const DB_LINEAGE_TABLE: &str = "grimodex_db_lineage";
/// clock の TRIGGER 名の接頭辞（`LIKE` ではなく GLOB で探す。`_` が wildcard になるため）。
pub const CLOCK_TRIGGER_PREFIX: &str = "grimodex_clock_";
/// 全体の連番の鍵。どの行が変わっても +1 される。
pub const CLOCK_KEY_ALL: &str = "*";
/// 監査表の UPDATE／DELETE の鍵（INSERT は表名そのまま）。
pub const CLOCK_KEY_AUDIT_MUTATE: &str = "ai_audit_events!mutate";
/// `'*'` の削除を拒否する TRIGGER の名前。
pub const CLOCK_GUARD_TRIGGER: &str = "grimodex_clock_guard_star";

const AUDIT_TABLE: &str = "ai_audit_events";

/// clock の表の DDL（`WITHOUT ROWID`）。桁あふれで `seq` が REAL になると
/// `CHECK` が書込みを止める（fail-closed。rev1 §1.4）。
pub const WRITE_CLOCK_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS grimodex_write_clock (\
    name TEXT PRIMARY KEY, \
    seq INTEGER NOT NULL CHECK (typeof(seq) = 'integer' AND seq >= 0)\
    ) WITHOUT ROWID";

/// lineage の表の DDL（1 行だけ。`id` は 32 文字の uuid v4 hex）。
pub const DB_LINEAGE_TABLE_DDL: &str = "CREATE TABLE IF NOT EXISTS grimodex_db_lineage (\
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), \
    id TEXT NOT NULL CHECK (length(id) = 32)\
    )";

/// 空白と大文字小文字と `IF NOT EXISTS` を無視した比較用の形。
/// SQLite は `sqlite_master.sql` に `IF NOT EXISTS` を残さない。
fn compact_ddl(sql: &str) -> String {
    crate::workspace_schema::compact_sql(sql).replacen("ifnotexists", "", 1)
}

/// clock の TRIGGER を付ける表の一覧（main schema の実表だけ。ソート済み）。
///
/// 除くもの：`sqlite_%`、clock の 2 表、virtual、shadow、view。名前は SQL に
/// 埋め込むので `[a-z0-9_]+` に限り、外れる名前があればエラーにする。
pub fn clock_target_tables(conn: &Connection) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT name FROM pragma_table_list
          WHERE schema = 'main' AND type = 'table'
            AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
            AND name NOT IN (?1, ?2)
          ORDER BY name",
    )?;
    let names = statement
        .query_map([WRITE_CLOCK_TABLE, DB_LINEAGE_TABLE], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for name in &names {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        {
            anyhow::bail!("write clock: table name {name:?} is outside [a-z0-9_]+");
        }
    }
    Ok(names)
}

/// 期待する clock の TRIGGER（名前と SQL）。純関数。
///
/// 表ごとに AFTER INSERT／UPDATE／DELETE の 3 本（`_ai`／`_au`／`_ad`）と、
/// clock 表に `'*'` の削除を拒否する guard を 1 本。名前の昇順で、guard は最後。
/// SQL に末尾の `;` は付けない（`sqlite_master.sql` と同じ形）。
pub fn expected_clock_triggers(tables: &[String]) -> Vec<(String, String)> {
    let mut sorted: Vec<&String> = tables.iter().collect();
    sorted.sort();
    let mut triggers = Vec::with_capacity(sorted.len() * 3 + 1);
    for table in sorted {
        for (suffix, event, mutate) in [
            ("ai", "INSERT", false),
            ("au", "UPDATE", true),
            ("ad", "DELETE", true),
        ] {
            let key = if mutate && table == AUDIT_TABLE {
                CLOCK_KEY_AUDIT_MUTATE
            } else {
                table.as_str()
            };
            let name = format!("{CLOCK_TRIGGER_PREFIX}{table}_{suffix}");
            let sql = format!(
                "CREATE TRIGGER {name} AFTER {event} ON \"{table}\" BEGIN \
                 UPDATE {WRITE_CLOCK_TABLE} SET seq = seq + 1 WHERE name = '{CLOCK_KEY_ALL}'; \
                 INSERT INTO {WRITE_CLOCK_TABLE}(name, seq) \
                 SELECT '{key}', seq FROM {WRITE_CLOCK_TABLE} WHERE name = '{CLOCK_KEY_ALL}' \
                 ON CONFLICT(name) DO UPDATE SET seq = excluded.seq; \
                 END"
            );
            triggers.push((name, sql));
        }
    }
    triggers.push((
        CLOCK_GUARD_TRIGGER.to_string(),
        format!(
            "CREATE TRIGGER {CLOCK_GUARD_TRIGGER} BEFORE DELETE ON {WRITE_CLOCK_TABLE} \
             WHEN OLD.name = '{CLOCK_KEY_ALL}' \
             BEGIN SELECT RAISE(ABORT, 'grimodex_write_clock: the global key must not be deleted'); END"
        ),
    ));
    triggers
}

/// v46 の write clock が物理的に揃っているか。読むだけで、何も変更しない。
///
/// - 2 表の SQL が期待と一致する（空白・大文字小文字・`IF NOT EXISTS` を無視）。
/// - `'*'` の行と、32 文字の hex の lineage の行がある。
/// - `grimodex_clock_*` の TRIGGER の集合が、実表から作った期待値と名前も SQL も
///   完全一致する（欠けも余りも無い。guard を含む）。
pub fn has_v46_write_clock(conn: &Connection) -> anyhow::Result<bool> {
    for (table, ddl) in [
        (WRITE_CLOCK_TABLE, WRITE_CLOCK_TABLE_DDL),
        (DB_LINEAGE_TABLE, DB_LINEAGE_TABLE_DDL),
    ] {
        let actual: Option<String> = rusqlite::OptionalExtension::optional(conn.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        ))?;
        match actual {
            Some(sql) if compact_ddl(&sql) == compact_ddl(ddl) => {}
            _ => return Ok(false),
        }
    }

    let has_global: bool = conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {WRITE_CLOCK_TABLE} WHERE name = ?1)"),
        [CLOCK_KEY_ALL],
        |row| row.get(0),
    )?;
    if !has_global {
        return Ok(false);
    }
    let lineage: Vec<String> = conn
        .prepare(&format!("SELECT id FROM {DB_LINEAGE_TABLE}"))?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;
    if lineage.len() != 1
        || lineage[0].len() != 32
        || !lineage[0].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Ok(false);
    }

    let expected: BTreeMap<String, String> = expected_clock_triggers(&clock_target_tables(conn)?)
        .into_iter()
        .map(|(name, sql)| (name, crate::workspace_schema::compact_sql(&sql)))
        .collect();
    let actual: BTreeMap<String, String> = conn
        .prepare(
            "SELECT name, sql FROM sqlite_master
              WHERE type = 'trigger' AND name GLOB 'grimodex_clock_*'",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .map(|row| {
            row.map(|(name, sql)| {
                (
                    name,
                    sql.map(|sql| crate::workspace_schema::compact_sql(&sql))
                        .unwrap_or_default(),
                )
            })
        })
        .collect::<Result<_, _>>()?;
    Ok(actual == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUDIT_DDL: &str =
        "CREATE TABLE ai_audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)";

    /// 実表の fixture（FK の CASCADE／SET NULL、AUTOINCREMENT、audit 表）。
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("fk");
        conn.execute_batch(&format!(
            "CREATE TABLE parents (id TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE kids (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL
                REFERENCES parents(id) ON DELETE CASCADE ON UPDATE CASCADE);
             CREATE TABLE orphans (id TEXT PRIMARY KEY, parent_id TEXT
                REFERENCES parents(id) ON DELETE SET NULL ON UPDATE CASCADE);
             CREATE TABLE counters (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER);
             CREATE TABLE source_rows (id TEXT PRIMARY KEY);
             {AUDIT_DDL};"
        ))
        .expect("fixture schema");
        conn
    }

    fn install(conn: &Connection) {
        conn.execute_batch(WRITE_CLOCK_TABLE_DDL)
            .expect("clock ddl");
        conn.execute_batch(DB_LINEAGE_TABLE_DDL)
            .expect("lineage ddl");
        conn.execute(
            "INSERT INTO grimodex_write_clock(name, seq) VALUES ('*', 0)",
            [],
        )
        .expect("seed global");
        conn.execute(
            "INSERT INTO grimodex_db_lineage(singleton, id) VALUES (1, ?1)",
            ["0123456789abcdef0123456789abcdef"],
        )
        .expect("seed lineage");
        let triggers = expected_clock_triggers(&clock_target_tables(conn).expect("targets"));
        for (_, sql) in triggers {
            conn.execute_batch(&sql).expect("create trigger");
        }
    }

    fn installed() -> Connection {
        let conn = fixture();
        install(&conn);
        conn
    }

    fn seq(conn: &Connection, key: &str) -> Option<i64> {
        rusqlite::OptionalExtension::optional(conn.query_row(
            "SELECT seq FROM grimodex_write_clock WHERE name = ?1",
            [key],
            |row| row.get(0),
        ))
        .expect("read seq")
    }

    #[test]
    fn write_clock_targets_exclude_virtual_shadow_sqlite_and_clock_tables() {
        let conn = fixture();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE scene_fts USING fts5(body);
             CREATE VIEW parent_view AS SELECT id FROM parents;
             CREATE TABLE scene_lens_data (id TEXT PRIMARY KEY);",
        )
        .expect("virtual, view, and a real table whose name ends in _data");
        conn.execute_batch(WRITE_CLOCK_TABLE_DDL).expect("clock");
        conn.execute_batch(DB_LINEAGE_TABLE_DDL).expect("lineage");
        conn.execute("INSERT INTO counters(v) VALUES (1)", [])
            .expect("create sqlite_sequence");
        // 前提：shadow と sqlite_sequence が本当に存在する。
        let listed: Vec<(String, String)> = conn
            .prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main'")
            .expect("list")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("map")
            .collect::<Result<_, _>>()
            .expect("rows");
        assert!(listed
            .iter()
            .any(|(n, t)| n == "scene_fts_data" && t == "shadow"));
        assert!(listed.iter().any(|(n, _)| n == "sqlite_sequence"));
        assert!(listed
            .iter()
            .any(|(n, t)| n == "scene_fts" && t == "virtual"));

        let targets = clock_target_tables(&conn).expect("targets");
        assert_eq!(
            targets,
            [
                "ai_audit_events",
                "counters",
                "kids",
                "orphans",
                "parents",
                "scene_lens_data",
                "source_rows"
            ]
        );
    }

    #[test]
    fn write_clock_targets_reject_unsafe_table_names() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("CREATE TABLE \"Bad-Name\" (id TEXT)")
            .expect("create");
        assert!(clock_target_tables(&conn).is_err());
    }

    #[test]
    fn write_clock_trigger_sql_never_references_new_or_old() {
        let tables: Vec<String> = ["ai_audit_events", "kids", "parents"]
            .into_iter()
            .map(String::from)
            .collect();
        let triggers = expected_clock_triggers(&tables);
        assert_eq!(triggers.len(), tables.len() * 3 + 1);
        let mut names = std::collections::BTreeSet::new();
        for (name, sql) in &triggers {
            assert!(names.insert(name.clone()), "duplicate trigger name {name}");
            assert!(name.starts_with(CLOCK_TRIGGER_PREFIX));
            if name == CLOCK_GUARD_TRIGGER {
                continue;
            }
            let upper = sql.to_ascii_uppercase();
            for word in upper.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
                assert!(word != "NEW" && word != "OLD", "{name} references {word}");
            }
        }
        let sql_of = |name: &str| {
            &triggers
                .iter()
                .find(|(n, _)| n == name)
                .unwrap_or_else(|| panic!("missing {name}"))
                .1
        };
        assert!(
            sql_of("grimodex_clock_ai_audit_events_ai").contains("SELECT 'ai_audit_events', seq")
        );
        assert!(sql_of("grimodex_clock_ai_audit_events_au")
            .contains("SELECT 'ai_audit_events!mutate', seq"));
        assert!(sql_of("grimodex_clock_ai_audit_events_ad")
            .contains("SELECT 'ai_audit_events!mutate', seq"));
        assert!(sql_of("grimodex_clock_kids_au").contains("SELECT 'kids', seq"));
        assert_eq!(triggers.last().expect("guard").0, CLOCK_GUARD_TRIGGER);
        // 入力の順序に依らない（決定的）。
        let mut reversed = tables.clone();
        reversed.reverse();
        assert_eq!(triggers, expected_clock_triggers(&reversed));
    }

    #[test]
    fn write_clock_invariant_accepts_a_complete_install() {
        let conn = installed();
        assert!(has_v46_write_clock(&conn).expect("inspect"));
    }

    #[test]
    fn write_clock_invariant_rejects_missing_extra_or_stale_trigger() {
        // 欠け
        let conn = installed();
        conn.execute_batch("DROP TRIGGER grimodex_clock_kids_ad")
            .expect("drop");
        assert!(!has_v46_write_clock(&conn).expect("missing trigger"));

        // guard の欠け
        let conn = installed();
        conn.execute_batch(&format!("DROP TRIGGER {CLOCK_GUARD_TRIGGER}"))
            .expect("drop guard");
        assert!(!has_v46_write_clock(&conn).expect("missing guard"));

        // 余り（古い表の trigger）
        let conn = installed();
        conn.execute_batch(
            "CREATE TRIGGER grimodex_clock_ghost_ai AFTER INSERT ON kids BEGIN SELECT 1; END",
        )
        .expect("extra");
        assert!(!has_v46_write_clock(&conn).expect("extra trigger"));

        // 新しい表に TRIGGER が無い
        let conn = installed();
        conn.execute_batch("CREATE TABLE late_table (id TEXT PRIMARY KEY)")
            .expect("new table");
        assert!(!has_v46_write_clock(&conn).expect("new table without trigger"));

        // SQL の差し替え（本体を空にする）
        let conn = installed();
        conn.execute_batch(
            "DROP TRIGGER grimodex_clock_parents_au;
             CREATE TRIGGER grimodex_clock_parents_au AFTER UPDATE ON \"parents\" BEGIN SELECT 1; END",
        )
        .expect("stale");
        assert!(!has_v46_write_clock(&conn).expect("stale trigger"));

        // 別の表に付け替える
        let conn = installed();
        let (_, sql) = expected_clock_triggers(&["parents".to_string()])
            .into_iter()
            .find(|(n, _)| n == "grimodex_clock_parents_ai")
            .expect("parents_ai");
        conn.execute_batch("DROP TRIGGER grimodex_clock_kids_ai")
            .expect("drop");
        conn.execute_batch(
            &sql.replace("grimodex_clock_parents_ai", "grimodex_clock_kids_ai")
                .replace("\"parents\"", "\"kids\""),
        )
        .expect("recreate with parents' key");
        assert!(!has_v46_write_clock(&conn).expect("wrong key"));
    }

    #[test]
    fn write_clock_invariant_rejects_missing_rows_and_wrong_tables() {
        let conn = installed();
        conn.execute_batch(&format!("DROP TRIGGER {CLOCK_GUARD_TRIGGER}"))
            .expect("drop guard to allow delete");
        conn.execute("DELETE FROM grimodex_write_clock WHERE name = '*'", [])
            .expect("delete global");
        assert!(!has_v46_write_clock(&conn).expect("missing global"));

        let conn = installed();
        conn.execute("DELETE FROM grimodex_db_lineage", [])
            .expect("delete lineage");
        assert!(!has_v46_write_clock(&conn).expect("missing lineage"));

        let conn = installed();
        // CHECK(length(id)=32) が書込みを拒否する。
        assert!(conn
            .execute("UPDATE grimodex_db_lineage SET id = 'short'", [])
            .is_err());
        conn.execute("UPDATE grimodex_db_lineage SET id = ?1", ["z".repeat(32)])
            .expect("32 non-hex chars pass the CHECK");
        assert!(!has_v46_write_clock(&conn).expect("non-hex lineage"));

        // 表の DDL が違う（CHECK が無い clock）
        let conn = fixture();
        conn.execute_batch(
            "CREATE TABLE grimodex_write_clock (name TEXT PRIMARY KEY, seq INTEGER NOT NULL) WITHOUT ROWID;",
        )
        .expect("weak clock");
        conn.execute_batch(DB_LINEAGE_TABLE_DDL).expect("lineage");
        conn.execute("INSERT INTO grimodex_write_clock VALUES ('*', 0)", [])
            .expect("seed");
        conn.execute(
            "INSERT INTO grimodex_db_lineage VALUES (1, '0123456789abcdef0123456789abcdef')",
            [],
        )
        .expect("seed lineage");
        for (_, sql) in expected_clock_triggers(&clock_target_tables(&conn).expect("targets")) {
            conn.execute_batch(&sql).expect("trigger");
        }
        assert!(!has_v46_write_clock(&conn).expect("weak clock ddl"));
    }

    #[test]
    fn previous_marker_without_write_clock_is_not_write_compatible() {
        // v45 の marker で、clock が無い DB は write 互換にならない。
        let conn = fixture();
        conn.pragma_update(
            None,
            "user_version",
            crate::PREVIOUS_COMPATIBLE_SCHEMA_VERSION,
        )
        .expect("stamp previous marker");
        assert!(!has_v46_write_clock(&conn).expect("no clock"));
        assert!(
            !crate::workspace_schema::is_previous_workspace_schema_write_compatible(&conn)
                .expect("previous compatibility")
        );
        assert!(
            !crate::workspace_schema::has_current_schema_checkpoint_invariants(&conn)
                .expect("current invariants")
        );
        // 現行の marker でも同じ。
        conn.pragma_update(None, "user_version", crate::SCHEMA_VERSION)
            .expect("stamp current marker");
        assert!(
            !crate::workspace_schema::has_current_schema_checkpoint_invariants(&conn)
                .expect("current invariants")
        );
    }

    #[test]
    fn clock_advances_on_cascade_set_null_update_cascade_replace_upsert_insert_select() {
        let conn = installed();
        let all = |c: &Connection| seq(c, "*").expect("global");

        let before = all(&conn);
        conn.execute("INSERT INTO parents(id) VALUES ('p1')", [])
            .expect("insert");
        assert_eq!(all(&conn), before + 1);
        assert_eq!(seq(&conn, "parents"), Some(before + 1));

        conn.execute("UPDATE parents SET v = 1 WHERE id = 'p1'", [])
            .expect("update");
        assert_eq!(all(&conn), before + 2);

        // INSERT .. SELECT：行ごとに進む。
        conn.execute_batch("INSERT INTO source_rows VALUES ('a'), ('b'), ('c')")
            .expect("seed");
        let s0 = all(&conn);
        conn.execute(
            "INSERT INTO kids(id, parent_id) SELECT id, 'p1' FROM source_rows",
            [],
        )
        .expect("insert select");
        assert_eq!(all(&conn), s0 + 3);
        assert_eq!(seq(&conn, "kids"), Some(s0 + 3));

        // UPDATE CASCADE（親の id の変更が子の UPDATE を起こす）。
        conn.execute("INSERT INTO orphans(id, parent_id) VALUES ('o1', 'p1')", [])
            .expect("orphan");
        let u0 = all(&conn);
        conn.execute("UPDATE parents SET id = 'p2' WHERE id = 'p1'", [])
            .expect("update cascade");
        assert!(all(&conn) > u0 + 1, "cascaded child updates also count");
        assert_eq!(
            conn.query_row("SELECT parent_id FROM kids WHERE id = 'a'", [], |r| r
                .get::<_, String>(0))
                .expect("cascaded"),
            "p2"
        );

        // INSERT OR REPLACE（既存行の置換）。
        let r0 = all(&conn);
        conn.execute("INSERT OR REPLACE INTO source_rows(id) VALUES ('a')", [])
            .expect("replace");
        assert!(all(&conn) > r0);
        assert!(seq(&conn, "source_rows").expect("table key") > r0);

        // UPSERT：衝突の側。
        let c0 = all(&conn);
        conn.execute(
            "INSERT INTO parents(id, v) VALUES ('p2', 9)
             ON CONFLICT(id) DO UPDATE SET v = excluded.v",
            [],
        )
        .expect("upsert conflict");
        assert!(all(&conn) > c0);
        // UPSERT：新規の側。
        let n0 = all(&conn);
        conn.execute(
            "INSERT INTO parents(id, v) VALUES ('p3', 1)
             ON CONFLICT(id) DO UPDATE SET v = excluded.v",
            [],
        )
        .expect("upsert insert");
        assert!(all(&conn) > n0);

        // ON DELETE SET NULL と ON DELETE CASCADE。
        let d0 = all(&conn);
        let kids0 = seq(&conn, "kids").expect("kids key");
        let orphans0 = seq(&conn, "orphans").expect("orphans key");
        conn.execute("DELETE FROM parents WHERE id = 'p2'", [])
            .expect("delete parent");
        assert_eq!(
            conn.query_row("SELECT count(*) FROM kids", [], |r| r.get::<_, i64>(0))
                .expect("count"),
            0
        );
        let orphan_is_null: bool = conn
            .query_row("SELECT parent_id IS NULL FROM orphans", [], |r| r.get(0))
            .expect("set null");
        assert!(orphan_is_null);
        // 親 1 + 子 3（CASCADE）+ orphan 1（SET NULL）。
        assert_eq!(all(&conn), d0 + 5);
        assert!(seq(&conn, "kids").expect("kids key") > kids0);
        assert!(seq(&conn, "orphans").expect("orphans key") > orphans0);
        // 表の鍵は、その表が最後に変わったときの '*' の値（親の AFTER DELETE は
        // FK の連鎖動作の後に走るので、親の鍵が最後）。
        assert_eq!(seq(&conn, "parents"), Some(d0 + 5));

        // 監査表：INSERT と UPDATE／DELETE で鍵が分かれる。
        conn.execute("INSERT INTO ai_audit_events(note) VALUES ('x')", [])
            .expect("audit insert");
        assert!(seq(&conn, "ai_audit_events").is_some());
        assert_eq!(seq(&conn, CLOCK_KEY_AUDIT_MUTATE), None);
        conn.execute("UPDATE ai_audit_events SET note = 'y'", [])
            .expect("audit update");
        let after_update = seq(&conn, CLOCK_KEY_AUDIT_MUTATE).expect("mutate key");
        assert_eq!(after_update, all(&conn));
        conn.execute("DELETE FROM ai_audit_events", [])
            .expect("audit delete");
        assert_eq!(seq(&conn, CLOCK_KEY_AUDIT_MUTATE), Some(all(&conn)));
        assert!(all(&conn) > after_update);
        assert_eq!(seq(&conn, "ai_audit_events"), Some(after_update - 1));

        // 行が欠けた表の鍵は、次の書込みで作り直される（自己修復）。
        conn.execute(
            "DELETE FROM grimodex_write_clock WHERE name = 'parents'",
            [],
        )
        .expect("delete table key");
        conn.execute("INSERT INTO parents(id) VALUES ('p4')", [])
            .expect("insert");
        assert_eq!(seq(&conn, "parents"), Some(all(&conn)));
    }

    #[test]
    fn clock_does_not_advance_on_rollback_or_savepoint_rollback() {
        let conn = installed();
        let before = seq(&conn, "*").expect("global");

        conn.execute_batch(
            "BEGIN;
             INSERT INTO parents(id) VALUES ('r1');
             ROLLBACK;",
        )
        .expect("rolled back");
        assert_eq!(seq(&conn, "*"), Some(before));
        assert_eq!(seq(&conn, "parents"), None);

        conn.execute_batch(
            "BEGIN;
             INSERT INTO parents(id) VALUES ('keep');
             SAVEPOINT inner;
             INSERT INTO parents(id) VALUES ('drop1');
             INSERT INTO parents(id) VALUES ('drop2');
             ROLLBACK TO inner;
             RELEASE inner;
             COMMIT;",
        )
        .expect("savepoint");
        assert_eq!(seq(&conn, "*"), Some(before + 1));
        assert_eq!(
            conn.query_row("SELECT count(*) FROM parents", [], |r| r.get::<_, i64>(0))
                .expect("count"),
            1
        );
    }

    #[test]
    fn clock_guard_rejects_deleting_the_global_key() {
        let conn = installed();
        let error = conn
            .execute("DELETE FROM grimodex_write_clock WHERE name = '*'", [])
            .expect_err("global key delete must abort");
        assert!(error.to_string().contains("global key"), "{error}");
        let error = conn
            .execute("DELETE FROM grimodex_write_clock", [])
            .expect_err("unqualified delete must abort too");
        assert!(error.to_string().contains("global key"), "{error}");
        assert!(seq(&conn, "*").is_some());
        // 表の鍵の削除は許す（自己修復できる）。
        conn.execute("INSERT INTO parents(id) VALUES ('p')", [])
            .expect("insert");
        conn.execute(
            "DELETE FROM grimodex_write_clock WHERE name = 'parents'",
            [],
        )
        .expect("table key delete is allowed");
    }

    #[test]
    fn clock_overflow_aborts_the_write_instead_of_wrapping() {
        let conn = installed();
        conn.execute(
            "UPDATE grimodex_write_clock SET seq = ?1 WHERE name = '*'",
            [i64::MAX],
        )
        .expect("seed max");
        let error = conn
            .execute("INSERT INTO parents(id) VALUES ('overflow')", [])
            .expect_err("seq + 1 becomes REAL and the CHECK aborts the write");
        assert!(error.to_string().contains("CHECK"), "{error}");
        assert_eq!(
            conn.query_row("SELECT count(*) FROM parents", [], |r| r.get::<_, i64>(0))
                .expect("count"),
            0,
            "the user's write is rolled back with the clock"
        );
        assert_eq!(seq(&conn, "*"), Some(i64::MAX));
    }
}
