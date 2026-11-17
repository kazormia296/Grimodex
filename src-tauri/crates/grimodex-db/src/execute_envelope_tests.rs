//! `narrative_proposal_revisions.reconciliation_envelope_json` の generic SQL の拒否
//! （DR-GSQLENV-1〜3）。`payload_json` の既存の試験（`nir1_entity_relation.rs`）が覆う
//! 単純な SELECT に加えて、別名・subquery・CTE・関数・WHERE／ORDER BY・view・batch の形と、
//! 拒否しない列・表（public surface）、renderer の DML の拒否のコードが変わらないことを固定する。

use super::*;
use serde_json::json;

/// envelope に入れる、本文の代わりの目印。拒否された結果にこの文字列が現れてはならない。
const ENVELOPE_MARKER: &str = "ENVELOPE-STATEMENT-AND-QUOTE-MARKER";
const ENVELOPE_COLUMN: &str = "reconciliation_envelope_json";

struct Seeded {
    proposal_id: &'static str,
    revision_id: &'static str,
}

fn seeded_db() -> (Database, Seeded) {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open in-memory database");
    db.migrate().expect("migrate database");
    db.execute(
        "INSERT INTO projects (id, title, created_at, updated_at)
         VALUES ('project-1', 'Project', datetime('now'), datetime('now'))",
        &[],
        "run",
    )
    .expect("seed project");
    let envelope = json!({
        "schemaVersion": 2,
        "assertion": { "payload": { "summary": ENVELOPE_MARKER } },
        "evidenceSet": [{ "quote": ENVELOPE_MARKER }],
    })
    .to_string();
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json,
                 spec_digest, status, created_at)
             VALUES ('run-1', 'project-1', 'surface', '{}', '{}',
                     'digest', 'completed', datetime('now'));
             INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, input_json, created_at)
             VALUES ('task-1', 'run-1', 'task', 'completed', '{}', datetime('now'));
             INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at)
             VALUES ('attempt-1', 'task-1', 1, 'completed', datetime('now'));
             INSERT INTO narrative_extraction_artifacts
                (id, run_id, task_id, attempt_id, artifact_kind, payload_json, created_at)
             VALUES ('artifact-1', 'run-1', 'task-1', 'attempt-1', 'test',
                     '{\"summary\":\"ARTIFACT-STAYS-READABLE\"}', datetime('now'));
             INSERT INTO narrative_proposal_sets
                (id, run_id, project_id, set_kind, status, summary_json, created_at, updated_at)
             VALUES ('set-1', 'run-1', 'project-1', 'test', 'draft', '{}',
                     datetime('now'), datetime('now'));
             INSERT INTO narrative_proposals
                (id, proposal_set_id, proposal_key, kind, payload_json, created_at, updated_at)
             VALUES ('proposal-1', 'set-1', 'key-1', 'test', '{}',
                     datetime('now'), datetime('now'));",
        )?;
        conn.execute(
            "INSERT INTO narrative_proposal_revisions
                (id, proposal_id, revision_number, payload_json, origin_kind,
                 reconciliation_envelope_json, reconciliation_envelope_digest,
                 created_at, created_by)
             VALUES ('revision-1', 'proposal-1', 1, '{}', 'enveloped', ?1,
                     'sha256:envelope-digest', datetime('now'), 'test')",
            [&envelope],
        )?;
        conn.execute_batch(
            "UPDATE narrative_proposals SET current_revision_id = 'revision-1'
              WHERE id = 'proposal-1';
             CREATE VIEW renderer_envelope_view AS
                SELECT id, reconciliation_envelope_json AS e
                  FROM narrative_proposal_revisions;
             CREATE VIEW renderer_digest_view AS
                SELECT id, reconciliation_envelope_digest AS d
                  FROM narrative_proposal_revisions;",
        )?;
        Ok(())
    })
    .expect("seed enveloped revision");
    (
        db,
        Seeded {
            proposal_id: "proposal-1",
            revision_id: "revision-1",
        },
    )
}

fn assert_envelope_denied(error: &anyhow::Error, context: &str) {
    let message = error.to_string();
    assert!(
        message.contains(RENDERER_TYPED_PAYLOAD_ERROR),
        "{context}: expected {RENDERER_TYPED_PAYLOAD_ERROR}, got {message}"
    );
    assert!(
        !message.contains(ENVELOPE_MARKER),
        "{context}: the rejection must not echo the envelope: {message}"
    );
}

/// envelope の列を（直接でも間接でも）読む文。列名を message に含む拒否を期待する。
const ENVELOPE_READ_SHAPES: &[&str] = &[
    "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?1",
    "SELECT reconciliation_envelope_json AS e FROM narrative_proposal_revisions WHERE id = ?1",
    "SELECT r.reconciliation_envelope_json AS e FROM narrative_proposal_revisions AS r WHERE r.id = ?1",
    "SELECT REVISIONS.RECONCILIATION_ENVELOPE_JSON FROM NARRATIVE_PROPOSAL_REVISIONS AS REVISIONS WHERE REVISIONS.id = ?1",
    "SELECT e FROM (SELECT reconciliation_envelope_json AS e FROM narrative_proposal_revisions WHERE id = ?1)",
    "WITH c AS (SELECT reconciliation_envelope_json AS e FROM narrative_proposal_revisions WHERE id = ?1) SELECT e FROM c",
    "SELECT json_extract(reconciliation_envelope_json, '$.assertion.payload.summary') AS s FROM narrative_proposal_revisions WHERE id = ?1",
    "SELECT json_extract(reconciliation_envelope_json, '$.evidenceSet[0].quote') AS q FROM narrative_proposal_revisions WHERE id = ?1",
    "SELECT length(reconciliation_envelope_json) AS n FROM narrative_proposal_revisions WHERE id = ?1",
    "SELECT id FROM narrative_proposal_revisions WHERE reconciliation_envelope_json IS NOT NULL AND id = ?1",
    "SELECT id FROM narrative_proposal_revisions WHERE reconciliation_envelope_json LIKE '%MARKER%' AND id = ?1",
    "SELECT count(*) AS n FROM narrative_proposal_revisions WHERE reconciliation_envelope_json = ?1",
    "SELECT id FROM narrative_proposal_revisions WHERE id = ?1 ORDER BY reconciliation_envelope_json",
    "SELECT id, reconciliation_envelope_json IS NULL AS missing FROM narrative_proposal_revisions WHERE id = ?1",
    "SELECT p.id FROM narrative_proposals AS p JOIN narrative_proposal_revisions AS r ON r.id = p.current_revision_id WHERE p.id = ?1 AND r.reconciliation_envelope_json IS NOT NULL",
    "SELECT e FROM renderer_envelope_view WHERE id = ?1",
    "SELECT id FROM renderer_envelope_view WHERE id = ?1 AND e IS NOT NULL",
];

#[test]
fn renderer_sql_rejects_every_envelope_read_shape() {
    let (db, seeded) = seeded_db();
    for sql in ENVELOPE_READ_SHAPES {
        // 引数は id（最後の 2 つの形は id でない値を渡しても拒否は同じ）。
        let params = [json!(seeded.revision_id)];
        let params: &[Value] = if sql.contains("p.id = ?1") {
            &[json!(seeded.proposal_id)]
        } else {
            &params
        };
        let error = db
            .execute_renderer(sql, params, "all")
            .expect_err(&format!("renderer SQL must not read the envelope: {sql}"));
        assert_envelope_denied(&error, sql);
        assert!(
            error
                .to_string()
                .to_ascii_lowercase()
                .contains(ENVELOPE_COLUMN),
            "the rejection must name the column ({sql}): {error}"
        );

        let batch_error = db
            .execute_batch_tx_renderer(&[BatchStatement {
                sql: (*sql).to_string(),
                params: params.to_vec(),
                method: "all".into(),
            }])
            .expect_err(&format!(
                "renderer batch SQL must not read the envelope: {sql}"
            ));
        assert_envelope_denied(&batch_error, sql);
    }
}

#[test]
fn renderer_sql_rejects_get_and_run_methods_for_the_envelope() {
    let (db, seeded) = seeded_db();
    for method in ["get", "all", "run", "values"] {
        let error = db
            .execute_renderer(
                "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?1",
                &[json!(seeded.revision_id)],
                method,
            )
            .expect_err("the method must not change the rejection");
        assert_envelope_denied(&error, method);
    }
}

#[test]
fn select_star_over_revisions_stays_rejected() {
    let (db, seeded) = seeded_db();
    for sql in [
        "SELECT * FROM narrative_proposal_revisions WHERE id = ?1",
        "SELECT r.* FROM narrative_proposal_revisions AS r WHERE r.id = ?1",
        "SELECT * FROM (SELECT * FROM narrative_proposal_revisions WHERE id = ?1)",
    ] {
        let error = db
            .execute_renderer(sql, &[json!(seeded.revision_id)], "all")
            .expect_err("a star read covers the protected columns");
        assert_envelope_denied(&error, sql);
    }
}

#[test]
fn renderer_sql_still_reads_the_columns_and_tables_that_are_public_surfaces() {
    let (db, seeded) = seeded_db();

    // 列を選んだ読み。setup 系の `SELECT id` と journey の digest の assert が頼る。
    let rows = db
        .execute_renderer(
            "SELECT id, proposal_id, revision_number, plan_fragment_json, plan_fragment_digest,
                    origin_kind, reconciliation_envelope_digest, created_at, created_by
               FROM narrative_proposal_revisions WHERE id = ?1",
            &[json!(seeded.revision_id)],
            "all",
        )
        .expect("non-protected revision columns stay readable");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!(seeded.revision_id));
    assert_eq!(rows[0]["origin_kind"], json!("enveloped"));
    assert_eq!(
        rows[0]["reconciliation_envelope_digest"],
        json!("sha256:envelope-digest")
    );
    // DR-GSQLENV-2：writer が無く、値は NULL のまま。拒否の対象にしない。
    assert_eq!(rows[0]["plan_fragment_json"], Value::Null);

    // envelope を読まない view と、envelope の digest だけを返す view は通る。
    let rows = db
        .execute_renderer(
            "SELECT d FROM renderer_digest_view WHERE id = ?1",
            &[json!(seeded.revision_id)],
            "all",
        )
        .expect("a view that does not touch the envelope stays readable");
    assert_eq!(rows[0]["d"], json!("sha256:envelope-digest"));

    // 閉じないと決めた public surface（ユーザーの回答）：artifacts の payload_json。
    let rows = db
        .execute_renderer(
            "SELECT payload_json FROM narrative_extraction_artifacts WHERE id = 'artifact-1'",
            &[],
            "all",
        )
        .expect("artifacts payload_json is a public surface and stays readable");
    assert!(rows[0]["payload_json"]
        .as_str()
        .is_some_and(|payload| payload.contains("ARTIFACT-STAYS-READABLE")));

    // 他の表で同名の列を名乗っても、名前だけでは拒否しない（（表, 列）の対で判定する）。
    db.execute(
        "CREATE TABLE other_envelope_holder (id TEXT PRIMARY KEY, reconciliation_envelope_json TEXT)",
        &[],
        "run",
    )
    .expect("trusted scratch table");
    db.execute(
        "INSERT INTO other_envelope_holder VALUES ('x', 'visible')",
        &[],
        "run",
    )
    .expect("trusted scratch row");
    let rows = db
        .execute_renderer(
            "SELECT reconciliation_envelope_json AS e FROM other_envelope_holder",
            &[],
            "all",
        )
        .expect("the pair, not the column name, is guarded");
    assert_eq!(rows[0]["e"], json!("visible"));
}

#[test]
fn payload_json_pairs_are_still_rejected() {
    let (db, seeded) = seeded_db();
    for (table, id) in [
        ("narrative_proposals", seeded.proposal_id),
        ("narrative_proposal_revisions", seeded.revision_id),
    ] {
        let error = db
            .execute_renderer(
                &format!("SELECT payload_json FROM {table} WHERE id = ?1"),
                &[json!(id)],
                "all",
            )
            .expect_err("payload_json stays rejected");
        assert_envelope_denied(&error, table);
        assert!(error.to_string().contains("payload_json"), "{error}");
    }
}

#[test]
fn renderer_dml_on_the_proposal_tables_keeps_the_protected_writer_rejection() {
    // DR-GSQLENV-3：envelope を読む trigger（monotonicity、immutable）を発火しうる DML は、
    // renderer では protected writer で先に拒否される。拒否の理由が新しい guard に
    // 変わらないことを固定する（変わるなら trigger の accessor での除外が要る）。
    let (db, seeded) = seeded_db();
    for sql in [
        "UPDATE narrative_proposal_revisions SET created_by = 'renderer' WHERE id = ?1",
        "UPDATE narrative_proposal_revisions SET reconciliation_envelope_json = '{}' WHERE id = ?1",
        "UPDATE narrative_proposal_revisions SET origin_kind = 'legacy-unbound' WHERE id = ?1",
        "DELETE FROM narrative_proposal_revisions WHERE id = ?1",
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, origin_kind, created_at, created_by)
         VALUES ('forged', 'proposal-1', 2, '{}', 'legacy-unbound', datetime('now'), 'renderer')",
        "UPDATE narrative_proposals SET current_revision_id = NULL WHERE id = 'proposal-1'",
        "UPDATE narrative_proposals SET current_revision_id = ?1 WHERE id = 'proposal-1'",
        "DELETE FROM narrative_proposals WHERE id = 'proposal-1'",
        "DELETE FROM projects WHERE id = 'project-1'",
    ] {
        let params: Vec<Value> = if sql.contains("?1") {
            vec![json!(seeded.revision_id)]
        } else {
            Vec::new()
        };
        let error = db
            .execute_renderer(sql, &params, "run")
            .expect_err(&format!("renderer DML must stay rejected: {sql}"));
        let message = error.to_string();
        assert!(
            message.contains(PROTECTED_WRITER_SQL_ERROR),
            "{sql}: the protected-writer code must be kept, got {message}"
        );
        assert!(
            !message.contains(RENDERER_TYPED_PAYLOAD_ERROR),
            "{sql}: the rejection must not turn into the typed-payload code: {message}"
        );
    }

    // trusted writer は authorizer の対象外：同じ列を読む trigger が通常どおり動く。
    db.with_conn(|conn| {
        let denied = conn.execute(
            "UPDATE narrative_proposal_revisions SET created_by = 'trusted' WHERE id = 'revision-1'",
            [],
        );
        assert!(
            denied.is_err(),
            "the v2 immutable trigger still guards trusted writers"
        );
        Ok(())
    })
    .expect("trusted connection");
}

#[test]
fn restricted_profile_keeps_the_d2a_rejection_before_the_typed_payload_guard() {
    // restricted（D2a の authorizer が上に載る）では、closed の表の列は
    // `D2A_EGRESS_DENIED` で先に拒否される。envelope の guard はこの順序を変えない
    // （unrestricted でだけ `RENDERER_SQL_TYPED_PAYLOAD` が返る）。
    let (db, seeded) = seeded_db();
    for sql in [
        "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?1",
        "SELECT json_extract(reconciliation_envelope_json, '$.schemaVersion') AS v FROM narrative_proposal_revisions WHERE id = ?1",
        "SELECT e FROM renderer_envelope_view WHERE id = ?1",
        "SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?1",
    ] {
        let error = db
            .execute_renderer_profile_egress(sql, &[json!(seeded.revision_id)], "all")
            .expect_err("restricted generic SQL must not read the revision");
        assert!(
            error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
            "{sql}: expected {RENDERER_PROFILE_EGRESS_ERROR}, got {error}"
        );
        assert!(
            !error.to_string().contains(RENDERER_TYPED_PAYLOAD_ERROR),
            "{sql}: the D2a code must come first, got {error}"
        );

        let batch_error = db
            .execute_batch_tx_renderer_profile_egress(&[BatchStatement {
                sql: sql.to_string(),
                params: vec![json!(seeded.revision_id)],
                method: "all".into(),
            }])
            .expect_err("restricted generic batch SQL must not read the revision");
        assert!(
            batch_error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
            "{sql}: expected {RENDERER_PROFILE_EGRESS_ERROR} for the batch, got {batch_error}"
        );
    }
}
