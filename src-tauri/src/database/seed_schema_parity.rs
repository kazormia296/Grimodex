//! M16 parity gate (DB health audit 2026-07): seed スクリプトのスキーマ
//! (`scripts/schema-seed-{ja,en}.sql`) が migrate.rs（正本）から乖離したら
//! CI を赤くする。seed スクリプト（Python）は同じ .sql を読み込むので、
//! この 1 ファイルが単一正本になる。
//!
//! DDL の完全一致比較は意図的にしない: seed の codex_fts は旧形状
//! （content 列なし）で、起動時の migrate_codex_fts_add_content が
//! DROP+再作成+rebuild して吸収する設計のため（「seed が列を持たない」
//! 方向の差分は subset 検証に掛からない）。ゲートは 3 本:
//!   1. subset — seed の全 table/column が from-scratch migrate 済み DB に
//!      存在する（migrate が知らない table/column が seed にあれば
//!      superset 違反として即 fail）。
//!   2. apply-then-migrate — seed schema の上で本物の migrate() が完走し、
//!      foreign_key_check が空で、from-scratch と同じテーブル集合に到達する
//!      （= Defer 判断の根拠「起動時 rebuild で救済される」の恒常検証）。
//!   3. DEFAULT drift — seed に存在する列の DEFAULT / NOT NULL / 型宣言が
//!      migrate と一致する（phase_resolution_mode 'reading' ドリフトの
//!      再発防止）。
//!
//! EN seed は意図的に JA より小さい（chronicle/plot/calendar 非対応）ため、
//! EN=JA の一致は強制しない。各 seed を個別に migrate と突き合わせる。

use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::Connection;

use super::Database;

const SEED_SCHEMA_JA: &str = include_str!("../../../scripts/schema-seed-ja.sql");
const SEED_SCHEMA_EN: &str = include_str!("../../../scripts/schema-seed-en.sql");

/// DEFAULT/NOT NULL/型 ドリフトゲートの意図的差分 allowlist（(table, column)）。
/// 現状は空: seed の codex_fts 旧形状は「seed 側に列が無い」方向の差分なので
/// このゲートには掛からない（欠落列は起動時 rebuild が吸収）。migrate.rs と
/// 意図的に DEFAULT 等を変える場合のみここに追加し、理由をコメントすること。
const DRIFT_ALLOWLIST: &[(&str, &str)] = &[];

#[derive(Debug, PartialEq)]
struct ColumnInfo {
    decl_type: String,
    notnull: bool,
    dflt_value: Option<String>,
}

/// main スキーマの table/virtual → 列情報。FTS5 の shadow テーブル
/// （codex_fts_data 等）は実装詳細なので除外する。
fn snapshot(db: &Database) -> BTreeMap<String, BTreeMap<String, ColumnInfo>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT name FROM pragma_table_list \
             WHERE schema = 'main' AND type IN ('table', 'virtual') \
               AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        let mut tables = BTreeMap::new();
        for name in names {
            tables.insert(name.clone(), table_columns(conn, &name)?);
        }
        Ok(tables)
    })
    .expect("snapshot schema")
}

fn table_columns(conn: &Connection, table: &str) -> anyhow::Result<BTreeMap<String, ColumnInfo>> {
    let mut stmt =
        conn.prepare("SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info(?1)")?;
    let cols = stmt
        .query_map([table], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ColumnInfo {
                    decl_type: normalize_type(&row.get::<_, String>(1)?),
                    notnull: row.get::<_, bool>(2)?,
                    dflt_value: row.get::<_, Option<String>>(3)?,
                },
            ))
        })?
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    Ok(cols)
}

/// 型宣言の表記ゆれ（大文字小文字・空白）だけを吸収する。意味の違いは残す。
fn normalize_type(decl: &str) -> String {
    decl.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase()
}

fn migrated_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
    db.migrate().expect("from-scratch migrate");
    db
}

fn seeded_db(schema: &str) -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
    db.with_conn(|conn| {
        conn.execute_batch(schema)?;
        Ok(())
    })
    .expect("apply seed schema to in-memory db");
    db
}

/// ゲート1: seed ⊆ migrate（table/column の存在）。
fn assert_seed_is_subset_of_migrate(schema: &str, label: &str) {
    let seed = snapshot(&seeded_db(schema));
    let migrated = snapshot(&migrated_db());
    for (table, seed_cols) in &seed {
        let Some(mig_cols) = migrated.get(table) else {
            panic!(
                "[{label}] seed table '{table}' is unknown to migrate.rs \
                 (seed must be a subset of migrate)"
            );
        };
        for col in seed_cols.keys() {
            assert!(
                mig_cols.contains_key(col),
                "[{label}] seed column '{table}.{col}' is unknown to migrate.rs \
                 (seed must be a subset of migrate)"
            );
        }
    }
}

/// ゲート2: seed 適用済み DB の上で本物の migrate() が完走し、健全な状態に至る。
fn assert_migrate_completes_on_seeded_db(schema: &str, label: &str) {
    let db = seeded_db(schema);
    // (i) migrate() が Ok で完走する。
    db.migrate()
        .unwrap_or_else(|e| panic!("[{label}] migrate() failed on seeded db: {e:#}"));
    // (ii) 外部キー整合が壊れていない。
    let violations = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(format!(
                        "table={} rowid={:?} parent={}",
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .expect("run foreign_key_check");
    assert!(
        violations.is_empty(),
        "[{label}] foreign_key_check reported violations after migrate: {violations:?}"
    );
    // (iii) from-scratch migrate 済み DB の全テーブルに到達している。
    let after: Vec<String> = snapshot(&db).into_keys().collect();
    let missing: Vec<String> = snapshot(&migrated_db())
        .into_keys()
        .filter(|t| !after.contains(t))
        .collect();
    assert!(
        missing.is_empty(),
        "[{label}] tables missing after migrate on seeded db \
         (startup rebuild no longer rescues the seed): {missing:?}"
    );
}

/// ゲート3: seed に存在する列の DEFAULT / NOT NULL / 型宣言が migrate と一致する。
fn assert_no_column_drift(schema: &str, label: &str) {
    let seed = snapshot(&seeded_db(schema));
    let migrated = snapshot(&migrated_db());
    for (table, seed_cols) in &seed {
        // テーブル自体の存在はゲート1が担保する。ここは共有列の定義差だけ見る。
        let Some(mig_cols) = migrated.get(table) else {
            continue;
        };
        for (col, seed_info) in seed_cols {
            if DRIFT_ALLOWLIST.contains(&(table.as_str(), col.as_str())) {
                continue;
            }
            let Some(mig_info) = mig_cols.get(col) else {
                continue;
            };
            assert_eq!(
                seed_info, mig_info,
                "[{label}] column definition drift on '{table}.{col}' \
                 (seed vs migrate.rs; fix scripts/schema-seed-{label}.sql \
                 to match migrate.rs, or add to DRIFT_ALLOWLIST with a reason)"
            );
        }
    }
}

#[test]
fn ja_seed_schema_is_subset_of_migrate() {
    assert_seed_is_subset_of_migrate(SEED_SCHEMA_JA, "ja");
}

#[test]
fn en_seed_schema_is_subset_of_migrate() {
    assert_seed_is_subset_of_migrate(SEED_SCHEMA_EN, "en");
}

#[test]
fn migrate_completes_on_ja_seeded_db() {
    assert_migrate_completes_on_seeded_db(SEED_SCHEMA_JA, "ja");
}

#[test]
fn migrate_completes_on_en_seeded_db() {
    assert_migrate_completes_on_seeded_db(SEED_SCHEMA_EN, "en");
}

#[test]
fn ja_seed_columns_match_migrate_defaults() {
    assert_no_column_drift(SEED_SCHEMA_JA, "ja");
}

#[test]
fn en_seed_columns_match_migrate_defaults() {
    assert_no_column_drift(SEED_SCHEMA_EN, "en");
}
