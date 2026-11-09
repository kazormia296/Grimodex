//! DB の中の書込み連番（write clock）の表・TRIGGER・不変条件（DB 段 1 の PR-1、DR-DBC-3）。
//!
//! 生成関数と不変条件はここ（core）が正本。MCP の `schema_allows_writes` と
//! `has_current_schema_checkpoint_invariants` が core を使うため。install（冪等な
//! DROP＋CREATE、余分な `grimodex_clock_%` の削除）と lineage の作り直しは
//! grimodex-db が持つ。
//!
//! 連番は失効の合図であって authority ではない。TRIGGER の本体は `NEW`／`OLD` を
//! 参照しない（D2a で closed の表の Read 拒否に当たり、renderer の書込みが止まるため）。
//!
//! # TRIGGER の本体は 1 文（`'*'` の UPDATE だけ）
//!
//! 通常の表の AFTER INSERT／UPDATE／DELETE の本体は
//! `UPDATE grimodex_write_clock SET seq = seq + 1 WHERE name = '*'` の 1 文。保存の経路は
//! `prepare_cached` を使わず、文のたびに TRIGGER の本体を compile するので、本体の文数が
//! そのまま上乗せになる（gate G1 の実測。DR-DBC-3 の判断 3）。表ごとの鍵は 1b／1c まで
//! 見送り、足すときは TRIGGER の本体を差し替える migration で足す。例外は
//! `ai_audit_events` の AFTER UPDATE／DELETE で、監査の差分検証のために
//! [`CLOCK_KEY_AUDIT_MUTATE`] の行も `'*'` の値に揃える（2 文目）。
//!
//! `'*'` の行が欠けると 1 文の UPDATE は何もしない（連番が止まる）。これは guard の
//! TRIGGER（`'*'` の DELETE を拒否）と、install／[`has_v46_write_clock`]（`'*'` の行を要求）
//! が守る。
//!
//! # 既知の限界
//!
//! - 外側の文の `OR IGNORE` は TRIGGER の本体にも及ぶ。`'*'` が `i64::MAX` のとき
//!   `seq + 1` が REAL になって `CHECK` に落ちるが、`INSERT OR IGNORE` の中ではその
//!   書込みだけが無視され、clock だけが止まる（利用者の書込みは成功する）。seq は 0 から
//!   始まり到達不能で、信頼しない DB の取り込み（Web Editor）は seq を 0 に戻す。
//! - 名前の比較用の正規化（[`has_v46_write_clock`] の SQL 比較）は引用符の中の空白と
//!   大文字小文字も潰す。`weird name` と `weirdname` の TRIGGER は区別できない。

use std::collections::BTreeMap;

use rusqlite::Connection;

/// clock の表名。
pub const WRITE_CLOCK_TABLE: &str = "grimodex_write_clock";
/// lineage（DB の系譜 id）の表名。
pub const DB_LINEAGE_TABLE: &str = "grimodex_db_lineage";
/// clock の TRIGGER 名の接頭辞（`LIKE` ではなく GLOB で探す。`_` が wildcard になるため）。
pub const CLOCK_TRIGGER_PREFIX: &str = "grimodex_clock_";
/// 全体の連番の鍵。対象表（`clock_target_tables`。virtual・shadow を除く main の表）の
/// 行が変わると +1 される。FTS だけを書く処理や `PRAGMA optimize` では進まない。
pub const CLOCK_KEY_ALL: &str = "*";
/// 監査表の UPDATE／DELETE だけが、`'*'` の増分の後に同じ値で書く鍵（監査の差分検証用）。
/// 通常の表には表ごとの鍵は無い。
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
/// 除くもの：`sqlite_%`、clock の 2 表、virtual、shadow、view。名前は生のまま返す
/// （authorizer は引用符なしの名前で比べる）。SQL に入れるときは [`quote_identifier`] で
/// 引用する（大文字・空白・`"`・`'`・日本語の名前でも install が通る）。
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
    Ok(names)
}

/// SQL の識別子として `"` で囲む（内部の `"` は `""`）。
pub fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 表と event の組の TRIGGER 名（生の名前。authorizer が見る `sqlite_master.name` と同じ）。
/// 名前の規則はここだけが持ち、[`expected_clock_triggers`] と
/// [`expected_clock_trigger_names`] が共有する。
fn clock_trigger_name(table: &str, suffix: &str) -> String {
    format!("{CLOCK_TRIGGER_PREFIX}{table}_{suffix}")
}

/// `(suffix, SQL の event, 監査表なら鍵を足すか)`。
const CLOCK_EVENTS: [(&str, &str, bool); 3] = [
    ("ai", "INSERT", false),
    ("au", "UPDATE", true),
    ("ad", "DELETE", true),
];

fn sorted_tables(tables: &[String]) -> Vec<&String> {
    let mut sorted: Vec<&String> = tables.iter().collect();
    sorted.sort();
    sorted
}

/// 期待する clock の TRIGGER の名前だけ（SQL を作らない）。生の名前。
///
/// [`expected_clock_triggers`] と同じ名前・同じ順序（表の昇順、各表は `_ai`／`_au`／`_ad`、
/// 最後に guard）。renderer の authorizer が接続ごとに集合を作る費用を下げるための関数。
pub fn expected_clock_trigger_names(tables: &[String]) -> Vec<String> {
    let mut names = Vec::with_capacity(tables.len() * 3 + 1);
    for table in sorted_tables(tables) {
        for (suffix, _, _) in CLOCK_EVENTS {
            names.push(clock_trigger_name(table, suffix));
        }
    }
    names.push(CLOCK_GUARD_TRIGGER.to_string());
    names
}

/// 期待する clock の TRIGGER（名前と SQL）。純関数。
///
/// 表ごとに AFTER INSERT／UPDATE／DELETE の 3 本（`_ai`／`_au`／`_ad`）と、
/// clock 表に `'*'` の削除を拒否する guard を 1 本。名前の昇順で、guard は最後。
/// 本体は `'*'` の UPDATE の 1 文だけ。`ai_audit_events` の UPDATE／DELETE だけ、
/// 続けて [`CLOCK_KEY_AUDIT_MUTATE`] の行を `'*'` の値に揃える 2 文目を持つ。
/// TRIGGER 名と表名は常に引用する。SQL に末尾の `;` は付けない
/// （`sqlite_master.sql` と同じ形）。
pub fn expected_clock_triggers(tables: &[String]) -> Vec<(String, String)> {
    let mut triggers = Vec::with_capacity(tables.len() * 3 + 1);
    for table in sorted_tables(tables) {
        for (suffix, event, mutate) in CLOCK_EVENTS {
            let name = clock_trigger_name(table, suffix);
            let mut body = format!(
                "UPDATE {WRITE_CLOCK_TABLE} SET seq = seq + 1 WHERE name = '{CLOCK_KEY_ALL}'; "
            );
            if mutate && table == AUDIT_TABLE {
                body.push_str(&format!(
                    "INSERT INTO {WRITE_CLOCK_TABLE}(name, seq) \
                     SELECT '{CLOCK_KEY_AUDIT_MUTATE}', seq FROM {WRITE_CLOCK_TABLE} \
                     WHERE name = '{CLOCK_KEY_ALL}' \
                     ON CONFLICT(name) DO UPDATE SET seq = excluded.seq; "
                ));
            }
            let sql = format!(
                "CREATE TRIGGER {} AFTER {event} ON {} BEGIN {body}END",
                quote_identifier(&name),
                quote_identifier(table)
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

    /// 規則外の名前（大文字・空白・`"`・`'`・日本語）の表でも対象に含まれ、生の名前で返る。
    #[test]
    fn write_clock_targets_keep_unusual_table_names_raw() {
        let conn = Connection::open_in_memory().expect("open");
        for name in ["Notes", "weird name", "a\"b", "o'clock", "日本語の表"] {
            conn.execute_batch(&format!(
                "CREATE TABLE {} (id TEXT)",
                quote_identifier(name)
            ))
            .expect("create");
        }
        let mut expected = ["Notes", "a\"b", "o'clock", "weird name", "日本語の表"];
        expected.sort();
        assert_eq!(clock_target_tables(&conn).expect("targets"), expected);
    }

    /// 規則外の名前の表でも install が通り、書込みで `'*'` が進み、不変条件が成り立つ。
    #[test]
    fn write_clock_unusual_table_names_install_advance_and_pass_the_invariant() {
        let conn = fixture();
        let unusual = ["Notes", "weird name", "a\"b", "o'clock", "日本語の表"];
        for name in unusual {
            conn.execute_batch(&format!(
                "CREATE TABLE {} (id TEXT PRIMARY KEY, v INTEGER)",
                quote_identifier(name)
            ))
            .expect("create");
        }
        install(&conn);
        assert!(has_v46_write_clock(&conn).expect("invariant"));
        for name in unusual {
            let before = seq(&conn, "*").expect("global");
            let quoted = quote_identifier(name);
            conn.execute(&format!("INSERT INTO {quoted}(id, v) VALUES ('x', 1)"), [])
                .expect("insert");
            assert_eq!(seq(&conn, "*"), Some(before + 1), "insert into {name}");
            conn.execute(&format!("UPDATE {quoted} SET v = 2"), [])
                .expect("update");
            assert_eq!(seq(&conn, "*"), Some(before + 2), "update {name}");
            conn.execute(&format!("DELETE FROM {quoted}"), [])
                .expect("delete");
            assert_eq!(seq(&conn, "*"), Some(before + 3), "delete from {name}");
        }
        // 名前の集合は SQL を作らずに、生の名前で同じになる。
        let tables = clock_target_tables(&conn).expect("targets");
        let from_sql: Vec<String> = expected_clock_triggers(&tables)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(expected_clock_trigger_names(&tables), from_sql);
        let mut stored: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'grimodex_clock_*'")
            .expect("prepare")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        let mut expected_sorted = from_sql.clone();
        stored.sort();
        expected_sorted.sort();
        assert_eq!(stored, expected_sorted, "stored names are the raw names");
    }

    #[test]
    fn write_clock_trigger_names_match_the_sql_generator_in_the_same_order() {
        let tables: Vec<String> = ["zeta", "ai_audit_events", "Alpha", "kids"]
            .into_iter()
            .map(String::from)
            .collect();
        let from_sql: Vec<String> = expected_clock_triggers(&tables)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(expected_clock_trigger_names(&tables), from_sql);
        assert_eq!(
            from_sql.last().map(String::as_str),
            Some(CLOCK_GUARD_TRIGGER)
        );
        let mut reversed = tables.clone();
        reversed.reverse();
        assert_eq!(expected_clock_trigger_names(&reversed), from_sql);
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
        // 通常の表の本体は '*' の UPDATE の 1 文だけ（表ごとの鍵は無い）。
        let one_statement =
            "BEGIN UPDATE grimodex_write_clock SET seq = seq + 1 WHERE name = '*'; END";
        for name in [
            "grimodex_clock_kids_ai",
            "grimodex_clock_kids_au",
            "grimodex_clock_kids_ad",
            "grimodex_clock_parents_au",
            "grimodex_clock_ai_audit_events_ai",
        ] {
            let sql = sql_of(name);
            assert!(sql.contains(one_statement), "{name}: {sql}");
            assert_eq!(sql.matches(';').count(), 1, "{name} has one statement");
            assert!(!sql.contains("INSERT INTO"), "{name}");
        }
        // 監査表の UPDATE／DELETE だけ、mutate の鍵を持つ 2 文目がある。
        for name in [
            "grimodex_clock_ai_audit_events_au",
            "grimodex_clock_ai_audit_events_ad",
        ] {
            let sql = sql_of(name);
            assert!(
                sql.contains("SELECT 'ai_audit_events!mutate', seq"),
                "{name}"
            );
            assert_eq!(sql.matches(';').count(), 2, "{name} has two statements");
        }
        // 表名と TRIGGER 名は常に引用する。
        assert!(sql_of("grimodex_clock_kids_au")
            .starts_with("CREATE TRIGGER \"grimodex_clock_kids_au\" AFTER UPDATE ON \"kids\""));
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

        // 別の表に付け替える（名前は kids のまま、ON が parents）。
        let conn = installed();
        let (_, sql) = expected_clock_triggers(&["kids".to_string()])
            .into_iter()
            .find(|(n, _)| n == "grimodex_clock_kids_ai")
            .expect("kids_ai");
        conn.execute_batch("DROP TRIGGER grimodex_clock_kids_ai")
            .expect("drop");
        conn.execute_batch(&sql.replace("ON \"kids\"", "ON \"parents\""))
            .expect("recreate attached to parents");
        assert!(!has_v46_write_clock(&conn).expect("wrong table"));

        // audit の mutate の鍵が無い（通常の本体にすり替えた）。
        let conn = installed();
        conn.execute_batch(
            "DROP TRIGGER grimodex_clock_ai_audit_events_au;
             CREATE TRIGGER \"grimodex_clock_ai_audit_events_au\" AFTER UPDATE ON \"ai_audit_events\" BEGIN \
             UPDATE grimodex_write_clock SET seq = seq + 1 WHERE name = '*'; END",
        )
        .expect("plain body on the audit trigger");
        assert!(!has_v46_write_clock(&conn).expect("audit trigger without the mutate key"));

        // 本体の '*' が別の鍵になっている。
        let conn = installed();
        conn.execute_batch(
            "DROP TRIGGER grimodex_clock_kids_ai;
             CREATE TRIGGER \"grimodex_clock_kids_ai\" AFTER INSERT ON \"kids\" BEGIN \
             UPDATE grimodex_write_clock SET seq = seq + 1 WHERE name = 'kids'; END",
        )
        .expect("wrong key");
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
        // 通常の表には表ごとの鍵が無い（'*' だけ）。
        assert_eq!(seq(&conn, "parents"), None);

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

        // 監査表：INSERT は '*' だけ。UPDATE／DELETE は '*' の増分の後に mutate の鍵を揃える。
        conn.execute("INSERT INTO ai_audit_events(note) VALUES ('x')", [])
            .expect("audit insert");
        assert_eq!(seq(&conn, CLOCK_KEY_AUDIT_MUTATE), None);
        let after_insert = all(&conn);
        conn.execute("UPDATE ai_audit_events SET note = 'y'", [])
            .expect("audit update");
        assert_eq!(all(&conn), after_insert + 1);
        assert_eq!(seq(&conn, CLOCK_KEY_AUDIT_MUTATE), Some(all(&conn)));
        let after_update = all(&conn);
        conn.execute("DELETE FROM ai_audit_events", [])
            .expect("audit delete");
        assert_eq!(all(&conn), after_update + 1);
        assert_eq!(seq(&conn, CLOCK_KEY_AUDIT_MUTATE), Some(all(&conn)));

        // 通常の表の書込みでは mutate の鍵は動かない。
        let mutate = seq(&conn, CLOCK_KEY_AUDIT_MUTATE);
        conn.execute("INSERT INTO parents(id) VALUES ('p4')", [])
            .expect("insert");
        assert_eq!(seq(&conn, CLOCK_KEY_AUDIT_MUTATE), mutate);

        // 表ごとの鍵は '*' と mutate 以外に作られない。
        let keys: Vec<String> = conn
            .prepare("SELECT name FROM grimodex_write_clock ORDER BY name")
            .expect("prepare")
            .query_map([], |r| r.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows");
        assert_eq!(keys, ["*", CLOCK_KEY_AUDIT_MUTATE]);
    }

    /// 1 文の UPDATE は `'*'` の行が無いと何もしない。guard が削除を拒否し、
    /// install／不変条件が行の欠けを検出する（ここでは guard を外して欠けを作る）。
    #[test]
    fn clock_stops_silently_when_the_global_row_is_missing_but_the_invariant_catches_it() {
        let conn = installed();
        conn.execute_batch(&format!("DROP TRIGGER {CLOCK_GUARD_TRIGGER}"))
            .expect("drop guard");
        conn.execute("DELETE FROM grimodex_write_clock WHERE name = '*'", [])
            .expect("delete global");
        conn.execute("INSERT INTO parents(id) VALUES ('p')", [])
            .expect("the user's write succeeds");
        assert_eq!(
            seq(&conn, "*"),
            None,
            "the one-statement UPDATE does nothing"
        );
        assert!(!has_v46_write_clock(&conn).expect("invariant detects the missing row"));
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
        // '*' 以外の鍵（audit の mutate）の削除は許す。
        conn.execute("UPDATE ai_audit_events SET note = 'x'", [])
            .expect("no rows, no trigger");
        conn.execute("INSERT INTO ai_audit_events(note) VALUES ('x')", [])
            .expect("insert");
        conn.execute("UPDATE ai_audit_events SET note = 'y'", [])
            .expect("update creates the mutate key");
        conn.execute(
            "DELETE FROM grimodex_write_clock WHERE name = 'ai_audit_events!mutate'",
            [],
        )
        .expect("a non-global key delete is allowed");
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

    /// 既知の限界（モジュール doc）：外側の `OR IGNORE` は TRIGGER の本体にも及ぶので、
    /// `'*'` が `i64::MAX` のとき clock の更新だけが無視される（利用者の書込みは成功する）。
    #[test]
    fn clock_overflow_under_or_ignore_stops_the_clock_but_not_the_write() {
        let conn = installed();
        conn.execute(
            "UPDATE grimodex_write_clock SET seq = ?1 WHERE name = '*'",
            [i64::MAX],
        )
        .expect("seed max");
        conn.execute("INSERT OR IGNORE INTO parents(id) VALUES ('ignored')", [])
            .expect("the write itself succeeds");
        assert_eq!(
            conn.query_row("SELECT count(*) FROM parents", [], |r| r.get::<_, i64>(0))
                .expect("count"),
            1
        );
        assert_eq!(seq(&conn, "*"), Some(i64::MAX), "the clock did not move");
    }
}
