//! SQLite の物理スキーマを、CI と生成資料で利用できる安定した契約へ変換する。
//!
//! このモジュールは migration の代替ではない。fresh な migration 済み DB、seed
//! 済み DB、Drizzle/browser の projection を比較するための観測面であり、SQL の
//! 意味を変更しない。

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// migration 後の SQLite schema の構造契約。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaContract {
    pub schema_version: i32,
    pub tables: BTreeMap<String, TableContract>,
    pub indexes: BTreeMap<String, IndexContract>,
    pub triggers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableContract {
    /// `table` または FTS5 などの `virtual`。
    pub kind: String,
    pub columns: BTreeMap<String, ColumnContract>,
    pub foreign_keys: Vec<ForeignKeyContract>,
    pub unique_constraints: Vec<UniqueConstraintContract>,
    pub create_sql: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnContract {
    pub ordinal: i32,
    pub declared_type: String,
    pub not_null: bool,
    pub default: Option<String>,
    /// SQLite の PK 順序。0 は PK ではない。
    pub primary_key: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyContract {
    pub id: i32,
    pub sequence: i32,
    pub table: String,
    pub from: String,
    pub to: Option<String>,
    pub on_update: String,
    pub on_delete: String,
    #[serde(rename = "match")]
    pub match_rule: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexContract {
    pub table: String,
    pub unique: bool,
    pub partial: bool,
    pub columns: Vec<IndexColumnContract>,
    pub create_sql: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexColumnContract {
    pub ordinal: i32,
    pub column: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueConstraintContract {
    pub columns: Vec<String>,
}

/// `main` schema のユーザー定義オブジェクトを検査する。
pub fn inspect_connection(conn: &Connection) -> anyhow::Result<SchemaContract> {
    let schema_version = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    let mut tables = BTreeMap::new();
    let mut table_stmt = conn.prepare(
        "SELECT name, type FROM pragma_table_list \
         WHERE schema = 'main' AND type IN ('table', 'virtual') \
           AND name NOT LIKE 'sqlite_%' \
         ORDER BY name",
    )?;
    let table_rows = table_stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    for row in table_rows {
        let (name, kind) = row?;
        let create_sql = conn
            .query_row(
                "SELECT sql FROM sqlite_master \
                 WHERE type IN ('table', 'view') AND name = ?1",
                [&name],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();

        tables.insert(
            name.clone(),
            TableContract {
                kind,
                columns: table_columns(conn, &name)?,
                foreign_keys: table_foreign_keys(conn, &name)?,
                unique_constraints: table_unique_constraints(conn, &name)?,
                create_sql: create_sql.map(|sql| normalize_sql(&sql)),
            },
        );
    }

    let indexes = table_indexes(conn)?;
    let triggers = schema_triggers(conn)?;

    Ok(SchemaContract {
        schema_version,
        tables,
        indexes,
        triggers,
    })
}

fn table_columns(
    conn: &Connection,
    table: &str,
) -> anyhow::Result<BTreeMap<String, ColumnContract>> {
    let mut stmt = conn.prepare(
        "SELECT cid, name, type, \"notnull\", dflt_value, pk \
         FROM pragma_table_info(?1) ORDER BY cid",
    )?;
    let rows = stmt.query_map([table], |row| {
        Ok((
            row.get::<_, String>(1)?,
            ColumnContract {
                ordinal: row.get(0)?,
                declared_type: normalize_type(&row.get::<_, String>(2)?),
                not_null: row.get(3)?,
                default: row.get(4)?,
                primary_key: row.get(5)?,
            },
        ))
    })?;

    rows.collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(Into::into)
}

fn table_foreign_keys(conn: &Connection, table: &str) -> anyhow::Result<Vec<ForeignKeyContract>> {
    let mut stmt = conn.prepare(
        "SELECT id, seq, \"table\", \"from\", \"to\", on_update, on_delete, \"match\" \
         FROM pragma_foreign_key_list(?1) ORDER BY id, seq",
    )?;
    let rows = stmt.query_map([table], |row| {
        Ok(ForeignKeyContract {
            id: row.get(0)?,
            sequence: row.get(1)?,
            table: row.get(2)?,
            from: row.get(3)?,
            to: row.get(4)?,
            on_update: row.get(5)?,
            on_delete: row.get(6)?,
            match_rule: row.get(7)?,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn table_unique_constraints(
    conn: &Connection,
    table: &str,
) -> anyhow::Result<Vec<UniqueConstraintContract>> {
    let mut index_stmt = conn.prepare(
        "SELECT name, origin FROM pragma_index_list(?1) \
         WHERE origin = 'u' ORDER BY seq",
    )?;
    let index_names = index_stmt
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    index_names
        .into_iter()
        .map(|index| {
            let columns = index_columns(conn, &index)?
                .into_iter()
                .map(|column| {
                    column.column.ok_or_else(|| {
                        anyhow::anyhow!(
                            "unique constraint {table}.{index} contains an expression column"
                        )
                    })
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            Ok(UniqueConstraintContract { columns })
        })
        .collect()
}

fn table_indexes(conn: &Connection) -> anyhow::Result<BTreeMap<String, IndexContract>> {
    let mut table_stmt = conn.prepare(
        "SELECT name FROM pragma_table_list \
         WHERE schema = 'main' AND type IN ('table', 'virtual') \
           AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let table_names = table_stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut indexes = BTreeMap::new();

    for table in table_names {
        let mut index_stmt = conn
            .prepare("SELECT name, \"unique\", partial FROM pragma_index_list(?1) ORDER BY seq")?;
        let index_rows = index_stmt.query_map([&table], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?;

        for index_row in index_rows {
            let (name, unique, partial) = index_row?;
            if name.starts_with("sqlite_autoindex_") {
                continue;
            }
            let columns = index_columns(conn, &name)?;
            let create_sql = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1",
                    [&name],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            indexes.insert(
                name,
                IndexContract {
                    table: table.clone(),
                    unique,
                    partial,
                    columns,
                    create_sql: create_sql.map(|sql| normalize_sql(&sql)),
                },
            );
        }
    }

    Ok(indexes)
}

fn index_columns(conn: &Connection, index: &str) -> anyhow::Result<Vec<IndexColumnContract>> {
    let mut stmt = conn.prepare("SELECT seqno, name FROM pragma_index_info(?1) ORDER BY seqno")?;
    let rows = stmt.query_map([index], |row| {
        Ok(IndexColumnContract {
            ordinal: row.get(0)?,
            column: row.get(1)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn schema_triggers(conn: &Connection) -> anyhow::Result<BTreeMap<String, String>> {
    let mut stmt = conn.prepare(
        "SELECT name, sql FROM sqlite_master \
         WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            normalize_sql(&row.get::<_, String>(1)?),
        ))
    })?;
    rows.collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(Into::into)
}

/// 型宣言の大文字小文字・空白だけを正規化する。
fn normalize_type(decl: &str) -> String {
    decl.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase()
}

/// sqlite_master の SQL を安定比較できるよう空白だけ正規化する。
fn normalize_sql(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}
