//! DR-CQA-7: the Codex rows the Scope extension reads through its two principal
//! joins are counted by `SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL`, which the query's
//! shared-read charge adds. The count must be what the extension's own read
//! makes: never fewer (a charge below the read is a loosening the approval does
//! not cover), and the same on every shape of principal, valid or not. The one
//! exception is a row the join drops after finding it (a ref to a character of
//! another project, or to an entry that is not a character), which the charge
//! does not count: a form that the ordinary paths cannot write
//! (`validate_principal_ownership`, `NEX_SCENE_SCOPE_CHARACTER_REFERENCED`) and
//! only a database written with its checks or foreign keys off can hold.

use std::path::Path;

use anyhow::Result;
use rusqlite::{params, Connection};

use super::*;
use crate::Database;

const NOW: &str = "2026-11-12T00:00:00.000Z";

/// p1: characters `c1` and `c2`, a location `l1`, and eight Scenes `s1`..`s8`
/// (every principal a reader). p2: a character `x1` and one Scene.
fn fixture() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        for project in ["p1", "p2"] {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES (?1, 'Project')",
                [project],
            )?;
        }
        for (id, project, kind) in [
            ("c1", "p1", "character"),
            ("c2", "p1", "character"),
            ("l1", "p1", "location"),
            ("x1", "p2", "character"),
        ] {
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name)
                 VALUES (?1, ?2, ?3, 'Entry')",
                params![id, project, kind],
            )?;
        }
        for (project, id) in [
            ("p1", "s1"),
            ("p1", "s2"),
            ("p1", "s3"),
            ("p1", "s4"),
            ("p1", "s5"),
            ("p1", "s6"),
            ("p1", "s7"),
            ("p1", "s8"),
            ("p2", "z1"),
        ] {
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
                 VALUES (?1, ?2, 'scene', 'Scene', ?1)",
                params![id, project],
            )?;
            ensure_scene_scope_binding_in_tx(
                conn,
                project,
                id,
                NOW,
                crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
            )?;
        }
        Ok(())
    })
    .expect("seed projects");
    db
}

fn character(reference: &str) -> String {
    format!(r#"{{"kind":"character","ref":"{reference}"}}"#)
}

fn set_principals(conn: &Connection, scene: &str, holder: &str, audience: &str) -> Result<()> {
    // The table's CHECK keeps a principal a JSON object. A database written
    // with the check off (a restore, a damaged file) can hold any text, and the
    // extension reads such a row all the same (`json_valid` guards the join), so
    // the shapes below include text the check would refuse.
    conn.execute_batch("PRAGMA ignore_check_constraints = ON")?;
    let changed = conn.execute(
        "UPDATE narrative_scene_scope_bindings
            SET knowledge_holder_json = ?1, audience_json = ?2
          WHERE scene_id = ?3",
        params![holder, audience, scene],
    )?;
    conn.execute_batch("PRAGMA ignore_check_constraints = OFF")?;
    assert_eq!(changed, 1);
    Ok(())
}

/// What the charge counts for `project`.
fn charged(conn: &Connection, project: &str) -> Result<i64> {
    Ok(
        conn.query_row(SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL, [project], |row| {
            row.get(0)
        })?,
    )
}

/// What the extension's read makes: the Codex rows its two `LEFT JOIN`s match,
/// which its own statement reports in the last two columns (a joined row is
/// `1`, none `0`). The extension is the statement that runs in a query.
fn read_by_the_extension(conn: &Connection, project: &str) -> Result<i64> {
    let mut statement = conn.prepare(SCOPE_EXTENSION_SQL)?;
    let rows = statement
        .query_map([project], |row| {
            Ok(row.get::<_, i64>(10)? + row.get::<_, i64>(11)?)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().sum())
}

/// Sets Scene `s1` of p1 to the principals and asserts the charge is `expected`
/// and equals what the extension reads, for p1 as a whole (the other Scenes are
/// readers).
fn assert_shape(holder: &str, audience: &str, expected: i64) {
    let db = fixture();
    db.with_conn(|conn| {
        set_principals(conn, "s1", holder, audience)?;
        let counted = charged(conn, "p1")?;
        assert_eq!(counted, expected, "{holder} / {audience}");
        assert_eq!(
            counted,
            read_by_the_extension(conn, "p1")?,
            "the charge is the extension's read: {holder} / {audience}"
        );
        Ok(())
    })
    .expect("shape");
}

#[test]
fn readers_name_no_codex_row() {
    let db = fixture();
    db.with_conn(|conn| {
        assert_eq!(charged(conn, "p1")?, 0);
        assert_eq!(read_by_the_extension(conn, "p1")?, 0);
        Ok(())
    })
    .expect("readers");
}

#[test]
fn a_holder_only_or_an_audience_only_is_one_row() {
    let reader = r#"{"kind":"reader"}"#;
    assert_shape(&character("c1"), reader, 1);
    assert_shape(reader, &character("c2"), 1);
}

#[test]
fn one_character_named_as_holder_and_audience_is_two_rows() {
    assert_shape(&character("c1"), &character("c1"), 2);
    assert_shape(&character("c1"), &character("c2"), 2);
}

#[test]
fn a_character_of_another_project_is_not_a_row() {
    // `x1` is a character, of p2: the join requires the binding's project.
    assert_shape(&character("x1"), &character("x1"), 0);
    assert_shape(&character("x1"), &character("c1"), 1);
}

#[test]
fn an_entry_that_is_not_a_character_is_not_a_row() {
    assert_shape(&character("l1"), &character("l1"), 0);
    assert_shape(&character("l1"), &character("c1"), 1);
}

#[test]
fn a_principal_without_a_usable_ref_is_not_a_row() {
    for unusable in [
        r#"{"kind":"character"}"#,
        r#"{"kind":"character","ref":null}"#,
        r#"{"kind":"character","ref":"missing"}"#,
        r#"{"kind":"character","ref":7}"#,
        r#"{"kind":"reader"}"#,
        "not json",
        "",
        "[]",
    ] {
        assert_shape(unusable, unusable, 0);
        // The same value beside a valid one leaves the valid one's row.
        assert_shape(unusable, &character("c1"), 1);
        assert_shape(&character("c1"), unusable, 1);
    }
}

/// A numeric `$.ref` is a number to `json_extract`, and a Codex row whose id
/// is the same digits is the row both statements find (the id column has TEXT
/// affinity, so `id = 7` compares as the text `'7'`): the charge and the
/// extension's read are the same on it, as on every shape.
#[test]
fn a_numeric_ref_names_the_codex_row_with_the_same_digits_in_both_statements() {
    let db = fixture();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name)
             VALUES ('7', 'p1', 'character', 'Seven')",
            [],
        )?;
        set_principals(
            conn,
            "s1",
            r#"{"kind":"character","ref":7}"#,
            r#"{"kind":"reader"}"#,
        )?;
        let counted = charged(conn, "p1")?;
        assert_eq!(counted, read_by_the_extension(conn, "p1")?);
        assert_eq!(counted, 1);
        // the digits as a string, and a number that no id has
        set_principals(
            conn,
            "s1",
            r#"{"kind":"character","ref":"7"}"#,
            r#"{"kind":"character","ref":8}"#,
        )?;
        assert_eq!(charged(conn, "p1")?, read_by_the_extension(conn, "p1")?);
        assert_eq!(charged(conn, "p1")?, 1);
        Ok(())
    })
    .expect("numeric ref");
}

#[test]
fn every_binding_counts_and_other_projects_do_not() {
    let db = fixture();
    db.with_conn(|conn| {
        let mut expected = 0;
        for (index, scene) in ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]
            .into_iter()
            .enumerate()
        {
            // Both principals the same character on even Scenes, holder only on
            // odd ones.
            let holder = character(if index % 2 == 0 { "c1" } else { "c2" });
            let audience = if index % 2 == 0 {
                character("c1")
            } else {
                r#"{"kind":"reader"}"#.to_owned()
            };
            set_principals(conn, scene, &holder, &audience)?;
            expected += if index % 2 == 0 { 2 } else { 1 };
        }
        // p2's Scene names p2's character, and p1's characters too: none of it
        // is p1's.
        set_principals(conn, "z1", &character("x1"), &character("c1"))?;
        assert_eq!(charged(conn, "p1")?, expected);
        assert_eq!(charged(conn, "p1")?, read_by_the_extension(conn, "p1")?);
        assert_eq!(charged(conn, "p2")?, 1);
        assert_eq!(charged(conn, "p2")?, read_by_the_extension(conn, "p2")?);
        assert_eq!(charged(conn, "no-such-project")?, 0);
        Ok(())
    })
    .expect("projects");
}

/// The equivalence is by construction (one text), and fixed here too: the
/// extension's joins and the charge's are the same two clauses, and the charge
/// reads the same binding rows the extension does.
#[test]
fn the_charge_and_the_extension_share_the_principal_joins() {
    let joins = |sql: &str| -> String {
        let from = sql.find("LEFT JOIN codex_entries kh").expect("kh join");
        let to = sql.find("WHERE b.project_id = ?1").expect("where");
        sql[from..to].trim_end().to_owned()
    };
    assert_eq!(
        joins(SCOPE_EXTENSION_SQL),
        joins(SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL)
    );
    assert_eq!(joins(SCOPE_EXTENSION_SQL).matches("LEFT JOIN").count(), 2);
    for sql in [SCOPE_EXTENSION_SQL, SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL] {
        assert!(sql.contains("FROM narrative_scene_scope_bindings b"));
        assert!(sql.contains("WHERE b.project_id = ?1"));
    }
    assert!(SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL.starts_with("SELECT COUNT(kh.id) + COUNT(au.id)"));
}

/// The counting statement seeks the binding rows of the project and each
/// Codex row by its key, as the extension's read does: its cost follows the
/// project's own rows.
#[test]
fn the_counting_statement_seeks_by_project_and_codex_key() {
    let db = fixture();
    db.with_conn(|conn| {
        let mut statement = conn.prepare(&format!(
            "EXPLAIN QUERY PLAN {SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL}"
        ))?;
        let plan = statement
            .query_map(["p1"], |row| row.get::<_, String>(3))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .join("\n");
        assert!(
            !plan.contains("TEMP B-TREE") && !plan.contains("AUTOMATIC"),
            "{plan}"
        );
        // The binding rows of the project by the project index, each Codex row
        // by its key (`id`), not by a scan.
        let line_of = |alias: &str| -> String {
            plan.lines()
                .find(|line| line.starts_with(&format!("SEARCH {alias} USING")))
                .unwrap_or_else(|| panic!("{alias} is sought, not scanned:\n{plan}"))
                .to_owned()
        };
        assert!(line_of("b").contains("(project_id=?)"), "{plan}");
        for alias in ["kh", "au"] {
            let line = line_of(alias);
            assert!(
                line.contains("sqlite_autoindex_codex_entries") && line.contains("(id=?)"),
                "{alias}: {plan}"
            );
        }
        Ok(())
    })
    .expect("plan");
}
