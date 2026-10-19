//! A9 (the veto sources) and A16 (its limits) at the function that the
//! writer, the preview and CB-4's reader share.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use rusqlite::{params, Connection};
use serde_json::json;

use super::*;
use crate::Database;

fn fixture() -> Database {
    let db = crate::test_support::current_schema_memory().expect("schema fixture");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p1', 'P');
             INSERT OR IGNORE INTO codex_types (id, project_id, slug, label)
               VALUES ('type-p1', 'p1', 'character', 'Character');
             INSERT INTO codex_entries (id, project_id, type, name)
               VALUES ('c1', 'p1', 'character', 'Hero');
             INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content)
             VALUES ('s1', 'p1', NULL, 'scene', 'One', 'a0', '{\"type\":\"doc\"}'),
                    ('s2', 'p1', NULL, 'scene', 'Two', 'a1', '{\"type\":\"doc\"}');",
        )?;
        Ok(())
    })
    .expect("seed");
    db
}

fn veto(db: &Database, scene: &str) -> anyhow::Result<Option<BodyDeclarationVeto>> {
    db.with_read_transaction(|conn| {
        scene_body_declaration_veto(conn, "p1", scene, VetoLimits::DEFAULT)
    })
}

fn verdict(db: &Database, scene: &str) -> Option<BodyDeclarationVeto> {
    veto(db, scene).expect("veto")
}

fn foreshadow(
    conn: &Connection,
    id: &str,
    secret: i64,
    abandoned: i64,
    payoff_scene: Option<&str>,
) {
    conn.execute(
        "INSERT INTO foreshadows (id, project_id, title, payoff_scene_id, secret, abandoned,
                                  payoff_confirmed, created_at, updated_at)
         VALUES (?1, 'p1', 'F', ?2, ?3, ?4, 1, 0, 0)",
        params![id, payoff_scene, secret, abandoned],
    )
    .unwrap();
}

fn setup(conn: &Connection, id: &str, foreshadow_id: &str, scene: &str, from: i64) {
    conn.execute(
        "INSERT INTO foreshadow_setups (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                                        semantic_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'plant', ?1, 0, 0)",
        params![id, foreshadow_id, scene, from, from + 1],
    )
    .unwrap();
}

fn payoff(conn: &Connection, id: &str, foreshadow_id: &str, scene: &str) {
    conn.execute(
        "INSERT INTO foreshadow_payoffs (id, foreshadow_id, scene_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, 0)",
        params![id, foreshadow_id, scene],
    )
    .unwrap();
}

fn event(conn: &Connection, id: &str, secret: i64, reveal_scene: Option<&str>) {
    conn.execute(
        "INSERT INTO events (id, project_id, secret, reveal_scene_id) VALUES (?1, 'p1', ?2, ?3)",
        params![id, secret, reveal_scene],
    )
    .unwrap();
}

#[test]
fn a_scene_with_no_record_has_no_veto() {
    let db = fixture();
    assert_eq!(verdict(&db, "s1"), None);
    // A scene that does not exist has no record either.
    assert_eq!(verdict(&db, "missing"), None);
}

#[test]
fn a_secret_foreshadow_setup_payoff_or_legacy_payoff_vetoes() {
    for (name, place) in [("legacy payoff", 0), ("setup", 1), ("payoff", 2)] {
        for abandoned in [0, 1] {
            let db = fixture();
            db.with_conn(|conn| {
                foreshadow(conn, "f1", 1, abandoned, (place == 0).then_some("s1"));
                if place == 1 {
                    setup(conn, "su1", "f1", "s1", 0);
                }
                if place == 2 {
                    payoff(conn, "pa1", "f1", "s1");
                }
                Ok(())
            })
            .unwrap();
            assert_eq!(
                verdict(&db, "s1"),
                Some(BodyDeclarationVeto::SecretForeshadow),
                "{name} abandoned={abandoned}"
            );
            assert_eq!(verdict(&db, "s2"), None, "{name}: another Scene is clear");
        }
    }
}

#[test]
fn a_foreshadow_that_is_not_secret_does_not_veto() {
    let db = fixture();
    db.with_conn(|conn| {
        foreshadow(conn, "f1", 0, 0, Some("s1"));
        setup(conn, "su1", "f1", "s1", 0);
        payoff(conn, "pa1", "f1", "s1");
        Ok(())
    })
    .unwrap();
    assert_eq!(verdict(&db, "s1"), None);
}

#[test]
fn a_secret_chronicle_event_vetoes_by_reveal_scene_or_by_link() {
    let db = fixture();
    db.with_conn(|conn| {
        event(conn, "e-secret", 1, Some("s1"));
        event(conn, "e-open", 0, Some("s2"));
        Ok(())
    })
    .unwrap();
    assert_eq!(
        verdict(&db, "s1"),
        Some(BodyDeclarationVeto::SecretEventReveal)
    );
    assert_eq!(
        verdict(&db, "s2"),
        None,
        "a non-secret reveal does not veto"
    );

    let db = fixture();
    db.with_conn(|conn| {
        event(conn, "e-secret", 1, None);
        event(conn, "e-open", 0, None);
        conn.execute(
            "INSERT INTO scene_events (scene_id, event_id) VALUES ('s1', 'e-secret'), ('s2', 'e-open')",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    // The link vetoes wherever the Scene sits in reading order.
    assert_eq!(
        verdict(&db, "s1"),
        Some(BodyDeclarationVeto::SecretEventLink)
    );
    assert_eq!(verdict(&db, "s2"), None);
}

#[test]
fn a_scene_pov_or_a_cached_beat_pov_vetoes() {
    let db = fixture();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET pov_character_id = 'c1' WHERE id = 's1'",
            [],
        )?;
        conn.execute(
            "INSERT INTO scene_beat_pov_cache (scene_id, pov_character_id) VALUES ('s2', 'c1')",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(verdict(&db, "s1"), Some(BodyDeclarationVeto::Pov));
    assert_eq!(verdict(&db, "s2"), Some(BodyDeclarationVeto::Pov));
}

fn set_content(db: &Database, scene: &str, content: serde_json::Value) {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET content = ?2 WHERE id = ?1",
            params![scene, content.to_string()],
        )?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn a_beat_pov_attribute_in_the_saved_body_vetoes() {
    let db = fixture();
    let beat = |attrs: serde_json::Value| {
        json!({"type": "doc", "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "x"}]},
            {"type": "blockquote", "content": [{"type": "sceneBeat", "attrs": attrs, "content": []}]},
        ]})
    };
    // attrs before type, deeply nested, string POV: a veto.
    set_content(&db, "s1", beat(json!({"id": "b1", "pov": "c1"})));
    assert_eq!(verdict(&db, "s1"), Some(BodyDeclarationVeto::Pov));
    // Key order does not matter.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET content = ?1 WHERE id = 's1'",
            [r#"{"type":"doc","content":[{"attrs":{"pov":"c1"},"content":[],"type":"sceneBeat"}]}"#],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(verdict(&db, "s1"), Some(BodyDeclarationVeto::Pov));
    // No pov, a null pov and an empty pov are not a POV.
    for attrs in [
        json!({"id": "b1"}),
        json!({"pov": null}),
        json!({"pov": ""}),
        json!({"pov": "  "}),
    ] {
        set_content(&db, "s1", beat(attrs.clone()));
        assert_eq!(verdict(&db, "s1"), None, "{attrs}");
    }
    // A pov attribute on a node that is not a beat is not a POV.
    set_content(
        &db,
        "s1",
        json!({"type": "doc", "content": [{"type": "paragraph", "attrs": {"pov": "c1"}}]}),
    );
    assert_eq!(verdict(&db, "s1"), None);
    // A pov of any other non-null shape fails closed.
    set_content(&db, "s1", beat(json!({"pov": 7})));
    assert_eq!(verdict(&db, "s1"), Some(BodyDeclarationVeto::Pov));
}

#[test]
fn rows_above_the_limit_are_an_error_and_never_a_verdict() {
    let db = fixture();
    db.with_conn(|conn| {
        foreshadow(conn, "f1", 0, 0, None);
        for index in 0..4 {
            setup(conn, &format!("su{index}"), "f1", "s1", index);
        }
        Ok(())
    })
    .unwrap();
    let run = |max_rows| {
        db.with_read_transaction(|conn| {
            scene_body_declaration_veto(
                conn,
                "p1",
                "s1",
                VetoLimits {
                    max_rows,
                    ..VetoLimits::DEFAULT
                },
            )
        })
    };
    // N rows are looked at; N + 1 are not.
    assert_eq!(run(4).unwrap(), None);
    let error = run(3).expect_err("N + 1 rows");
    assert!(error.to_string().contains(VETO_ROW_LIMIT_MARKER), "{error}");
    assert!(run(0).is_err());
    // A secret row inside the first N rows wins over a later limit.
    db.with_conn(|conn| {
        foreshadow(conn, "f2", 1, 0, None);
        setup(conn, "su-secret", "f2", "s1", 100);
        Ok(())
    })
    .unwrap();
    assert!(run(3).is_err(), "the first source still has 4 rows");
    // With the secret one first in its source and a budget that reaches it:
    let found = db
        .with_read_transaction(|conn| {
            scene_body_declaration_veto(
                conn,
                "p1",
                "s1",
                VetoLimits {
                    max_rows: 5,
                    ..VetoLimits::DEFAULT
                },
            )
        })
        .unwrap();
    assert_eq!(found, Some(BodyDeclarationVeto::SecretForeshadow));
}

#[test]
fn a_saved_body_above_the_limit_is_an_error_and_is_not_read() {
    let db = fixture();
    set_content(&db, "s1", json!({"type": "doc", "text": "x".repeat(2000)}));
    let error = db
        .with_read_transaction(|conn| {
            scene_body_declaration_veto(
                conn,
                "p1",
                "s1",
                VetoLimits {
                    max_content_bytes: 1000,
                    ..VetoLimits::DEFAULT
                },
            )
        })
        .expect_err("content above the limit");
    assert!(
        error.to_string().contains(VETO_CONTENT_LIMIT_MARKER),
        "{error}"
    );
}

#[test]
fn the_default_limits_are_the_documented_values() {
    assert_eq!(SCENE_BODY_VETO_MAX_ROWS, 512);
    assert_eq!(VetoLimits::DEFAULT.max_rows, 512);
    assert_eq!(
        VetoLimits::DEFAULT.max_content_bytes,
        SCENE_BODY_READ_MAX_BYTES
    );
    assert_eq!(SCENE_BODY_READ_MAX_BYTES, 64 * 1024);
    assert_eq!(SCENE_BODY_READ_PEAK_MAX_BYTES, 64 * 1024 * 1024);
}

// ---- the records part (CB-4 S1) ---------------------------------------------

fn records(
    db: &Database,
    scene: &str,
    max_rows: usize,
) -> anyhow::Result<super::veto::VetoRecordsRead> {
    db.with_read_transaction(|conn| {
        super::veto::scene_body_declaration_veto_records(conn, "p1", scene, max_rows)
    })
}

#[test]
fn the_records_part_agrees_with_the_full_veto_on_records_and_leaves_the_body_alone() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};

    // Every record source: the full veto and the records part give the same
    // verdict and the same row count behaviour.
    let db = fixture();
    db.with_conn(|conn| {
        foreshadow(conn, "f1", 1, 0, Some("s1"));
        event(conn, "e-secret", 1, Some("s2"));
        Ok(())
    })
    .unwrap();
    for scene in ["s1", "s2"] {
        assert_eq!(
            records(&db, scene, 512).unwrap().veto,
            verdict(&db, scene),
            "{scene}"
        );
    }

    // A beat POV lives only in the saved body: the full veto finds it, the
    // records part is not allowed to look.
    let db = fixture();
    set_content(
        &db,
        "s1",
        json!({"type": "doc", "content": [{"type": "sceneBeat", "attrs": {"pov": "c1"}}]}),
    );
    assert_eq!(verdict(&db, "s1"), Some(BodyDeclarationVeto::Pov));
    assert_eq!(records(&db, "s1", 512).unwrap().veto, None);

    // The records part does not even prepare a statement that names `content`.
    db.with_conn(|conn| {
        conn.authorizer(Some(|context: AuthContext<'_>| match context.action {
            AuthAction::Read {
                table_name,
                column_name,
            } if table_name == "tree_nodes" && column_name == "content" => Authorization::Deny,
            _ => Authorization::Allow,
        }))?;
        Ok(())
    })
    .unwrap();
    assert_eq!(records(&db, "s1", 512).unwrap().veto, None);
    assert!(
        db.with_read_transaction(|conn| {
            scene_body_declaration_veto(conn, "p1", "s1", VetoLimits::DEFAULT)
        })
        .is_err(),
        "the full veto does need the body"
    );
    db.with_conn(|conn| {
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn the_records_part_counts_the_rows_it_looked_at_and_fails_above_the_limit() {
    let db = fixture();
    db.with_conn(|conn| {
        foreshadow(conn, "f1", 0, 0, None);
        for index in 0..4 {
            setup(conn, &format!("su{index}"), "f1", "s1", index);
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(records(&db, "s1", 512).unwrap().rows_looked_at, 4);
    assert_eq!(records(&db, "s1", 4).unwrap().rows_looked_at, 4);
    let error = records(&db, "s1", 3).expect_err("N + 1 rows");
    assert!(error.to_string().contains(VETO_ROW_LIMIT_MARKER), "{error}");
    assert_eq!(records(&db, "s2", 512).unwrap().rows_looked_at, 0);
}
