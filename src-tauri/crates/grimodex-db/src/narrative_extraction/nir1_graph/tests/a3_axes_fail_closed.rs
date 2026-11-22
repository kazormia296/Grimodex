//! PUB-G 前提 #6（DR-PUBG-6-1）：A3 の Scope 軸（POV・phase・story・auto）の理由で
//! 不適格になった revision が、Graph の registration／query／worker の経路で
//! fail-closed に落ちることを、結合で確かめる。
//!
//! s7r2 の製品経路で観測した A3 の不適格の理由は 5 種だけで、軸の理由は単位試験
//! （`nir1_entity_relation` の `a3_axis_reason_tests`）でだけ固定していた。ここは、それらの
//! 理由が `evaluate_nir1_entity_relation_disclosure_for_graph` を通って、Graph が
//! 材料を 1 つも返さない（node も edge も 0、material binding なし）ことまでを固定する。
//! 不適格の revision は error でなく「材料の無い available」になる（graph は空）。

use super::*;
use crate::narrative_extraction::nir1_entity_relation::tests_scope_shape::RelaxedScopeShape;

fn build(
    setup: impl FnOnce(&Connection) -> Result<()>,
    customize: impl Fn(&mut grimodex_core::narrative_nir1::EntityInput),
) -> Result<Fixture> {
    let directory = TestDirectory(
        std::env::temp_dir().join(format!("nir1-c-graph-a3-axes-{}", uuid::Uuid::new_v4())),
    );
    std::fs::create_dir_all(&directory.0)?;
    let db = crate::Database::new(&directory.0.join("grimodex.db"))?;
    db.migrate()?;
    seed_run_and_catalog(&db)?;
    prepare_a3_scope_fixture(&db)?;
    db.with_conn(|conn| setup(conn))?;
    run_incremental_freshness_cycle(&db)?;
    let mut typed = request(&db);
    for entity in &mut typed.bundle.entities {
        entity.scope.reading = ScopeValue::Exact {
            value: "scene:a3-source".into(),
        };
        entity.scope.phase = "draft".into();
        customize(entity);
    }
    crate::narrative_extraction::nir1_entity_relation::tests::rebind_scope_tokens(&db, &mut typed)?;
    let created = create_nir1_entity_relation_revision(&db, typed)?;
    approve_typed_revision(&db, "nir1-run", &created)?;
    let authority = WorkspaceAuthority::from_database_for_test(db, directory.0.clone())?;
    publish_graph_index(&authority)?;
    Ok(Fixture {
        authority,
        lifecycle: WorkspaceLifecycleCore::new(),
        revision: created["revisionId"].as_str().unwrap().to_owned(),
        _directory: directory,
    })
}

const SEED: &str = "nir1-alice";

fn pov_is_alice(conn: &Connection) -> Result<()> {
    conn.execute(
        "UPDATE tree_nodes SET pov_character_id = 'nir1-alice'
          WHERE id = 'nir1' AND project_id = 'default-project'",
        [],
    )?;
    Ok(())
}

fn story_keys(conn: &Connection, keys: [(&str, &str); 3]) -> Result<()> {
    for (scene, key) in keys {
        conn.execute(
            "UPDATE tree_nodes SET story_time_order = ?1
              WHERE id = ?2 AND project_id = 'default-project'",
            params![key, scene],
        )?;
    }
    conn.execute(
        "UPDATE projects SET phase_resolution_mode = 'reading' WHERE id = 'default-project'",
        [],
    )?;
    Ok(())
}

fn a3_read(fixture: &Fixture) -> Result<Nir1EntityRelationDisclosureRead> {
    fixture.authority.with_read_transaction(|conn| {
        evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &fixture.revision, "nir1")
    })
}

fn assert_closed_empty(response: &Nir1GraphResponse, label: &str) {
    assert_eq!(
        response.status, "available",
        "{label}: {:?}",
        response.reason
    );
    let graph = response
        .graph
        .as_ref()
        .expect("available response has a graph");
    assert!(graph.nodes.is_empty(), "{label}: material leaked as a node");
    assert!(
        graph.edges.is_empty(),
        "{label}: material leaked as an edge"
    );
}

/// 対照：軸が合えば同じ構成で material が出る。軸の理由で不適格なら、A3 の理由が
/// 名指しで出て、registration の後の query は ordinary／worker のどちらも空の graph になる。
#[test]
fn a3_axis_ineligibility_reaches_the_graph_as_an_empty_closed_result() -> Result<()> {
    let _relaxed = RelaxedScopeShape::hold();

    let control = build(pov_is_alice, |entity| {
        entity.scope.pov = Some("nir1-alice".into())
    })?;
    assert!(matches!(
        a3_read(&control)?,
        Nir1EntityRelationDisclosureRead::Eligible(_)
    ));
    let mut reader = control.registered_reader()?;
    let response = query(&mut reader, SEED)?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let graph = response.graph.expect("control graph");
    assert_eq!((graph.nodes.len(), graph.edges.len()), (2, 1));

    type Setup = fn(&Connection) -> Result<()>;
    type Customize = fn(&mut grimodex_core::narrative_nir1::EntityInput);
    let cases: [(&str, Setup, Customize); 4] = [
        ("a3-pov-mismatch", pov_is_alice, |entity| {
            entity.scope.pov = Some("nir1-bob".into())
        }),
        (
            "a3-auto-scope-future",
            |_| Ok(()),
            |entity| {
                entity.scope.auto = ScopeValue::Exact {
                    value: "scene:a3-future".into(),
                }
            },
        ),
        (
            "a3-story-scope-future",
            |conn| {
                story_keys(
                    conn,
                    [("a3-source", "z0"), ("nir1", "a0"), ("a3-future", "z1")],
                )
            },
            |entity| {
                entity.scope.story = ScopeValue::Exact {
                    value: "story:a3-source".into(),
                }
            },
        ),
        (
            "a3-phase-future",
            |conn| {
                conn.execute(
                    "INSERT INTO codex_entry_phases
                        (id, entry_id, anchor_node_id, label, created_at, updated_at, version)
                     VALUES ('a3-later', 'nir1-alice', 'a3-future', 'later',
                             '2026-09-17T00:00:10.000Z', '2026-09-17T00:00:10.000Z', 0)",
                    [],
                )?;
                Ok(())
            },
            |entity| {
                if entity.entity_id == "nir1-alice" {
                    entity.scope.phase = "later".into();
                }
            },
        ),
    ];
    for (reason, setup, customize) in cases {
        let fixture = build(setup, customize)?;
        match a3_read(&fixture)? {
            Nir1EntityRelationDisclosureRead::Unavailable { reason: got } => {
                assert_eq!(got, reason)
            }
            Nir1EntityRelationDisclosureRead::Eligible(_) => {
                anyhow::bail!("{reason}: the fixture was A3 eligible")
            }
        }

        let mut ordinary = fixture.registered_reader()?;
        assert_closed_empty(&query(&mut ordinary, SEED)?, reason);
        assert_closed_empty(&query(&mut ordinary, "nir1-bob")?, reason);
        assert!(ordinary.connection.as_ref().unwrap().is_autocommit());

        let mut worker = fixture.worker_reader()?;
        assert_closed_empty(&worker_query(&mut worker, SEED)?, reason);
    }
    Ok(())
}
