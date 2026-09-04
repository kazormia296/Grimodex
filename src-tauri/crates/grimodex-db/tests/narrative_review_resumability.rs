use grimodex_db::narrative_extraction::{
    self, ensure_test_schema, IsRunResumableForReviewPayload, ListResumableRunsPayload,
};
use grimodex_db::Database;
use rusqlite::{params, Connection};

const PROJECT_ID: &str = "project-review-resumability";
const SURFACE_PATH_ID: &str = "chronicle.extract";

fn test_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open in-memory database");
    db.with_conn(|conn| {
        conn.execute(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'p')",
            [],
        )?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'Review resumability')",
            [PROJECT_ID],
        )?;
        ensure_test_schema(conn)
    })
    .expect("seed narrative extraction schema");
    db
}

fn seed_review_candidate(
    conn: &Connection,
    run_id: &str,
    lifecycle_at: &str,
    proposal_statuses: &[&str],
) -> anyhow::Result<()> {
    let proposal_set_id = format!("set:{run_id}");
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, started_at, completed_at)
         VALUES (?1, ?2, ?3, '{}', '{}', ?4, 'completed', '{}', ?5, ?5, ?5)",
        params![
            run_id,
            PROJECT_ID,
            SURFACE_PATH_ID,
            format!("spec:{run_id}"),
            lifecycle_at
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_sets
            (id, run_id, project_id, set_kind, status, summary_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'chronicle.extract.review@1', 'draft', '{}', ?4, ?4)",
        params![proposal_set_id, run_id, PROJECT_ID, lifecycle_at],
    )?;
    for (index, status) in proposal_statuses.iter().enumerate() {
        conn.execute(
            "INSERT INTO narrative_proposals
                (id, proposal_set_id, proposal_key, kind, status, payload_json,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, 'chronicle.create-event@1', ?4, '{}', ?5, ?5)",
            params![
                format!("proposal:{run_id}:{index}"),
                proposal_set_id,
                format!("key:{run_id}:{index}"),
                status,
                lifecycle_at
            ],
        )?;
    }
    Ok(())
}

fn exact_payload(run_id: &str) -> IsRunResumableForReviewPayload {
    IsRunResumableForReviewPayload {
        run_id: run_id.to_string(),
        project_id: PROJECT_ID.to_string(),
        surface_path_id: SURFACE_PATH_ID.to_string(),
    }
}

#[test]
fn exact_review_resumability_is_not_hidden_by_one_hundred_newer_candidates() {
    let db = test_db();
    let target_run_id = "run:target:older";
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        seed_review_candidate(
            &tx,
            target_run_id,
            "2026-01-01T00:00:00.000Z",
            &["unreviewed", "held"],
        )?;
        for index in 0..101 {
            seed_review_candidate(
                &tx,
                &format!("run:newer:{index:03}"),
                "2026-08-26T00:00:00.000Z",
                &["unreviewed"],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
    .expect("seed 102 Review-resumable Runs");

    let bounded = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: PROJECT_ID.to_string(),
            surface_path_id: Some(SURFACE_PATH_ID.to_string()),
            limit: Some(100),
        },
    )
    .expect("bounded discovery");
    let bounded = bounded.as_array().expect("bounded summary array");
    assert_eq!(bounded.len(), 100);
    assert!(
        bounded
            .iter()
            .all(|summary| summary["runId"] != target_run_id),
        "the older target demonstrates bounded-discovery false absence"
    );

    let exact = narrative_extraction::narrative_extraction_is_run_resumable_for_review(
        &db,
        exact_payload(target_run_id),
    )
    .expect("exact authority query");
    assert_eq!(exact.run_id, target_run_id);
    assert_eq!(exact.project_id, PROJECT_ID);
    assert_eq!(exact.surface_path_id, SURFACE_PATH_ID);
    assert!(exact.resumable);

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_proposals
                SET status = 'rejected'
              WHERE proposal_set_id = ?1",
            [format!("set:{target_run_id}")],
        )?;
        Ok(())
    })
    .expect("terminalize every remaining target Proposal");

    let terminal = narrative_extraction::narrative_extraction_is_run_resumable_for_review(
        &db,
        exact_payload(target_run_id),
    )
    .expect("exact terminal query");
    assert!(!terminal.resumable);
}

#[test]
fn exact_review_resumability_rejects_non_exact_and_cross_scope_coordinates() {
    let db = test_db();
    db.with_conn(|conn| {
        seed_review_candidate(
            conn,
            "run:scope-guard",
            "2026-08-26T00:00:00.000Z",
            &["unreviewed"],
        )
    })
    .expect("seed scope-guard Run");

    for payload in [
        IsRunResumableForReviewPayload {
            run_id: "".to_string(),
            ..exact_payload("run:scope-guard")
        },
        IsRunResumableForReviewPayload {
            run_id: " run:scope-guard".to_string(),
            ..exact_payload("run:scope-guard")
        },
        IsRunResumableForReviewPayload {
            project_id: format!("{PROJECT_ID} "),
            ..exact_payload("run:scope-guard")
        },
        IsRunResumableForReviewPayload {
            surface_path_id: format!(" {SURFACE_PATH_ID}"),
            ..exact_payload("run:scope-guard")
        },
    ] {
        let error =
            narrative_extraction::narrative_extraction_is_run_resumable_for_review(&db, payload)
                .expect_err("non-exact coordinate must fail closed");
        assert!(
            error
                .to_string()
                .contains("NEX_REVIEW_RESUME_QUERY_INVALID"),
            "unexpected error: {error}"
        );
    }

    for payload in [
        IsRunResumableForReviewPayload {
            project_id: "other-project".to_string(),
            ..exact_payload("run:scope-guard")
        },
        IsRunResumableForReviewPayload {
            surface_path_id: "other.surface".to_string(),
            ..exact_payload("run:scope-guard")
        },
    ] {
        let error =
            narrative_extraction::narrative_extraction_is_run_resumable_for_review(&db, payload)
                .expect_err("cross-scope coordinate must fail closed");
        assert!(
            error
                .to_string()
                .contains("NEX_REVIEW_RESUME_RUN_SCOPE_MISMATCH"),
            "unexpected error: {error}"
        );
    }

    let error = narrative_extraction::narrative_extraction_is_run_resumable_for_review(
        &db,
        exact_payload("run:missing"),
    )
    .expect_err("unknown exact Run must not be reported terminal");
    assert!(
        error
            .to_string()
            .contains("NEX_REVIEW_RESUME_RUN_NOT_FOUND"),
        "unexpected error: {error}"
    );
}
