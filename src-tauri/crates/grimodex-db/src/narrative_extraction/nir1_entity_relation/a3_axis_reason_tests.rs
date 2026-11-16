//! PUB-G 前提 #6（DR-PUBG-6-1）：A3 の Scope 軸の「名指しで固定されていない理由」を、
//! 公開の evaluate の経由で 1 つずつ固定する。
//!
//! s7r2 の製品経路で出た A3 の不適格の理由は 5 種だけで、POV・phase・story-scope・
//! auto-scope・query 軸の理由は Rust の試験でだけ確かめている。ここは、それまで
//! 名指しの assert が無かった理由（a3-pov-unavailable、a3-phase-ambiguous、
//! a3-phase-anchor-unavailable、a3-story-scope-unavailable、a3-auto-scope-future、
//! a3-auto-scope-unavailable、a3-query-scene-unavailable）と、a3-entity-unavailable の
//! 前に立つ門（A2）の観測を足す。各軸は、対照（Eligible）と、理由が出る場合の対で固定する。
//!
//! 実行されるコードは変えない（親の `nir1_entity_relation.rs` には `#[cfg(test)] mod` の宣言だけを足す）。story／auto／POV の Scope は prepare が作らない形なので、
//! 他の A3 の軸の試験と同じく `RelaxedScopeShape` を持つ。

use anyhow::Result;
use grimodex_core::narrative_nir1::{EntityInput, ScopeValue};
use rusqlite::Connection;

use super::tests::{
    approve_typed_revision, prepare_a3_scope_fixture, rebind_scope_tokens, request,
    seed_run_and_catalog,
};
use super::{
    create_nir1_entity_relation_revision, evaluate_nir1_entity_relation_disclosure,
    Nir1EntityRelationDisclosureRead,
};
use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
use crate::test_support::fresh_migrated_memory;
use crate::Database;

const PROJECT: &str = "default-project";

/// 理由の読み。`None` は Eligible。
type Reason = Option<String>;

fn read_reason(db: &Database, revision_id: &str, query_scene_id: &str) -> Result<Reason> {
    let read = db.with_read_transaction(|conn| {
        evaluate_nir1_entity_relation_disclosure(conn, PROJECT, revision_id, query_scene_id)
    })?;
    Ok(match read {
        Nir1EntityRelationDisclosureRead::Eligible(_) => None,
        Nir1EntityRelationDisclosureRead::Unavailable { reason } => Some(reason),
    })
}

/// a3-source（reading rank 0）の Scope を持つ 2 つの Entity を approved の
/// revision にして返す。`setup` は DB を A3 の fixture に足し、`customize` は各 Entity の
/// Scope を作り替える。
fn approved_revision(
    setup: impl FnOnce(&Connection) -> Result<()>,
    customize: impl Fn(&mut EntityInput),
) -> Result<(Database, String)> {
    let db = fresh_migrated_memory()?;
    seed_run_and_catalog(&db)?;
    prepare_a3_scope_fixture(&db)?;
    db.with_conn(|conn| setup(conn))?;
    run_incremental_freshness_cycle(&db)?;

    let mut typed_request = request(&db);
    for entity in &mut typed_request.bundle.entities {
        entity.scope.reading = ScopeValue::Exact {
            value: "scene:a3-source".into(),
        };
        customize(entity);
    }
    rebind_scope_tokens(&db, &mut typed_request)?;
    let created = create_nir1_entity_relation_revision(&db, typed_request)?;
    approve_typed_revision(&db, "nir1-run", &created)?;
    let revision_id = created["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("typed revision id missing"))?
        .to_owned();
    Ok((db, revision_id))
}

fn set_story_keys(conn: &Connection, keys: [(&str, Option<&str>); 3], mode: &str) -> Result<()> {
    for (scene_id, story_key) in keys {
        conn.execute(
            "UPDATE tree_nodes SET story_time_order = ?1
              WHERE id = ?2 AND project_id = 'default-project'",
            rusqlite::params![story_key, scene_id],
        )?;
    }
    conn.execute(
        "UPDATE projects SET phase_resolution_mode = ?1 WHERE id = 'default-project'",
        [mode],
    )?;
    Ok(())
}

// ---- POV ------------------------------------------------------------------

/// 実体の POV は、可視でも character でなければ `a3-pov-unavailable`（mismatch ではない）。
/// query の viewpoint は別の可視 character で、query 側の門は通っている。
#[test]
fn a3_pov_that_is_not_a_visible_character_is_unavailable_not_mismatch() -> Result<()> {
    let _relaxed = super::tests_scope_shape::RelaxedScopeShape::hold();
    let insert_entry = |conn: &Connection, id: &str, kind: &str, mode: &str| -> Result<()> {
        conn.execute(
            "INSERT INTO codex_entries
                (id, project_id, type, name, summary, context_mode, updated_at)
             VALUES (?1, 'default-project', ?2, ?1, ?1, ?3, '2026-09-17T00:00:00Z')",
            rusqlite::params![id, kind, mode],
        )?;
        Ok(())
    };
    let query_viewpoint_is_alice = |conn: &Connection| -> Result<()> {
        conn.execute(
            "UPDATE tree_nodes SET pov_character_id = 'nir1-alice'
              WHERE id = 'nir1' AND project_id = 'default-project'",
            [],
        )?;
        Ok(())
    };

    // 対照：query と同じ可視の character は Eligible。
    let (db, revision) = approved_revision(
        |conn| {
            insert_entry(conn, "pov-extra", "character", "always")?;
            query_viewpoint_is_alice(conn)
        },
        |entity| entity.scope.pov = Some("nir1-alice".into()),
    )?;
    assert_eq!(read_reason(&db, &revision, "nir1")?, None);

    // 可視だが character ではない POV。
    let (db, revision) = approved_revision(
        |conn| {
            insert_entry(conn, "pov-place", "location", "always")?;
            query_viewpoint_is_alice(conn)
        },
        |entity| entity.scope.pov = Some("pov-place".into()),
    )?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?.as_deref(),
        Some("a3-pov-unavailable")
    );

    // 隠された POV は、公開の evaluate では A3 の POV の門でなく `source-revision-changed`
    // （A2 の `validate_scope_binding` の POV の可視の確認。観測）。
    let (db, revision) = approved_revision(
        |conn| {
            insert_entry(conn, "pov-extra", "character", "always")?;
            query_viewpoint_is_alice(conn)
        },
        |entity| entity.scope.pov = Some("pov-extra".into()),
    )?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?.as_deref(),
        Some("a3-pov-mismatch"),
        "可視の別の character は unavailable でなく mismatch"
    );
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE codex_entries SET context_mode = 'hidden' WHERE id = 'pov-extra'",
            [],
        )?;
        Ok(())
    })?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?.as_deref(),
        Some("source-revision-changed")
    );
    Ok(())
}

// ---- phase ----------------------------------------------------------------

fn insert_phase(
    conn: &Connection,
    id: &str,
    entry_id: &str,
    anchor: Option<&str>,
    label: &str,
    created_at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO codex_entry_phases
            (id, entry_id, anchor_node_id, label, created_at, updated_at, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, 0)",
        rusqlite::params![id, entry_id, anchor, label, created_at],
    )?;
    Ok(())
}

/// 同じ label の phase が同じ Entity に 2 つあれば、どちらも選ばず `a3-phase-ambiguous`。
#[test]
fn a3_phase_label_matching_two_phases_is_ambiguous() -> Result<()> {
    let (db, revision) = approved_revision(
        |conn| {
            insert_phase(
                conn,
                "a3-same-1",
                "nir1-alice",
                Some("a3-source"),
                "same",
                "2026-09-17T00:00:10.000Z",
            )
        },
        |entity| {
            if entity.entity_id == "nir1-alice" {
                entity.scope.phase = "same".into();
            }
        },
    )?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?,
        None,
        "対照：phase は 1 つ"
    );

    db.with_conn(|conn| {
        insert_phase(
            conn,
            "a3-same-2",
            "nir1-alice",
            Some("a3-source"),
            "same",
            "2026-09-17T00:00:11.000Z",
        )
    })?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?.as_deref(),
        Some("a3-phase-ambiguous")
    );
    Ok(())
}

/// 選んだ phase の anchor が無い（NULL）か、Scope authority の Scene でなければ
/// `a3-phase-anchor-unavailable`。
#[test]
fn a3_phase_whose_anchor_is_missing_or_not_a_scene_is_anchor_unavailable() -> Result<()> {
    let (db, revision) = approved_revision(
        |conn| {
            insert_phase(
                conn,
                "a3-anchor",
                "nir1-alice",
                Some("a3-source"),
                "anchored",
                "2026-09-17T00:00:10.000Z",
            )
        },
        |entity| {
            if entity.entity_id == "nir1-alice" {
                entity.scope.phase = "anchored".into();
            }
        },
    )?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?,
        None,
        "対照：anchor は Scene"
    );

    // anchor が NULL（Scene を消す `ON DELETE SET NULL` と同じ状態）。
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE codex_entry_phases SET anchor_node_id = NULL, version = version + 1
              WHERE id = 'a3-anchor'",
            [],
        )?;
        Ok(())
    })?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?.as_deref(),
        Some("a3-phase-anchor-unavailable")
    );

    // anchor が Scene でない node（folder）。
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES ('a3-folder', 'default-project', 'folder', 'Folder', '{}', 'b0')",
            [],
        )?;
        conn.execute(
            "UPDATE codex_entry_phases SET anchor_node_id = 'a3-folder', version = version + 1
              WHERE id = 'a3-anchor'",
            [],
        )?;
        Ok(())
    })?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?.as_deref(),
        Some("a3-phase-anchor-unavailable")
    );
    Ok(())
}

// ---- story-scope / auto-scope ----------------------------------------------

/// 明示の story key は Reading が軸でも Story の authority で比べる。source が一意に解決し、
/// query の Scene が重複 key（曖昧）なら、比べられず `a3-story-scope-unavailable`。
#[test]
fn a3_explicit_story_scope_against_an_ambiguous_query_is_unavailable() -> Result<()> {
    let story_scope = |entity: &mut EntityInput| {
        entity.scope.story = ScopeValue::Exact {
            value: "story:a3-source".into(),
        };
    };
    // 対照：source a0 < query a1 は Eligible。
    let _relaxed = super::tests_scope_shape::RelaxedScopeShape::hold();
    let (db, revision) = approved_revision(
        |conn| {
            set_story_keys(
                conn,
                [
                    ("a3-source", Some("a0")),
                    ("nir1", Some("a1")),
                    ("a3-future", Some("a2")),
                ],
                "reading",
            )
        },
        story_scope,
    )?;
    assert_eq!(read_reason(&db, &revision, "nir1")?, None);

    // query（nir1）と a3-future が同じ key で、どちらも曖昧。
    let (db, revision) = approved_revision(
        |conn| {
            set_story_keys(
                conn,
                [
                    ("a3-source", Some("a0")),
                    ("nir1", Some("a1")),
                    ("a3-future", Some("a1")),
                ],
                "reading",
            )
        },
        story_scope,
    )?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?.as_deref(),
        Some("a3-story-scope-unavailable")
    );
    Ok(())
}

/// 明示の story／auto の参照が authority で解決しなくなった場合、公開の evaluate は A3 の理由でなく
/// `source-revision-changed` を返す（観測。A2 の `validate_scope_binding` の `validate_scope_value`
/// が先に落ちる、というコードの読みと整合する。story の key を書き換えた時点で別の source token
/// が動いた可能性とは、この試験では分けていない）。
#[test]
fn a3_explicit_story_or_auto_reference_that_stops_resolving_reads_as_source_revision_changed(
) -> Result<()> {
    let _relaxed = super::tests_scope_shape::RelaxedScopeShape::hold();
    type Customize = fn(&mut EntityInput);
    let shapes: [(&str, Customize); 2] = [
        ("story", |entity| {
            entity.scope.story = ScopeValue::Exact {
                value: "story:a3-source".into(),
            }
        }),
        ("auto", |entity| {
            entity.scope.auto = ScopeValue::Exact {
                value: "story:a3-source".into(),
            }
        }),
    ];
    for (axis, customize) in shapes {
        let (db, revision) = approved_revision(
            |conn| {
                set_story_keys(
                    conn,
                    [
                        ("a3-source", Some("a0")),
                        ("nir1", Some("a1")),
                        ("a3-future", Some("a2")),
                    ],
                    "reading",
                )
            },
            customize,
        )?;
        assert_eq!(read_reason(&db, &revision, "nir1")?, None, "{axis}: 対照");
        // a3-source と nir1 が同じ key になり、a3-source の story の参照は Resolved でなくなる。
        db.with_conn(|conn| {
            set_story_keys(
                conn,
                [
                    ("a3-source", Some("a1")),
                    ("nir1", Some("a1")),
                    ("a3-future", Some("a2")),
                ],
                "reading",
            )
        })?;
        assert_eq!(
            read_reason(&db, &revision, "nir1")?.as_deref(),
            Some("source-revision-changed"),
            "{axis}"
        );
    }
    Ok(())
}

/// auto の Scope が query より後ろの Scene を名指しすれば `a3-auto-scope-future`。
#[test]
fn a3_auto_scope_after_the_query_is_future() -> Result<()> {
    let _relaxed = super::tests_scope_shape::RelaxedScopeShape::hold();
    let auto_at = |scene: &'static str| {
        move |entity: &mut EntityInput| {
            entity.scope.auto = ScopeValue::Exact {
                value: format!("scene:{scene}"),
            };
        }
    };
    let reading = |conn: &Connection| {
        set_story_keys(
            conn,
            [("a3-source", None), ("nir1", None), ("a3-future", None)],
            "reading",
        )
    };

    // 対照：query と同じ Scene（Equal）は通る。
    let (db, revision) = approved_revision(reading, auto_at("nir1"))?;
    assert_eq!(read_reason(&db, &revision, "nir1")?, None);

    let (db, revision) = approved_revision(reading, auto_at("a3-future"))?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?.as_deref(),
        Some("a3-auto-scope-future")
    );
    Ok(())
}

/// Story が軸のとき、auto の Scene の story key が未解決なら比べられず
/// `a3-auto-scope-unavailable`。
#[test]
fn a3_auto_scope_on_a_scene_without_a_story_key_is_unavailable_on_the_story_axis() -> Result<()> {
    let _relaxed = super::tests_scope_shape::RelaxedScopeShape::hold();
    let auto_at = |scene: &'static str| {
        move |entity: &mut EntityInput| {
            entity.scope.auto = ScopeValue::Exact {
                value: format!("scene:{scene}"),
            };
        }
    };
    // a3-source は key が無く（先頭で継承も無い）、nir1 と a3-future は解決する。
    let story = |conn: &Connection| {
        set_story_keys(
            conn,
            [
                ("a3-source", None),
                ("nir1", Some("a0")),
                ("a3-future", Some("a1")),
            ],
            "story",
        )
    };

    // 対照：query と同じ Scene（解決済み・Equal）は通る。
    let (db, revision) = approved_revision(story, auto_at("nir1"))?;
    assert_eq!(read_reason(&db, &revision, "nir1")?, None);

    let (db, revision) = approved_revision(story, auto_at("a3-source"))?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?.as_deref(),
        Some("a3-auto-scope-unavailable")
    );
    Ok(())
}

// ---- query 軸 --------------------------------------------------------------

/// query の Scene が project に無ければ `a3-query-scene-unavailable`（対照は同じ revision を
/// 既存の query で読んで Eligible）。
#[test]
fn a3_query_scene_that_does_not_exist_is_unavailable() -> Result<()> {
    let (db, revision) = approved_revision(|_| Ok(()), |_| {})?;
    assert_eq!(read_reason(&db, &revision, "nir1")?, None);
    assert_eq!(
        read_reason(&db, &revision, "a3-no-such-scene")?.as_deref(),
        Some("a3-query-scene-unavailable")
    );
    Ok(())
}

// ---- entity ----------------------------------------------------------------

/// 実体の Codex 行が消えても、公開の evaluate は `Err`（a3-entity-unavailable）でなく
/// Unavailable の値で `source-revision-changed` を返す（この削除の経路で観測。A3 の
/// `a3-entity-unavailable` は `load_a3_phases` の中で、A2 の後ろに置かれている）。
#[test]
fn a3_deleted_entity_is_stopped_by_a2_before_the_entity_gate() -> Result<()> {
    let (db, revision) = approved_revision(|_| Ok(()), |_| {})?;
    assert_eq!(read_reason(&db, &revision, "nir1")?, None);
    db.with_conn(|conn| {
        conn.execute("DELETE FROM codex_relations", [])?;
        conn.execute("DELETE FROM codex_entries WHERE id = 'nir1-alice'", [])?;
        Ok(())
    })?;
    assert_eq!(
        read_reason(&db, &revision, "nir1")?.as_deref(),
        Some("source-revision-changed")
    );
    Ok(())
}
