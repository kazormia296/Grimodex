use std::path::Path;

use grimodex_db::domain_writes::{tree_node_create, TreeNodeCreatePayload};
use grimodex_db::{BatchStatement, Database, SqlOrigin, PROTECTED_WRITER_SQL_ERROR};
use serde_json::{json, Value};

const PROJECT_ID: &str = "c2zc-generic-dml-project";
const SCENE_ID: &str = "c2zc-generic-dml-scene";
const SCENE_DOC: &str = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"authoritative body"}]}]}"#;

fn database() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title, language) VALUES (?1, 'DML', 'ja')",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed project");
    db
}

fn scene_create_payload(request_id: &str) -> TreeNodeCreatePayload {
    serde_json::from_value(json!({
        "id": SCENE_ID,
        "projectId": PROJECT_ID,
        "requestId": request_id,
        "sessionId": format!("session:{request_id}"),
        "eventUid": format!("event:{request_id}"),
        "origin": "human",
        "originalTransactionId": null,
        "undoJournalId": null,
        "parentId": null,
        "nodeType": "scene",
        "title": "DML scene",
        "sortOrder": "a0",
        "synopsis": null,
        "status": null,
        "sourceUri": null,
        "sourceMtime": null,
        "content": SCENE_DOC,
        "canonicalPayload": null
    }))
    .expect("decode scene create payload")
}

fn forged_coverage_insert() -> String {
    "INSERT INTO change_events
        (project_id, event_uid, domain, op_type, entity_type, entity_id,
         payload, session_id, sequence, timestamp, prev_hash, hash)
     VALUES ('c2zc-generic-dml-project', 'forged-coverage', 'timelapse-internal',
             'doc.step.coverage', 'scene', 'c2zc-generic-dml-scene',
             '{\"resultContentDigest\":\"forged\"}', 'forged-session', 1, 1,
             'forged-prev', 'forged-hash')"
        .to_string()
}

fn assert_no_forged_rows_and_authoritative_snapshot(db: &Database) {
    let rows = db
        .execute(
            "SELECT domain, op_type, entity_id, payload
               FROM change_events
              WHERE project_id = ?1
              ORDER BY sequence",
            &[Value::String(PROJECT_ID.to_string())],
            "all",
        )
        .expect("read canonical change events");
    assert_eq!(rows.len(), 1, "typed create must own the canonical event");
    assert_eq!(rows[0]["domain"], Value::String("tree".to_string()));
    assert_ne!(
        rows[0]["op_type"],
        Value::String("doc.step.coverage".to_string())
    );

    let snapshots = db
        .execute(
            "SELECT domain, entity_type, entity_id, anchor_sequence, payload, encoding
               FROM state_snapshots
              WHERE project_id = ?1",
            &[Value::String(PROJECT_ID.to_string())],
            "all",
        )
        .expect("read authoritative body snapshot");
    assert_eq!(
        snapshots.len(),
        1,
        "typed scene create must retain one snapshot"
    );
    assert_eq!(snapshots[0]["domain"], Value::String("editor".to_string()));
    assert_eq!(
        snapshots[0]["entity_type"],
        Value::String("scene".to_string())
    );
    assert_eq!(
        snapshots[0]["entity_id"],
        Value::String(SCENE_ID.to_string())
    );
    assert_eq!(snapshots[0]["anchor_sequence"], Value::from(1));
    assert_eq!(
        snapshots[0]["payload"],
        Value::String(SCENE_DOC.to_string())
    );
    assert_eq!(snapshots[0]["encoding"], Value::String("json".to_string()));
}

#[test]
fn renderer_and_mcp_generic_dml_cannot_forge_coverage_or_suppress_typed_snapshot() {
    for (origin, use_batch) in [
        (SqlOrigin::Renderer, false),
        (SqlOrigin::Renderer, true),
        (SqlOrigin::McpGeneric, false),
        (SqlOrigin::McpGeneric, true),
    ] {
        let db = database();
        let sql = forged_coverage_insert();
        let error = if use_batch {
            let statements = vec![
                BatchStatement {
                    sql: "INSERT INTO project_settings (project_id, key, value)
                          VALUES ('c2zc-generic-dml-project', 'ordinary.batch', 'forged')"
                        .to_string(),
                    params: vec![],
                    method: "run".to_string(),
                },
                BatchStatement {
                    sql,
                    params: vec![],
                    method: "run".to_string(),
                },
            ];
            match origin {
                SqlOrigin::Renderer => db
                    .execute_batch_tx_renderer(&statements)
                    .expect_err("renderer batch coverage forge must be denied"),
                SqlOrigin::McpGeneric => db
                    .execute_batch_tx_untrusted(origin, &statements)
                    .expect_err("MCP batch coverage forge must be denied"),
                _ => unreachable!("only untrusted origins are exercised"),
            }
        } else {
            match origin {
                SqlOrigin::Renderer => db
                    .execute_renderer(&sql, &[], "run")
                    .expect_err("renderer coverage forge must be denied"),
                SqlOrigin::McpGeneric => db
                    .execute_untrusted(origin, &sql, &[], "run")
                    .expect_err("MCP coverage forge must be denied"),
                _ => unreachable!("only untrusted origins are exercised"),
            }
        };
        assert!(
            error.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
            "{origin:?} {} coverage forge escaped protected-writer policy: {error}",
            if use_batch { "batch" } else { "single" }
        );

        let ordinary_batch_rows = db
            .execute(
                "SELECT COUNT(*) AS count
                   FROM project_settings
                  WHERE project_id = ?1 AND key = 'ordinary.batch'",
                &[Value::String(PROJECT_ID.to_string())],
                "get",
            )
            .expect("inspect generic batch rollback");
        assert_eq!(ordinary_batch_rows[0]["count"], Value::from(0));

        let forged_rows = db
            .execute_untrusted(
                origin,
                "SELECT COUNT(*) AS count
                   FROM change_events
                  WHERE project_id = ?1 AND op_type = 'doc.step.coverage'",
                &[Value::String(PROJECT_ID.to_string())],
                "get",
            )
            .expect("untrusted SELECT of protected table remains allowed");
        assert_eq!(forged_rows[0]["count"], Value::from(0));

        tree_node_create(
            &db,
            scene_create_payload(&format!("request:{origin:?}:{}", use_batch)),
        )
        .expect("trusted typed body writer must still commit");
        assert_no_forged_rows_and_authoritative_snapshot(&db);
    }
}
