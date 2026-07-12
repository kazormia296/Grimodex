//! M16 parity gate (DB health audit 2026-07): seed スクリプトのスキーマ
//! (`scripts/schema-seed-{ja,en}.sql`) が migrate.rs（正本）から乖離したら
//! CI を赤くする。seed スクリプト（Python）は同じ .sql を読み込むので、
//! この 1 ファイルが単一正本になる。
//!
//! DDL の完全一致比較は意図的にしない: seed の codex_fts（と同期 trigger
//! 3 本）は旧形状（content 列なし）で、起動時の migrate_codex_fts_add_content
//! が DROP+再作成+rebuild して吸収する設計のため（「seed が列を持たない」
//! 方向の差分は subset 検証に掛からない）。ゲートは 5 本:
//!   1. table/column subset — seed の全 table/column が from-scratch migrate
//!      済み DB に存在する（migrate が知らない table/column が seed に
//!      あれば superset 違反として即 fail）。
//!   2. index subset — seed の index 名が migrate の index 名の部分集合で
//!      ある（seed 発明の index / migrate が廃止した index の残存検出。
//!      migrate.rs に DROP INDEX の rescue は無いので残存は恒久化する）。
//!   3. trigger parity — seed の全 trigger が migrate に同名で存在し、
//!      正規化済み SQL 本体も一致する。名前だけの比較にしないのは、buggy
//!      trigger が CREATE TRIGGER IF NOT EXISTS で残存して専用 drop-migration
//!      を要した前歴が 2 回あるため（delete_cv / _en FTS）。
//!   4. apply-then-migrate — seed schema の上で本物の migrate() が完走し、
//!      foreign_key_check が空で、from-scratch migrate 済み DB と
//!      table/column（定義込み・双方向）/index/trigger が一致する
//!      （= Defer 判断の根拠「起動時 rebuild で救済される」の恒常検証。
//!      migrate.rs の base CREATE TABLE に列を足して add_column_if_missing
//!      の rescue を書き忘れる回帰もここで捕まえる）。
//!   5. column drift — seed に存在する列の DEFAULT / NOT NULL / 型宣言が
//!      migrate と一致する（phase_resolution_mode 'reading' ドリフトの
//!      再発防止）。
//!
//! EN seed は意図的に JA より小さい（chronicle/plot/calendar 非対応）ため、
//! EN=JA の一致は強制しない。各 seed を個別に migrate と突き合わせる。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::{schema_contract::inspect_connection, Database};

const SEED_SCHEMA_JA: &str = include_str!("../../../../scripts/schema-seed-ja.sql");
const SEED_SCHEMA_EN: &str = include_str!("../../../../scripts/schema-seed-en.sql");

/// DEFAULT/NOT NULL/型 ドリフトゲートの意図的差分 allowlist（(table, column)）。
/// 現状は空: seed の codex_fts 旧形状は「seed 側に列が無い」方向の差分なので
/// このゲートには掛からない（欠落列は起動時 rebuild が吸収）。migrate.rs と
/// 意図的に DEFAULT 等を変える場合のみここに追加し、理由をコメントすること。
const DRIFT_ALLOWLIST: &[(&str, &str)] = &[];

/// trigger 本体比較（ゲート3）の意図的差分 allowlist。
/// codex_fts_ai/ad/au: seed の codex_fts は意図的に旧形状（content 列なし）で、
/// 同期 trigger も旧形状のペアを保持する。migrate_codex_fts_add_content が
/// 起動時に 3 本とも DROP→新形状で再作成するため、ここでは本体比較を免除する
/// （同名 trigger の存在チェックは免除しない）。rescue 後に from-scratch と
/// 一致することはゲート4の trigger 一致検証が担保する。
const TRIGGER_ALLOWLIST: &[&str] = &["codex_fts_ai", "codex_fts_ad", "codex_fts_au"];

/// ゲート4(iii) の列定義比較（from-scratch vs migrate-on-seeded）の
/// 意図的差分 allowlist（(table, column)）。
/// foreshadows.secret: migrate.rs の base CREATE TABLE は DEFAULT 1（新規 DB の
/// 新規伏線は秘匿が既定 = schema.ts の default(true) と一致）だが、rescue の
/// add_column_if_missing は意図的に DEFAULT 0（列導入前から存在する既存レコード
/// を「表示」に倒す後方互換。migrate.rs の当該行コメント参照）。ALTER で付いた
/// 列 DEFAULT は恒久残存するため、旧 DB 由来（= seed 経由も同じ経路）の DB は
/// from-scratch と DEFAULT が一致しない。これは設計どおりの非対称。
/// lint_term_dictionary.project_id: base CREATE は NOT NULL FK だが、rescue は
/// 「ALTER では FK/NOT NULL を付けられないため列は nullable で追加し backfill
/// 後に孤児行を掃除する」設計（migrate.rs の当該行コメント参照）。同じく
/// 設計どおりの非対称。
const RESCUE_DRIFT_ALLOWLIST: &[(&str, &str)] = &[
    ("foreshadows", "secret"),
    ("lint_term_dictionary", "project_id"),
];

#[derive(Debug, PartialEq)]
struct ColumnInfo {
    decl_type: String,
    notnull: bool,
    dflt_value: Option<String>,
}

/// main スキーマの構造スナップショット。FTS5 の shadow テーブル
/// （codex_fts_data 等）と自動生成 index（sqlite_autoindex_*）は
/// 実装詳細なので除外する。
struct SchemaObjects {
    /// table/virtual テーブル名 → 列名 → 列定義。
    tables: BTreeMap<String, BTreeMap<String, ColumnInfo>>,
    /// 明示的に CREATE された index 名。
    indexes: BTreeSet<String>,
    /// trigger 名 → 空白正規化済みの CREATE TRIGGER SQL 本体。
    triggers: BTreeMap<String, String>,
}

fn snapshot(db: &Database) -> SchemaObjects {
    db.with_conn(|conn| {
        let contract = inspect_connection(conn)?;
        let tables = contract
            .tables
            .into_iter()
            .map(|(name, table)| {
                let columns = table
                    .columns
                    .into_iter()
                    .map(|(column_name, column)| {
                        (
                            column_name,
                            ColumnInfo {
                                decl_type: column.declared_type,
                                notnull: column.not_null,
                                dflt_value: column.default,
                            },
                        )
                    })
                    .collect();
                (name, columns)
            })
            .collect();
        let indexes = contract.indexes.into_keys().collect::<BTreeSet<_>>();
        let triggers = contract.triggers;

        Ok(SchemaObjects {
            tables,
            indexes,
            triggers,
        })
    })
    .expect("snapshot schema")
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
    for (table, seed_cols) in &seed.tables {
        let Some(mig_cols) = migrated.tables.get(table) else {
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

/// ゲート2: seed の index 名 ⊆ migrate の index 名。
/// migrate.rs には DROP INDEX の rescue が無いため、seed 発明の index や
/// migrate が廃止した index は起動時 migrate でも消えず恒久残存する。
fn assert_seed_indexes_are_subset_of_migrate(schema: &str, label: &str) {
    let seed = snapshot(&seeded_db(schema));
    let migrated = snapshot(&migrated_db());
    let unknown: Vec<&String> = seed.indexes.difference(&migrated.indexes).collect();
    assert!(
        unknown.is_empty(),
        "[{label}] seed indexes unknown to migrate.rs \
         (seed must be a subset of migrate; startup migrate never drops them): {unknown:?}"
    );
}

/// ゲート3: seed の全 trigger が migrate に同名で存在し、本体も一致する。
fn assert_seed_triggers_match_migrate(schema: &str, label: &str) {
    let seed = snapshot(&seeded_db(schema));
    let migrated = snapshot(&migrated_db());
    for (name, seed_sql) in &seed.triggers {
        let Some(mig_sql) = migrated.triggers.get(name) else {
            panic!(
                "[{label}] seed trigger '{name}' is unknown to migrate.rs \
                 (seed must be a subset of migrate)"
            );
        };
        if TRIGGER_ALLOWLIST.contains(&name.as_str()) {
            continue;
        }
        assert_eq!(
            seed_sql, mig_sql,
            "[{label}] trigger '{name}' body drift (seed vs migrate.rs; \
             CREATE TRIGGER IF NOT EXISTS does not replace an existing trigger, \
             so a stale seed body would persist — fix scripts/schema-seed-{label}.sql, \
             or add to TRIGGER_ALLOWLIST with a reason if a startup rescue rebuilds it)"
        );
    }
}

/// ゲート4: seed 適用済み DB の上で本物の migrate() が完走し、from-scratch
/// migrate 済み DB と同じ構造（table/column 定義・index・trigger）に収束する。
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
    // (iii) from-scratch migrate 済み DB と構造一致（双方向）。
    // テーブル名集合だけの比較では「migrate.rs の base CREATE TABLE に列を
    // 足して add_column_if_missing の rescue を書き忘れる」回帰（最頻）を
    // 検出できないため、列定義まで比較する。逆方向（seeded 側の余剰）も
    // 失敗 rebuild の残骸（_new 一時テーブル等）検出のため fail にする。
    let expected = snapshot(&migrated_db());
    let actual = snapshot(&db);

    let expected_tables: Vec<&String> = expected.tables.keys().collect();
    let actual_tables: Vec<&String> = actual.tables.keys().collect();
    assert_eq!(
        expected_tables, actual_tables,
        "[{label}] table set after migrate on seeded db differs from from-scratch migrate \
         (missing = rescue forgotten; extra = rebuild residue)"
    );
    for (table, exp_cols) in &expected.tables {
        let act_cols = &actual.tables[table];
        let exp_names: Vec<&String> = exp_cols.keys().collect();
        let act_names: Vec<&String> = act_cols.keys().collect();
        assert_eq!(
            exp_names, act_names,
            "[{label}] column set of '{table}' after migrate on seeded db differs from \
             from-scratch migrate (a missing column means the base CREATE TABLE gained a \
             column without an add_column_if_missing rescue)"
        );
        for (col, exp_info) in exp_cols {
            if RESCUE_DRIFT_ALLOWLIST.contains(&(table.as_str(), col.as_str())) {
                continue;
            }
            assert_eq!(
                &act_cols[col], exp_info,
                "[{label}] column '{table}.{col}' after migrate on seeded db differs from \
                 from-scratch migrate (the rescue path produced a different definition; \
                 if the divergence is intentional backwards-compat, add it to \
                 RESCUE_DRIFT_ALLOWLIST with a reason)"
            );
        }
    }
    assert_eq!(
        expected.indexes, actual.indexes,
        "[{label}] index set after migrate on seeded db differs from from-scratch migrate"
    );
    let expected_triggers: Vec<&String> = expected.triggers.keys().collect();
    let actual_triggers: Vec<&String> = actual.triggers.keys().collect();
    assert_eq!(
        expected_triggers, actual_triggers,
        "[{label}] trigger set after migrate on seeded db differs from from-scratch migrate"
    );
    for (name, exp_sql) in &expected.triggers {
        assert_eq!(
            &actual.triggers[name], exp_sql,
            "[{label}] trigger '{name}' after migrate on seeded db differs from from-scratch \
             migrate (a stale seed trigger survived IF NOT EXISTS — it needs a startup \
             drop-migration like the delete_cv / _en FTS precedents)"
        );
    }
}

/// ゲート5: seed に存在する列の DEFAULT / NOT NULL / 型宣言が migrate と一致する。
fn assert_no_column_drift(schema: &str, label: &str) {
    let seed = snapshot(&seeded_db(schema));
    let migrated = snapshot(&migrated_db());
    for (table, seed_cols) in &seed.tables {
        // テーブル自体の存在はゲート1が担保する。ここは共有列の定義差だけ見る。
        let Some(mig_cols) = migrated.tables.get(table) else {
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
fn ja_seed_indexes_are_subset_of_migrate() {
    assert_seed_indexes_are_subset_of_migrate(SEED_SCHEMA_JA, "ja");
}

#[test]
fn en_seed_indexes_are_subset_of_migrate() {
    assert_seed_indexes_are_subset_of_migrate(SEED_SCHEMA_EN, "en");
}

#[test]
fn ja_seed_triggers_match_migrate() {
    assert_seed_triggers_match_migrate(SEED_SCHEMA_JA, "ja");
}

#[test]
fn en_seed_triggers_match_migrate() {
    assert_seed_triggers_match_migrate(SEED_SCHEMA_EN, "en");
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
